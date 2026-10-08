import { describe, expect, it } from 'vitest';
import { parseCodes, pickPrice, priceOrder } from '../../supabase/functions/_shared/pricing';

const env = (values: Record<string, string>) => (name: string) => values[name];

describe('checkout prices', () => {
  it('defaults to $5 and charges ₹449 only when ₹ is asked for', () => {
    expect(pickPrice(undefined, env({}))).toEqual({ currency: 'USD', amountMinor: 500 });
    expect(pickPrice('INR', env({}))).toEqual({ currency: 'INR', amountMinor: 44900 });
  });

  it('takes both amounts from the server settings', () => {
    const e = env({ RAZORPAY_AMOUNT_MINOR: '700', RAZORPAY_INR_AMOUNT_MINOR: '59900' });
    expect(pickPrice('USD', e).amountMinor).toBe(700);
    expect(pickPrice('INR', e).amountMinor).toBe(59900);
  });

  it('never lets a caller choose the price or an odd currency', () => {
    for (const requested of ['EUR', 'inr', '0', 1, null, { amount: 1 }, 'INR; amount=1']) {
      expect(pickPrice(requested, env({}))).toEqual({ currency: 'USD', amountMinor: 500 });
    }
  });

  it('ignores a broken setting instead of charging nothing', () => {
    expect(pickPrice('INR', env({ RAZORPAY_INR_AMOUNT_MINOR: '0' })).amountMinor).toBe(44900);
    expect(pickPrice('INR', env({ RAZORPAY_INR_AMOUNT_MINOR: 'abc' })).amountMinor).toBe(44900);
    expect(pickPrice('USD', env({ RAZORPAY_AMOUNT_MINOR: '-5' })).amountMinor).toBe(500);
  });
});

describe('discounts', () => {
  const inr = { currency: 'INR' as const, amountMinor: 44900 };

  it('leaves the price alone without codes', () => {
    expect(priceOrder(inr, 0, 0)).toEqual({ currency: 'INR', listMinor: 44900, promoOffMinor: 0, offerOffMinor: 0, finalMinor: 44900 });
  });

  it('takes the influencer 10% off the list price', () => {
    expect(priceOrder(inr, 1000, 0)).toMatchObject({ promoOffMinor: 4490, offerOffMinor: 0, finalMinor: 40410 });
  });

  it('stacks an offer on top of the promo: the offer is a percentage of what is left', () => {
    const order = priceOrder(inr, 1000, 2000);
    expect(order.promoOffMinor).toBe(4490);
    expect(order.offerOffMinor).toBe(8082); // 20% of 40410
    expect(order.finalMinor).toBe(32328);
    expect(order.listMinor - order.promoOffMinor - order.offerOffMinor).toBe(order.finalMinor);
  });

  it('applies an offer by itself', () => {
    expect(priceOrder({ currency: 'USD', amountMinor: 500 }, 0, 1500)).toMatchObject({ offerOffMinor: 75, finalMinor: 425 });
  });

  it('never goes below the smallest charge Razorpay accepts', () => {
    const order = priceOrder({ currency: 'USD', amountMinor: 500 }, 9000, 9000);
    expect(order.finalMinor).toBe(100);
    expect(order.listMinor - order.promoOffMinor - order.offerOffMinor).toBe(100);
  });

  it('accepts at most three well-formed codes and ignores the rest', () => {
    expect(parseCodes([' ravi 10 ', 'diwali5', 'third123', 'fourth12'])).toEqual(['RAVI10', 'DIWALI5', 'THIRD123']);
    expect(parseCodes(['ab', 'x'.repeat(20), 7, null, 'ok-no', 'RAVI10', 'ravi10'])).toEqual(['RAVI10']);
    expect(parseCodes('RAVI10')).toEqual([]);
    expect(parseCodes(undefined)).toEqual([]);
  });
});
