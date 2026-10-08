-- Fillie cloud schema, part 7: the admin side of the influencer programme and discount offers.
-- Every function starts with _admin_guard(), so only the verified Google admin can call them.

create or replace function public._balance_json(p_influencer uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(currency, a), '{}'::jsonb) from (
    select currency, public._available(p_influencer, currency) as a from public.commissions where influencer_id = p_influencer group by currency) x
  where a <> 0;
$$;
revoke all on function public._balance_json(uuid) from public, anon, authenticated;

-- Overview numbers shown on the admin Overview tab ----------------------------------------------------------------
create or replace function public.admin_influencer_overview() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  perform public.sync_commissions();
  return jsonb_build_object(
    'active_influencers', (select count(*) from public.influencers where status = 'active'),
    'total_influencers',  (select count(*) from public.influencers),
    'orders', (select count(*) from public.commissions where status in ('pending','approved')),
    'commission_generated', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(commission_minor) s from public.commissions where status in ('pending','approved') group by currency) x), '{}'::jsonb),
    'commission_owed', coalesce((select jsonb_object_agg(currency, s) from (
        select currency, sum(commission_minor) filter (where status in ('pending','approved')) - coalesce((select sum(w.gross_minor) from public.withdrawals w where w.currency = c.currency and w.status = 'paid'), 0) s
          from public.commissions c group by currency) x where s > 0), '{}'::jsonb),
    'influencer_revenue', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(order_amount_minor) s from public.commissions where status in ('pending','approved') group by currency) x), '{}'::jsonb),
    'pending_withdrawals', (select count(*) from public.withdrawals where status = 'pending'),
    'pending_withdrawal_minor', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(net_minor) s from public.withdrawals where status in ('pending','approved') group by currency) x), '{}'::jsonb),
    'open_messages', (select count(*) from public.influencer_messages where not resolved),
    'active_offers', (select count(*) from public.discount_offers where active and (ends_at is null or ends_at > now())),
    'offer_redemptions', (select count(*) from public.payments where offer_id is not null and status = 'paid')
  );
end $$;
revoke all on function public.admin_influencer_overview() from public, anon;
grant execute on function public.admin_influencer_overview() to authenticated;

-- Influencers list ----------------------------------------------------------------------------------------------------------
create or replace function public.admin_influencers(p_limit int default 200, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  perform public.sync_commissions();
  return coalesce((select jsonb_agg(r order by r.created_at desc) from (
    select i.id, i.full_name, coalesce(nullif(i.display_name, ''), i.full_name) as name, i.city, i.state, i.status, i.created_at, i.photo_path,
           i.primary_platform, i.niche,
           coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'active', c.active) order by c.created_at) from public.promo_codes c where c.influencer_id = i.id), '[]'::jsonb) as codes,
           (select count(*) from public.commissions c where c.influencer_id = i.id and c.status in ('pending','approved')) as orders,
           coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(order_amount_minor) s from public.commissions where influencer_id = i.id and status in ('pending','approved') group by currency) x), '{}'::jsonb) as revenue,
           coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(commission_minor) s from public.commissions where influencer_id = i.id and status in ('pending','approved') group by currency) x), '{}'::jsonb) as commission,
           public._balance_json(i.id) as balance,
           coalesce((select p.verification from public.influencer_payouts p where p.influencer_id = i.id), 'none') as payout
      from public.influencers i
     order by i.created_at desc limit least(p_limit, 500) offset p_offset) r), '[]'::jsonb);
end $$;
revoke all on function public.admin_influencers(int, int) from public, anon;
grant execute on function public.admin_influencers(int, int) to authenticated;

