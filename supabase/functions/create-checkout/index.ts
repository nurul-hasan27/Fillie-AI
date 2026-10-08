// Starts the one-time checkout (or, with quote:true, only prices it) with Razorpay (a payment link): ₹ for UPI/netbanking/wallets/cards, or $ for international cards.
// Deploy with: supabase functions deploy create-checkout
// Secrets: SUCCESS_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
//          RAZORPAY_AMOUNT_MINOR (USD cents, default 500 = $5), RAZORPAY_INR_AMOUNT_MINOR (paise, default 44900 = ₹449)
import { corsHeaders, reply } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseCodes, pickPrice, priceOrder, type PricedOrder } from '../_shared/pricing.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

interface ResolvedCode { kind: 'promo' | 'offer'; id: string; code: string; discount_bps: number; title: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // The caller must be signed in; the user id comes from the verified token, never from the body.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const userResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
  });
  if (!userResponse.ok) return reply({ error: 'Sign in first.' }, 401);
  const user = (await userResponse.json()) as { id: string; email?: string };

  const body = (await req.json().catch(() => ({}))) as { currency?: string; codes?: unknown; quote?: boolean };
  const price = pickPrice(body.currency, (name) => Deno.env.get(name));

  // Resolve the codes in the database: it knows who owns a code, whether it is live, and who is buying.
  const applied: ResolvedCode[] = [];
  const rejected: Array<{ code: string; reason: string }> = [];
  for (const code of parseCodes(body.codes)) {
    const { data, error } = await admin.rpc('checkout_resolve', { p_code: code, p_user: user.id });
    if (error || !data) {
      console.error(JSON.stringify({ event: 'checkout_resolve_failed', message: error?.message }));
      return reply({ error: 'Could not check that code. Please try again.' }, 502);
    }
    const result = data as ResolvedCode & { error?: string };
    if (result.error) rejected.push({ code, reason: result.error });
    else if (applied.some((a) => a.kind === result.kind)) rejected.push({ code, reason: 'same_kind' });
    else applied.push(result);
  }
  const promo = applied.find((a) => a.kind === 'promo');
  const offer = applied.find((a) => a.kind === 'offer');
  const order = priceOrder(price, promo?.discount_bps ?? 0, offer?.discount_bps ?? 0);

  if (body.quote) return reply({ order, applied: applied.map(({ kind, code, discount_bps, title }) => ({ kind, code, discount_bps, title })), rejected });
  // Never charge a different price than the buyer saw: a code that no longer works stops the payment.
  const refused = rejected.filter((r) => r.reason !== 'same_kind');
  if (refused.length) return reply({ error: 'A code you entered can no longer be used. Remove it and try again.', rejected: refused }, 409);
  return razorpay(user, order, promo, offer);
});

async function razorpay(user: { id: string; email?: string }, order: PricedOrder, promo?: ResolvedCode, offer?: ResolvedCode): Promise<Response> {
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
      amount: order.finalMinor,
      currency: order.currency,
      description: 'Fillie: lifetime access',
      reference_id: `${user.id.slice(0, 8)}-${Date.now()}`,
      customer: user.email ? { email: user.email } : undefined,
      notify: { email: false, sms: false },
      // Our own record of how the price was made up; the payment recorder reads it back from Razorpay.
      notes: {
        user_id: user.id,
        ...(promo ? { promo_id: promo.id } : {}),
        ...(offer ? { offer_id: offer.id } : {}),
        list_minor: String(order.listMinor),
        promo_off: String(order.promoOffMinor),
        offer_off: String(order.offerOffMinor),
      },
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
