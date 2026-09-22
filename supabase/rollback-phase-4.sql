-- ─── ROLLBACK: PHASE 4 ONLY ───────────────────────────────────────────────────
--
-- Undoes 20260922000700_phase4_auth.sql and nothing else. After this runs the
-- database is back to the Phase 3 posture: RLS enabled and forced, zero
-- policies, no api-role privileges. That is the SAFE direction — every row
-- becomes unreachable again, rather than exposed.
--
-- This is NOT supabase/rollback.sql, which destroys the Phase 3 schema and
-- every task in it. This file drops only what Phase 4 added: policies, grants,
-- two triggers and their functions, the view, and the role function.
--
-- WHAT IT MUST NEVER TOUCH, and does not:
--
--   auth.users    Deleting someone's account is a separate, deliberate, manual
--                 Dashboard action. It is never scripted, never part of a
--                 rollback file, and never bundled with a schema change.
--                 Losing a schema change must not cost somebody their account.
--
--   profiles rows Role assignments survive a policy rollback, so re-applying
--                 Phase 4 does not mean re-enrolling three people. The table
--                 itself is Phase 3's and stays; only its policy is dropped.
--
--   task data     No row is deleted. Provenance is left exactly as it stands.
--
-- Safe to run twice, and safe on a database that never had Phase 4 applied.
-- Every statement is guarded.

-- ─── The view ─────────────────────────────────────────────────────────────────
drop view if exists public.school_summary;

-- ─── Policies ─────────────────────────────────────────────────────────────────
drop policy if exists tasks_fon_select    on public.tasks;
drop policy if exists tasks_fon_insert    on public.tasks;
drop policy if exists tasks_fon_update    on public.tasks;
drop policy if exists tasks_fon_delete    on public.tasks;
drop policy if exists tasks_abigail_select on public.tasks;
drop policy if exists tasks_abigail_insert on public.tasks;
drop policy if exists tasks_abigail_update on public.tasks;

drop policy if exists area_notes_fon_select            on public.area_notes;
drop policy if exists area_notes_fon_insert            on public.area_notes;
drop policy if exists area_notes_fon_update            on public.area_notes;
drop policy if exists area_notes_abigail_select        on public.area_notes;
drop policy if exists area_notes_abigail_insert        on public.area_notes;
drop policy if exists area_notes_abigail_update        on public.area_notes;
drop policy if exists area_notes_accountability_select on public.area_notes;

drop policy if exists profiles_select_own on public.profiles;

-- ─── Provenance triggers ──────────────────────────────────────────────────────
drop trigger if exists tasks_stamp_provenance         on public.tasks;
drop trigger if exists tasks_forbid_provenance_change on public.tasks;

drop function if exists app.stamp_task_provenance();
drop function if exists app.forbid_provenance_change();

-- ─── Grants ───────────────────────────────────────────────────────────────────
--
-- Back to the Phase 3 lockdown: the api roles hold nothing on any public table
-- and nothing in the app schema.
revoke all on public.tasks      from anon, authenticated;
revoke all on public.area_notes from anon, authenticated;
revoke all on public.profiles   from anon, authenticated;

alter default privileges for role postgres in schema app
  grant execute on functions to public;

revoke all on schema app from anon, authenticated;

-- ─── The role function ────────────────────────────────────────────────────────
--
-- Dropped last: the policies and the view above reference it.
drop function if exists app.current_app_role();

-- USAGE on schema public is deliberately left alone. Phase 4 never granted it —
-- it predates Phase 3 — so revoking it here would break more than it undoes.