create or replace function public.admin_influencer_detail(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare result jsonb;
begin
  perform public._admin_guard();
  perform public.sync_commissions();
  select jsonb_build_object(
    'profile', to_jsonb(i),
    'sign_in_email', (select email from auth.users where id = i.user_id),
    'payout', (select to_jsonb(p) from public.influencer_payouts p where p.influencer_id = i.id),
    'codes', coalesce((select jsonb_agg(x order by x.created_at) from (
        select c.id, c.code, c.active, c.discount_bps, c.commission_bps, c.created_at,
               count(m.id) filter (where m.status in ('pending','approved')) as orders,
               coalesce((select jsonb_object_agg(cur, s) from (select currency cur, sum(order_amount_minor) s from public.commissions where promo_code_id = c.id and status in ('pending','approved') group by currency) r), '{}'::jsonb) as revenue,
               coalesce((select jsonb_object_agg(cur, s) from (select currency cur, sum(commission_minor) s from public.commissions where promo_code_id = c.id and status in ('pending','approved') group by currency) r), '{}'::jsonb) as commission
          from public.promo_codes c left join public.commissions m on m.promo_code_id = c.id where c.influencer_id = i.id group by c.id) x), '[]'::jsonb),
    'balance', public._balance_json(i.id),
    'totals', jsonb_build_object(
        'orders', (select count(*) from public.commissions where influencer_id = i.id and status in ('pending','approved')),
        'revenue', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(order_amount_minor) s from public.commissions where influencer_id = i.id and status in ('pending','approved') group by currency) x), '{}'::jsonb),
        'commission', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(commission_minor) s from public.commissions where influencer_id = i.id and status in ('pending','approved') group by currency) x), '{}'::jsonb),
        'paid_out', coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(net_minor) s from public.withdrawals where influencer_id = i.id and status = 'paid' group by currency) x), '{}'::jsonb)),
    'ledger', coalesce((select jsonb_agg(l) from (
        select m.id, m.order_ref, c.code, m.order_amount_minor, m.commission_minor, m.currency, m.status, m.created_at, m.note, m.withdrawal_id, au.email as customer_email
          from public.commissions m join public.promo_codes c on c.id = m.promo_code_id
          join public.payments pay on pay.id = m.payment_id left join auth.users au on au.id = pay.user_id
         where m.influencer_id = i.id order by m.created_at desc limit 300) l), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg(w) from (select id, currency, gross_minor, tds_minor, fee_minor, net_minor, status, method, requested_at, paid_at, payout_reference from public.withdrawals where influencer_id = i.id order by requested_at desc) w), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(mm) from (select id, subject, message, resolved, created_at from public.influencer_messages where influencer_id = i.id order by created_at desc limit 50) mm), '[]'::jsonb)
  ) into result from public.influencers i where i.id = p_id;
  return result;
end $$;
revoke all on function public.admin_influencer_detail(uuid) from public, anon;
grant execute on function public.admin_influencer_detail(uuid) to authenticated;

create or replace function public.admin_set_influencer_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  if p_status not in ('active','suspended') then raise exception 'bad status'; end if;
  update public.influencers set status = p_status, updated_at = now() where id = p_id and status <> 'deleted';
end $$;
revoke all on function public.admin_set_influencer_status(uuid, text) from public, anon;
grant execute on function public.admin_set_influencer_status(uuid, text) to authenticated;

create or replace function public.admin_set_payout_verification(p_id uuid, p_verification text) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  if p_verification not in ('pending','verified','rejected') then raise exception 'bad status'; end if;
  update public.influencer_payouts set verification = p_verification where influencer_id = p_id;
end $$;
revoke all on function public.admin_set_payout_verification(uuid, text) from public, anon;
grant execute on function public.admin_set_payout_verification(uuid, text) to authenticated;

