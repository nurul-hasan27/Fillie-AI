// Marks a user as paid when Razorpay confirms the payment link was paid.
// Deploy with: supabase functions deploy razorpay-webhook --no-verify-jwt
// Secrets: RAZORPAY_WEBHOOK_SECRET
// In Razorpay: Settings > Webhooks > add this function's URL, event "payment_link.paid".
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyRazorpaySignature } from '../_shared/razorpay-signature.ts';
import { recordPayment } from '../_shared/payments.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  const payload = await req.text();
  const valid = await verifyRazorpaySignature(payload, req.headers.get('X-Razorpay-Signature'), Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '');
  if (!valid) return new Response('invalid signature', { status: 400 });

  const event = JSON.parse(payload) as {
    event: string;
    payload?: {
      payment_link?: { entity?: { status?: string; notes?: { user_id?: string } } };
      payment?: { entity?: { id: string; amount: number; currency: string; status?: string } };
    };
  };

  if (event.event === 'payment_link.paid') {
    const link = event.payload?.payment_link?.entity;
    const payment = event.payload?.payment?.entity;
    const userId = link?.notes?.user_id;
    if (link?.status === 'paid' && payment && userId) {
      const result = await recordPayment(admin, { userId, provider: 'razorpay', ref: payment.id, amountMinor: payment.amount, currency: payment.currency });
      // 500 makes Razorpay retry rather than drop a paid user.
      if (!result.ok) return new Response('could not record payment', { status: 500 });
    }
  }
  return new Response('ok');
});
