-- Fillie cloud schema, part 2: payments, feedback, usage, consent and the admin dashboard.
-- Run after 0001_init.sql.

-- Which resume was used, shown in the Database when the role could not be read.
alter table public.applications add column if not exists resume_name text not null default '';
alter table public.entitlements add column if not exists provider text;

-- Every successful payment (written only by the payment webhooks) --------------------
create table if not exists public.payments (
  id           bigserial primary key,
  user_id      uuid references auth.users(id) on delete set null,
  provider     text not null check (provider in ('stripe','razorpay')),
  provider_ref text not null unique,          -- Stripe session / Razorpay payment id; makes webhooks idempotent
  amount_minor integer not null,              -- cents or paise
  currency     text not null,
  created_at   timestamptz not null default now()
);
alter table public.payments enable row level security;   -- no policies: service role only

-- Reviews and bug reports from inside the extension ---------------------------------
create table if not exists public.feedback (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete set null,
  rating     smallint check (rating between 1 and 5),
  kind       text not null default 'review' check (kind in ('review','bug','idea')),
  message    text not null default '' check (char_length(message) <= 2000),
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
create policy "own feedback: insert" on public.feedback for insert with check (auth.uid() = user_id);
create policy "own feedback: read"   on public.feedback for select using (auth.uid() = user_id);

-- Usage: one row per filling, plus how many answers the user had to correct ---------
create table if not exists public.usage_events (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete set null,
  device     text,                              -- hashed device id for signed-out users
  kind       text not null check (kind in ('fill','quality')),
  filled     integer,                           -- quality: answers Fillie wrote
  edited     integer,                           -- quality: answers the user then changed
  created_at timestamptz not null default now()
);
create index if not exists usage_events_created_idx on public.usage_events (created_at desc);
alter table public.usage_events enable row level security;
create policy "own usage: insert" on public.usage_events for insert with check (auth.uid() = user_id and device is null);

-- Consent to use an offer as an anonymous success story -----------------------------
create table if not exists public.user_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  share_offers boolean not null default false,
  updated_at  timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy "own settings: read"   on public.user_settings for select using (auth.uid() = user_id);
create policy "own settings: insert" on public.user_settings for insert with check (auth.uid() = user_id);
create policy "own settings: update" on public.user_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Admin ---------------------------------------------------------------------------------
-- The admin is whoever signed in with a VERIFIED Google identity for this address.
-- Checking auth.identities (not just the JWT email) means a password account that
-- merely claims the same address cannot pass.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from auth.identities i
    where i.user_id = auth.uid()
      and i.provider = 'google'
      and lower(i.identity_data ->> 'email') = 'mdnurulhasan1111@gmail.com'
      and coalesce((i.identity_data ->> 'email_verified')::boolean, false)
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public._admin_guard() returns void
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
end $$;
revoke all on function public._admin_guard() from public, anon, authenticated;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare result jsonb;
begin
  perform public._admin_guard();
  select jsonb_build_object(
    'users_total',   (select count(*) from auth.users),
    'users_7d',      (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'paid_users',    (select count(*) from public.entitlements where paid),
    'active_7d',     (select count(distinct coalesce(user_id::text, device)) from public.usage_events where kind = 'fill' and created_at > now() - interval '7 days'),
    'active_30d',    (select count(distinct coalesce(user_id::text, device)) from public.usage_events where kind = 'fill' and created_at > now() - interval '30 days'),
    'fills_total',   (select count(*) from public.usage_events where kind = 'fill'),
    'fills_7d',      (select count(*) from public.usage_events where kind = 'fill' and created_at > now() - interval '7 days'),
    'revenue', coalesce((select jsonb_agg(r) from (
        select currency, sum(amount_minor) as total_minor, count(*) as payments,
               coalesce(sum(amount_minor) filter (where created_at > now() - interval '30 days'), 0) as last_30d_minor
        from public.payments group by currency) r), '[]'::jsonb),
    'revenue_by_provider', coalesce((select jsonb_agg(r) from (
        select provider, currency, sum(amount_minor) as total_minor, count(*) as payments
        from public.payments group by provider, currency) r), '[]'::jsonb),
    'applications_total', (select count(*) from public.applications),
    'funnel', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.applications group by status) s), '{}'::jsonb),
    'offers_count',  (select count(*) from public.applications where status = 'offer'),
    'offers_avg_lpa',(select round(avg(offer_lpa), 1) from public.applications where status = 'offer' and offer_lpa is not null),
    'top_companies', coalesce((select jsonb_agg(c) from (
        select company, count(*) as applications,
               count(*) filter (where status = 'offer') as offers
        from public.applications group by company order by count(*) desc limit 8) c), '[]'::jsonb),
    'feedback_total',(select count(*) from public.feedback),
    'avg_rating',    (select round(avg(rating)::numeric, 2) from public.feedback where rating is not null),
    'rating_counts', coalesce((select jsonb_object_agg(rating, n) from (select rating, count(*) n from public.feedback where rating is not null group by rating) s), '{}'::jsonb),
    'answers_filled',(select coalesce(sum(filled), 0) from public.usage_events where kind = 'quality'),
    'answers_edited',(select coalesce(sum(edited), 0) from public.usage_events where kind = 'quality'),
    'signups_daily', coalesce((select jsonb_agg(d order by d.day) from (
        select to_char(g.day, 'YYYY-MM-DD') as day, count(u.id) as count
        from generate_series(current_date - 29, current_date, '1 day') g(day)
        left join auth.users u on u.created_at::date = g.day::date group by g.day) d), '[]'::jsonb),
    'fills_daily', coalesce((select jsonb_agg(d order by d.day) from (
        select to_char(g.day, 'YYYY-MM-DD') as day, count(e.id) as count
        from generate_series(current_date - 29, current_date, '1 day') g(day)
        left join public.usage_events e on e.kind = 'fill' and e.created_at::date = g.day::date group by g.day) d), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

create or replace function public.admin_users(p_limit int default 100, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(u) from (
    select au.id, au.email, au.created_at, au.last_sign_in_at,
           coalesce(e.paid, false) as paid,
           (select count(*) from public.applications a where a.user_id = au.id) as applications,
           (select count(*) from public.applications a where a.user_id = au.id and a.status = 'offer') as offers
    from auth.users au left join public.entitlements e on e.user_id = au.id
    order by au.created_at desc limit least(p_limit, 200) offset p_offset) u), '[]'::jsonb);
