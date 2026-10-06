-- The pay stated in the job posting (e.g. "8-12 LPA"), copied from the page, never guessed.
alter table public.applications add column if not exists offered_ctc text not null default '';
