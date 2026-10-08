// @vitest-environment node
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeDb } from '../helpers/pg-backend';

/**
 * Runs the real migrations against an in-memory Postgres (PGlite) with a tiny stand-in for
 * Supabase's auth and storage schemas, then drives the influencer programme end to end:
 * codes, checkout, commissions, balances, tax, withdrawals, deletion, fraud flags and permissions.
 */

let db: PGlite;
const ids: Record<string, string> = {};

const asUser = async (id: string | null) => { await db.query(`select set_config('request.uid', $1, false)`, [id ?? '']); };
const call = async (fn: string, ...args: unknown[]) => {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const result = await db.query<{ r: unknown }>(`select public.${fn}(${placeholders}) as r`, args.map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : a)));
  return result.rows[0]?.r as any;
};
const fails = async (promise: Promise<unknown>, message: RegExp | string) => {
  await expect(promise).rejects.toThrow(message);
};
const user = async (email: string) => (await db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [email])).rows[0]!.id;

const FORM = (over: Record<string, unknown> = {}) => ({
  full_name: 'Asha Verma', display_name: 'Asha Codes', email: 'asha@example.com', phone: '+91 98765 43210', dob: '1998-04-02',
  city: 'Pune', state: 'Maharashtra', socials: { instagram: { username: 'ashacodes', url: 'https://instagram.com/ashacodes' } },
  total_followers: 52000, primary_platform: 'Instagram', niche: 'Tech', audience_location: 'India', audience_size: '10k-50k',
  promote_on: ['Instagram', 'YouTube'], agree_accurate: true, agree_terms: true, agree_withdrawal: true, agree_fraud: true, ...over,
});
const PAYOUT = {
  account_holder: 'Asha Verma', account_number: '123456789012', account_number_confirm: '123456789012', ifsc: 'HDFC0001234', bank_name: 'HDFC Bank',
  upi_id: 'asha@okhdfc', pan: 'ABCDE1234F', pan_name: 'ASHA VERMA',
};

/** Records an order that used a code, the way the payment recorder does, then finalises it. */
async function order(userId: string | null, codeId: string, ref: string, amount = 44900, ageDays = 0, currency = 'INR') {
  const pay = await db.query<{ id: number }>(
    `insert into public.payments (user_id, provider, provider_ref, amount_minor, currency, list_amount_minor, promo_code_id, promo_discount_minor, created_at)
     values ($1, 'razorpay', $2, $3, $4, $3, $5, 0, now() - make_interval(days => $6)) returning id`,
    [userId, ref, amount, currency, codeId, ageDays],
  );
  await call('finalize_order', ref);
  if (ageDays > 0) await db.query(`update public.commissions set created_at = now() - make_interval(days => $1) where payment_id = $2`, [ageDays, pay.rows[0]!.id]);
  return pay.rows[0]!.id;
}

beforeAll(async () => {
  db = await makeDb();
  ids.admin = await user('mdnurulhasan1111@gmail.com');
  await db.query(`insert into auth.identities (user_id, provider, identity_data) values ($1, 'google', '{"email":"mdnurulhasan1111@gmail.com","email_verified":true}')`, [ids.admin]);
  ids.asha = await user('asha@example.com');
  ids.ravi = await user('ravi@example.com');
  ids.cust1 = await user('buyer1@example.com');
  ids.cust2 = await user('buyer2@example.com');
}, 120_000);

