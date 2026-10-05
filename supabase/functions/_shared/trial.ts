/**
 * Free-trial decision, kept free of Deno APIs so it can be unit-tested.
 *
 * A filling counts against the device when ANY of its identifiers has used the
 * allowance: the install id, or the hardware hash (shared by every browser on
 * one machine). The IP bucket is more generous because households and offices
 * share an address.
 */
export interface TrialCounts {
  installCount: number;
  hwCount: number;
  ipCount: number;
}

export interface TrialDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export const IP_LIMIT_FACTOR = 3;

export function decideTrial(counts: TrialCounts, limit: number): TrialDecision {
  const used = Math.max(counts.installCount, counts.hwCount);
  const ipBlocked = counts.ipCount >= limit * IP_LIMIT_FACTOR;
  const remaining = ipBlocked ? 0 : Math.max(0, limit - used);
  return { allowed: remaining > 0, remaining, limit };
}

/** Start of the current calendar week (Monday, UTC) as YYYY-MM-DD. */
export function weekStart(now = Date.now()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const HEX = /^[0-9a-f]{16,128}$/i;
const INSTALL = /^[0-9a-f-]{16,64}$/i;

/** Rejects malformed identifiers so garbage cannot create endless counter rows. */
export function validIdentifiers(body: { install?: unknown; hw?: unknown }): body is { install: string; hw: string } {
  return typeof body.install === 'string' && INSTALL.test(body.install) && typeof body.hw === 'string' && HEX.test(body.hw);
}
