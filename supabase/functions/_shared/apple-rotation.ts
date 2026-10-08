import { buildAppleClientSecret, needsRotation, type AppleCredentials } from './apple-secret.ts';

export interface RotationEnv {
  teamId?: string;
  keyId?: string;
  servicesId?: string;
  privateKey?: string;
  /** A Supabase personal access token (sbp_...): the only credential that may change a project's auth settings. */
  managementToken?: string;
  projectRef?: string;
  rotateBeforeDays?: number;
}

export interface RotationStore {
  getExpiry(): Promise<number | null>;
  setExpiry(expiresAt: number, rotatedAt: number): Promise<void>;
}

export interface RotationOptions {
  force?: boolean;
  dryRun?: boolean;
}

export type RotationResult =
  | { ok: true; rotated: boolean; expiresAt: number | null; daysLeft: number | null; reason: 'renewed' | 'still_valid' | 'dry_run_due' | 'dry_run_not_due'; warning?: string }
  | { ok: false; status: number; error: string; missing?: string[] };

const REQUIRED: Array<[keyof RotationEnv, string]> = [
  ['teamId', 'APPLE_TEAM_ID'], ['keyId', 'APPLE_KEY_ID'], ['servicesId', 'APPLE_SERVICES_ID'], ['privateKey', 'APPLE_PRIVATE_KEY'],
  ['managementToken', 'SUPABASE_MANAGEMENT_TOKEN'], ['projectRef', 'SUPABASE_PROJECT_REF'],
];

const days = (seconds: number) => Math.floor(seconds / 86_400);

/**
 * Renews the Apple client secret when it is close to expiring and writes it into Supabase Auth.
 * Safe to run as often as you like: it does nothing while the current secret has plenty of time left.
 * The secret itself is never returned or logged.
 */
export async function rotateAppleSecret(
  env: RotationEnv,
  store: RotationStore,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  options: RotationOptions = {},
  now = Math.floor(Date.now() / 1000),
): Promise<RotationResult> {
  const missing = REQUIRED.filter(([key]) => !env[key]).map(([, name]) => name);
  if (missing.length) return { ok: false, status: 500, error: 'Missing configuration.', missing };
  if (!/^[a-z0-9]{20}$/.test(env.projectRef!)) return { ok: false, status: 500, error: 'SUPABASE_PROJECT_REF is not a valid project reference.' };

  const current = await store.getExpiry();
  const due = options.force === true || needsRotation(current, now, env.rotateBeforeDays ?? 45);
  const daysLeft = current ? days(current - now) : null;
  if (options.dryRun) return { ok: true, rotated: false, expiresAt: current, daysLeft, reason: due ? 'dry_run_due' : 'dry_run_not_due' };
  if (!due) return { ok: true, rotated: false, expiresAt: current, daysLeft, reason: 'still_valid' };

  let secret: { token: string; expiresAt: number };
  try {
    const credentials: AppleCredentials = { teamId: env.teamId!, keyId: env.keyId!, servicesId: env.servicesId!, privateKey: env.privateKey! };
    secret = await buildAppleClientSecret(credentials, now);
  } catch (error) {
    // The message names the problem (for example a malformed key) and never contains the key.
    return { ok: false, status: 500, error: error instanceof Error ? error.message : 'Could not sign the Apple client secret.' };
  }

  const response = await fetchImpl(`https://api.supabase.com/v1/projects/${env.projectRef}/config/auth`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${env.managementToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ external_apple_secret: secret.token }),
  });
  if (!response.ok) {
    return { ok: false, status: 502, error: `Supabase refused the update (HTTP ${response.status}). Check SUPABASE_MANAGEMENT_TOKEN and SUPABASE_PROJECT_REF.` };
  }

  // Remember the expiry only after Supabase accepted the new secret, so a failure is retried on the next run.
  try {
    await store.setExpiry(secret.expiresAt, now);
  } catch (error) {
    // Supabase already has the new secret, so this is a warning, not a failure. The next run will simply renew again.
    return { ok: true, rotated: true, expiresAt: secret.expiresAt, daysLeft: days(secret.expiresAt - now), reason: 'renewed', warning: error instanceof Error ? error.message : 'Could not remember the expiry date.' };
  }
  return { ok: true, rotated: true, expiresAt: secret.expiresAt, daysLeft: days(secret.expiresAt - now), reason: 'renewed' };
}