describe('joining', () => {
  it('rejects a form that is incomplete, underage or missing an agreement', async () => {
    await asUser(ids.asha!);
    await fails(call('influencer_apply', FORM({ agree_fraud: false })), /accept all four/);
    await fails(call('influencer_apply', FORM({ dob: '2015-01-01' })), /at least 18/);
    await fails(call('influencer_apply', FORM({ phone: '123' })), /mobile number/);
    await fails(call('influencer_apply', FORM({ promote_on: [] })), /at least one place/);
    await fails(call('influencer_apply', FORM({ socials: { instagram: { username: 'a', url: 'ftp://x' } } })), /https/);
    expect(await call('influencer_me')).toBeNull();
  });

  it('creates the profile and an automatic code, and a second apply is refused', async () => {
    await asUser(ids.asha!);
    const me = await call('influencer_apply', FORM());
    expect(me.profile.full_name).toBe('Asha Verma');
    expect(me.profile.user_id).toBeUndefined();
    expect(me.codes).toHaveLength(1);
    expect(me.codes[0].code).toMatch(/^ASHACODE\d\d$/);
    expect(me.codes[0].discount_bps).toBe(1000);
    ids.inf = me.profile.id;
    ids.code = me.codes[0].id;
    await fails(call('influencer_apply', FORM()), /already an influencer/);
  });

  it('accepts a chosen code and enforces uniqueness across influencers and offers', async () => {
    await asUser(ids.ravi!);
    await fails(call('influencer_apply', FORM({ email: 'ravi@example.com', promo_code: 'ab' })), /4 to 16/);
    const me = await call('influencer_apply', FORM({ full_name: 'Ravi Kumar', email: 'ravi@example.com', promo_code: ' ravi 10 ' }));
    expect(me.codes[0].code).toBe('RAVI10');
    ids.raviInf = me.profile.id;
    await asUser(ids.asha!);
    await fails(call('influencer_create_code', 'ravi10'), /already taken/);
    await asUser(ids.admin!);
    await fails(call('admin_offer_save', { code: 'RAVI10', discount_percent: 5 }), /already in use/);
    const offer = await call('admin_offer_save', { code: 'diwali5', title: 'Diwali', discount_percent: 5 });
    expect(offer.code).toBe('DIWALI5');
    await asUser(ids.asha!);
    await fails(call('influencer_create_code', 'DIWALI5'), /already taken/);
  });

  it('limits how many codes one influencer can have', async () => {
    await asUser(ids.asha!);
    for (const c of ['ASHAONE', 'ASHATWO', 'ASHATHREE', 'ASHAFOUR']) await call('influencer_create_code', c);
    await fails(call('influencer_create_code', 'ASHAFIVE'), /up to 5/);
    const me = await call('influencer_me');
    expect(me.codes).toHaveLength(5);
    await call('influencer_set_code_active', me.codes[4].id, false);
    expect((await call('influencer_me')).codes[4].active).toBe(false);
  });

  it('saves payout details with validation and shows only a masked copy back', async () => {
    await asUser(ids.asha!);
    await fails(call('influencer_save_payout', { ...PAYOUT, account_number_confirm: '999999999' }), /do not match/);
    await fails(call('influencer_save_payout', { ...PAYOUT, ifsc: 'BAD' }), /IFSC/);
    await fails(call('influencer_save_payout', { ...PAYOUT, pan: 'XYZ' }), /PAN/);
    const me = await call('influencer_save_payout', PAYOUT);
    expect(me.payout.account_last4).toBe('9012');
    expect(JSON.stringify(me)).not.toContain('123456789012');
    expect(JSON.stringify(me)).not.toContain('ABCDE1234F');
    expect(me.payout.verification).toBe('pending');
  });
});

