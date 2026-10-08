import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/** A tiny stand-in for the parts of Supabase that the migrations rely on (roles, auth, storage). */
export const SUPABASE_STUBS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz not null default now(), last_sign_in_at timestamptz);
  create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid, provider text, identity_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit int, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  grant usage on schema auth, storage to anon, authenticated, service_role;
`;

export const MIGRATIONS = [
  '0001_init', '0002_payments_feedback_admin', '0003_table_grants', '0004_offered_ctc', '0005_influencers', '0006_influencer_api', '0007_influencer_admin', '0008_public_offers', '0009_saved_answers',
];

/** An in-memory Postgres with every migration applied. */
export async function makeDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const file of MIGRATIONS) await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', `${file}.sql`), 'utf8'));
  return db;
}
