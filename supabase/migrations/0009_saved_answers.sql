-- Fillie cloud schema, part 9: answers a user hearted while filling a form ("Interview prep").
-- Additive: one column. The extension writes it on every application save, so apply this BEFORE the extension update goes out.
alter table public.applications
  add column if not exists saved_answers jsonb not null default '[]'::jsonb;

-- A list, and not unreasonably large (the extension keeps at most 80 answers of a few thousand characters).
do $$ begin
  alter table public.applications add constraint applications_saved_answers_valid
    check (jsonb_typeof(saved_answers) = 'array' and pg_column_size(saved_answers) < 400000);
exception when duplicate_object then null; end $$;
