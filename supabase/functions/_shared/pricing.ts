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

export interface PricedOrder {
  currency: Currency;
  /** The list price before any code. */
  listMinor: number;
  /** Discount from an influencer's promo code. */
  promoOffMinor: number;
  /** Extra discount from an offer code, taken off the price after the promo. */
  offerOffMinor: number;
  /** What the customer pays. */
  finalMinor: number;
}

/** Smallest amount Razorpay accepts for a payment link (₹1 / $1). */
export const MIN_CHARGE_MINOR = 100;

/**
 * Applies a promo code and then an offer code. The offer is a percentage of the price that is
 * left after the promo, so the two stack but can never take the price below the minimum charge.
 */
export function priceOrder(price: Price, promoBps: number, offerBps: number): PricedOrder {
  const list = price.amountMinor;
  const promoOff = promoBps > 0 ? Math.round((list * promoBps) / 10_000) : 0;
  const afterPromo = list - promoOff;
  const offerRaw = offerBps > 0 ? Math.round((afterPromo * offerBps) / 10_000) : 0;
  const finalMinor = Math.max(MIN_CHARGE_MINOR, afterPromo - offerRaw);
  return { currency: price.currency, listMinor: list, promoOffMinor: promoOff, offerOffMinor: afterPromo - finalMinor, finalMinor };
}

/**
 * Up to three codes, trimmed, upper-cased and de-duplicated. One promo and one offer can be used together, so a third
 * is only there to let a newly typed code replace one of the same kind. Anything else is dropped.
 */
export function parseCodes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const code = raw.replace(/\s+/g, '').toUpperCase();
    if (/^[A-Z0-9]{4,16}$/.test(code)) seen.add(code);
    if (seen.size === 3) break;
  }
  return [...seen];
}
