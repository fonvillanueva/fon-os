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