-- Transaction ledger -----------------------------------------------------------------------------------------------------------
create or replace function public.admin_ledger(p_status text default null, p_limit int default 200, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  perform public.sync_commissions();
  return jsonb_build_object(
    'total', (select count(*) from public.commissions where p_status is null or status = p_status),
    'rows', coalesce((select jsonb_agg(r) from (
      select m.id, m.order_ref, m.payment_id, c.code, m.influencer_id,
             coalesce(nullif(i.display_name, ''), i.full_name) as influencer, m.order_amount_minor, m.commission_minor, m.currency,
             m.status, m.created_at, m.note, m.withdrawal_id, au.email as customer_email, pay.status as payment_status
        from public.commissions m
        join public.promo_codes c on c.id = m.promo_code_id
        join public.influencers i on i.id = m.influencer_id
        join public.payments pay on pay.id = m.payment_id
        left join auth.users au on au.id = pay.user_id
       where p_status is null or m.status = p_status
       order by m.created_at desc limit least(p_limit, 500) offset p_offset) r), '[]'::jsonb));
end $$;
revoke all on function public.admin_ledger(text, int, int) from public, anon;
grant execute on function public.admin_ledger(text, int, int) to authenticated;

-- cancel: disqualify an order (fraud, self-referral) | reverse: the customer was refunded
-- approve: release early | reinstate: undo a cancel
create or replace function public.admin_ledger_action(p_id bigint, p_action text, p_note text default '') returns void
language plpgsql security definer set search_path = public, auth as $$
declare m record; wid bigint; wstatus text;
begin
  perform public._admin_guard();
  select * into m from public.commissions where id = p_id for update;
  if not found then raise exception 'Transaction not found.'; end if;
  if m.withdrawal_id is not null then select id, status into wid, wstatus from public.withdrawals where id = m.withdrawal_id; end if;

  if p_action = 'cancel' then
    if m.status not in ('pending','approved') then raise exception 'Only pending or approved commissions can be cancelled.'; end if;
    if wid is not null then raise exception 'This commission is part of withdrawal #%. Reject that withdrawal first.', wid; end if;
    update public.commissions set status = 'cancelled', status_changed_at = now(), note = left(coalesce(nullif(p_note, ''), 'Cancelled by admin.'), 500) where id = p_id;
  elsif p_action = 'reverse' then
    if m.status not in ('pending','approved') then raise exception 'Only pending or approved commissions can be reversed.'; end if;
    if wid is not null and wstatus in ('pending','approved') then raise exception 'This commission is in withdrawal #% that is still open. Reject it first.', wid; end if;
    update public.commissions set status = 'reversed', status_changed_at = now(),
           clawback_open = (wid is not null and wstatus = 'paid'),
           note = left(coalesce(nullif(p_note, ''), 'Reversed: the customer was refunded.'), 500) where id = p_id;
    update public.payments set status = 'refunded', refunded_at = now() where id = m.payment_id;
  elsif p_action = 'approve' then
    if m.status <> 'pending' then raise exception 'Only pending commissions can be approved.'; end if;
    update public.commissions set status = 'approved', status_changed_at = now(), note = left(coalesce(nullif(p_note, ''), m.note), 500) where id = p_id;
  elsif p_action = 'reinstate' then
    if m.status <> 'cancelled' then raise exception 'Only cancelled commissions can be reinstated.'; end if;
    update public.commissions set status = 'pending', status_changed_at = now(), note = left(coalesce(nullif(p_note, ''), 'Reinstated by admin.'), 500) where id = p_id;
  else
    raise exception 'Unknown action.';
  end if;
end $$;
revoke all on function public.admin_ledger_action(bigint, text, text) from public, anon;
grant execute on function public.admin_ledger_action(bigint, text, text) to authenticated;

-- Withdrawal management ---------------------------------------------------------------------------------------------------------------
create or replace function public.admin_withdrawals(p_status text default null) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(r) from (
    select w.id, w.influencer_id, coalesce(nullif(i.display_name, ''), i.full_name) as influencer, w.gross_minor, w.net_minor, w.tds_minor, w.fee_minor,
           w.currency, w.requested_at, w.method, w.status, w.paid_at,
           coalesce((select p.verification from public.influencer_payouts p where p.influencer_id = i.id), 'none') as payout
      from public.withdrawals w join public.influencers i on i.id = w.influencer_id
     where p_status is null or w.status = p_status
     order by case w.status when 'pending' then 0 when 'approved' then 1 else 2 end, w.requested_at desc limit 300) r), '[]'::jsonb);
