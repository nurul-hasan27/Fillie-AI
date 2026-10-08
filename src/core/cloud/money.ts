/** Money and discount helpers for the payment section of the Account page. */

export type Currency = 'INR' | 'USD';

export interface PricedOrder {
  currency: Currency;
  listMinor: number;
  promoOffMinor: number;
  offerOffMinor: number;
  finalMinor: number;
}

export interface AppliedCode {
  kind: 'promo' | 'offer';
  code: string;
  discount_bps: number;
  title: string;
}

/** What the server says the buyer would pay in one currency with these codes. */
export interface CheckoutQuote {
  order: PricedOrder;
  applied: AppliedCode[];
  rejected: Array<{ code: string; reason: string }>;
}

export interface QuoteSet {
  INR: CheckoutQuote;
  USD: CheckoutQuote;
}

/** "₹449", "₹383.89", "$4.50". Whole rupees drop the decimals. */
export function formatMoney(minor: number, currency: Currency): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(minor / 100);
}

export const percentLabel = (bps: number): string => `${Math.round(bps) / 100}%`;

export const REJECT_TEXT: Record<string, string> = {
  not_found: 'That code is not valid.',
  inactive: 'That code is not active.',
  own_code: 'You cannot use your own code.',
  expired: 'That offer has ended.',
  not_started: 'That offer has not started yet.',
  used_up: 'That offer has been fully used.',
};

/** Reads the quote answer defensively: an older checkout function answers with a payment link instead of a price. */
export function readQuote(value: unknown): CheckoutQuote | null {
  const q = value as Partial<CheckoutQuote> | null;
  if (!q || typeof q !== 'object' || !q.order || typeof q.order.finalMinor !== 'number' || !Array.isArray(q.applied)) return null;
  return { order: q.order, applied: q.applied, rejected: Array.isArray(q.rejected) ? q.rejected : [] };
}

/** The first reason worth showing, ignoring the harmless "same kind" replacement. */
export function rejectionNote(quote: CheckoutQuote): string {
  const bad = quote.rejected.find((r) => r.reason !== 'same_kind');
  return bad ? `${bad.code}: ${REJECT_TEXT[bad.reason] ?? 'Could not apply that code.'}` : '';
}
