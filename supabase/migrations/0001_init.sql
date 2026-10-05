-- Fillie cloud schema. Run once in the Supabase SQL editor (or `supabase db push`).
-- Every user table is protected by row-level security: a signed-in user can only
-- ever see and change their own rows.

-- Applications tracker ---------------------------------------------------------
create table if not exists public.applications (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  company       text not null,
  role          text not null,
  status        text not null check (status in ('applied','interview','offer','rejected')),
  interview_at  text,                       -- ISO local date-time, kept as typed
  offer_lpa     numeric(7,2),
  applied_at    date not null,
  notes         text[] not null default '{}',
  rating        smallint check (rating between 1 and 5),
  rating_source text check (rating_source in ('ai','user')),
  url           text not null default '',
  host          text not null default '',
  updated_at    bigint not null,
  created_at    timestamptz not null default now()
);

-- Matches the Database view's ordering, so each 100-row page is an index scan.
create index if not exists applications_user_applied_idx
  on public.applications (user_id, applied_at desc, id desc);

alter table public.applications enable row level security;

create policy "own applications: read"   on public.applications for select using (auth.uid() = user_id);
create policy "own applications: insert" on public.applications for insert with check (auth.uid() = user_id);
create policy "own applications: update" on public.applications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own applications: delete" on public.applications for delete using (auth.uid() = user_id);

-- Backup of the user's Fillie data (profile, memory, resumes; never API keys) ----
create table if not exists public.backups (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.backups enable row level security;

create policy "own backup: read"   on public.backups for select using (auth.uid() = user_id);
create policy "own backup: insert" on public.backups for insert with check (auth.uid() = user_id);
create policy "own backup: update" on public.backups for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own backup: delete" on public.backups for delete using (auth.uid() = user_id);

-- Paid licences. Users may READ their row; only the Stripe webhook (service role,
-- which bypasses RLS) can write it, so a user can never grant themselves access.
create table if not exists public.entitlements (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  paid           boolean not null default false,
  paid_at        timestamptz,
  stripe_session text
);

alter table public.entitlements enable row level security;

create policy "own entitlement: read" on public.entitlements for select using (auth.uid() = user_id);

-- Free-trial counter ---------------------------------------------------------------
-- Keys are hashes (install id, hardware hash, IP hash). No policies are defined,
-- so only the `trial` function (service role) can read or write it.
create table if not exists public.trial_usage (
  key   text not null,
  week  date not null,
  count integer not null default 0,
  primary key (key, week)
);

alter table public.trial_usage enable row level security;

create or replace function public.increment_trial(p_key text, p_week date)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.trial_usage (key, week, count) values (p_key, p_week, 1)
  on conflict (key, week) do update set count = public.trial_usage.count + 1
  returning count;
$$;

revoke all on function public.increment_trial(text, date) from public, anon, authenticated;

-- Old weeks are useless; keep the table small.
create or replace function public.prune_trial_usage() returns void
language sql security definer set search_path = public as $$
  delete from public.trial_usage where week < current_date - 35;
$$;
revoke all on function public.prune_trial_usage() from public, anon, authenticated;