describe('checkout codes', () => {
  it('resolves promo codes and offers, and refuses own, unknown, expired and used-up codes', async () => {
    const promo = await call('checkout_resolve', 'ravi10', ids.cust1);
    expect(promo).toMatchObject({ kind: 'promo', code: 'RAVI10', discount_bps: 1000 });
    expect(await call('checkout_resolve', 'diwali5', ids.cust1)).toMatchObject({ kind: 'offer', discount_bps: 500 });
    expect(await call('checkout_resolve', 'RAVI10', ids.ravi)).toEqual({ error: 'own_code' });
    expect(await call('checkout_resolve', 'NOPE1234', ids.cust1)).toEqual({ error: 'not_found' });
    expect(await call('checkout_resolve', '!!', ids.cust1)).toEqual({ error: 'not_found' });

    await asUser(ids.admin!);
    await call('admin_offer_save', { code: 'OLDONE', discount_percent: 5, ends_at: '2020-01-01T00:00:00Z' });
    await call('admin_offer_save', { code: 'SOONONE', discount_percent: 5, starts_at: '2099-01-01T00:00:00Z' });
    await call('admin_offer_save', { code: 'ONLYONE', discount_percent: 5, max_uses: 1 });
    expect(await call('checkout_resolve', 'OLDONE', ids.cust1)).toEqual({ error: 'expired' });
    expect(await call('checkout_resolve', 'SOONONE', ids.cust1)).toEqual({ error: 'not_started' });
    const only = await call('checkout_resolve', 'ONLYONE', ids.cust1);
    expect(only.kind).toBe('offer');
    await db.query(`insert into public.payments (user_id, provider, provider_ref, amount_minor, currency, offer_id) values ($1,'razorpay','plink_offer1',100,'INR',$2)`, [ids.cust1, only.id]);
    expect(await call('checkout_resolve', 'ONLYONE', ids.cust2)).toEqual({ error: 'used_up' });
  });

  it('refuses a code once the influencer is suspended or the code is paused', async () => {
    await asUser(ids.admin!);
    await call('admin_set_influencer_status', ids.raviInf, 'suspended');
    expect(await call('checkout_resolve', 'RAVI10', ids.cust1)).toEqual({ error: 'inactive' });
    await call('admin_set_influencer_status', ids.raviInf, 'active');
    expect((await call('checkout_resolve', 'RAVI10', ids.cust1)).kind).toBe('promo');
  });
});

describe('commissions', () => {
  it('credits 10% of what the customer paid as pending, once, however often the payment is recorded', async () => {
    const payId = await order(ids.cust1!, ids.code!, 'plink_A1', 40410);
    await call('finalize_order', 'plink_A1');
    const rows = (await db.query(`select * from public.commissions where payment_id = $1`, [payId])).rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ commission_minor: 4041, status: 'pending', rate_bps: 1000, currency: 'INR' });
  });

  it('cancels a self-referral and keeps it off the balance', async () => {
    await order(ids.asha!, ids.code!, 'plink_SELF', 44900);
    const row = (await db.query(`select status, note from public.commissions where order_ref = 'plink_SELF'`)).rows[0] as any;
    expect(row.status).toBe('cancelled');
    expect(row.note).toMatch(/Self-referral/);
  });

  it('does not credit anything for a payment without a code', async () => {
    await db.query(`insert into public.payments (user_id, provider, provider_ref, amount_minor, currency) values ($1,'razorpay','plink_PLAIN',44900,'INR')`, [ids.cust2]);
    expect(await call('finalize_order', 'plink_PLAIN')).toEqual({ commission: false });
  });

  it('keeps pending money out of the available balance until the refund window passes', async () => {
    await asUser(ids.asha!);
    const dash = await call('influencer_dashboard', 30);
    const inr = dash.balances.find((b: any) => b.currency === 'INR');
    expect(inr.available).toBe(0);
    expect(inr.pending).toBe(4041);
    expect(dash.recent[0].order_id).toMatch(/^ORD-/);
    expect(JSON.stringify(dash)).not.toMatch(/buyer1|cust|@example/);
    expect(dash.totals.orders).toBe(1);
  });
});