end $$;
revoke all on function public.admin_withdrawals(text) from public, anon;
grant execute on function public.admin_withdrawals(text) to authenticated;

create or replace function public.admin_withdrawal_detail(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare w record; result jsonb;
begin
  perform public._admin_guard();
  select * into w from public.withdrawals where id = p_id;
  if not found then return null; end if;
  select jsonb_build_object(
    'withdrawal', to_jsonb(w),
    'influencer', (select jsonb_build_object('id', i.id, 'name', coalesce(nullif(i.display_name, ''), i.full_name), 'full_name', i.full_name, 'status', i.status,
                      'phone', i.phone, 'email', i.email, 'city', i.city, 'state', i.state, 'joined', i.created_at) from public.influencers i where i.id = w.influencer_id),
    'payout', (select to_jsonb(p) from public.influencer_payouts p where p.influencer_id = w.influencer_id),
    'previous', coalesce((select jsonb_agg(x) from (select id, currency, gross_minor, net_minor, status, requested_at, paid_at, payout_reference from public.withdrawals where influencer_id = w.influencer_id and id <> w.id order by requested_at desc limit 20) x), '[]'::jsonb),
    'commissions', coalesce((select jsonb_agg(c) from (
        select m.id, m.order_ref, pc.code, m.order_amount_minor, m.commission_minor, m.currency, m.status, m.created_at
          from public.commissions m join public.promo_codes pc on pc.id = m.promo_code_id where m.withdrawal_id = w.id order by m.created_at) c), '[]'::jsonb)
  ) into result;
  return result;
end $$;
revoke all on function public.admin_withdrawal_detail(bigint) from public, anon;
grant execute on function public.admin_withdrawal_detail(bigint) to authenticated;

create or replace function public.admin_withdrawal_action(p_id bigint, p_action text, p_note text default '', p_reference text default '') returns void
language plpgsql security definer set search_path = public, auth as $$
declare w record; ids bigint[];
begin
  perform public._admin_guard();
  select * into w from public.withdrawals where id = p_id for update;
  if not found then raise exception 'Withdrawal not found.'; end if;

  if p_action = 'approve' then
    if w.status <> 'pending' then raise exception 'Only pending withdrawals can be approved.'; end if;
    update public.withdrawals set status = 'approved', reviewed_at = now(), admin_note = left(coalesce(p_note, ''), 500) where id = p_id;
  elsif p_action = 'paid' then
    if w.status <> 'approved' then raise exception 'Approve the withdrawal before marking it paid.'; end if;
    if btrim(coalesce(p_reference, '')) = '' then raise exception 'Enter the transaction reference (UTR) of the transfer.'; end if;
    update public.withdrawals set status = 'paid', paid_at = now(), payout_reference = left(btrim(p_reference), 120), admin_note = left(coalesce(nullif(p_note, ''), w.admin_note), 500) where id = p_id;
  elsif p_action = 'reject' then
    if w.status not in ('pending','approved') then raise exception 'This withdrawal can no longer be rejected.'; end if;
    if btrim(coalesce(p_note, '')) = '' then raise exception 'Write the reason, so the influencer can see it.'; end if;
    update public.withdrawals set status = 'rejected', reviewed_at = now(), admin_note = left(btrim(p_note), 500) where id = p_id;
    -- The money goes back to the influencer's balance, and any clawback that was netted off becomes open again.
    update public.commissions set withdrawal_id = null where withdrawal_id = p_id;
    select coalesce(array_agg(x::bigint), '{}') into ids from jsonb_array_elements_text(coalesce(w.breakdown -> 'clawback_ids', '[]'::jsonb)) x;
    update public.commissions set clawback_open = true where id = any(ids);
  else
    raise exception 'Unknown action.';
  end if;
end $$;
revoke all on function public.admin_withdrawal_action(bigint, text, text, text) from public, anon;
grant execute on function public.admin_withdrawal_action(bigint, text, text, text) to authenticated;

-- Suspicious activity ----------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_fraud_flags() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare flags jsonb := '[]'::jsonb;
begin
  perform public._admin_guard();

  -- Buyer is the influencer (same account or same email).
  flags := flags || coalesce((select jsonb_agg(jsonb_build_object('kind', 'self_referral', 'severity', 'high', 'influencer_id', i.id,
      'influencer', coalesce(nullif(i.display_name, ''), i.full_name), 'code', c.code, 'count', 1, 'at', m.created_at,
      'detail', 'Order ' || upper(right(m.order_ref, 8)) || ' was bought by the influencer themselves.'))
    from public.commissions m join public.influencers i on i.id = m.influencer_id join public.promo_codes c on c.id = m.promo_code_id
    join public.payments pay on pay.id = m.payment_id
    where (i.user_id is not null and i.user_id = pay.user_id) or m.note like 'Self-referral%'), '[]'::jsonb);

  -- One customer using more than one creator code.
  flags := flags || coalesce((select jsonb_agg(jsonb_build_object('kind', 'multiple_codes', 'severity', 'medium', 'influencer_id', null, 'influencer', au.email, 'code', x.codes, 'count', x.n,
      'at', x.last_at, 'detail', 'This customer paid ' || x.n || ' times using ' || x.n_codes || ' different creator codes.'))
    from (select pay.user_id, count(*) n, count(distinct pay.promo_code_id) n_codes, string_agg(distinct c.code, ', ') codes, max(pay.created_at) last_at
            from public.payments pay join public.promo_codes c on c.id = pay.promo_code_id where pay.user_id is not null
           group by pay.user_id having count(distinct pay.promo_code_id) > 1) x
    join auth.users au on au.id = x.user_id), '[]'::jsonb);

  -- Many cancelled or reversed commissions.
  flags := flags || coalesce((select jsonb_agg(jsonb_build_object('kind', 'cancellations', 'severity', case when x.bad >= 5 then 'high' else 'medium' end, 'influencer_id', x.influencer_id,
      'influencer', x.name, 'code', null, 'count', x.bad, 'at', x.last_at,
      'detail', x.bad || ' of ' || x.total || ' commissions were cancelled or reversed (' || round(100.0 * x.bad / x.total) || '%).'))
    from (select m.influencer_id, coalesce(nullif(i.display_name, ''), i.full_name) name, count(*) total, count(*) filter (where m.status in ('cancelled','reversed')) bad, max(m.status_changed_at) last_at
            from public.commissions m join public.influencers i on i.id = m.influencer_id group by m.influencer_id, i.display_name, i.full_name) x
   where x.bad >= 3 and x.bad::numeric / x.total >= 0.3), '[]'::jsonb);

  -- Refunds after the commission was already credited.
  flags := flags || coalesce((select jsonb_agg(jsonb_build_object('kind', 'refunds', 'severity', case when x.n >= 3 then 'high' else 'low' end, 'influencer_id', x.influencer_id,
      'influencer', x.name, 'code', null, 'count', x.n, 'at', x.last_at, 'detail', x.n || ' refunded order(s) after the commission was credited.'))
    from (select m.influencer_id, coalesce(nullif(i.display_name, ''), i.full_name) name, count(*) n, max(pay.refunded_at) last_at
            from public.commissions m join public.influencers i on i.id = m.influencer_id join public.payments pay on pay.id = m.payment_id
           where pay.status = 'refunded' group by m.influencer_id, i.display_name, i.full_name) x), '[]'::jsonb);

  -- Unusual patterns: a burst of orders for one code, or many brand-new accounts buying with the same code.
  flags := flags || coalesce((select jsonb_agg(jsonb_build_object('kind', 'burst', 'severity', 'medium', 'influencer_id', x.influencer_id, 'influencer', x.name, 'code', x.code,
      'count', x.n, 'at', x.at, 'detail', x.n || ' orders with this code within one hour.'))
    from (select distinct on (c.id) c.influencer_id, coalesce(nullif(i.display_name, ''), i.full_name) name, c.code, p1.created_at at,
                 (select count(*) from public.payments p2 where p2.promo_code_id = p1.promo_code_id and p2.created_at >= p1.created_at and p2.created_at < p1.created_at + interval '1 hour') n
            from public.payments p1 join public.promo_codes c on c.id = p1.promo_code_id join public.influencers i on i.id = c.influencer_id
           where p1.promo_code_id is not null
           order by c.id, (select count(*) from public.payments p2 where p2.promo_code_id = p1.promo_code_id and p2.created_at >= p1.created_at and p2.created_at < p1.created_at + interval '1 hour') desc) x
   where x.n >= 4), '[]'::jsonb);

  flags := flags || coalesce((select jsonb_agg(jsonb_build_object('kind', 'fresh_accounts', 'severity', 'medium', 'influencer_id', x.influencer_id, 'influencer', x.name, 'code', null,
      'count', x.n, 'at', x.last_at, 'detail', x.n || ' buyers created their account less than 10 minutes before paying with this influencer''s codes.'))
    from (select c.influencer_id, coalesce(nullif(i.display_name, ''), i.full_name) name, count(*) n, max(pay.created_at) last_at
            from public.payments pay join public.promo_codes c on c.id = pay.promo_code_id join public.influencers i on i.id = c.influencer_id
            join auth.users au on au.id = pay.user_id
           where pay.created_at - au.created_at < interval '10 minutes'
           group by c.influencer_id, i.display_name, i.full_name having count(*) >= 3) x), '[]'::jsonb);

  return flags;
end $$;
revoke all on function public.admin_fraud_flags() from public, anon;
grant execute on function public.admin_fraud_flags() to authenticated;

-- Discount offers ------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_discount_offers() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(r order by r.created_at desc) from (
    select o.id, o.code, o.title, o.discount_bps, o.starts_at, o.ends_at, o.max_uses, o.active, o.note, o.created_at,
           (select count(*) from public.payments p where p.offer_id = o.id and p.status = 'paid') as uses,
           coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(offer_discount_minor) s from public.payments where offer_id = o.id and status = 'paid' group by currency) x), '{}'::jsonb) as discount_given,
           coalesce((select jsonb_object_agg(currency, s) from (select currency, sum(amount_minor) s from public.payments where offer_id = o.id and status = 'paid' group by currency) x), '{}'::jsonb) as revenue
      from public.discount_offers o) r), '[]'::jsonb);
