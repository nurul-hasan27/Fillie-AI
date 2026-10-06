/**
 * The two prices Fillie sells at. The buyer chooses a currency; the amount is always
 * taken from the server, never from the request, so nobody can pick their own price.
 *
 * Razorpay offers UPI, netbanking, wallets and Indian cards only for INR payments.
 * USD payments get international cards only.
 */
export type Currency = 'INR' | 'USD';

export interface Price {
  currency: Currency;
  /** In the currency's smallest unit (paise or cents). */
  amountMinor: number;
}

export function pickPrice(requested: unknown, env: (name: string) => string | undefined): Price {
  if (requested === 'INR') {
    return { currency: 'INR', amountMinor: positive(env('RAZORPAY_INR_AMOUNT_MINOR'), 44900) };
  }
  return { currency: 'USD', amountMinor: positive(env('RAZORPAY_AMOUNT_MINOR'), 500) };
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 ? n : fallback;
}