describe('withdrawals', () => {
  it('explains why a withdrawal is not possible yet', async () => {
    await asUser(ids.asha!);
    expect(await call('influencer_quote_withdrawal', 'INR')).toMatchObject({ ok: false, reason: 'no_balance' });
  });

  it('releases matured commissions, then quotes below the minimum, and with TDS only once the yearly limit is crossed', async () => {
    await order(ids.cust2!, ids.code!, 'plink_B1', 44900, 10);
    await db.query(`update public.commissions set created_at = now() - interval '9 days' where order_ref = 'plink_A1'`);
    await asUser(ids.asha!);
    let q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.available).toBe(4041 + 4490);
    expect(q).toMatchObject({ ok: false, reason: 'below_minimum', minimum: 50000 });

    // 13 more orders: 18 x ~₹45 is well above ₹500 but below the ₹20,000 TDS limit.
    for (let i = 0; i < 12; i += 1) await order(null, ids.code!, `plink_M${i}`, 44900, 12);
    q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.ok).toBe(true);
    expect(q.tds).toBe(0);
    expect(q.net).toBe(q.gross);
    expect(q.destination.account_masked).toBe('••••••••9012');
  });

  it('applies TDS with a catch-up once the financial-year total passes the limit, and counts earlier payouts', async () => {
    await db.query(`delete from public.commissions`);
    await db.query(`delete from public.withdrawals`);
    // 60 orders of ₹449 with 10% commission = ₹44.90 each is too small; use big amounts instead.
    await order(null, ids.code!, 'plink_BIG1', 20_000_000, 10); // commission ₹20,000 exactly = the threshold
    await asUser(ids.asha!);
    let q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.gross).toBe(2_000_000);
    expect(q.tds).toBe(0); // not above the limit yet
    await order(null, ids.code!, 'plink_BIG2', 1_000_000, 10); // +₹1,000
    q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.gross).toBe(2_100_000);
    expect(q.tds).toBe(42_000); // 2% of ₹21,000
    expect(q.net).toBe(2_100_000 - 42_000);
    expect(q.lines[0].key).toBe('tds');

    const req = await call('influencer_request_withdrawal', 'INR');
    expect(req.net_minor).toBe(2_058_000);
    ids.w1 = String(req.id);
    // The same money cannot be withdrawn twice.
    await fails(call('influencer_request_withdrawal', 'INR'), /no_balance/);
    const linked = (await db.query(`select count(*)::int c from public.commissions where withdrawal_id = $1`, [ids.w1])).rows[0] as any;
    expect(linked.c).toBe(2);

    // A later payout only pays the extra tax due on the new money.
    await order(null, ids.code!, 'plink_BIG3', 10_000_000, 10); // +₹10,000
    q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.gross).toBe(1_000_000);
    expect(q.tds).toBe(20_000); // 2% of the new ₹10,000, the earlier ₹420 is already counted
  });

  it('puts the admin in charge: approve, mark paid with a reference, or reject with a reason', async () => {
    await asUser(ids.admin!);
    const list = await call('admin_withdrawals', 'pending');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ influencer: 'Asha Codes', status: 'pending', currency: 'INR' });

    const detail = await call('admin_withdrawal_detail', Number(ids.w1));
    expect(detail.payout.account_number).toBe('123456789012');
    expect(detail.payout.pan).toBe('ABCDE1234F');
    expect(detail.commissions).toHaveLength(2);

    await fails(call('admin_withdrawal_action', Number(ids.w1), 'paid', '', 'UTR1'), /Approve the withdrawal/);
    await call('admin_withdrawal_action', Number(ids.w1), 'approve');
    await fails(call('admin_withdrawal_action', Number(ids.w1), 'paid', '', ''), /transaction reference/);
    await call('admin_withdrawal_action', Number(ids.w1), 'paid', '', 'UTR-778899');
    const row = (await db.query(`select status, payout_reference, paid_at from public.withdrawals where id = $1`, [ids.w1])).rows[0] as any;
    expect(row).toMatchObject({ status: 'paid', payout_reference: 'UTR-778899' });
    expect(row.paid_at).toBeTruthy();
    await fails(call('admin_withdrawal_action', Number(ids.w1), 'reject', 'no'), /can no longer be rejected/);
  });

  it('returns the money when a withdrawal is rejected', async () => {
    await asUser(ids.asha!);
    const req = await call('influencer_request_withdrawal', 'INR');
    await asUser(ids.admin!);
    await fails(call('admin_withdrawal_action', req.id, 'reject', ''), /reason/);
    await call('admin_withdrawal_action', req.id, 'reject', 'Bank details did not match PAN');
    await asUser(ids.asha!);
    const q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.available).toBe(1_000_000);
    const dash = await call('influencer_dashboard', 30);
    expect(dash.withdrawals.find((w: any) => w.status === 'rejected').note).toMatch(/Bank details/);
  });

  it('keeps influencers apart: nobody can see or touch another influencer\'s money', async () => {
    await asUser(ids.ravi!);
    const dash = await call('influencer_dashboard', 30);
    expect(dash.balances).toEqual([]);
    expect(dash.withdrawals).toEqual([]);
    expect(await call('influencer_quote_withdrawal', 'INR')).toMatchObject({ ok: false, reason: 'payout_details_missing' });
    await asUser(null);
    await fails(call('influencer_me'), /not signed in/);
  });
});

