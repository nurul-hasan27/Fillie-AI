// Renews the Sign in with Apple client secret (it expires every 6 months) and updates Supabase Auth with it.
// Called on a schedule by .github/workflows/rotate-apple-secret.yml; see docs/APPLE_SIGN_IN.md.
// Deploy with: supabase functions deploy rotate-apple-secret --no-verify-jwt
// Secrets: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_SERVICES_ID, APPLE_PRIVATE_KEY, MANAGEMENT_ACCESS_TOKEN,
//          APPLE_ROTATION_TOKEN (shared with the scheduler), optional APPLE_ROTATE_BEFORE_DAYS (default 45).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { reply, corsHeaders } from '../_shared/cors.ts';
import { timingSafeEqual } from '../_shared/hmac.ts';
import { rotateAppleSecret, type RotationStore } from '../_shared/apple-rotation.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const STATE_KEY = 'apple_client_secret';

/** Where the current expiry is remembered: a row in platform_settings (created by migration 0005). */
const store: RotationStore = {
  async getExpiry() {
    const { data } = await admin.from('platform_settings').select('value').eq('key', STATE_KEY).maybeSingle();
    const expiresAt = Number((data?.value as { expires_at?: number } | null)?.expires_at);
    return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
  },
  async setExpiry(expiresAt, rotatedAt) {
    const { error } = await admin.from('platform_settings').upsert({ key: STATE_KEY, value: { expires_at: expiresAt, rotated_at: rotatedAt }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Could not save the expiry: ${error.message}`);
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405);

  // Only our scheduler may call this. The token is compared in constant time.
  const expected = Deno.env.get('APPLE_ROTATION_TOKEN') ?? '';
  const given = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (expected.length < 24 || !timingSafeEqual(given, expected)) return reply({ error: 'Not allowed.' }, 401);

  const body = (await req.json().catch(() => ({}))) as { force?: boolean; dryRun?: boolean };
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const result = await rotateAppleSecret(
    {
      teamId: Deno.env.get('APPLE_TEAM_ID'), keyId: Deno.env.get('APPLE_KEY_ID'), servicesId: Deno.env.get('APPLE_SERVICES_ID'),
      privateKey: Deno.env.get('APPLE_PRIVATE_KEY'), managementToken: Deno.env.get('MANAGEMENT_ACCESS_TOKEN'),
      projectRef: new URL(supabaseUrl).hostname.split('.')[0],
      rotateBeforeDays: Number(Deno.env.get('APPLE_ROTATE_BEFORE_DAYS')) || undefined,
    },
    store,
    fetch,
    { force: body.force === true, dryRun: body.dryRun === true },
  );

  console.log(JSON.stringify({ event: 'apple_secret_rotation', ok: result.ok, ...(result.ok ? { rotated: result.rotated, reason: result.reason, days_left: result.daysLeft } : { error: result.error, missing: result.missing }) }));
  return reply(result, result.ok ? 200 : result.status);
});