end $$;
revoke all on function public.admin_discount_offers() from public, anon;
grant execute on function public.admin_discount_offers() to authenticated;

create or replace function public.admin_offer_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare id_in uuid := nullif(p ->> 'id', '')::uuid; c text := public._norm_code(p ->> 'code'); bps int; row_id uuid;
begin
  perform public._admin_guard();
  begin bps := round((p ->> 'discount_percent')::numeric * 100); exception when others then bps := null; end;
  if bps is null or bps < 100 or bps > 9000 then raise exception 'The discount must be between 1%% and 90%%.'; end if;
  if c = '' then c := 'OFFER' || lpad(floor(random() * 10000)::text, 4, '0'); end if;
  if c !~ '^[A-Z0-9]{4,16}$' then raise exception 'Offer codes use 4 to 16 letters and numbers.'; end if;
  if nullif(p ->> 'starts_at', '') is not null and nullif(p ->> 'ends_at', '') is not null and (p ->> 'ends_at')::timestamptz <= (p ->> 'starts_at')::timestamptz then
    raise exception 'The end date must be after the start date.';
  end if;
  begin
    if id_in is null then
      insert into public.discount_offers (code, title, discount_bps, starts_at, ends_at, max_uses, active, note)
      values (c, left(btrim(coalesce(p ->> 'title', '')), 80), bps, nullif(p ->> 'starts_at', '')::timestamptz, nullif(p ->> 'ends_at', '')::timestamptz,
              nullif(p ->> 'max_uses', '')::int, coalesce((p ->> 'active')::boolean, true), left(btrim(coalesce(p ->> 'note', '')), 500))
      returning id into row_id;
    else
      update public.discount_offers set code = c, title = left(btrim(coalesce(p ->> 'title', '')), 80), discount_bps = bps,
             starts_at = nullif(p ->> 'starts_at', '')::timestamptz, ends_at = nullif(p ->> 'ends_at', '')::timestamptz,
             max_uses = nullif(p ->> 'max_uses', '')::int, active = coalesce((p ->> 'active')::boolean, active), note = left(btrim(coalesce(p ->> 'note', '')), 500)
       where id = id_in returning id into row_id;
    end if;
  exception when unique_violation then
    raise exception 'That code is already in use. Choose another.';
  end;
  return jsonb_build_object('id', row_id, 'code', c);
