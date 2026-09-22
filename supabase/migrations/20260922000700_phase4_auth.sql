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
