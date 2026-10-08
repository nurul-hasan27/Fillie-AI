-- Fillie cloud schema, part 6: what a signed-in influencer can do (all through functions).
-- Customers are never exposed: influencers see counts, amounts and dates, never a name, email or full order id.

-- Validation helpers ---------------------------------------------------------------------------
create or replace function public._clean_socials(p jsonb) returns jsonb
language plpgsql stable as $$
declare k text; out jsonb := '{}'::jsonb; u text; n text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return out; end if;
  foreach k in array array['instagram','youtube','facebook','x','other'] loop
    if p ? k and jsonb_typeof(p -> k) = 'object' then
      n := left(btrim(coalesce(p -> k ->> 'username', '')), 80);
      u := left(btrim(coalesce(p -> k ->> 'url', '')), 300);
      if u <> '' and u !~* '^https?://' then raise exception 'The % link must start with https://', k; end if;
      if n <> '' or u <> '' then out := out || jsonb_build_object(k, jsonb_build_object('username', n, 'url', u)); end if;
    end if;
  end loop;
  return out;
end $$;

-- Validates and normalises the profile part of the form. Returns the cleaned values as jsonb.
create or replace function public._clean_profile(p jsonb) returns jsonb
language plpgsql stable as $$
declare
  full_name text := btrim(coalesce(p ->> 'full_name', ''));
  email text := lower(btrim(coalesce(p ->> 'email', '')));
  phone text := regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9+]', '', 'g');
  dob date;
  primary_platform text := btrim(coalesce(p ->> 'primary_platform', ''));
  niche text := btrim(coalesce(p ->> 'niche', ''));
  promote text[];
  followers int := 0;
begin
  if char_length(full_name) < 2 then raise exception 'Enter your full name.'; end if;
  if email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
  if char_length(regexp_replace(phone, '\D', '', 'g')) < 10 then raise exception 'Enter a valid mobile number.'; end if;
  begin dob := (p ->> 'dob')::date; exception when others then dob := null; end;
  if dob is null then raise exception 'Enter your date of birth.'; end if;
  if dob > (current_date - interval '18 years')::date then raise exception 'You must be at least 18 to join the programme.'; end if;
  if dob < date '1920-01-01' then raise exception 'Enter a valid date of birth.'; end if;
  if primary_platform not in ('Instagram','YouTube','Facebook','X','Other') then raise exception 'Choose your primary platform.'; end if;
  if niche not in ('Fashion','Beauty','Fitness','Food','Tech','Lifestyle','Education','Gaming','Other') then raise exception 'Choose your content category.'; end if;
  if btrim(coalesce(p ->> 'audience_location', '')) = '' then raise exception 'Tell us where your audience is.'; end if;
  if btrim(coalesce(p ->> 'audience_size', '')) = '' then raise exception 'Choose your approximate audience size.'; end if;
  begin followers := greatest(0, coalesce((p ->> 'total_followers')::int, 0)); exception when others then followers := 0; end;
  select coalesce(array_agg(distinct v), '{}') into promote
    from jsonb_array_elements_text(coalesce(p -> 'promote_on', '[]'::jsonb)) v
   where v in ('Instagram','YouTube','WhatsApp','Telegram','Website/Blog','Other');
  if coalesce(array_length(promote, 1), 0) = 0 then raise exception 'Choose at least one place where you will promote Fillie.'; end if;

  return jsonb_build_object(
    'full_name', left(full_name, 120),
    'display_name', left(btrim(coalesce(p ->> 'display_name', '')), 80),
    'email', left(email, 200), 'phone', left(phone, 20), 'dob', dob,
    'city', left(btrim(coalesce(p ->> 'city', '')), 80), 'state', left(btrim(coalesce(p ->> 'state', '')), 80),
    'socials', public._clean_socials(p -> 'socials'),
    'total_followers', followers, 'primary_platform', primary_platform,
    'niche', niche, 'niche_other', left(btrim(coalesce(p ->> 'niche_other', '')), 80),
    'audience_location', left(btrim(p ->> 'audience_location'), 120), 'audience_size', left(btrim(p ->> 'audience_size'), 40),
    'description', left(btrim(coalesce(p ->> 'description', '')), 1000),
    'monthly_reach', left(btrim(coalesce(p ->> 'monthly_reach', '')), 60),
    'collab_type', left(btrim(coalesce(p ->> 'collab_type', '')), 80),
    'promote_on', to_jsonb(promote)
  );