end $$;
revoke all on function public.admin_offer_save(jsonb) from public, anon;
grant execute on function public.admin_offer_save(jsonb) to authenticated;

create or replace function public.admin_offer_set_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  update public.discount_offers set active = p_active where id = p_id;
end $$;
revoke all on function public.admin_offer_set_active(uuid, boolean) from public, anon;
grant execute on function public.admin_offer_set_active(uuid, boolean) to authenticated;

create or replace function public.admin_offer_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  if exists (select 1 from public.payments where offer_id = p_id) then raise exception 'This offer has been used. Turn it off instead of deleting it.'; end if;
  delete from public.discount_offers where id = p_id;
end $$;
revoke all on function public.admin_offer_delete(uuid) from public, anon;
grant execute on function public.admin_offer_delete(uuid) to authenticated;

-- Support inbox ----------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_influencer_messages(p_resolved boolean default false) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(r) from (
    select m.id, m.influencer_id, coalesce(nullif(i.display_name, ''), i.full_name) as influencer, coalesce(i.email, '') as email, m.subject, m.message, m.resolved, m.created_at
      from public.influencer_messages m join public.influencers i on i.id = m.influencer_id
     where m.resolved = p_resolved order by m.created_at desc limit 200) r), '[]'::jsonb);
end $$;
revoke all on function public.admin_influencer_messages(boolean) from public, anon;
grant execute on function public.admin_influencer_messages(boolean) to authenticated;

