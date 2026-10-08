// Marks a user as paid when Razorpay confirms a payment link was paid.
// Deploy with: supabase functions deploy razorpay-webhook --no-verify-jwt
// Secrets: RAZORPAY_WEBHOOK_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
// In Razorpay: Settings > Webhooks > add this function's URL, event "payment_link.paid", and a Secret.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyRazorpaySignature } from '../_shared/razorpay-signature.ts';
import { fetchPaidLink, toPaidLink } from '../_shared/razorpay-api.ts';
import { recordPayment } from '../_shared/payments.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

interface WebhookEvent {
  event: string;
  payload?: { payment_link?: { entity?: { id?: string } & Record<string, unknown> } };
}

Deno.serve(async (req) => {
  const payload = await req.text();
  const signature = req.headers.get('X-Razorpay-Signature');
  const signed = await verifyRazorpaySignature(payload, signature, Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '');

  let event: WebhookEvent;
  try {
    event = JSON.parse(payload) as WebhookEvent;
  } catch {
    return new Response('bad request', { status: 400 });
  }
  console.log(JSON.stringify({ event: 'razorpay_webhook_received', type: event.event, signed }));
  if (event.event !== 'payment_link.paid') return new Response('ignored');

  const link = event.payload?.payment_link?.entity;
  let paid;
  if (signed) {
    // A correctly signed event comes from Razorpay, so its content can be used directly.
    paid = toPaidLink(link as Parameters<typeof toPaidLink>[0]);
  } else {
    // No valid signature (commonly: the webhook was saved in Razorpay without a Secret).
    // The payload is NOT trusted. We only take the link id from it and ask Razorpay
    // directly, with our own API key, whether that link was really paid.
    console.error(JSON.stringify({ event: 'razorpay_webhook_unsigned', has_signature: Boolean(signature), has_secret: Boolean(Deno.env.get('RAZORPAY_WEBHOOK_SECRET')), hint: 'Set the Secret in Razorpay > Settings > Webhooks to match RAZORPAY_WEBHOOK_SECRET' }));
    const keyId = Deno.env.get('RAZORPAY_KEY_ID') ?? '';
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';
    paid = keyId && keySecret && link?.id ? await fetchPaidLink(fetch, keyId, keySecret, link.id) : null;
    if (!paid) return new Response('invalid signature', { status: 400 });
  }

  if (!paid) {
    console.error(JSON.stringify({ event: 'razorpay_webhook_unusable', reason: 'link not paid or no user_id in notes' }));
    return new Response('ignored');
  }

  const result = await recordPayment(admin, { userId: paid.userId, provider: 'razorpay', ...paid });
  // 500 makes Razorpay retry rather than drop a paid user.
  if (!result.ok) return new Response('could not record payment', { status: 500 });
  return new Response('ok');
});
