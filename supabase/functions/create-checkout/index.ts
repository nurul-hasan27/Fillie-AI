// Starts a Stripe Checkout for the $5 one-time payment.
// Deploy with: supabase functions deploy create-checkout
// Secrets: STRIPE_SECRET_KEY, SUCCESS_URL, CANCEL_URL
import { corsHeaders, reply } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // The caller must be signed in; the user id comes from the verified token, never from the body.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const userResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
  });
  if (!userResponse.ok) return reply({ error: 'Sign in first.' }, 401);
  const user = (await userResponse.json()) as { id: string; email?: string };

  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': '500',
    'line_items[0][price_data][product_data][name]': 'Fillie: lifetime access',
    client_reference_id: user.id,
    success_url: Deno.env.get('SUCCESS_URL')!,
    cancel_url: Deno.env.get('CANCEL_URL')!,
  });
  if (user.email) form.set('customer_email', user.email);

  const stripe = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const session = await stripe.json();
  if (!stripe.ok || !session.url) return reply({ error: 'Could not start checkout.' }, 502);
  return reply({ url: session.url });
});
