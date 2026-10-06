import { hmacHex, timingSafeEqual } from './hmac.ts';

/**
 * Verifies a Stripe webhook signature (the `Stripe-Signature` header) with the
 * Web Crypto API, so no SDK is needed. Rejects old timestamps to stop replays.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;

  const now = (options.now ?? Date.now)() / 1000;
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSeconds ?? 300)) return false;

  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}
