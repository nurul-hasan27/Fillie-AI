-- Fillie cloud schema, part 5: influencer programme (schema, settings, checkout helpers).
-- Additive only: nothing here changes or removes existing data.
--
-- How the money flows
--   promo code (influencer)  -> customer gets discount_bps off the list price
--   offer code (admin)       -> customer gets a further discount_bps off the price after the promo
--   commission               -> rate_bps of what the customer actually paid, credited when the payment is recorded
--   pending  -> approved     -> automatically once the refund window has passed (see sync_commissions)
--   withdrawal               -> influencer asks for their whole available balance; admin approves and pays
--
-- Access model: every table below is reachable only through SECURITY DEFINER functions
-- (influencer_* for the signed-in influencer, admin_* for the admin, checkout_* / finalize_order for
-- the Edge Functions). No table grants are given to anon or authenticated, so a leaked anon key
-- cannot read or change anything directly.

-- Platform settings (one row per key, edited from the admin page) ---------------------------
create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;

insert into public.platform_settings (key, value) values
  ('refund_window_days',            '7'::jsonb),
  ('default_customer_discount_bps', '1000'::jsonb),
  ('default_commission_bps',        '1000'::jsonb),
  ('max_codes_per_influencer',      '5'::jsonb),
  ('min_withdrawal_minor',          '{"INR":50000,"USD":1000}'::jsonb),
  -- Income-tax TDS on commission (India, section 194H). Confirm the rate and threshold with your accountant.
  ('tds_bps',                       '200'::jsonb),
  ('tds_no_pan_bps',                '2000'::jsonb),
  ('tds_threshold_minor',           '{"INR":2000000}'::jsonb),
  -- Flat fee per payout (for example a bank transfer fee) and a share of the gateway fee, both off by default.
  ('payout_fee_minor',              '{"INR":0,"USD":0}'::jsonb)
on conflict (key) do nothing;

create or replace function public._setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from public.platform_settings where key = p_key;
$$;
revoke all on function public._setting(text) from public, anon, authenticated;

