import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Records a payment and unlocks the user. Both steps are idempotent: the payment
 * row is keyed on the provider's own id, so a webhook that Stripe or Razorpay
 * retries cannot double-count revenue.
 */
export async function recordPayment(
  admin: SupabaseClient,
  payment: { userId: string; provider: 'stripe' | 'razorpay'; ref: string; amountMinor: number; currency: string },
): Promise<boolean> {
  const { error: payError } = await admin.from('payments').upsert(
    {
      user_id: payment.userId,
      provider: payment.provider,
      provider_ref: payment.ref,
      amount_minor: payment.amountMinor,
      currency: payment.currency.toUpperCase(),
    },
    { onConflict: 'provider_ref', ignoreDuplicates: true },
  );
  if (payError) return false;

  const { error } = await admin.from('entitlements').upsert({
    user_id: payment.userId,
    paid: true,
    paid_at: new Date().toISOString(),
    stripe_session: payment.provider === 'stripe' ? payment.ref : null,
    provider: payment.provider,
  });
  return !error;
}
