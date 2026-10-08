/**
 * Asks Razorpay itself whether a payment link was paid. Razorpay's answer, fetched
 * with our own API key, is the source of truth, so nothing a caller sends can
 * fake a payment. Used when a webhook arrives without a signature, and to
 * reconcile a payment for a user who presses "I have paid".
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PaidLink {
  userId: string;
  /**
   * The payment link id. A link is single-use, and Razorpay does not always list the
   * payment id on it, so the link id is the one stable key. Every path (signed webhook,
   * unsigned webhook, "I have paid") uses it, so one payment can never be counted twice.
   */
  ref: string;
  amountMinor: number;
  currency: string;
  /** How the price was made up, copied from the notes our own checkout wrote on the link. */
  promoCodeId?: string;
  offerId?: string;
  listAmountMinor?: number;
  promoDiscountMinor?: number;
  offerDiscountMinor?: number;
}

interface LinkEntity {
  id?: string;
  status?: string;
  amount?: number;
  amount_paid?: number;
  currency?: string;
  notes?: Record<string, string> | unknown[];
  payments?: Array<{ payment_id?: string; status?: string }> | null;
}

const authHeader = (keyId: string, keySecret: string) => ({ Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}` });

/** Turns a Razorpay link into a paid record, or null when it is not paid or not ours. */
export function toPaidLink(link: LinkEntity | null | undefined): PaidLink | null {
  if (!link || link.status !== 'paid') return null;
  const notes = (link.notes && !Array.isArray(link.notes) ? link.notes : {}) as Record<string, string | undefined>;
  const userId = notes.user_id;
  if (!userId) return null;
  if (!link.id) return null;
  const uuid = (value: string | undefined) => (value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined);
  const minor = (value: string | undefined) => (value && /^\d{1,9}$/.test(value) ? Number(value) : undefined);
  return {
    userId,
    ref: link.id,
    amountMinor: link.amount_paid ?? link.amount ?? 0,
    currency: link.currency ?? 'INR',
    promoCodeId: uuid(notes.promo_id),
    offerId: uuid(notes.offer_id),
    listAmountMinor: minor(notes.list_minor),
    promoDiscountMinor: minor(notes.promo_off),
    offerDiscountMinor: minor(notes.offer_off),
  };
}

export async function fetchPaidLink(fetchImpl: FetchLike, keyId: string, keySecret: string, linkId: string): Promise<PaidLink | null> {
  if (!/^plink_[A-Za-z0-9]{6,32}$/.test(linkId)) return null; // never build a URL from arbitrary input
  const response = await fetchImpl(`https://api.razorpay.com/v1/payment_links/${linkId}`, { headers: authHeader(keyId, keySecret) });
  if (!response.ok) return null;
  return toPaidLink((await response.json().catch(() => null)) as LinkEntity | null);
}

/** Recent paid links that belong to this user. */
export async function listPaidLinksFor(fetchImpl: FetchLike, keyId: string, keySecret: string, userId: string, count = 100): Promise<PaidLink[]> {
  const response = await fetchImpl(`https://api.razorpay.com/v1/payment_links?count=${count}`, { headers: authHeader(keyId, keySecret) });
  if (!response.ok) return [];
  const body = (await response.json().catch(() => ({}))) as { payment_links?: LinkEntity[] };
  return (body.payment_links ?? []).map(toPaidLink).filter((paid): paid is PaidLink => paid !== null && paid.userId === userId);
}
