import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decideTrial, validIdentifiers, weekStart } from '../../supabase/functions/_shared/trial';
import { verifyStripeSignature } from '../../supabase/functions/_shared/stripe-signature';

describe('trial decision', () => {
  it('uses the busiest identifier, so a new install on the same machine does not reset the count', () => {
    expect(decideTrial({ installCount: 0, hwCount: 3, ipCount: 3 }, 3)).toEqual({ allowed: false, remaining: 0, limit: 3 });
    expect(decideTrial({ installCount: 1, hwCount: 0, ipCount: 1 }, 3).remaining).toBe(2);
  });

  it('blocks a flooded IP even when the device looks new', () => {
    expect(decideTrial({ installCount: 0, hwCount: 0, ipCount: 9 }, 3).allowed).toBe(false);
    expect(decideTrial({ installCount: 0, hwCount: 0, ipCount: 8 }, 3).allowed).toBe(true);
  });

  it('rejects malformed identifiers', () => {
    expect(validIdentifiers({ install: 'a'.repeat(32), hw: 'f'.repeat(64) })).toBe(true);
    expect(validIdentifiers({ install: '<script>', hw: 'zz' })).toBe(false);
    expect(validIdentifiers({})).toBe(false);
  });

  it('starts weeks on Monday UTC', () => {
    expect(weekStart(Date.UTC(2026, 9, 7))).toBe('2026-10-05');
  });
});

describe('Stripe webhook signature', () => {
  const secret = 'whsec_test';
  const payload = '{"type":"checkout.session.completed"}';
  const sign = (t: number, body = payload) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  const now = () => 1_700_000_000_000;

  it('accepts a correct, recent signature', async () => {
    expect(await verifyStripeSignature(payload, sign(1_700_000_000), secret, { now })).toBe(true);
  });

  it('rejects a tampered body, wrong secret, missing header and replayed timestamp', async () => {
    expect(await verifyStripeSignature('{"type":"x"}', sign(1_700_000_000), secret, { now })).toBe(false);
    expect(await verifyStripeSignature(payload, sign(1_700_000_000), 'other', { now })).toBe(false);
    expect(await verifyStripeSignature(payload, null, secret, { now })).toBe(false);
    expect(await verifyStripeSignature(payload, sign(1_699_990_000), secret, { now })).toBe(false);
  });
});

describe('Razorpay webhook signature', () => {
  const secret = 'rzp_whsec';
  const payload = '{"event":"payment_link.paid"}';
  const sign = (body = payload, key = secret) => createHmac('sha256', key).update(body).digest('hex');

  it('accepts the right signature and rejects anything else', async () => {
    const { verifyRazorpaySignature } = await import('../../supabase/functions/_shared/razorpay-signature');
    expect(await verifyRazorpaySignature(payload, sign(), secret)).toBe(true);
    expect(await verifyRazorpaySignature(payload, sign(payload, 'other'), secret)).toBe(false);
    expect(await verifyRazorpaySignature('{"event":"x"}', sign(), secret)).toBe(false);
    expect(await verifyRazorpaySignature(payload, null, secret)).toBe(false);
    expect(await verifyRazorpaySignature(payload, sign(), '')).toBe(false);
  });
});
