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

-- Stop future tables in this schema from inheriting the default grants.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- The app schema is internal; the API roles have no business there at all.
revoke all on schema app from anon, authenticated;
