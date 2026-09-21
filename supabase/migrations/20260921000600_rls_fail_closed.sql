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
