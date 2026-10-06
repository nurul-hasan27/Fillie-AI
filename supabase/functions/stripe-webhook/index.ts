// Marks a user as paid when Stripe confirms the payment.
// Deploy with: supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets: STRIPE_WEBHOOK_SECRET
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyStripeSignature } from '../_shared/stripe-signature.ts';
import { recordPayment } from '../_shared/payments.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  const payload = await req.text();
  const valid = await verifyStripeSignature(payload, req.headers.get('Stripe-Signature'), Deno.env.get('STRIPE_WEBHOOK_SECRET')!);
  if (!valid) return new Response('invalid signature', { status: 400 });

  const event = JSON.parse(payload) as {
    type: string;
    data: { object: { id: string; payment_status?: string; client_reference_id?: string; amount_total?: number; currency?: string } };
  };

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    if (session.payment_status === 'paid' && session.client_reference_id) {
      const result = await recordPayment(admin, {
        userId: session.client_reference_id,
        provider: 'stripe',
        ref: session.id,
        amountMinor: session.amount_total ?? 500,
        currency: session.currency ?? 'usd',
      });
      // A failure returns 500 so Stripe retries instead of dropping a paid user.
      if (!result.ok) return new Response('could not record payment', { status: 500 });
    }
  }
  return new Response('ok');
});
