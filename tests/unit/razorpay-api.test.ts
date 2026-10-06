import { describe, expect, it } from 'vitest';
import { fetchPaidLink, listPaidLinksFor, toPaidLink, type FetchLike } from '../../supabase/functions/_shared/razorpay-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const paidLink = { id: 'plink_ABC123xyz', status: 'paid', amount: 42000, amount_paid: 42000, currency: 'INR', notes: { user_id: 'u1' }, payments: [{ payment_id: 'pay_9', status: 'captured' }] };

describe('Razorpay payment link checks', () => {
  it('accepts only a paid link that carries a user', () => {
    expect(toPaidLink(paidLink)).toEqual({ userId: 'u1', ref: 'plink_ABC123xyz', amountMinor: 42000, currency: 'INR' });
    expect(toPaidLink({ ...paidLink, status: 'created' })).toBeNull();
    expect(toPaidLink({ ...paidLink, notes: [] })).toBeNull();
    expect(toPaidLink(null)).toBeNull();
  });

  it('uses the link id as the one stable reference, whether or not Razorpay lists the payment id', () => {
    expect(toPaidLink({ ...paidLink, payments: null })?.ref).toBe('plink_ABC123xyz');
    expect(toPaidLink({ ...paidLink, payments: [] })?.ref).toBe('plink_ABC123xyz');
    expect(toPaidLink({ ...paidLink, payments: [{ payment_id: 'pay_9' }] })?.ref).toBe('plink_ABC123xyz');
  });

  it('asks Razorpay (with our key) instead of believing the caller', async () => {
    const seen: string[] = [];
    const f: FetchLike = async (url, init) => {
      seen.push(`${url} ${(init?.headers as Record<string, string>)?.Authorization?.slice(0, 6)}`);
      return json(paidLink);
    };
    expect(await fetchPaidLink(f, 'rzp_test_k', 'secret', 'plink_ABC123xyz')).toMatchObject({ userId: 'u1' });
    expect(seen[0]).toBe('https://api.razorpay.com/v1/payment_links/plink_ABC123xyz Basic ');
  });

  it('returns null when Razorpay says the link is not paid, or does not know it', async () => {
    expect(await fetchPaidLink(async () => json({ ...paidLink, status: 'created' }), 'k', 's', 'plink_ABC123xyz')).toBeNull();
    expect(await fetchPaidLink(async () => json({ error: {} }, 400), 'k', 's', 'plink_ABC123xyz')).toBeNull();
  });

  it('never builds a request URL from a malicious id', async () => {
    let called = false;
    const f: FetchLike = async () => ((called = true), json(paidLink));
    for (const bad of ['../orders', 'plink_x/../../orders', 'plink_ab', '', 'x'.repeat(80)]) {
      expect(await fetchPaidLink(f, 'k', 's', bad)).toBeNull();
    }
    expect(called).toBe(false);
  });

  it('lists only this user\'s paid links', async () => {
    const f: FetchLike = async () =>
      json({ payment_links: [paidLink, { ...paidLink, id: 'plink_other1', notes: { user_id: 'u2' } }, { ...paidLink, id: 'plink_unpaid', status: 'created' }] });
    const mine = await listPaidLinksFor(f, 'k', 's', 'u1');
    expect(mine).toHaveLength(1);
    expect(mine[0].userId).toBe('u1');
  });
});
