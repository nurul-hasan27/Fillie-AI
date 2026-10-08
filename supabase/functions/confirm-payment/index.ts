// "I have paid": asks Razorpay whether this signed-in user has a paid payment link,
// and unlocks them if so. Works even if the webhook never reaches us.
// Deploy with: supabase functions deploy confirm-payment
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, reply } from '../_shared/cors.ts';
import { listPaidLinksFor } from '../_shared/razorpay-api.ts';
import { recordPayment } from '../_shared/payments.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // The user comes from the verified token, never from the request body.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const userResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
  });
  if (!userResponse.ok) return reply({ error: 'Sign in first.' }, 401);
  const user = (await userResponse.json()) as { id: string };

  const keyId = Deno.env.get('RAZORPAY_KEY_ID');
  const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) return reply({ confirmed: 0, note: 'Razorpay is not set up.' });

  const paid = await listPaidLinksFor(fetch, keyId, keySecret, user.id);
  let confirmed = 0;
  for (const link of paid) {
    const result = await recordPayment(admin, { ...link, provider: 'razorpay' });
    if (result.ok) confirmed += 1;
  }
  console.log(JSON.stringify({ event: 'confirm_payment', user_id: user.id, paid_links: paid.length, confirmed }));
  return reply({ confirmed });
});