end $$;

-- Saves bank / UPI / PAN details. Every field is re-entered on each save (the page only shows a masked copy).
create or replace function public._save_payout(p_influencer uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  holder text := btrim(coalesce(p ->> 'account_holder', ''));
  acct text := regexp_replace(coalesce(p ->> 'account_number', ''), '\s', '', 'g');
  acct2 text := regexp_replace(coalesce(p ->> 'account_number_confirm', ''), '\s', '', 'g');
  ifsc text := upper(btrim(coalesce(p ->> 'ifsc', '')));
  upi text := lower(btrim(coalesce(p ->> 'upi_id', '')));
  pan text := upper(btrim(coalesce(p ->> 'pan', '')));
  gst text := upper(btrim(coalesce(p ->> 'gstin', '')));
  proof text := nullif(btrim(coalesce(p ->> 'proof_path', '')), '');
begin
  if char_length(holder) < 2 then raise exception 'Enter the account holder name.'; end if;
  if acct !~ '^[0-9]{9,18}$' then raise exception 'Enter a valid bank account number (9 to 18 digits).'; end if;
  if acct <> acct2 then raise exception 'The account numbers do not match.'; end if;
  if ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then raise exception 'Enter a valid IFSC code, for example HDFC0001234.'; end if;
  if pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then raise exception 'Enter a valid PAN, for example ABCDE1234F.'; end if;
  if upi <> '' and upi !~ '^[a-z0-9._-]{2,}@[a-z]{2,}$' then raise exception 'Enter a valid UPI ID, for example name@bank.'; end if;
  if gst <> '' and gst !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then raise exception 'Enter a valid GSTIN or leave it empty.'; end if;

  insert into public.influencer_payouts as ip (influencer_id, account_holder, account_number, ifsc, bank_name, upi_id, pan, pan_name, gstin, proof_path, verification, updated_at)
  values (p_influencer, left(holder, 120), acct, ifsc, left(btrim(coalesce(p ->> 'bank_name', '')), 80), left(upi, 80), pan,
          left(btrim(coalesce(p ->> 'pan_name', '')), 120), gst, proof, 'pending', now())
  on conflict (influencer_id) do update set
    account_holder = excluded.account_holder, account_number = excluded.account_number, ifsc = excluded.ifsc,
    bank_name = excluded.bank_name, upi_id = excluded.upi_id, pan = excluded.pan, pan_name = excluded.pan_name,
    gstin = excluded.gstin, proof_path = coalesce(excluded.proof_path, ip.proof_path),
    verification = 'pending', updated_at = now();
end $$;
revoke all on function public._save_payout(uuid, jsonb) from public, anon, authenticated;

-- What the influencer sees about themselves ---------------------------------------------------------
create or replace function public._me_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', to_jsonb(i) - 'user_id' - 'commission_bps',
    'commission_bps', i.commission_bps,
    'payout', (select case when ip.influencer_id is null then null else jsonb_build_object(
                 'account_holder', ip.account_holder, 'account_last4', right(ip.account_number, 4), 'ifsc', ip.ifsc,
                 'bank_name', ip.bank_name, 'upi_id', ip.upi_id, 'pan_masked', public._mask_tail(ip.pan, 1),
                 'pan_name', ip.pan_name, 'gstin', ip.gstin, 'has_proof', ip.proof_path is not null, 'verification', ip.verification) end
               from public.influencer_payouts ip where ip.influencer_id = i.id),
    'codes', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'active', c.active, 'discount_bps', c.discount_bps, 'created_at', c.created_at) order by c.created_at)
                         from public.promo_codes c where c.influencer_id = i.id), '[]'::jsonb),
    'max_codes', coalesce((public._setting('max_codes_per_influencer') #>> '{}')::int, 5),
    'terms_version', i.terms_version
  ) from public.influencers i where i.id = p_id;
$$;
revoke all on function public._me_json(uuid) from public, anon, authenticated;

create or replace function public.influencer_me() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare me uuid := public._me();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if me is null then return null; end if;
  return public._me_json(me);
end $$;
revoke all on function public.influencer_me() from public, anon;
grant execute on function public.influencer_me() to authenticated;

-- Joining ------------------------------------------------------------------------------------------------
create or replace function public.influencer_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  uid uuid := auth.uid(); clean jsonb; new_id uuid; wanted text; code text;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if public._me() is not null then raise exception 'You are already an influencer.'; end if;
  if coalesce((p ->> 'agree_accurate')::boolean, false) is not true
     or coalesce((p ->> 'agree_terms')::boolean, false) is not true
     or coalesce((p ->> 'agree_withdrawal')::boolean, false) is not true
     or coalesce((p ->> 'agree_fraud')::boolean, false) is not true then
    raise exception 'Please accept all four agreements to join.';
  end if;
  clean := public._clean_profile(p);

  insert into public.influencers (user_id, full_name, display_name, email, phone, dob, photo_path, city, state, socials, total_followers,
                                  primary_platform, niche, niche_other, audience_location, audience_size, description, monthly_reach, collab_type,
                                  promote_on, commission_bps, agreed_at)
  values (uid, clean ->> 'full_name', clean ->> 'display_name', clean ->> 'email', clean ->> 'phone', (clean ->> 'dob')::date,
          nullif(p ->> 'photo_path', ''), clean ->> 'city', clean ->> 'state', clean -> 'socials', (clean ->> 'total_followers')::int,
          clean ->> 'primary_platform', clean ->> 'niche', clean ->> 'niche_other', clean ->> 'audience_location', clean ->> 'audience_size',
          clean ->> 'description', clean ->> 'monthly_reach', clean ->> 'collab_type',
          array(select jsonb_array_elements_text(clean -> 'promote_on')),
          coalesce((public._setting('default_commission_bps') #>> '{}')::int, 1000), now())
  returning id into new_id;

  wanted := public._norm_code(p ->> 'promo_code');
  if wanted <> '' then
    if wanted !~ '^[A-Z0-9]{4,16}$' then raise exception 'Promo codes use 4 to 16 letters and numbers.'; end if;
    code := wanted;
  else
    code := public._generate_code(coalesce(nullif(clean ->> 'display_name', ''), clean ->> 'full_name'));
  end if;
  begin
    insert into public.promo_codes (influencer_id, code, discount_bps, commission_bps)
    values (new_id, code, coalesce((public._setting('default_customer_discount_bps') #>> '{}')::int, 1000),
            coalesce((public._setting('default_commission_bps') #>> '{}')::int, 1000));
  exception when unique_violation then
    raise exception 'That promo code is already taken. Try another.';
  end;

  if p ? 'payout' and jsonb_typeof(p -> 'payout') = 'object' and (p -> 'payout' ->> 'account_number') is not null then
    perform public._save_payout(new_id, p -> 'payout');
  end if;
  return public._me_json(new_id);
end $$;
revoke all on function public.influencer_apply(jsonb) from public, anon;
grant execute on function public.influencer_apply(jsonb) to authenticated;

create or replace function public.influencer_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me(); clean jsonb;
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  clean := public._clean_profile(p);
  update public.influencers set
    full_name = clean ->> 'full_name', display_name = clean ->> 'display_name', email = clean ->> 'email', phone = clean ->> 'phone',
    dob = (clean ->> 'dob')::date, city = clean ->> 'city', state = clean ->> 'state', socials = clean -> 'socials',
    total_followers = (clean ->> 'total_followers')::int, primary_platform = clean ->> 'primary_platform', niche = clean ->> 'niche',
    niche_other = clean ->> 'niche_other', audience_location = clean ->> 'audience_location', audience_size = clean ->> 'audience_size',
    description = clean ->> 'description', monthly_reach = clean ->> 'monthly_reach', collab_type = clean ->> 'collab_type',
    promote_on = array(select jsonb_array_elements_text(clean -> 'promote_on')),
    photo_path = case when p ? 'photo_path' then nullif(p ->> 'photo_path', '') else photo_path end,
    updated_at = now()
  where id = me;
  return public._me_json(me);
end $$;
revoke all on function public.influencer_update(jsonb) from public, anon;
grant execute on function public.influencer_update(jsonb) to authenticated;

create or replace function public.influencer_save_payout(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me();
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  perform public._save_payout(me, p);
  return public._me_json(me);
end $$;
revoke all on function public.influencer_save_payout(jsonb) from public, anon;
grant execute on function public.influencer_save_payout(jsonb) to authenticated;

-- Codes --------------------------------------------------------------------------------------------------------
create or replace function public.influencer_create_code(p_code text default null) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me(); inf record; wanted text := public._norm_code(p_code); code text; limit_n int;
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  select * into inf from public.influencers where id = me;
  if inf.status <> 'active' then raise exception 'Your account is suspended. Contact support.'; end if;
  limit_n := coalesce((public._setting('max_codes_per_influencer') #>> '{}')::int, 5);
  if (select count(*) from public.promo_codes where influencer_id = me) >= limit_n then
    raise exception 'You can have up to % promo codes. Pause one you no longer use instead.', limit_n;
  end if;
  if wanted <> '' then
    if wanted !~ '^[A-Z0-9]{4,16}$' then raise exception 'Promo codes use 4 to 16 letters and numbers.'; end if;
    code := wanted;
  else
    code := public._generate_code(coalesce(nullif(inf.display_name, ''), inf.full_name));
  end if;
  begin
    insert into public.promo_codes (influencer_id, code, discount_bps, commission_bps)
    values (me, code, coalesce((public._setting('default_customer_discount_bps') #>> '{}')::int, 1000), inf.commission_bps);
  exception when unique_violation then
    raise exception 'That promo code is already taken. Try another.';
  end;
  return public._me_json(me);
end $$;
revoke all on function public.influencer_create_code(text) from public, anon;
grant execute on function public.influencer_create_code(text) to authenticated;

create or replace function public.influencer_set_code_active(p_id uuid, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me();
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  update public.promo_codes set active = p_active where id = p_id and influencer_id = me;
  return public._me_json(me);
end $$;
revoke all on function public.influencer_set_code_active(uuid, boolean) from public, anon;
grant execute on function public.influencer_set_code_active(uuid, boolean) to authenticated;

-- Dashboard ----------------------------------------------------------------------------------------------------
create or replace function public.influencer_dashboard(p_days int default 30) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me(); days int := least(greatest(coalesce(p_days, 30), 7), 365); result jsonb;
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  perform public.sync_commissions();
  select jsonb_build_object(
    'balances', coalesce((select jsonb_agg(b) from (
        select c.currency,
               public._available(me, c.currency) as available,
               coalesce(sum(c.commission_minor) filter (where c.status = 'pending'), 0) as pending,
               coalesce(sum(c.commission_minor) filter (where c.status in ('pending','approved')), 0) as lifetime,
               coalesce((select sum(w.net_minor) from public.withdrawals w where w.influencer_id = me and w.currency = c.currency and w.status = 'paid'), 0) as paid_out,
               coalesce((select sum(w.gross_minor) from public.withdrawals w where w.influencer_id = me and w.currency = c.currency and w.status in ('pending','approved')), 0) as in_review
          from public.commissions c where c.influencer_id = me group by c.currency) b), '[]'::jsonb),
    'totals', jsonb_build_object(
        'orders', (select count(*) from public.commissions where influencer_id = me and status <> 'cancelled'),
        'cancelled', (select count(*) from public.commissions where influencer_id = me and status in ('cancelled','reversed')),
        'revenue', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(order_amount_minor) s from public.commissions where influencer_id = me and status in ('pending','approved') group by currency) r), '{}'::jsonb),
        'commission', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(commission_minor) s from public.commissions where influencer_id = me and status in ('pending','approved') group by currency) r), '{}'::jsonb)),
    'codes', coalesce((select jsonb_agg(x order by x.created_at) from (
        select pc.id, pc.code, pc.active, pc.discount_bps, pc.created_at,
               count(c.id) filter (where c.status in ('pending','approved')) as orders,
               coalesce((select jsonb_object_agg(cur, s) from (select currency cur, sum(commission_minor) s from public.commissions where promo_code_id = pc.id and status in ('pending','approved') group by currency) r), '{}'::jsonb) as commission,
               coalesce((select jsonb_object_agg(cur, s) from (select currency cur, sum(order_amount_minor) s from public.commissions where promo_code_id = pc.id and status in ('pending','approved') group by currency) r), '{}'::jsonb) as revenue
          from public.promo_codes pc left join public.commissions c on c.promo_code_id = pc.id
         where pc.influencer_id = me group by pc.id) x), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
        select to_char(g.day, 'YYYY-MM-DD') as day,
               count(c.id) filter (where c.status in ('pending','approved')) as orders,
               coalesce(sum(c.commission_minor) filter (where c.status in ('pending','approved') and c.currency = 'INR'), 0) as earned_inr,
               coalesce(sum(c.commission_minor) filter (where c.status in ('pending','approved') and c.currency = 'USD'), 0) as earned_usd
          from generate_series(current_date - (days - 1), current_date, '1 day') g(day)
          left join public.commissions c on c.influencer_id = me and c.created_at::date = g.day::date
         group by g.day) d), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(r) from (
        select 'ORD-' || upper(right(c.order_ref, 6)) as order_id, pc.code, c.order_amount_minor, c.commission_minor, c.currency, c.status, c.created_at,
               case when c.status = 'pending' then c.created_at + make_interval(days => coalesce((public._setting('refund_window_days') #>> '{}')::int, 7)) end as available_on
          from public.commissions c join public.promo_codes pc on pc.id = c.promo_code_id
         where c.influencer_id = me order by c.created_at desc limit 50) r), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg(w) from (
        select id, currency, gross_minor, tds_minor, fee_minor, net_minor, status, method, requested_at, paid_at, payout_reference,
               case when status = 'rejected' then admin_note else '' end as note
          from public.withdrawals where influencer_id = me order by requested_at desc limit 50) w), '[]'::jsonb),
    'refund_window_days', coalesce((public._setting('refund_window_days') #>> '{}')::int, 7)
  ) into result;
  return result;
end $$;
revoke all on function public.influencer_dashboard(int) from public, anon;
grant execute on function public.influencer_dashboard(int) to authenticated;

-- Withdrawals: quote first, so the influencer sees exactly what lands in the bank ----------------------------
create or replace function public._quote(p_influencer uuid, p_currency text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  inf record; pay record; cur text := upper(coalesce(p_currency, 'INR'));
  available bigint; minimum bigint; gross bigint; method text;
  fy_start timestamptz; cum_before bigint; tds_before bigint; threshold bigint; rate int; due bigint; tds bigint := 0;
  flat bigint; net bigint; lines jsonb := '[]'::jsonb; reason text := null;
begin
  select * into inf from public.influencers where id = p_influencer;
  select * into pay from public.influencer_payouts where influencer_id = p_influencer;
  available := public._available(p_influencer, cur);
  minimum := coalesce((public._setting('min_withdrawal_minor') ->> cur)::bigint, 0);
  gross := available;

  if inf.status <> 'active' then reason := 'suspended';
  elsif pay.influencer_id is null or pay.account_number = '' or pay.pan = '' then reason := 'payout_details_missing';
  elsif gross <= 0 then reason := 'no_balance';
  elsif gross < minimum then reason := 'below_minimum';
  end if;

  method := case when pay.account_number <> '' then 'bank' else 'upi' end;

  -- TDS: charged on the running total for the Indian financial year (1 April to 31 March), catching up once
  -- the yearly threshold is crossed, and only for rupee payouts.
  if cur = 'INR' and gross > 0 then
    fy_start := (date_trunc('year', (now() at time zone 'Asia/Kolkata') - interval '3 months') + interval '3 months') at time zone 'Asia/Kolkata';
    select coalesce(sum(gross_minor), 0), coalesce(sum(tds_minor), 0) into cum_before, tds_before
      from public.withdrawals where influencer_id = p_influencer and currency = cur and status in ('pending','approved','paid') and requested_at >= fy_start;
    threshold := coalesce((public._setting('tds_threshold_minor') ->> cur)::bigint, 0);
    rate := coalesce((case when pay.pan <> '' then public._setting('tds_bps') else public._setting('tds_no_pan_bps') end #>> '{}')::int, 0);
    if rate > 0 and cum_before + gross > threshold then
      due := floor((cum_before + gross)::numeric * rate / 10000);
      tds := least(gross, greatest(0, due - tds_before));
    end if;
    if tds > 0 then
      lines := lines || jsonb_build_array(jsonb_build_object('key', 'tds', 'label', 'Income-tax deducted at source (TDS)', 'amount_minor', tds,
                 'note', format('%s%% under section 194H once your payouts pass the yearly limit. Counts towards your tax credit (Form 26AS).', round(rate / 100.0, 2))));
    end if;
  end if;

  flat := coalesce((public._setting('payout_fee_minor') ->> cur)::bigint, 0);
  if flat > 0 then
    lines := lines || jsonb_build_array(jsonb_build_object('key', 'payout_fee', 'label', 'Bank transfer fee', 'amount_minor', flat, 'note', 'Charged for sending the money to your account.'));
  end if;

  net := gross - tds - flat;
  if reason is null and net <= 0 then reason := 'below_minimum'; end if;

  return jsonb_build_object(
    'ok', reason is null, 'reason', reason, 'currency', cur, 'available', available, 'minimum', minimum,
    'gross', gross, 'tds', tds, 'fee', flat, 'net', greatest(net, 0), 'lines', lines, 'method', method,
    'destination', case when pay.influencer_id is null then null else jsonb_build_object(
        'bank_name', pay.bank_name, 'holder', pay.account_holder, 'account_masked', public._mask_tail(pay.account_number, 4), 'ifsc', pay.ifsc, 'upi_id', pay.upi_id) end
  );
end $$;
revoke all on function public._quote(uuid, text) from public, anon, authenticated;

create or replace function public.influencer_quote_withdrawal(p_currency text default 'INR') returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me();
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  perform public.sync_commissions();
  return public._quote(me, p_currency);
end $$;
revoke all on function public.influencer_quote_withdrawal(text) from public, anon;
grant execute on function public.influencer_quote_withdrawal(text) to authenticated;

create or replace function public.influencer_request_withdrawal(p_currency text default 'INR') returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  me uuid := public._me(); q jsonb; pay record; wid bigint; cur text := upper(coalesce(p_currency, 'INR'));
  clawbacks bigint[];
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  -- Serialise per influencer so two quick clicks cannot withdraw the same money twice.
  perform 1 from public.influencers where id = me for update;
  perform public.sync_commissions();
  q := public._quote(me, cur);
  if (q ->> 'ok')::boolean is not true then
    raise exception 'Withdrawal not possible: %', coalesce(q ->> 'reason', 'unknown');
  end if;
  select * into pay from public.influencer_payouts where influencer_id = me;
  select coalesce(array_agg(id), '{}') into clawbacks from public.commissions where influencer_id = me and currency = cur and status = 'reversed' and clawback_open;

  insert into public.withdrawals (influencer_id, currency, gross_minor, tds_minor, fee_minor, net_minor, breakdown, method, payout_snapshot)
  values (me, cur, (q ->> 'gross')::int, (q ->> 'tds')::int, (q ->> 'fee')::int, (q ->> 'net')::int,
          jsonb_build_object('lines', q -> 'lines', 'clawback_ids', to_jsonb(clawbacks)), q ->> 'method',
          jsonb_build_object('holder', pay.account_holder, 'bank_name', pay.bank_name, 'account_masked', public._mask_tail(pay.account_number, 4),
                             'account_number', pay.account_number, 'ifsc', pay.ifsc, 'upi_id', pay.upi_id, 'pan', pay.pan, 'pan_name', pay.pan_name,
                             'gstin', pay.gstin, 'verification', pay.verification))
  returning id into wid;

  update public.commissions set withdrawal_id = wid where influencer_id = me and currency = cur and status = 'approved' and withdrawal_id is null;
  update public.commissions set clawback_open = false where id = any(clawbacks);
  return jsonb_build_object('id', wid, 'net_minor', (q ->> 'net')::int, 'currency', cur);
end $$;
revoke all on function public.influencer_request_withdrawal(text) from public, anon;
grant execute on function public.influencer_request_withdrawal(text) to authenticated;

-- Leaving the programme ----------------------------------------------------------------------------------------------
create or replace function public.influencer_delete_summary() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me();
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  perform public.sync_commissions();
  return jsonb_build_object(
    'available', coalesce((select jsonb_object_agg(currency, a) from (select currency, public._available(me, currency) a from public.commissions where influencer_id = me group by currency) x where a > 0), '{}'::jsonb),
    'pending', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(commission_minor) s from public.commissions where influencer_id = me and status = 'pending' group by currency) x), '{}'::jsonb),
    'in_review', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(gross_minor) s from public.withdrawals where influencer_id = me and status in ('pending','approved') group by currency) x), '{}'::jsonb));
end $$;
revoke all on function public.influencer_delete_summary() from public, anon;
grant execute on function public.influencer_delete_summary() to authenticated;

create or replace function public.influencer_delete_account(p_forfeit_pending boolean default false) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me(); s jsonb; code_ids uuid[];
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  perform 1 from public.influencers where id = me for update;
  s := public.influencer_delete_summary();
  if s -> 'available' <> '{}'::jsonb then raise exception 'balance_left'; end if;
  if s -> 'in_review' <> '{}'::jsonb then raise exception 'withdrawal_in_progress'; end if;
  if s -> 'pending' <> '{}'::jsonb and not coalesce(p_forfeit_pending, false) then raise exception 'pending_left'; end if;

  update public.commissions set status = 'cancelled', status_changed_at = now(), note = 'Influencer closed the account before this matured.'
   where influencer_id = me and status = 'pending';
  update public.promo_codes set active = false where influencer_id = me;
  delete from public.influencer_payouts where influencer_id = me;
  -- Keep the name (needed for the ledger and tax records) but drop everything else personal.
  update public.influencers set status = 'deleted', deleted_at = now(), user_id = null, phone = '', email = '', dob = null, photo_path = null,
         city = '', state = '', socials = '{}'::jsonb, description = '', updated_at = now()
   where id = me;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function public.influencer_delete_account(boolean) from public, anon;
grant execute on function public.influencer_delete_account(boolean) to authenticated;

-- Support -----------------------------------------------------------------------------------------------------------------
create or replace function public.influencer_send_message(p_subject text, p_message text) returns void
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := public._me();
begin
  if me is null then raise exception 'You are not an influencer.'; end if;
  if btrim(coalesce(p_subject, '')) = '' or btrim(coalesce(p_message, '')) = '' then raise exception 'Write a subject and a message.'; end if;
  if (select count(*) from public.influencer_messages where influencer_id = me and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You have sent several messages recently. Please wait a little.';
  end if;
  insert into public.influencer_messages (influencer_id, subject, message) values (me, left(btrim(p_subject), 120), left(btrim(p_message), 4000));
end $$;
revoke all on function public.influencer_send_message(text, text) from public, anon;
grant execute on function public.influencer_send_message(text, text) to authenticated;

-- Storage for the profile photo (public) and bank proof (private), one folder per user ---------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('influencer-photos', 'influencer-photos', true, 2097152, array['image/jpeg','image/png','image/webp']),
  ('influencer-proofs', 'influencer-proofs', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "influencer files: own insert" on storage.objects;
create policy "influencer files: own insert" on storage.objects for insert to authenticated
  with check (bucket_id in ('influencer-photos','influencer-proofs') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "influencer files: own update" on storage.objects;
create policy "influencer files: own update" on storage.objects for update to authenticated
  using (bucket_id in ('influencer-photos','influencer-proofs') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "influencer files: own delete" on storage.objects;
create policy "influencer files: own delete" on storage.objects for delete to authenticated
  using (bucket_id in ('influencer-photos','influencer-proofs') and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "influencer files: own or admin read" on storage.objects;
create policy "influencer files: own or admin read" on storage.objects for select to authenticated
  using (bucket_id in ('influencer-photos','influencer-proofs') and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