end $$;
revoke all on function public.admin_users(int, int) from public, anon;
grant execute on function public.admin_users(int, int) to authenticated;

create or replace function public.admin_feedback(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(f) from (
    select fb.id, fb.rating, fb.kind, fb.message, fb.created_at, au.email
    from public.feedback fb left join auth.users au on au.id = fb.user_id
    order by fb.created_at desc limit least(p_limit, 200)) f), '[]'::jsonb);
end $$;
revoke all on function public.admin_feedback(int) from public, anon;
grant execute on function public.admin_feedback(int) to authenticated;

-- Offers. The student's email is revealed only when they opted in to share it.
create or replace function public.admin_offers() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(o) from (
    select a.company, a.role, a.offer_lpa, a.applied_at,
           coalesce(s.share_offers, false) as shared,
           case when coalesce(s.share_offers, false) then au.email end as email
    from public.applications a
    left join public.user_settings s on s.user_id = a.user_id
    left join auth.users au on au.id = a.user_id
    where a.status = 'offer'
    order by a.applied_at desc limit 200) o), '[]'::jsonb);
end $$;
revoke all on function public.admin_offers() from public, anon;
grant execute on function public.admin_offers() to authenticated;

create or replace function public.admin_payments(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(p) from (
    select pay.id, pay.provider, pay.amount_minor, pay.currency, pay.created_at, au.email
    from public.payments pay left join auth.users au on au.id = pay.user_id
    order by pay.created_at desc limit least(p_limit, 200)) p), '[]'::jsonb);
end $$;
revoke all on function public.admin_payments(int) from public, anon;
grant execute on function public.admin_payments(int) to authenticated;