describe('ledger, refunds and clawbacks', () => {
  it('reverses a refunded order and nets a paid-out commission off the next withdrawal', async () => {
    await asUser(ids.admin!);
    const ledger = await call('admin_ledger', null, 50, 0);
    const paid = ledger.rows.find((r: any) => r.order_ref === 'plink_BIG1');
    expect(paid.status).toBe('approved');
    expect(paid.customer_email).toBeNull(); // guest-style payment in the test has no user
    await call('admin_ledger_action', paid.id, 'reverse', 'Customer refunded via Razorpay');
    const after = (await db.query(`select status, clawback_open from public.commissions where id = $1`, [paid.id])).rows[0] as any;
    expect(after).toEqual({ status: 'reversed', clawback_open: true });
    expect(((await db.query(`select status from public.payments where provider_ref = 'plink_BIG1'`)).rows[0] as any).status).toBe('refunded');
    await asUser(ids.asha!);
    const q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.available).toBe(1_000_000 - 2_000_000 ); // the ₹20,000 paid earlier is owed back
    expect(q.ok).toBe(false);
  });

  it('cancels, reinstates and refuses nonsense transitions', async () => {
    await asUser(ids.admin!);
    const ledger = await call('admin_ledger', 'approved', 50, 0);
    const target = ledger.rows.find((r: any) => r.order_ref === 'plink_BIG3');
    await fails(call('admin_ledger_action', target.id, 'reinstate'), /Only cancelled/);
    await call('admin_ledger_action', target.id, 'cancel', 'Looks fake');
    await call('admin_ledger_action', target.id, 'reinstate');
    expect(((await db.query(`select status from public.commissions where id = $1`, [target.id])).rows[0] as any).status).toBe('pending');
    await fails(call('admin_ledger_action', target.id, 'explode'), /Unknown action/);
  });
});

describe('leaving the programme', () => {
  it('blocks deletion while money is left, then deletes and scrubs personal data', async () => {
    await asUser(ids.ravi!);
    const s = await call('influencer_delete_summary');
    expect(s.available).toEqual({});
    await call('influencer_delete_account', true);
    await asUser(ids.admin!);
    const list = await call('admin_influencers');
    const ravi = list.find((i: any) => i.full_name === 'Ravi Kumar');
    expect(ravi.status).toBe('deleted');
    expect(ravi.codes[0].active).toBe(false);
    const row = (await db.query(`select phone, email, user_id from public.influencers where id = $1`, [ids.raviInf])).rows[0] as any;
    expect(row).toEqual({ phone: '', email: '', user_id: null });
    expect(await call('checkout_resolve', 'RAVI10', ids.cust1)).toEqual({ error: 'inactive' });
    await asUser(ids.ravi!);
    expect(await call('influencer_me')).toBeNull(); // free to join again later
  });

  it('refuses to delete while there is a balance or an open withdrawal', async () => {
    await order(null, ids.code!, 'plink_LEFT1', 40_000_000, 10);
    await asUser(ids.asha!);
    const s = await call('influencer_delete_summary');
    expect(Object.keys(s.available).length + Object.keys(s.in_review).length + Object.keys(s.pending).length).toBeGreaterThan(0);
    await fails(call('influencer_delete_account', true), /balance_left|withdrawal_in_progress/);
  });
});

