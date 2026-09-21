-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
--
-- Undoes every Phase 3 migration, in reverse dependency order. Safe to run more
-- than once, and safe to run on a database where the migrations never applied.
--
-- This DESTROYS the tables and everything in them. Before running it on a
-- database that holds real tasks, take a backup:
--
--   1. In the app, My View → "Export backup" (the JSON file is the independent
--      copy — see docs/phase-3-supabase.md).
--   2. Supabase Dashboard → Database → Backups, or
--      pg_dump "$SUPABASE_DB_URL" > fon-os-pre-rollback.sql
--
-- After this runs, re-applying supabase/migrations/*.sql in filename order
-- rebuilds the schema exactly.

drop table if exists public.import_batches cascade;
drop table if exists public.idempotency_keys cascade;
drop table if exists public.audit_log cascade;
drop table if exists public.area_notes cascade;
drop table if exists public.tasks cascade;
drop table if exists public.profiles cascade;

drop function if exists app.touch_updated_at() cascade;
drop function if exists app.forbid_mutation() cascade;

drop schema if exists app cascade;
