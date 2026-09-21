-- ─── FON'S OS — PHASE 3 SCHEMA ────────────────────────────────────────────────
--
-- GENERATED FILE. Do not edit by hand.
-- Source: supabase/migrations/*.sql   Rebuild: npm run db:build-apply-all
--
-- Paste the whole file into the Supabase SQL Editor and run it, or:
--   psql "$SUPABASE_DB_URL" -f supabase/apply-all.sql
--
-- Safe to run more than once: every statement is guarded, so re-running is a
-- no-op and will not duplicate a constraint, index or trigger, or disturb rows.
--
-- This creates tables with RLS enabled, forced, and NO policies. That denies
-- every row to every role except one holding BYPASSRLS. Nothing can read the
-- board until Phase 4 adds policies. That is intended.
--
-- Afterwards, run supabase/verify.sql to confirm the result.

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260921000100_vocabulary.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── VOCABULARY ───────────────────────────────────────────────────────────────
--
-- Allowed values live in CHECK constraints rather than Postgres enums: the area
-- list is expected to change (Work and Inbox were added in Phase 2), and
-- swapping a constraint is a plain transactional DDL statement whereas
-- ALTER TYPE ... ADD VALUE is not freely reversible.
--
-- Every list here is mirrored from src/lib/areas.js and src/lib/model.js and is
-- asserted against them in supabase/tests/parity.test.mjs, so the database and
-- the app cannot drift apart silently.
--
-- Migrations are written to be re-runnable: applying them twice is a no-op.

create schema if not exists app;

comment on schema app is
  'Internal helpers. Never exposed through PostgREST; public config only, no secrets.';

-- Keeps updated_at honest without clobbering a timestamp the caller set
-- deliberately — the JSON importer carries the original updated_at forward.
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- Append-only enforcement for the audit log. Fires for every role including
-- service_role, which bypasses RLS but not triggers.
create or replace function app.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'relation %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260921000200_profiles.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── PROFILES (Phase 4 preparation only) ──────────────────────────────────────
--
-- Maps a Supabase Auth user to one of the three human roles. This migration
-- creates the vocabulary and the table; it deliberately does NOT create any
-- policy, grant, trigger or sign-up hook. Authentication is Phase 4.
--
-- Pong is intentionally absent: it is not a person and gets no auth user. It
-- will authenticate to our own server-side API in Phase 5, which then talks to
-- Postgres. Pong appears only in the `actor` vocabulary, as an attribution
-- value on tasks and audit rows.

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null,
  display_name text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint profiles_role_valid
    check (role in ('fon', 'abigail', 'accountability'))
);

comment on table public.profiles is
  'Phase 4 preparation. No policies and no grants: unreachable until Phase 4 adds them.';
comment on column public.profiles.role is
  'fon = everything; abigail = Family and Home only; accountability = read-only School summary.';

-- At most one Fon and one accountability viewer; Abigail is likewise singular
-- today but the constraint is expressed per-role so it can be relaxed later.
create unique index if not exists profiles_one_per_role
  on public.profiles (role)
  where role in ('fon', 'abigail', 'accountability');

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function app.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260921000300_tasks.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── TASKS ────────────────────────────────────────────────────────────────────
--
-- One row per task, mirroring the flat array the app already keeps in
-- localStorage (src/lib/model.js). Every field the app carries is represented,
-- so nothing is lost on import: provenance (created_by, source), ownership,
-- visibility, notes, priority, due date and time, completion state, and all
-- three timestamps.
--
-- `id` has a default but the app supplies its own v4 UUID, which is why Phase 2
-- made every id a real UUID. An import is a straight copy, not a re-key.

create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  notes        text not null default '',
  area         text not null,
  status       text not null default 'open',
  priority     text not null default '—',
  due_date     date,
  due_time     time,
  owner        text,
  visibility   text not null default 'private',
  created_by   text not null default 'fon',
  source       text not null default 'manual',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz,

  -- Set by the Claude school importer so a re-import updates rather than
  -- duplicates. Null for anything a human or Pong created.
  import_key   text,

  constraint tasks_title_not_blank
    check (length(btrim(title)) > 0),

  constraint tasks_area_valid
    check (area in ('inbox', 'school', 'work', 'reading', 'family', 'faith', 'home')),

  constraint tasks_status_valid
    check (status in ('open', 'done', 'archived')),

  constraint tasks_priority_valid
    check (priority in ('—', '!', '!!')),

  constraint tasks_visibility_valid
    check (visibility in ('private', 'shared')),

  constraint tasks_created_by_valid
    check (created_by in ('fon', 'abigail', 'pong', 'claude-import')),

  constraint tasks_source_valid
    check (source in ('manual', 'pong-voice', 'claude-import', 'abigail')),

  -- The Phase 2 sharing invariant, now enforced by the database. Abigail can
  -- only ever reach Family and Home, so a task outside those areas can never be
  -- marked shared — not by a bug, not by a bad import, not by direct SQL.
  constraint tasks_shared_only_in_shared_areas
    check (visibility = 'private' or area in ('family', 'home')),

  -- Mirrors normalizeTask: a time with no date is meaningless.
  constraint tasks_due_time_requires_due_date
    check (due_time is null or due_date is not null),

  -- open must have no completion time; done must have one. Archived is left
  -- permissive so a completed task keeps its history when it is archived.
  -- CASE rather than a biconditional so an unknown status falls through to
  -- tasks_status_valid, which reports the actual problem.
  constraint tasks_completed_at_matches_status
    check (
      case status
        when 'open' then completed_at is null
        when 'done' then completed_at is not null
        else true
      end
    ),

  -- The app stores an absent owner as "", which must not reach the database as
  -- a value distinct from "no owner".
  constraint tasks_owner_not_blank
    check (owner is null or length(btrim(owner)) > 0),

  constraint tasks_import_key_not_blank
    check (import_key is null or length(btrim(import_key)) > 0)
);

comment on table public.tasks is
  'Every task across all seven areas. RLS is enabled and forced with no policies: unreachable until Phase 4.';
comment on column public.tasks.id is
  'v4 UUID. The app generates its own ids, so an import copies them unchanged.';
comment on column public.tasks.visibility is
  'shared is only legal in family and home — see tasks_shared_only_in_shared_areas.';
comment on column public.tasks.import_key is
  'Stable key from a Claude school import file. Unique per source; null otherwise.';

-- Duplicate protection for re-imported Claude files. A partial index because
-- null import_keys must never collide with one another.
create unique index if not exists tasks_source_import_key_unique
  on public.tasks (source, import_key)
  where import_key is not null;

create index if not exists tasks_area_status_idx on public.tasks (area, status);
create index if not exists tasks_due_date_idx on public.tasks (due_date) where due_date is not null;
create index if not exists tasks_open_idx on public.tasks (area) where status = 'open';

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function app.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260921000400_area_notes.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── AREA NOTES ───────────────────────────────────────────────────────────────
--
-- The one-line status note shown at the top of each card in My View. Keyed by
-- area, so there is exactly one per area and an import is an upsert.

create table if not exists public.area_notes (
  area       text primary key,
  note       text not null default '',
  updated_at timestamptz not null default now(),

  constraint area_notes_area_valid
    check (area in ('inbox', 'school', 'work', 'reading', 'family', 'faith', 'home'))
);

comment on table public.area_notes is
  'Per-area status note. The School note is the only one the Accountability View may read in Phase 4.';

drop trigger if exists area_notes_touch_updated_at on public.area_notes;
create trigger area_notes_touch_updated_at
  before update on public.area_notes
  for each row execute function app.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260921000500_audit_idempotency_imports.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── AUDIT / IDEMPOTENCY / IMPORT BOOKKEEPING ─────────────────────────────────
--
-- Three tables Phase 5 depends on. Created now so the schema is complete and
-- reviewable, but nothing writes to them yet.

-- Tamper-evident record of every write Pong makes. No foreign key to tasks: the
-- log must outlive the row it describes.
--
-- UPDATE and DELETE are refused by a row-level trigger; TRUNCATE by a
-- statement-level one, because a row-level trigger cannot fire on TRUNCATE and
-- would otherwise let the whole log be emptied in a single statement. Both
-- refuse for every role, service_role included: it bypasses RLS, but not
-- triggers.
--
-- DROP TABLE remains available to the table owner. That is accepted: it is not
-- silent and it requires owner rights, whereas TRUNCATE looks like an ordinary
-- data operation and leaves an intact, empty table behind.
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  action     text not null,
  task_id    uuid,
  before     jsonb,
  after      jsonb,
  request_id text,

  constraint audit_log_actor_valid
    check (actor in ('fon', 'abigail', 'pong', 'claude-import')),
  constraint audit_log_action_not_blank
    check (length(btrim(action)) > 0)
);

comment on table public.audit_log is
  'Append-only: UPDATE, DELETE and TRUNCATE all raise, for every role including service_role, which bypasses RLS but not triggers. DROP TABLE remains available to the owner.';

create index if not exists audit_log_task_id_idx on public.audit_log (task_id);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app.forbid_mutation();

-- TRUNCATE needs its own statement-level trigger: a FOR EACH ROW trigger never
-- fires on it, so without this the entire log could be emptied in one
-- statement, leaving no trace.
drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function app.forbid_mutation();

-- Replay protection for Pong. A repeated voice request carrying the same key
-- returns the stored response instead of acting twice.
create table if not exists public.idempotency_keys (
  key        text primary key,
  actor      text not null,
  task_id    uuid,
  response   jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),

  constraint idempotency_keys_actor_valid
    check (actor in ('fon', 'abigail', 'pong', 'claude-import')),
  constraint idempotency_keys_key_not_blank
    check (length(btrim(key)) > 0),
  constraint idempotency_keys_expiry_after_creation
    check (expires_at > created_at)
);

comment on table public.idempotency_keys is
  'Phase 5 replay protection: duplicate voice requests must not create duplicate tasks.';

create index if not exists idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

-- One row per applied import file. The checksum makes re-running the same
-- export a no-op at the batch level, before any task row is touched.
create table if not exists public.import_batches (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  source_label text not null default '',
  checksum     text not null,
  task_count   integer not null default 0,
  imported_at  timestamptz not null default now(),

  constraint import_batches_kind_valid
    check (kind in ('local-json', 'claude-school')),
  constraint import_batches_checksum_valid
    check (checksum ~ '^[0-9a-f]{64}$'),
  constraint import_batches_task_count_non_negative
    check (task_count >= 0),
  constraint import_batches_unique_payload
    unique (kind, checksum)
);

comment on table public.import_batches is
  'Duplicate protection for imports: the same payload can be applied repeatedly with no effect.';
comment on column public.import_batches.checksum is
  'SHA-256 of the canonicalised payload, lowercase hex.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260921000600_rls_fail_closed.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── ROW LEVEL SECURITY: FAIL CLOSED ──────────────────────────────────────────
--
-- Every table gets RLS ENABLED and FORCED, and **no policies at all**.
--
-- In Postgres, RLS with zero policies denies every row to every non-superuser,
-- non-BYPASSRLS role. That is the whole point: there is no permissive temporary
-- policy to forget to remove later. Phase 4 adds the first policy, and until
-- then `anon` and `authenticated` cannot read or write a single row.
--
-- FORCE is what extends that denial to the table owner as well, so a mistake in
-- a later migration that runs as the owner cannot quietly read the board.
--
-- What this does NOT stop: `service_role` holds BYPASSRLS, so a server holding
-- the service-role key reads and writes everything. That key is the crown
-- jewel. It lives only in server-side environment variables — never in browser
-- code, never in this repository, never in a log or a screenshot. See
-- docs/phase-3-supabase.md, "Keys and where they live".

do $$
declare
  t text;
begin
  foreach t in array array[
    'tasks', 'area_notes', 'profiles', 'audit_log', 'idempotency_keys', 'import_batches'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    -- Supabase grants the API roles broad table privileges by default. Revoke
    -- them so the denial does not rest on RLS alone.
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;

-- ─── DEFAULT PRIVILEGES FOR FUTURE TABLES ─────────────────────────────────────
--
-- `ALTER DEFAULT PRIVILEGES` with no `FOR ROLE` edits only the default-ACL
-- entries owned by the role *executing the statement*. Supabase seeds its own
-- entries for anon/authenticated as `supabase_admin` (or `postgres`), so an
-- unqualified revoke run as anyone else is a silent no-op — and a table created
-- later lands with full anon/authenticated privileges and RLS off.
--
-- So: enumerate every role that owns such an entry in schema `public` and
-- revoke explicitly `FOR ROLE` each one. Re-running is a no-op because the loop
-- finds nothing left to revoke.
--
-- `ALTER DEFAULT PRIVILEGES FOR ROLE x` requires membership of x. If that is
-- missing the statement is skipped with a loud WARNING naming the exact
-- remediation, and `supabase/verify.sql` check 17 reports FAIL — the failure is
-- never silent.

create or replace function app.revoke_api_default_privileges()
returns void
language plpgsql
as $$
declare
  entry     record;
  obj_label text;
  blocked   text := '';
begin
  for entry in
    select distinct pg_get_userbyid(defaclrole) as role_name,
           defaclobjtype as objtype
    from pg_default_acl
    where defaclnamespace = 'public'::regnamespace
      and (defaclacl::text like '%anon=%' or defaclacl::text like '%authenticated=%')
  loop
    obj_label := case entry.objtype
                   when 'r' then 'TABLES'
                   when 'S' then 'SEQUENCES'
                   when 'f' then 'FUNCTIONS'
                   when 'T' then 'TYPES'
                 end;
    continue when obj_label is null;

    begin
      execute format(
        'alter default privileges for role %I in schema public revoke all on %s from anon, authenticated',
        entry.role_name, obj_label
      );
    exception
      when insufficient_privilege then
        blocked := blocked || format(
          E'\n  alter default privileges for role %I in schema public revoke all on %s from anon, authenticated;',
          entry.role_name, obj_label);
    end;
  end loop;

  if blocked <> '' then
    raise warning
      E'Could not revoke default privileges owned by another role (membership required).\nRun these as a role that has it (on Supabase, supabase_admin owns them):%s',
      blocked;
  end if;
end;
$$;

comment on function app.revoke_api_default_privileges() is
  'Revokes anon/authenticated default privileges in public FOR ROLE each owning role. Skips with a WARNING where membership is missing; verify.sql check 18 then reports FAIL.';

select app.revoke_api_default_privileges();

-- Also cover the executing role's own entries, including ones that do not exist
-- yet and so were invisible to the loop above.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- The app schema is internal; the API roles have no business there at all.
revoke all on schema app from anon, authenticated;