describe('admin views, fraud flags and settings', () => {
  it('lists influencers with orders, revenue, commission, balance and status', async () => {
    await asUser(ids.admin!);
    const list = await call('admin_influencers');
    const asha = list.find((i: any) => i.full_name === 'Asha Verma');
    expect(asha.orders).toBeGreaterThan(0);
    expect(asha.codes.length).toBe(5);
    expect(asha.status).toBe('active');
    const detail = await call('admin_influencer_detail', ids.inf);
    expect(detail.payout.pan).toBe('ABCDE1234F');
    expect(detail.ledger.length).toBeGreaterThan(0);
    expect(detail.withdrawals.length).toBeGreaterThan(0);
    const overview = await call('admin_influencer_overview');
    expect(overview.active_influencers).toBe(1);
    expect(overview.pending_withdrawals).toBeGreaterThanOrEqual(0);
  });

  it('flags self-referrals, multiple codes per customer, bursts and refunds', async () => {
    await asUser(ids.admin!);
    await asUser(ids.asha!);
    const code2 = (await call('influencer_me')).codes[1].id;
    await order(ids.asha!, ids.code!, 'plink_SELF2', 44900, 1);
    await order(ids.cust1!, ids.code!, 'plink_X1', 44900, 1);
    await order(ids.cust1!, code2, 'plink_X2', 44900, 1);
    for (let i = 0; i < 4; i += 1) await order(null, ids.code!, `plink_BURST${i}`, 44900, 0);
    await asUser(ids.admin!);
    const flags = await call('admin_fraud_flags');
    const kinds = new Set(flags.map((f: any) => f.kind));
    for (const kind of ['self_referral', 'multiple_codes', 'burst', 'refunds']) expect(kinds.has(kind), kind).toBe(true);
  });

  it('creates, edits, pauses and deletes offers, and rejects bad discounts', async () => {
    await asUser(ids.admin!);
    await fails(call('admin_offer_save', { code: 'BADONE', discount_percent: 95 }), /between 1% and 90%/);
    await fails(call('admin_offer_save', { code: 'BADTWO', discount_percent: 10, starts_at: '2026-02-01T00:00:00Z', ends_at: '2026-01-01T00:00:00Z' }), /end date/);
    const saved = await call('admin_offer_save', { code: 'SPRING10', title: 'Spring', discount_percent: 10, max_uses: 50 });
    await call('admin_offer_save', { id: saved.id, code: 'SPRING10', title: 'Spring sale', discount_percent: 12.5 });
    const offers = await call('admin_discount_offers');
    const row = offers.find((o: any) => o.code === 'SPRING10');
    expect(row).toMatchObject({ title: 'Spring sale', discount_bps: 1250, uses: 0, active: true });
    await call('admin_offer_set_active', saved.id, false);
    expect(await call('checkout_resolve', 'SPRING10', ids.cust1)).toEqual({ error: 'inactive' });
    await call('admin_offer_delete', saved.id);
    const used = offers.find((o: any) => o.code === 'ONLYONE');
    await fails(call('admin_offer_delete', used.id), /has been used/);
  });

  it('stores settings after validating them', async () => {
    await asUser(ids.admin!);
    await fails(call('admin_set_settings', { refund_window_days: -1 }), /Invalid/);
    await fails(call('admin_set_settings', { evil: 1 }), /Unknown setting/);
    const next = await call('admin_set_settings', { payout_fee_minor: { INR: 1000, USD: 0 }, min_withdrawal_minor: { INR: 10000, USD: 1000 } });
    expect(next.payout_fee_minor.INR).toBe(1000);
    await asUser(ids.asha!);
    const q = await call('influencer_quote_withdrawal', 'INR');
    expect(q.fee).toBe(1000);
    expect(q.lines.some((l: any) => l.key === 'payout_fee')).toBe(true);
  });

  it('collects support messages for the admin', async () => {
    await asUser(ids.asha!);
    await fails(call('influencer_send_message', ' ', 'hi'), /subject and a message/);
    await call('influencer_send_message', 'Payout question', 'When will I be paid?');
    await asUser(ids.admin!);
    const inbox = await call('admin_influencer_messages', false);
    expect(inbox[0]).toMatchObject({ subject: 'Payout question', influencer: 'Asha Codes' });
    await call('admin_message_resolve', inbox[0].id, true);
    expect(await call('admin_influencer_messages', false)).toEqual([]);
  });
});