create or replace function public.admin_message_resolve(p_id bigint, p_resolved boolean default true) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  update public.influencer_messages set resolved = p_resolved where id = p_id;
end $$;
revoke all on function public.admin_message_resolve(bigint, boolean) from public, anon;
grant execute on function public.admin_message_resolve(bigint, boolean) to authenticated;

-- Settings ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_get_settings() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_object_agg(key, value) from public.platform_settings), '{}'::jsonb);
end $$;
revoke all on function public.admin_get_settings() from public, anon;
grant execute on function public.admin_get_settings() to authenticated;

create or replace function public.admin_set_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare k text; v jsonb;
begin
  perform public._admin_guard();
  for k, v in select * from jsonb_each(p) loop
    if k in ('refund_window_days','max_codes_per_influencer') then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 90 or (v #>> '{}')::numeric <> floor((v #>> '{}')::numeric) then raise exception 'Invalid value for %', k; end if;
    elsif k in ('default_customer_discount_bps','default_commission_bps','tds_bps','tds_no_pan_bps') then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 9000 or (v #>> '{}')::numeric <> floor((v #>> '{}')::numeric) then raise exception 'Invalid value for %', k; end if;
    elsif k in ('min_withdrawal_minor','tds_threshold_minor','payout_fee_minor') then
      if jsonb_typeof(v) <> 'object' then raise exception 'Invalid value for %', k; end if;
    else
      raise exception 'Unknown setting %', k;
    end if;
    insert into public.platform_settings (key, value, updated_at) values (k, v, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end loop;
  return public.admin_get_settings();
end $$;
revoke all on function public.admin_set_settings(jsonb) from public, anon;
grant execute on function public.admin_set_settings(jsonb) to authenticated;
