/** The few client methods this module uses, so it can be tested without Supabase. */
export interface DbError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export interface AdminClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError | null }>;
  from(table: string): {
    upsert(row: Record<string, unknown>, options?: { onConflict?: string; ignoreDuplicates?: boolean }): PromiseLike<{ error: DbError | null }>;
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: DbError | null }> };
    };
  };
}

export type RecordResult = { ok: true } | { ok: false; step: string; error: DbError };

export interface PaymentInput {
  userId: string;
  provider: 'razorpay';
  ref: string;
  amountMinor: number;
  currency: string;
  /** Set when the buyer used an influencer code and/or an offer; see create-checkout. */
  promoCodeId?: string;
  offerId?: string;
  listAmountMinor?: number;
  promoDiscountMinor?: number;
  offerDiscountMinor?: number;
}

/**
 * Records a payment and unlocks the user.
 *
 * Idempotent: the payment row is keyed on the provider's own id and written with
 * ON CONFLICT DO NOTHING, and an already-paid user is left exactly as they are
 * (so `paid_at` keeps the first payment's time). A webhook that Stripe or
 * Razorpay retries cannot double-count revenue or move the unlock date.
 *
 * When the order used an influencer code, the commission is credited by the database function
 * `finalize_order`, which is also idempotent, so a retry can never pay the influencer twice.
 *
 * Every failure is logged with the exact database operation and Postgres error
 * code. No keys, payloads or customer details are logged.
 */
export async function recordPayment(admin: AdminClient, payment: PaymentInput): Promise<RecordResult> {
  const fail = (step: string, error: DbError): RecordResult => {
    console.error(
      JSON.stringify({
        event: 'payment_record_failed',
        step,
        provider: payment.provider,
        ref: payment.ref,
        user_id: payment.userId,
        code: error.code,
        message: error.message,
        details: error.details ?? undefined,
        hint: error.hint ?? undefined,
      }),
    );
    return { ok: false, step, error };
  };

  const { error: payError } = await admin.from('payments').upsert(
    {
      user_id: payment.userId,
      provider: payment.provider,
      provider_ref: payment.ref,
      amount_minor: payment.amountMinor,
      currency: payment.currency.toUpperCase(),
      ...(payment.promoCodeId ? { promo_code_id: payment.promoCodeId } : {}),
      ...(payment.offerId ? { offer_id: payment.offerId } : {}),
      ...(payment.listAmountMinor !== undefined ? { list_amount_minor: payment.listAmountMinor } : {}),
      promo_discount_minor: payment.promoDiscountMinor ?? 0,
      offer_discount_minor: payment.offerDiscountMinor ?? 0,
    },
    { onConflict: 'provider_ref', ignoreDuplicates: true },
  );
  if (payError) return fail('insert payments (on conflict do nothing)', payError);

  const { data: existing, error: readError } = await admin.from('entitlements').select('paid').eq('user_id', payment.userId).maybeSingle();
  if (readError) return fail('select entitlements', readError);
  if (existing?.paid !== true) {
    const { error } = await admin.from('entitlements').upsert({
      user_id: payment.userId,
      paid: true,
      paid_at: new Date().toISOString(),
      provider: payment.provider,
    });
    if (error) return fail('upsert entitlements', error);
    console.log(JSON.stringify({ event: 'payment_recorded', provider: payment.provider, ref: payment.ref, user_id: payment.userId }));
  }

  // The customer is unlocked either way; a failure here makes the caller retry, which is safe.
  if (payment.promoCodeId) {
    const { error } = await admin.rpc('finalize_order', { p_ref: payment.ref });
    if (error) return fail('finalize_order (influencer commission)', error);
  }
  return { ok: true };
}
