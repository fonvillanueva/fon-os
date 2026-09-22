-- ─── FON'S OS — DATABASE SCHEMA (PHASE 3 + PHASE 4) ──────────────────────────
--
-- GENERATED FILE. Do not edit by hand.
-- Source: supabase/migrations/*.sql   Rebuild: npm run db:build-apply-all
--
-- Paste the whole file into the Supabase SQL Editor and run it, or:
--   psql "$SUPABASE_DB_URL" -f supabase/apply-all.sql
--
-- Safe to run more than once: every statement is guarded, so re-running is a
-- no-op and will not duplicate a constraint, index, trigger or policy, or
-- disturb rows.
--
-- Phase 3 creates the tables with RLS enabled and FORCED. Phase 4 adds the
-- first policies: fifteen of them, every one scoped to a person's role in
-- public.profiles. An account with no profiles row still reaches nothing, and
-- nothing here creates one — enrolment stays a deliberate manual step.
--
-- NOT granted by this file: any access to audit_log, idempotency_keys or
-- import_batches; any write path to profiles; any DELETE for Abigail.
--
-- Afterwards, run supabase/verify.sql to confirm the result. Check 18 is
-- EXPECTED to FAIL on Supabase — accepted residual RES-001.

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
-- remediation, and `supabase/verify.sql` check 18 reports FAIL — the failure is
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260922000700_phase4_auth.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── PHASE 4: AUTHENTICATION AND AUTHORIZATION ────────────────────────────────
--
-- Implements docs/phase-4-auth-plan.md. Read that document first; this file is
-- the plan made executable, and the section numbers below point back into it.
--
-- THE ONE-ROLE MODEL (§0). PostgREST authenticates every signed-in person as
-- the same database role, `authenticated`. There is no per-person database
-- role, so the GRANTs below are identical for Fon, Abigail and the
-- accountability viewer — they are the outer envelope of what any signed-in
-- person could possibly do. ALL separation between the three lives in the RLS
-- policies, which resolve the caller's app role from their `profiles` row.
--
-- Read the grants alone and you will get the wrong answer. DELETE is granted on
-- `tasks` because Fon needs it; Abigail is blocked by the ABSENCE of a DELETE
-- policy, not by the grant.
--
-- AN ACCOUNT GRANTS NOTHING. Authorization comes from a `profiles` row that
-- only Fon can create, by Dashboard or SQL. Nothing here creates one, and there
-- is no trigger on `auth.users`. A stray signup therefore resolves to a null
-- role, matches no policy, and reads zero rows — by construction, not by a rule
-- someone has to remember.
--
-- WHAT THIS FILE DOES NOT DO:
--   * no access to audit_log, idempotency_keys or import_batches (§1) — audit
--     reads are deferred to Phase 5, when there is an audit surface to use them
--   * no DELETE policy for Abigail (D1) — she archives instead
--   * no write path to profiles for any client role (D3) — ever
--   * no reference to MFA assurance level in any policy (the D5a invariant)
--   * no new tables, so the Phase 3 lockdown array is unchanged
--
-- Re-runnable: every statement is guarded, so applying twice is a no-op.

-- ─── 1. ROLE RESOLUTION (§3.1) ────────────────────────────────────────────────
--
-- The single point at which a database session becomes a person. Every policy
-- below funnels through it.
--
-- Four properties are load-bearing and each is asserted separately by
-- supabase/verify.sql check 22 and supabase/tests/phase4-auth.test.mjs:
--
--   owner = postgres   a definer function runs as its owner; postgres owns
--                      profiles and holds BYPASSRLS on Supabase, which is what
--                      lets this read profiles through FORCE RLS (see check 21)
--   security definer   so it does not depend on the profiles policy, which
--                      would be circular
--   search_path = ''   blocks search-path hijacking, the classic attack on a
--                      definer function; every name below is schema-qualified
--   stable             lets Postgres evaluate it once per statement
--
-- Returns NULL for a user with no profile row, so every comparison against it
-- is false and every policy fails closed. Returns only the caller's own role;
-- it cannot enumerate anyone else's.
create or replace function app.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select p.role from public.profiles p where p.user_id = auth.uid() $$;

alter function app.current_app_role() owner to postgres;

comment on function app.current_app_role() is
  'The caller''s app role from their profiles row, or NULL when they have none. Definer with an empty search_path. No policy on profiles may call this — it would be circular.';

-- ─── 2. TABLE GRANTS (§3.2) ───────────────────────────────────────────────────
--
-- Phase 3 ran `revoke all on schema app from anon, authenticated`, so this
-- re-grants narrowly. THIS IS THE COMPLETE LIST. Anything not here is an
-- over-grant and fails verify.sql check 5.
--
-- Function privileges are handled in section 4, after every function exists.

grant usage on schema app to authenticated;

-- Tables. `anon` receives nothing, anywhere.
grant select, insert, update, delete on public.tasks      to authenticated;
grant select, insert, update         on public.area_notes to authenticated;
grant select                         on public.profiles   to authenticated;
-- school_summary is granted in section 6, where the view is created.

-- NOT granted, deliberately:
--   audit_log         deferred to Phase 5 (§1). Phase 4 ships no audit surface,
--                     so the grant would buy nothing while widening what a
--                     stolen session can read.
--   idempotency_keys  server-side only
--   import_batches    server-side only
--
-- USAGE on schemas `public` and `auth` is NOT granted here either. Supabase
-- already grants both to `authenticated`, and Phase 3 never revoked them. Every
-- grant above is inert without USAGE on public, and every policy calling
-- auth.uid() fails without USAGE on auth — so check 5a asserts both rather than
-- leaving the dependency silent.
--
-- No sequence grants are needed: the only identity column is audit_log.id, and
-- `authenticated` reaches that table for nothing at all.

-- ─── 3. PROVENANCE (§3.6) ─────────────────────────────────────────────────────
--
-- A. Immutability, for every session and every role including fon and
--    service_role. Mirrors the PATCHABLE_FIELDS allowlist in src/lib/model.js.
create or replace function app.forbid_provenance_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by
     or new.source is distinct from old.source
  then
    raise exception
      'id, created_at, created_by and source are immutable on %.%',
      tg_table_schema, tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function app.forbid_provenance_change() is
  'Rejects any UPDATE that alters id, created_at, created_by or source. Applies to every role — triggers fire for BYPASSRLS roles too.';

-- B. Stamping, for APP SESSIONS ONLY.
--
-- THE SCOPING IS THE WHOLE POINT. The Phase 3 importer runs as a BYPASSRLS
-- role with no auth.uid(), carrying created_by and source from the exported
-- board — including 'pong-voice' and 'claude-import', which no app role maps
-- to. An unconditional stamp would silently rewrite every imported row to
-- fon/manual, destroying exactly the history Phases 2 and 3 preserved.
--
-- So: stamp only when there is a signed-in session AND that session resolves to
-- an app role. Otherwise leave the row exactly as supplied.
create or replace function app.stamp_task_provenance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  app_role text;
begin
  if auth.uid() is null then
    return new;                       -- importer, psql, service_role job
  end if;

  app_role := (select app.current_app_role());
  if app_role is null then
    return new;                       -- signed in but unprofiled; no policy
  end if;                             -- will admit the row anyway

  if app_role = 'fon' then
    new.created_by := 'fon';
    new.source     := 'manual';
  elsif app_role = 'abigail' then
    new.created_by := 'abigail';
    new.source     := 'abigail';
  end if;
  -- accountability cannot reach INSERT at all: no policy, no path.

  return new;
end;
$$;

comment on function app.stamp_task_provenance() is
  'Forces created_by and source from the caller''s app role, but only inside an app session. Sessions without auth.uid() — the Phase 3 importer above all — are left untouched so imported provenance survives byte for byte.';

drop trigger if exists tasks_forbid_provenance_change on public.tasks;
create trigger tasks_forbid_provenance_change
  before update on public.tasks
  for each row execute function app.forbid_provenance_change();

drop trigger if exists tasks_stamp_provenance on public.tasks;
create trigger tasks_stamp_provenance
  before insert on public.tasks
  for each row execute function app.stamp_task_provenance();

-- ─── 4. FUNCTION PRIVILEGES (§3.2) ────────────────────────────────────────────
--
-- Postgres grants EXECUTE to PUBLIC on EVERY new function by default, so
-- granting USAGE on schema `app` in section 2 would otherwise expose all five
-- of these. Each is revoked explicitly, by name, AFTER it exists.
--
-- WHY NOT `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM
-- PUBLIC`, which docs/phase-4-auth-plan.md §3.2 specifies? Because it is a
-- SILENT NO-OP. Postgres stores a default-ACL row as a grant list, and the
-- built-in EXECUTE-to-PUBLIC on functions is implicit rather than an entry that
-- can be subtracted — so the statement records nothing in pg_default_acl and a
-- function created afterwards still lands with owner + PUBLIC. Reproduced four
-- ways in supabase/tests/phase4-auth.test.mjs.
--
-- That is the RES-001 failure mode exactly: a line that reads like a control
-- and does nothing. Shipping it would be worse than useless, because the next
-- reader would trust it. Explicit revokes are used instead, and a test asserts
-- that NO function in `app` is executable by PUBLIC or by anon — which also
-- catches a future function added without a revoke, the case the default
-- privileges line was supposed to cover.
--
-- Revoking EXECUTE does not disturb the triggers that call these: Postgres does
-- not check EXECUTE on a trigger function for the triggering user. Asserted by
-- test, because getting it wrong would break every update.
revoke execute on function app.touch_updated_at()              from public;
revoke execute on function app.forbid_mutation()               from public;
revoke execute on function app.revoke_api_default_privileges() from public;
revoke execute on function app.forbid_provenance_change()      from public;
revoke execute on function app.stamp_task_provenance()         from public;

-- current_app_role() is revoked from PUBLIC first and only then granted to
-- `authenticated`. Granting alone would materialise the ACL with the implicit
-- PUBLIC entry still in it, leaving the function executable by anon.
revoke execute on function app.current_app_role() from public;
grant  execute on function app.current_app_role() to authenticated;

-- ─── 5. POLICIES (§3.3) ───────────────────────────────────────────────────────
--
-- EXACTLY 15 POLICIES, AND NOTHING ELSE ON ANY TABLE. verify.sql check 4
-- compares this set against the catalog in both directions: an extra policy
-- fails, and a missing one fails too.
--
-- Every policy is PERMISSIVE and `to authenticated`. Permissive policies are
-- OR-ed together, which is why an unexpected extra policy is dangerous rather
-- than merely untidy: one `using (true)` would defeat every predicate below.
--
-- `(select app.current_app_role())` — the parenthesised subselect is the
-- Supabase RLS idiom. It makes Postgres evaluate the role ONCE PER QUERY
-- instead of once per row. That changes the plan, not just the constant factor.
--
-- Three absences are load-bearing and easy to mistake for oversights:
--   * accountability holds NO policy on tasks — it reads only the view (§3.7),
--     because RLS is row-level and cannot hide the `notes` column
--   * abigail holds NO DELETE policy (D1) — she archives instead
--   * NO role holds any policy on audit_log, idempotency_keys or
--     import_batches (§1)

-- tasks — fon: everything, every area.
drop policy if exists tasks_fon_select on public.tasks;
create policy tasks_fon_select on public.tasks
  for select to authenticated
  using ((select app.current_app_role()) = 'fon');

drop policy if exists tasks_fon_insert on public.tasks;
create policy tasks_fon_insert on public.tasks
  for insert to authenticated
  with check ((select app.current_app_role()) = 'fon');

drop policy if exists tasks_fon_update on public.tasks;
create policy tasks_fon_update on public.tasks
  for update to authenticated
  using ((select app.current_app_role()) = 'fon')
  with check ((select app.current_app_role()) = 'fon');

drop policy if exists tasks_fon_delete on public.tasks;
create policy tasks_fon_delete on public.tasks
  for delete to authenticated
  using ((select app.current_app_role()) = 'fon');

-- tasks — abigail: shared Family and Home only.
--
-- `visibility = 'shared'` is load-bearing: without it she would see Fon's
-- private Family and Home tasks. It appears in USING *and* WITH CHECK, so the
-- RESULTING row must also satisfy it — which is what blocks move-out,
-- unshare-to-hide, and unshare-then-move.
drop policy if exists tasks_abigail_select on public.tasks;
create policy tasks_abigail_select on public.tasks
  for select to authenticated
  using (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
    and visibility = 'shared'
  );

drop policy if exists tasks_abigail_insert on public.tasks;
create policy tasks_abigail_insert on public.tasks
  for insert to authenticated
  with check (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
    and visibility = 'shared'
  );

drop policy if exists tasks_abigail_update on public.tasks;
create policy tasks_abigail_update on public.tasks
  for update to authenticated
  using (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
    and visibility = 'shared'
  )
  with check (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
    and visibility = 'shared'
  );

-- area_notes — no DELETE for anyone. There are at most seven rows, one per
-- area; blanking a note is an UPDATE. Removing the verb removes a whole class
-- of question, so it is not granted either.
drop policy if exists area_notes_fon_select on public.area_notes;
create policy area_notes_fon_select on public.area_notes
  for select to authenticated
  using ((select app.current_app_role()) = 'fon');

drop policy if exists area_notes_fon_insert on public.area_notes;
create policy area_notes_fon_insert on public.area_notes
  for insert to authenticated
  with check ((select app.current_app_role()) = 'fon');

drop policy if exists area_notes_fon_update on public.area_notes;
create policy area_notes_fon_update on public.area_notes
  for update to authenticated
  using ((select app.current_app_role()) = 'fon')
  with check ((select app.current_app_role()) = 'fon');

drop policy if exists area_notes_abigail_select on public.area_notes;
create policy area_notes_abigail_select on public.area_notes
  for select to authenticated
  using (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
  );

drop policy if exists area_notes_abigail_insert on public.area_notes;
create policy area_notes_abigail_insert on public.area_notes
  for insert to authenticated
  with check (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
  );

drop policy if exists area_notes_abigail_update on public.area_notes;
create policy area_notes_abigail_update on public.area_notes
  for update to authenticated
  using (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
  )
  with check (
    (select app.current_app_role()) = 'abigail'
    and area in ('family', 'home')
  );

-- The School *area* note is displayed in Accountability View today, so it is
-- deliberately readable. It is the area note, not a task note.
drop policy if exists area_notes_accountability_select on public.area_notes;
create policy area_notes_accountability_select on public.area_notes
  for select to authenticated
  using (
    (select app.current_app_role()) = 'accountability'
    and area = 'school'
  );

-- profiles — read your own row, and nothing else, ever (D3).
--
-- NO INSERT, UPDATE OR DELETE POLICY IS CREATED HERE OR IN ANY LATER PHASE, and
-- the verbs are not granted. Roles are assigned only by service_role/postgres
-- through the Dashboard or SQL. This is a standing prohibition, not a Phase 4
-- convenience: a write path to this table is a self-elevation path.
--
-- This predicate must NOT call app.current_app_role(): that function reads
-- profiles, so a profiles policy calling it would be self-referential. Asserted
-- by test.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ─── 6. THE ACCOUNTABILITY VIEW (§3.7, D6) ────────────────────────────────────
--
-- RLS is row-level and cannot hide a column, so the read-only School summary
-- cannot be built from a policy on `tasks` — accountability would then be able
-- to select `notes` directly. It is a definer view exposing a fixed column list
-- instead, and `notes` is not among them.
--
-- security_invoker = false — the view runs as its OWNER and so is not subject
--   to the caller's policies on tasks. That is how accountability reads School
--   rows while holding no tasks policy at all. The role filter therefore has to
--   live INSIDE the view, and it does.
--
--   This works only because the owner can get past FORCE RLS on `tasks`. On
--   Supabase, `postgres` holds BYPASSRLS, which is what makes that true. If it
--   ever stopped holding it, this view would return ZERO ROWS to everyone — a
--   silent outage rather than a leak. verify.sql check 21 and a dedicated test
--   pin that dependency, because the plan documented the behaviour without
--   documenting what it rests on.
--
-- security_barrier = true — without it Postgres may push a caller-supplied
--   WHERE predicate BELOW the view's own filter, so a cheap leaky function in a
--   predicate could observe rows the filter was meant to exclude. The barrier
--   forbids that reordering. It costs some optimiser freedom, which is
--   irrelevant at seven areas and a few hundred rows.
--
-- D6, recorded deliberately: the accountability viewer DOES see School task
-- titles, and never task notes. Anything written into a School task title is
-- visible to them.
drop view if exists public.school_summary;
create view public.school_summary
with (security_invoker = false, security_barrier = true) as
select
  t.id,
  t.title,
  t.status,
  t.priority,
  t.due_date,
  t.due_time,
  t.completed_at,
  t.updated_at
from public.tasks t
where t.area = 'school'
  and (select app.current_app_role()) in ('fon', 'accountability');

alter view public.school_summary owner to postgres;

comment on view public.school_summary is
  'Read-only School summary for the accountability viewer. Definer view with a barrier; exposes titles but never notes (D6). Its column list is pinned by verify.sql check 20.';

grant select on public.school_summary to authenticated;
