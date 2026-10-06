-- Fillie cloud schema, part 3: explicit table and function privileges.
--
-- Why this exists: in this project the default privileges for new tables in
-- `public` give anon, authenticated and service_role NO select/insert/update/
-- delete (only TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). RLS was never the problem:
-- service_role bypasses it. The Stripe webhook failed with
--   42501 permission denied for table payments
-- because service_role had no INSERT on the table, and the signed-in app would
-- have hit the same error on its own tables.
--
-- Least privilege: every grant below matches an RLS policy or a server function.
-- Safe to run more than once.

-- Start from nothing, so leftover default privileges (e.g. TRUNCATE) do not stay.
revoke all on table
  public.applications, public.backups, public.entitlements, public.feedback,
  public.payments, public.trial_usage, public.usage_events, public.user_settings
from anon, authenticated, service_role;

-- Server side (Edge Functions use the service role): the webhooks write payments
-- and entitlements; the trial function writes trial_usage and usage_events.
grant select, insert, update, delete on table
  public.applications, public.backups, public.entitlements, public.feedback,
  public.payments, public.trial_usage, public.usage_events, public.user_settings
to service_role;

-- Signed-in users: only what the extension does, and only for their own rows
-- (the RLS policies in 0001 and 0002 enforce "own rows").
grant select, insert, update, delete on table public.applications to authenticated;
grant select, insert, update, delete on table public.backups      to authenticated;
grant select                         on table public.entitlements to authenticated;  -- read-only: users can never grant themselves access
grant select, insert                 on table public.feedback     to authenticated;
grant insert                         on table public.usage_events to authenticated;
grant select, insert, update         on table public.user_settings to authenticated;

-- payments and trial_usage: service role only. anon gets nothing anywhere.

-- Identity columns inserted through the API need their sequences.
grant usage, select on sequence public.payments_id_seq     to service_role;
grant usage, select on sequence public.feedback_id_seq     to service_role, authenticated;
grant usage, select on sequence public.usage_events_id_seq to service_role, authenticated;

-- The trial function calls increment_trial through the API as service_role.
grant execute on function public.increment_trial(text, date) to service_role;
grant execute on function public.prune_trial_usage()          to service_role;
