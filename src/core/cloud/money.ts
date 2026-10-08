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

/** An offer an admin has chosen to show customers in "Explore offers". Creator codes are never listed. */
export interface PublicOffer {
  code: string;
  title: string;
  discount_bps: number;
  ends_at: string | null;
  /** How many uses remain, when the offer has a limit. */
  left: number | null;
}

export function readOffers(value: unknown): PublicOffer[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
    .map((o) => ({
      code: String(o.code ?? '').toUpperCase(),
      title: String(o.title ?? ''),
      discount_bps: Number(o.discount_bps) || 0,
      ends_at: typeof o.ends_at === 'string' ? o.ends_at : null,
      left: typeof o.left === 'number' ? o.left : null,
    }))
    .filter((o) => /^[A-Z0-9]{4,16}$/.test(o.code) && o.discount_bps > 0);
}

/** "Ends today", "Ends tomorrow", "Ends in 5 days", "Ends 12 Oct", or "" for no end. */
export function endsLabel(endsAt: string | null, now = new Date()): string {
  if (!endsAt) return '';
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(end) - day(now)) / 86_400_000);
  if (days <= 0) return 'Ends today';
  if (days === 1) return 'Ends tomorrow';
  if (days <= 7) return `Ends in ${days} days`;
  return `Ends ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}
