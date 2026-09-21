-- ─── PHASE 3 VERIFICATION ─────────────────────────────────────────────────────
--
-- Run this in the Supabase SQL Editor after supabase/apply-all.sql.
-- It reads only the catalog — it creates nothing, changes nothing, and needs no
-- privileges beyond reading system views. Copy the whole result back for review.
--
-- Every application-controlled row should read PASS.
--
-- Check 18 is expected to FAIL on Supabase: the default privileges it reports
-- are owned by `supabase_admin`, which a project owner cannot alter. That is
-- recorded as accepted residual RES-001, and the check is deliberately NOT
-- softened to produce a green board — see docs/phase-3-verification.md.
-- Check 19 is the compensating control.
--
-- The final row is the overall verdict, and it counts check 18's FAIL.

with expected_tables(name) as (
  values ('area_notes'), ('audit_log'), ('idempotency_keys'),
         ('import_batches'), ('profiles'), ('tasks')
),
results(ord, check_name, status, detail) as (

  select 1, 'All six tables exist',
    case when count(*) = 6 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(tablename, ', ' order by tablename), '(none)')
  from pg_tables
  where schemaname = 'public' and tablename in (select name from expected_tables)

  union all
  select 2, 'RLS enabled on every table',
    case when count(*) filter (where not c.relrowsecurity) = 0 and count(*) = 6 then 'PASS' else 'FAIL' end,
    format('%s of %s enabled', count(*) filter (where c.relrowsecurity), count(*))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in (select name from expected_tables)

  union all
  select 3, 'RLS FORCED on every table (applies to the owner too)',
    case when count(*) filter (where not c.relforcerowsecurity) = 0 and count(*) = 6 then 'PASS' else 'FAIL' end,
    format('%s of %s forced', count(*) filter (where c.relforcerowsecurity), count(*))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in (select name from expected_tables)

  union all
  select 4, 'Zero policies (fail closed, nothing to remove later)',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(tablename || '.' || policyname, ', '), 'none — correct')
  from pg_policies where schemaname = 'public'

  union all
  -- has_table_privilege is grantor-independent and covers privileges held
  -- indirectly through role membership, which information_schema.role_table_grants
  -- does not show unless the grantee role is currently enabled.
  select 5, 'anon and authenticated hold no privilege on any public table',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(format('%s on %s', who, relname), ', '), 'none — correct')
  from (
    select r.rolname as who, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join pg_roles r
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and r.rolname in ('anon', 'authenticated')
      and has_table_privilege(
            r.oid, c.oid,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  ) held

  union all
  -- Kept alongside as a second, independent reading of the same property.
  select 6, 'No catalogued grants to anon or authenticated',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(distinct grantee || ':' || table_name, ', '), 'none — correct')
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')

  union all
  select 7, 'tasks.id is uuid (app-generated ids insert unchanged)',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    coalesce(max(data_type), '(missing)')
  from information_schema.columns
  where table_schema = 'public' and table_name = 'tasks' and column_name = 'id' and data_type = 'uuid'

  union all
  select 8, 'tasks has all 16 columns',
    case when count(*) = 16 then 'PASS' else 'FAIL' end,
    format('%s columns', count(*))
  from information_schema.columns
  where table_schema = 'public' and table_name = 'tasks'

  union all
  select 9, 'Sharing invariant constraint present',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    coalesce(max(conname), '(missing)')
  from pg_constraint
  where conname = 'tasks_shared_only_in_shared_areas'

  union all
  -- Named rather than counted, so a missing constraint is reported by name.
  select 10, 'All 12 tasks CHECK constraints present',
    case when count(*) = 12 then 'PASS' else 'FAIL' end,
    case when count(*) = 12 then '12 of 12'
         else 'missing: ' || (
           select string_agg(e.name, ', ' order by e.name)
           from (values
             ('tasks_title_not_blank'), ('tasks_area_valid'), ('tasks_status_valid'),
             ('tasks_priority_valid'), ('tasks_visibility_valid'), ('tasks_created_by_valid'),
             ('tasks_source_valid'), ('tasks_shared_only_in_shared_areas'),
             ('tasks_due_time_requires_due_date'), ('tasks_completed_at_matches_status'),
             ('tasks_owner_not_blank'), ('tasks_import_key_not_blank')
           ) as e(name)
           where not exists (
             select 1 from pg_constraint c
             where c.conrelid = 'public.tasks'::regclass and c.contype = 'c' and c.conname = e.name
           )
         )
    end
  from pg_constraint c2
  join (values
    ('tasks_title_not_blank'), ('tasks_area_valid'), ('tasks_status_valid'),
    ('tasks_priority_valid'), ('tasks_visibility_valid'), ('tasks_created_by_valid'),
    ('tasks_source_valid'), ('tasks_shared_only_in_shared_areas'),
    ('tasks_due_time_requires_due_date'), ('tasks_completed_at_matches_status'),
    ('tasks_owner_not_blank'), ('tasks_import_key_not_blank')
  ) as expected(name) on expected.name = c2.conname
  where c2.conrelid = 'public.tasks'::regclass and c2.contype = 'c'

  union all
  select 11, 'Partial unique index on (source, import_key)',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    coalesce(max(indexname), '(missing)')
  from pg_indexes
  where schemaname = 'public' and indexname = 'tasks_source_import_key_unique'

  union all
  -- Both guards: the row-level one cannot fire on TRUNCATE, so the
  -- statement-level one is what stops the log being emptied in one statement.
  select 12, 'audit_log guards present (append-only AND no-truncate)',
    case when count(*) = 2 then 'PASS' else 'FAIL' end,
    case when count(*) = 2 then 'audit_log_append_only, audit_log_no_truncate'
         else 'missing: ' || coalesce((
           select string_agg(e.name, ', ' order by e.name)
           from (values ('audit_log_append_only'), ('audit_log_no_truncate')) as e(name)
           where not exists (
             select 1 from pg_trigger g
             where g.tgrelid = 'public.audit_log'::regclass
               and g.tgname = e.name and not g.tgisinternal)
         ), '(none)')
    end
  from pg_trigger
  where tgrelid = 'public.audit_log'::regclass
    and tgname in ('audit_log_append_only', 'audit_log_no_truncate')
    and not tgisinternal

  union all
  select 13, 'updated_at triggers present on tasks, area_notes, profiles',
    case when count(*) = 3 then 'PASS' else 'FAIL' end,
    format('%s of 3', count(*))
  from pg_trigger
  where tgname like '%touch_updated_at' and not tgisinternal

  union all
  select 14, 'Internal app schema and its two functions exist',
    case when count(*) = 2 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(p.proname, ', ' order by p.proname), '(missing)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname in ('touch_updated_at', 'forbid_mutation')

  union all
  select 15, 'Area vocabulary lists all seven areas',
    case when (select pg_get_constraintdef(oid) from pg_constraint where conname = 'tasks_area_valid')
              like '%inbox%school%work%reading%family%faith%home%'
         then 'PASS' else 'FAIL' end,
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'tasks_area_valid'), '(missing)')

  union all
  select 16, 'profiles covers the three human roles and excludes pong',
    case when (select pg_get_constraintdef(oid) from pg_constraint where conname = 'profiles_role_valid')
              not like '%pong%'
         and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'profiles_role_valid')
              like '%fon%abigail%accountability%'
         then 'PASS' else 'FAIL' end,
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'profiles_role_valid'), '(missing)')

  union all
  select 17, 'No task data present yet (schema only, as expected in Phase 3)',
    case when (select count(*) from public.tasks) = 0 then 'PASS' else 'NOTE' end,
    format('%s task rows', (select count(*) from public.tasks))

  union all
  -- ALTER DEFAULT PRIVILEGES is scoped to the role that ran it, so an entry
  -- owned by another role survives an unqualified revoke and silently grants
  -- anon on every table created later.
  select 18, 'No default privileges granting anon or authenticated in public',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(format('%s owns %s', pg_get_userbyid(defaclrole), defaclobjtype), ', '),
             'none — correct')
  from pg_default_acl
  where defaclnamespace = 'public'::regnamespace
    and (defaclacl::text like '%anon=%' or defaclacl::text like '%authenticated=%')

  union all
  -- Catches a table created outside these migrations — via the dashboard, or by
  -- a later phase — that would otherwise sit in public with RLS off.
  select 19, 'EVERY table in public has RLS enabled and forced (not just the six)',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(c.relname, ', ' order by c.relname), 'none unprotected — correct')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and (not c.relrowsecurity or not c.relforcerowsecurity)
)

select ord as "#", check_name as "check", status, detail from results
union all
-- Context row. Status is NOTE, so it changes no check and no verdict: the
-- OVERALL count below still sees check 18's FAIL.
select 98, 'CONTEXT: check 18 is a platform-owned default ACL this project cannot alter',
  'NOTE',
  'Accepted residual RES-001 — see docs/phase-3-verification.md. Every other check is application-controlled.'
union all
select 99, 'OVERALL',
  case when exists (select 1 from results where status = 'FAIL') then 'FAIL' else 'PASS' end,
  format('%s passed, %s failed', (select count(*) from results where status = 'PASS'),
                                 (select count(*) from results where status = 'FAIL'))
order by 1;
