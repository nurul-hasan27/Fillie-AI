import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordPayment, type AdminClient, type DbError } from '../../supabase/functions/_shared/payments';

/** An in-memory stand-in that enforces the same rules as the real tables. */
function fakeDb(options: { denyTable?: string; deniedOp?: string } = {}) {
  const payments = new Map<string, Record<string, unknown>>();
  const entitlements = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const denied = (table: string, op: string): DbError | null =>
    options.denyTable === table && (!options.deniedOp || options.deniedOp === op)
      ? { code: '42501', message: `permission denied for table ${table}` }
      : null;

  const client: AdminClient = {
    from(table) {
      return {
        async upsert(row, opts) {
          calls.push(`upsert ${table}`);
          const error = denied(table, 'insert');
          if (error) return { error };
          if (table === 'payments') {
            const key = String(row.provider_ref);
            if (!payments.has(key) || !opts?.ignoreDuplicates) payments.set(key, row);
          } else {
            entitlements.set(String(row.user_id), row);
          }
          return { error: null };
        },
        select() {
          return {
            eq: (_column, value) => ({
              async maybeSingle() {
                calls.push(`select ${table}`);
                const error = denied(table, 'select');
                return error ? { data: null, error } : { data: entitlements.get(value) ?? null, error: null };
              },
            }),
          };
        },
      };
    },
  };
  return { client, payments, entitlements, calls };
}

const payment = { userId: 'user-1', provider: 'stripe' as const, ref: 'cs_test_1', amountMinor: 500, currency: 'usd' };

afterEach(() => vi.restoreAllMocks());

describe('recordPayment', () => {
  it('records the payment and unlocks the right user', async () => {
    const db = fakeDb();
    expect(await recordPayment(db.client, payment)).toEqual({ ok: true });
    expect(db.payments.get('cs_test_1')).toMatchObject({ user_id: 'user-1', amount_minor: 500, currency: 'USD', provider: 'stripe' });
    expect(db.entitlements.get('user-1')).toMatchObject({ paid: true, provider: 'stripe', stripe_session: 'cs_test_1' });
    expect(db.entitlements.size).toBe(1);
  });

  it('is idempotent: a retried webhook adds no payment row and keeps the first unlock time', async () => {
    const db = fakeDb();
    await recordPayment(db.client, payment);
    const first = db.entitlements.get('user-1')?.paid_at;
    await new Promise((r) => setTimeout(r, 5));
    expect(await recordPayment(db.client, payment)).toEqual({ ok: true });
    expect(db.payments.size).toBe(1);
    expect(db.entitlements.get('user-1')?.paid_at).toBe(first);
  });

  it('does not write the unlock for Razorpay with a Stripe session id', async () => {
    const db = fakeDb();
    await recordPayment(db.client, { ...payment, provider: 'razorpay', ref: 'pay_1', currency: 'inr', amountMinor: 42000 });
    expect(db.entitlements.get('user-1')).toMatchObject({ provider: 'razorpay', stripe_session: null });
  });

  it('names the exact operation and Postgres code when the table grant is missing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = fakeDb({ denyTable: 'payments' });
    const result = await recordPayment(db.client, payment);
    expect(result).toMatchObject({ ok: false, step: 'insert payments (on conflict do nothing)', error: { code: '42501' } });
    // Nothing is unlocked when the payment could not be recorded.
    expect(db.entitlements.size).toBe(0);
    const entry = JSON.parse(String(log.mock.calls[0][0]));
    expect(entry).toMatchObject({ event: 'payment_record_failed', step: 'insert payments (on conflict do nothing)', code: '42501', ref: 'cs_test_1' });
  });

  it('reports a failure to unlock separately from a failure to record', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = fakeDb({ denyTable: 'entitlements', deniedOp: 'insert' });
    const result = await recordPayment(db.client, payment);
    expect(result).toMatchObject({ ok: false, step: 'upsert entitlements' });
    // The payment itself was kept, so a retry only has to finish the unlock.
    expect(db.payments.size).toBe(1);
  });

  it('never logs secrets or the payload', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await recordPayment(fakeDb({ denyTable: 'payments' }).client, payment);
    expect(String(log.mock.calls[0][0])).not.toMatch(/sk_|whsec|service_role|Bearer/i);
  });
});