describe('explore offers', () => {
  it('lists only live, listed, not-used-up offers to signed-in customers, never creator codes', async () => {
    await asUser(ids.admin!);
    await call('admin_offer_save', { code: 'PUBLIC10', title: 'Public sale', discount_percent: 10 });
    await call('admin_offer_save', { code: 'HIDDEN15', title: 'Secret', discount_percent: 15, listed: false });
    await call('admin_offer_save', { code: 'PAUSED20', title: 'Paused', discount_percent: 20, active: false });
    await asUser(ids.cust1!);
    const offers = await call('list_public_offers');
    const codes = offers.map((o: any) => o.code);
    expect(codes).toContain('PUBLIC10');
    expect(codes).toContain('DIWALI5');
    for (const hidden of ['HIDDEN15', 'PAUSED20', 'OLDONE', 'SOONONE', 'ONLYONE', 'RAVI10']) expect(codes, hidden).not.toContain(hidden);
    expect(offers.every((o: any) => !('id' in o) && !('note' in o))).toBe(true);
    expect(offers[0].discount_bps).toBeGreaterThanOrEqual(offers[offers.length - 1].discount_bps); // best first
    // The hidden offer still works when typed in.
    expect((await call('checkout_resolve', 'HIDDEN15', ids.cust1)).kind).toBe('offer');
  });

  it('is closed to visitors who are not signed in, and the admin list shows which offers are public', async () => {
    await asUser(null);
    await fails(call('list_public_offers'), /not signed in/);
    await asUser(ids.admin!);
    const rows = await call('admin_discount_offers');
    expect(rows.find((o: any) => o.code === 'HIDDEN15').listed).toBe(false);
    expect(rows.find((o: any) => o.code === 'PUBLIC10').listed).toBe(true);
    const saved = rows.find((o: any) => o.code === 'PUBLIC10');
    await call('admin_offer_save', { id: saved.id, code: 'PUBLIC10', title: 'Public sale', discount_percent: 10, listed: false });
    await asUser(ids.cust1!);
    expect((await call('list_public_offers')).map((o: any) => o.code)).not.toContain('PUBLIC10');
  });
});

describe('saved answers on applications', () => {
  it('keeps hearted answers with the application, defaults to none, and refuses anything that is not a list', async () => {
    await db.query(`insert into public.applications (id, user_id, company, role, status, applied_at, updated_at) values ('a1', $1, 'Razorpay', 'SDE', 'applied', current_date, 1)`, [ids.cust1]);
    expect((await db.query<{ saved_answers: unknown }>(`select saved_answers from public.applications where id = 'a1'`)).rows[0]!.saved_answers).toEqual([]);
    await db.query(`update public.applications set saved_answers = $1::jsonb where id = 'a1'`, [JSON.stringify([{ id: 'q1', question: 'Why us?', answer: 'Because…', savedAt: 1 }])]);
    expect((await db.query<{ saved_answers: Array<{ question: string }> }>(`select saved_answers from public.applications where id = 'a1'`)).rows[0]!.saved_answers[0]!.question).toBe('Why us?');
    await expect(db.query(`update public.applications set saved_answers = '{"a":1}'::jsonb where id = 'a1'`)).rejects.toThrow(/saved_answers_valid/);
  });
});

describe('permissions', () => {
  it('keeps every admin function closed to ordinary signed-in users', async () => {
    await asUser(ids.asha!);
    const calls: Array<[string, unknown[]]> = [
      ['admin_influencers', []], ['admin_influencer_overview', []], ['admin_ledger', [null, 10, 0]], ['admin_withdrawals', [null]],
      ['admin_fraud_flags', []], ['admin_discount_offers', []], ['admin_get_settings', []], ['admin_set_settings', [{}]],
    ];
    for (const [fn, args] of calls) await fails(call(fn, ...args), /not authorized/);
  });

  it('gives the anon and signed-in roles no direct access to any influencer table', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      for (const table of ['influencers', 'influencer_payouts', 'promo_codes', 'discount_offers', 'commissions', 'withdrawals', 'platform_settings', 'influencer_messages']) {
        await expect(db.query(`select * from public.${table} limit 1`), `${role} on ${table}`).rejects.toThrow(/permission denied/);
      }
      await db.exec('reset role');
    }
  });

  it('lets anon call nothing, and signed-in users call only the influencer functions', async () => {
    await db.exec('set role anon');
    await expect(db.query(`select public.influencer_me()`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.checkout_resolve('X', null)`)).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
    await db.exec('set role authenticated');
    await expect(db.query(`select public.checkout_resolve('RAVI10', null)`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.finalize_order('x')`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.sync_commissions()`)).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });
});
