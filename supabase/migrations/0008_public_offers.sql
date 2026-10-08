-- Fillie cloud schema, part 8: offers can be shown to customers ("Explore offers").
-- Additive: one new column (existing offers stay listed) and one new function; the two admin functions are replaced
-- by the same code plus the new column.

alter table public.discount_offers add column if not exists listed boolean not null default true;

-- What a signed-in customer may browse: live, listed, not used up. Influencer codes are never included.
create or replace function public.list_public_offers() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(r order by r.discount_bps desc, r.code) from (
    select o.code, o.title, o.discount_bps, o.ends_at, o.max_uses,
           case when o.max_uses is null then null else greatest(o.max_uses - (select count(*) from public.payments p where p.offer_id = o.id and p.status = 'paid'), 0) end as left
      from public.discount_offers o
     where o.active and o.listed
       and (o.starts_at is null or o.starts_at <= now())
       and (o.ends_at is null or o.ends_at > now())
       and (o.max_uses is null or (select count(*) from public.payments p where p.offer_id = o.id and p.status = 'paid') < o.max_uses)) r), '[]'::jsonb);
end $$;
revoke all on function public.list_public_offers() from public, anon;
grant execute on function public.list_public_offers() to authenticated;

create or replace function public.admin_discount_offers() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public._admin_guard();
  return coalesce((select jsonb_agg(r order by r.created_at desc) from (
    select o.id, o.code, o.title, o.discount_bps, o.starts_at, o.ends_at, o.max_uses, o.active, o.listed, o.note, o.created_at,
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
      insert into public.discount_offers (code, title, discount_bps, starts_at, ends_at, max_uses, active, listed, note)
      values (c, left(btrim(coalesce(p ->> 'title', '')), 80), bps, nullif(p ->> 'starts_at', '')::timestamptz, nullif(p ->> 'ends_at', '')::timestamptz,
              nullif(p ->> 'max_uses', '')::int, coalesce((p ->> 'active')::boolean, true), coalesce((p ->> 'listed')::boolean, true), left(btrim(coalesce(p ->> 'note', '')), 500))
      returning id into row_id;
    else
      update public.discount_offers set code = c, title = left(btrim(coalesce(p ->> 'title', '')), 80), discount_bps = bps,
             starts_at = nullif(p ->> 'starts_at', '')::timestamptz, ends_at = nullif(p ->> 'ends_at', '')::timestamptz,
             max_uses = nullif(p ->> 'max_uses', '')::int, active = coalesce((p ->> 'active')::boolean, active), listed = coalesce((p ->> 'listed')::boolean, listed), note = left(btrim(coalesce(p ->> 'note', '')), 500)
       where id = id_in returning id into row_id;
    end if;
  exception when unique_violation then
    raise exception 'That code is already in use. Choose another.';
  end;
  return jsonb_build_object('id', row_id, 'code', c);
end $$;
revoke all on function public.admin_offer_save(jsonb) from public, anon;
grant execute on function public.admin_offer_save(jsonb) to authenticated;

