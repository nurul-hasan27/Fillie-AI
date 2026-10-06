/** The few client methods this module uses, so it can be tested without Supabase. */
export interface DbError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export interface AdminClient {
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
  provider: 'stripe' | 'razorpay';
  ref: string;
  amountMinor: number;
  currency: string;
}

/**
 * Records a payment and unlocks the user.
 *
 * Idempotent: the payment row is keyed on the provider's own id and written with
 * ON CONFLICT DO NOTHING, and an already-paid user is left exactly as they are
 * (so `paid_at` keeps the first payment's time). A webhook that Stripe or
 * Razorpay retries cannot double-count revenue or move the unlock date.
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
    },
    { onConflict: 'provider_ref', ignoreDuplicates: true },
  );
  if (payError) return fail('insert payments (on conflict do nothing)', payError);

  const { data: existing, error: readError } = await admin.from('entitlements').select('paid').eq('user_id', payment.userId).maybeSingle();
  if (readError) return fail('select entitlements', readError);
  if (existing?.paid === true) return { ok: true };

  const { error } = await admin.from('entitlements').upsert({
    user_id: payment.userId,
    paid: true,
    paid_at: new Date().toISOString(),
    stripe_session: payment.provider === 'stripe' ? payment.ref : null,
    provider: payment.provider,
  });
  if (error) return fail('upsert entitlements', error);

  console.log(JSON.stringify({ event: 'payment_recorded', provider: payment.provider, ref: payment.ref, user_id: payment.userId }));
  return { ok: true };
}
