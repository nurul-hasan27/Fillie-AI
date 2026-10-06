import { hmacHex, timingSafeEqual } from './hmac.ts';

/**
 * Razorpay signs the raw webhook body with HMAC-SHA256 using the webhook
 * secret and sends it in `X-Razorpay-Signature` (hex).
 */
export async function verifyRazorpaySignature(payload: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  return timingSafeEqual(signature.trim().toLowerCase(), await hmacHex(secret, payload));
}
