import { describe, expect, it } from 'vitest';
import { pickPrice } from '../../supabase/functions/_shared/pricing';

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
