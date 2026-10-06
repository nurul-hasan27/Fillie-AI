// Starts the one-time checkout with Razorpay (a payment link): ₹ for UPI/netbanking/wallets/cards, or $ for international cards.
// Deploy with: supabase functions deploy create-checkout
// Secrets: SUCCESS_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
//          RAZORPAY_AMOUNT_MINOR (USD cents, default 500 = $5), RAZORPAY_INR_AMOUNT_MINOR (paise, default 44900 = ₹449)
import { corsHeaders, reply } from '../_shared/cors.ts';
import { pickPrice, type Price } from '../_shared/pricing.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // The caller must be signed in; the user id comes from the verified token, never from the body.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const userResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
  });
  if (!userResponse.ok) return reply({ error: 'Sign in first.' }, 401);
  const user = (await userResponse.json()) as { id: string; email?: string };

  const body = (await req.json().catch(() => ({}))) as { currency?: string };
  return razorpay(user, pickPrice(body.currency, (name) => Deno.env.get(name)));
});

async function razorpay(user: { id: string; email?: string }, price: Price): Promise<Response> {
  const keyId = Deno.env.get('RAZORPAY_KEY_ID');
  const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    console.error(JSON.stringify({ event: 'checkout_failed', provider: 'razorpay', message: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET secret missing' }));
    return reply({ error: 'Razorpay is not set up.' }, 501);
  }

  const response = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: price.amountMinor,
      currency: price.currency,
      description: 'Fillie: lifetime access',
      reference_id: `${user.id.slice(0, 8)}-${Date.now()}`,
      customer: user.email ? { email: user.email } : undefined,
      notify: { email: false, sms: false },
      notes: { user_id: user.id },
      callback_url: Deno.env.get('SUCCESS_URL')!,
      callback_method: 'get',
    }),
  });
  const link = await response.json().catch(() => ({}));
  if (!response.ok || !link.short_url) {
    // Razorpay's own description (e.g. "Authentication failed", "callback_url invalid") is safe to show and is the fastest diagnosis.
    console.error(JSON.stringify({ event: 'checkout_failed', provider: 'razorpay', status: response.status, code: link?.error?.code, field: link?.error?.field, message: link?.error?.description }));
    return reply({ error: `Razorpay: ${link?.error?.description ?? `could not start checkout (HTTP ${response.status}).`}` }, 502);
  }
  return reply({ url: link.short_url });
}
