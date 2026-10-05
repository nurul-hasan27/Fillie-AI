// Counts free fillings per device. Deploy with: supabase functions deploy trial
// Secrets: TRIAL_SALT (any random string).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, reply } from '../_shared/cors.ts';
import { decideTrial, validIdentifiers, weekStart } from '../_shared/trial.ts';

const LIMIT = Number(Deno.env.get('FREE_FILLS_PER_WEEK') ?? '3');
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function count(key: string, week: string): Promise<number> {
  const { data } = await admin.from('trial_usage').select('count').eq('key', key).eq('week', week).maybeSingle();
  return data?.count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return reply({ error: 'method not allowed' }, 405);

  const body = await req.json().catch(() => ({}));
  if (!validIdentifiers(body)) return reply({ error: 'bad request' }, 400);

  const salt = Deno.env.get('TRIAL_SALT') ?? '';
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  const week = weekStart();
  const keys = { install: `i:${body.install}`, hw: `h:${body.hw}`, ip: `p:${await sha(`${salt}|${ip}`)}` };

  const decision = decideTrial(
    { installCount: await count(keys.install, week), hwCount: await count(keys.hw, week), ipCount: await count(keys.ip, week) },
    LIMIT,
  );

  if (body.action === 'consume' && decision.allowed) {
    await Promise.all(Object.values(keys).map((key) => admin.rpc('increment_trial', { p_key: key, p_week: week })));
    return reply({ ...decision, remaining: decision.remaining - 1 });
  }
  return reply(decision);
});