-- Influencers -------------------------------------------------------------------------------
create table if not exists public.influencers (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid unique references auth.users(id) on delete set null,
  status            text not null default 'active' check (status in ('active','suspended','deleted')),
  full_name         text not null check (char_length(full_name) between 2 and 120),
  display_name      text not null default '' check (char_length(display_name) <= 80),
  email             text not null default '',
  phone             text not null default '',
  dob               date,
  photo_path        text,
  city              text not null default '',
  state             text not null default '',
  socials           jsonb not null default '{}'::jsonb,
  total_followers   integer not null default 0 check (total_followers >= 0),
  primary_platform  text not null default '',
  niche             text not null default '',
  niche_other       text not null default '',
  audience_location text not null default '',
  audience_size     text not null default '',
  description       text not null default '' check (char_length(description) <= 1000),
  monthly_reach     text not null default '',
  collab_type       text not null default '',
  promote_on        text[] not null default '{}',
  commission_bps    integer not null default 1000 check (commission_bps between 0 and 5000),
  agreed_at         timestamptz not null default now(),
  terms_version     text not null default '2026-10',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index if not exists influencers_status_idx on public.influencers (status, created_at desc);
alter table public.influencers enable row level security;

-- Payout details: kept apart from the profile so they are never returned by accident.
create table if not exists public.influencer_payouts (
  influencer_id  uuid primary key references public.influencers(id) on delete cascade,
  account_holder text not null default '',
  account_number text not null default '',
  ifsc           text not null default '',
  bank_name      text not null default '',
  upi_id         text not null default '',
  pan            text not null default '',
  pan_name       text not null default '',
  gstin          text not null default '',
  proof_path     text,
  verification   text not null default 'pending' check (verification in ('pending','verified','rejected')),
  updated_at     timestamptz not null default now()
);
alter table public.influencer_payouts enable row level security;

-- Codes ---------------------------------------------------------------------------------------
create table if not exists public.promo_codes (
  id             uuid primary key default gen_random_uuid(),
  influencer_id  uuid not null references public.influencers(id) on delete restrict,
  code           text not null check (code ~ '^[A-Z0-9]{4,16}$'),
  discount_bps   integer not null default 1000 check (discount_bps between 1 and 9000),
  commission_bps integer not null default 1000 check (commission_bps between 0 and 5000),
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create unique index if not exists promo_codes_code_key on public.promo_codes (code);
create index if not exists promo_codes_influencer_idx on public.promo_codes (influencer_id);
alter table public.promo_codes enable row level security;

create table if not exists public.discount_offers (
  id           uuid primary key default gen_random_uuid(),
  code         text not null check (code ~ '^[A-Z0-9]{4,16}$'),
  title        text not null default '' check (char_length(title) <= 80),
  discount_bps integer not null check (discount_bps between 1 and 9000),
  starts_at    timestamptz,
  ends_at      timestamptz,
  max_uses     integer check (max_uses is null or max_uses > 0),
  active       boolean not null default true,
  note         text not null default '' check (char_length(note) <= 500),
  created_at   timestamptz not null default now()
);
create unique index if not exists discount_offers_code_key on public.discount_offers (code);
alter table public.discount_offers enable row level security;

-- A code is either an influencer promo code or an offer, never both, so one box at checkout can take either.
create or replace function public._code_unique_across() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'promo_codes' and exists (select 1 from public.discount_offers where code = new.code) then
    raise exception 'code_taken' using errcode = '23505';
  elsif tg_table_name = 'discount_offers' and exists (select 1 from public.promo_codes where code = new.code) then
    raise exception 'code_taken' using errcode = '23505';
  end if;
  return new;
end $$;
drop trigger if exists promo_codes_unique_across on public.promo_codes;
create trigger promo_codes_unique_across before insert or update of code on public.promo_codes for each row execute function public._code_unique_across();
drop trigger if exists discount_offers_unique_across on public.discount_offers;
create trigger discount_offers_unique_across before insert or update of code on public.discount_offers for each row execute function public._code_unique_across();

-- Payments remember how the price was made up -----------------------------------------------
alter table public.payments
  add column if not exists status               text not null default 'paid' check (status in ('paid','refunded')),
  add column if not exists list_amount_minor    integer,
  add column if not exists promo_code_id        uuid references public.promo_codes(id),
  add column if not exists promo_discount_minor integer not null default 0,
  add column if not exists offer_id             uuid references public.discount_offers(id),
  add column if not exists offer_discount_minor integer not null default 0,
  add column if not exists refunded_at          timestamptz;
create index if not exists payments_promo_idx on public.payments (promo_code_id) where promo_code_id is not null;
create index if not exists payments_offer_idx on public.payments (offer_id) where offer_id is not null;
create index if not exists payments_user_idx  on public.payments (user_id);

-- Withdrawals -----------------------------------------------------------------------------------
create table if not exists public.withdrawals (
  id                bigserial primary key,
  influencer_id     uuid not null references public.influencers(id) on delete restrict,
  currency          text not null,
  gross_minor       integer not null check (gross_minor > 0),
  tds_minor         integer not null default 0 check (tds_minor >= 0),
  fee_minor         integer not null default 0 check (fee_minor >= 0),
  net_minor         integer not null check (net_minor >= 0),
  breakdown         jsonb not null default '{}'::jsonb,
  method            text not null check (method in ('bank','upi')),
  payout_snapshot   jsonb not null default '{}'::jsonb,
  status            text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
  payout_reference  text not null default '',
  admin_note        text not null default '',
  requested_at      timestamptz not null default now(),
  reviewed_at       timestamptz,
  paid_at           timestamptz
);
create index if not exists withdrawals_influencer_idx on public.withdrawals (influencer_id, requested_at desc);
create index if not exists withdrawals_status_idx on public.withdrawals (status, requested_at desc);
alter table public.withdrawals enable row level security;

-- The commission ledger: one row per order that used an influencer code ----------------------
create table if not exists public.commissions (
  id                  bigserial primary key,
  payment_id          bigint not null unique references public.payments(id) on delete restrict,
  influencer_id       uuid not null references public.influencers(id) on delete restrict,
  promo_code_id       uuid not null references public.promo_codes(id) on delete restrict,
  order_ref           text not null,
  order_amount_minor  integer not null,
  currency            text not null,
  rate_bps            integer not null,
  commission_minor    integer not null check (commission_minor >= 0),
  status              text not null default 'pending' check (status in ('pending','approved','cancelled','reversed')),
  withdrawal_id       bigint references public.withdrawals(id) on delete set null,
  -- Set when a commission is reversed after it was already paid out; it is netted off the next withdrawal.
  clawback_open       boolean not null default false,
  note                text not null default '',
  created_at          timestamptz not null default now(),
  status_changed_at   timestamptz not null default now()
);
create index if not exists commissions_influencer_idx on public.commissions (influencer_id, created_at desc);
create index if not exists commissions_status_idx on public.commissions (status, created_at);
create index if not exists commissions_code_idx on public.commissions (promo_code_id);
create index if not exists commissions_withdrawal_idx on public.commissions (withdrawal_id) where withdrawal_id is not null;
alter table public.commissions enable row level security;

-- Messages from influencers (the admin reads them on the Influencers tab) --------------------
create table if not exists public.influencer_messages (
  id            bigserial primary key,
  influencer_id uuid not null references public.influencers(id) on delete cascade,
  subject       text not null check (char_length(subject) between 1 and 120),
  message       text not null check (char_length(message) between 1 and 4000),
  resolved      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists influencer_messages_idx on public.influencer_messages (resolved, created_at desc);
alter table public.influencer_messages enable row level security;

-- Table privileges: service role only (RPCs run as the function owner) ---------------------------
revoke all on table
  public.platform_settings, public.influencers, public.influencer_payouts, public.promo_codes,
  public.discount_offers, public.withdrawals, public.commissions, public.influencer_messages
from anon, authenticated, service_role;
grant select, insert, update, delete on table
  public.platform_settings, public.influencers, public.influencer_payouts, public.promo_codes,
  public.discount_offers, public.withdrawals, public.commissions, public.influencer_messages
to service_role;
grant usage, select on sequence public.withdrawals_id_seq, public.commissions_id_seq, public.influencer_messages_id_seq to service_role;
grant select, insert, update on table public.payments to service_role;

-- Pending commissions become approved once the refund window has passed. Called at the start of
-- every function that reads balances, so no scheduled job is needed.
create or replace function public.sync_commissions() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.commissions
     set status = 'approved', status_changed_at = now()
   where status = 'pending'
     and created_at <= now() - make_interval(days => coalesce((public._setting('refund_window_days') #>> '{}')::int, 7));
end $$;
revoke all on function public.sync_commissions() from public, anon, authenticated;
grant execute on function public.sync_commissions() to service_role;

-- Helpers ------------------------------------------------------------------------------------------
create or replace function public._norm_code(p text) returns text
language sql immutable as $$ select upper(regexp_replace(btrim(coalesce(p, '')), '\s', '', 'g')) $$;

create or replace function public._mask_tail(p text, p_keep int default 4) returns text
language sql immutable as $$
  select case when p is null or p = '' then ''
              when char_length(p) <= p_keep then repeat('•', char_length(p))
              else repeat('•', char_length(p) - p_keep) || right(p, p_keep) end
$$;

-- The influencer behind the signed-in user (not deleted), or null.
create or replace function public._me() returns uuid
language sql stable security definer set search_path = public, auth as $$
  select id from public.influencers where user_id = auth.uid() and status <> 'deleted';
$$;
revoke all on function public._me() from public, anon;
grant execute on function public._me() to authenticated;

-- Money the influencer can withdraw now: approved, not yet in a withdrawal, minus open clawbacks.
create or replace function public._available(p_influencer uuid, p_currency text) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(commission_minor) filter (where status = 'approved' and withdrawal_id is null), 0)
       - coalesce(sum(commission_minor) filter (where status = 'reversed' and clawback_open), 0)
    from public.commissions where influencer_id = p_influencer and currency = p_currency;
$$;
revoke all on function public._available(uuid, text) from public, anon, authenticated;

create or replace function public._generate_code(p_base text) returns text
language plpgsql set search_path = public as $$
declare base text; candidate text; i int := 0;
begin
  base := upper(left(regexp_replace(coalesce(p_base, ''), '[^A-Za-z0-9]', '', 'g'), 8));
  if char_length(base) < 2 then base := 'FILLIE'; end if;
  loop
    candidate := base || lpad(floor(random() * 100)::text, 2, '0');
    if i >= 8 then candidate := base || lpad(floor(random() * 10000)::text, 4, '0'); end if;
    exit when not exists (select 1 from public.promo_codes where code = candidate)
          and not exists (select 1 from public.discount_offers where code = candidate);
    i := i + 1;
    if i > 30 then raise exception 'could not generate a free code'; end if;
  end loop;
  return left(candidate, 16);
end $$;
revoke all on function public._generate_code(text) from public, anon, authenticated;

-- Checkout helpers (service role only) -------------------------------------------------------------
-- Looks a code up for a signed-in buyer. Returns {kind:'promo'|'offer', ...} or {error:'...'}.
create or replace function public.checkout_resolve(p_code text, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare c text := public._norm_code(p_code); pr record; off record; uses int;
begin
  if c !~ '^[A-Z0-9]{4,16}$' then return jsonb_build_object('error', 'not_found'); end if;

  select p.id, p.code, p.discount_bps, p.commission_bps, p.active, i.status as istatus, i.user_id as iuser,
         coalesce(nullif(i.display_name, ''), i.full_name) as iname
    into pr from public.promo_codes p join public.influencers i on i.id = p.influencer_id where p.code = c;
  if found then
    if not pr.active or pr.istatus <> 'active' then return jsonb_build_object('error', 'inactive'); end if;
    if pr.iuser is not null and pr.iuser = p_user then return jsonb_build_object('error', 'own_code'); end if;
    return jsonb_build_object('kind', 'promo', 'id', pr.id, 'code', pr.code, 'discount_bps', pr.discount_bps, 'title', 'Creator code · ' || pr.iname);
  end if;

  select * into off from public.discount_offers where code = c;
  if found then
    if not off.active then return jsonb_build_object('error', 'inactive'); end if;
    if off.starts_at is not null and off.starts_at > now() then return jsonb_build_object('error', 'not_started'); end if;
    if off.ends_at is not null and off.ends_at < now() then return jsonb_build_object('error', 'expired'); end if;
    if off.max_uses is not null then
      select count(*) into uses from public.payments where offer_id = off.id and status = 'paid';
      if uses >= off.max_uses then return jsonb_build_object('error', 'used_up'); end if;
    end if;
    return jsonb_build_object('kind', 'offer', 'id', off.id, 'code', off.code, 'discount_bps', off.discount_bps, 'title', coalesce(nullif(off.title, ''), 'Offer'));
  end if;

  return jsonb_build_object('error', 'not_found');
end $$;
revoke all on function public.checkout_resolve(text, uuid) from public, anon, authenticated;
grant execute on function public.checkout_resolve(text, uuid) to service_role;

-- Called by the payment recorder after a payment row exists. Safe to call again (idempotent).
create or replace function public.finalize_order(p_ref text) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare pay record; pr record; inf record; self boolean; amt int; created int := 0;
begin
  select * into pay from public.payments where provider_ref = p_ref;
  if not found or pay.promo_code_id is null then return jsonb_build_object('commission', false); end if;
  if exists (select 1 from public.commissions where payment_id = pay.id) then return jsonb_build_object('commission', false, 'existing', true); end if;

  select * into pr from public.promo_codes where id = pay.promo_code_id;
  select * into inf from public.influencers where id = pr.influencer_id;
  if inf.id is null then return jsonb_build_object('commission', false); end if;

  self := (inf.user_id is not null and inf.user_id = pay.user_id)
       or (pay.user_id is not null and inf.email <> '' and lower(inf.email) = (select lower(email) from auth.users where id = pay.user_id));
  amt := floor(pay.amount_minor::numeric * pr.commission_bps / 10000);

  insert into public.commissions (payment_id, influencer_id, promo_code_id, order_ref, order_amount_minor, currency, rate_bps, commission_minor, status, note)
  values (pay.id, inf.id, pr.id, pay.provider_ref, pay.amount_minor, pay.currency, pr.commission_bps, amt,
          case when self then 'cancelled' else 'pending' end,
          case when self then 'Self-referral: the buyer is the influencer.' else '' end)
  on conflict (payment_id) do nothing;
  get diagnostics created = row_count;
  return jsonb_build_object('commission', created > 0, 'self_referral', self);
end $$;
revoke all on function public.finalize_order(text) from public, anon, authenticated;
grant execute on function public.finalize_order(text) to service_role;
