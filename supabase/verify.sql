-- ─── PHASE 3 VERIFICATION ─────────────────────────────────────────────────────
--
-- Run this in the Supabase SQL Editor after supabase/apply-all.sql.
-- It reads only the catalog — it creates nothing, changes nothing, and needs no
-- privileges beyond reading system views. Copy the whole result back for review.
--
-- Every row should read PASS. The final row is the overall verdict.

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
  select 5, 'No grants to anon or authenticated',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(distinct grantee || ':' || table_name, ', '), 'none — correct')
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')

  union all
  select 6, 'tasks.id is uuid (app-generated ids insert unchanged)',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    coalesce(max(data_type), '(missing)')
  from information_schema.columns
  where table_schema = 'public' and table_name = 'tasks' and column_name = 'id' and data_type = 'uuid'

  union all
  select 7, 'tasks has all 16 columns',
    case when count(*) = 16 then 'PASS' else 'FAIL' end,
    format('%s columns', count(*))
  from information_schema.columns
  where table_schema = 'public' and table_name = 'tasks'

  union all
  select 8, 'Sharing invariant constraint present',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    coalesce(max(conname), '(missing)')
  from pg_constraint
  where conname = 'tasks_shared_only_in_shared_areas'

  union all
  -- Named rather than counted, so a missing constraint is reported by name.
  select 9, 'All 12 tasks CHECK constraints present',
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
  select 10, 'Partial unique index on (source, import_key)',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    coalesce(max(indexname), '(missing)')
  from pg_indexes
  where schemaname = 'public' and indexname = 'tasks_source_import_key_unique'

  union all
  select 11, 'audit_log append-only trigger present',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    coalesce(max(tgname), '(missing)')
  from pg_trigger
  where tgrelid = 'public.audit_log'::regclass and tgname = 'audit_log_append_only' and not tgisinternal

  union all
  select 12, 'updated_at triggers present on tasks, area_notes, profiles',
    case when count(*) = 3 then 'PASS' else 'FAIL' end,
    format('%s of 3', count(*))
  from pg_trigger
  where tgname like '%touch_updated_at' and not tgisinternal

  union all
  select 13, 'Internal app schema and its two functions exist',
    case when count(*) = 2 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(p.proname, ', ' order by p.proname), '(missing)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname in ('touch_updated_at', 'forbid_mutation')

  union all
  select 14, 'Area vocabulary lists all seven areas',
    case when (select pg_get_constraintdef(oid) from pg_constraint where conname = 'tasks_area_valid')
              like '%inbox%school%work%reading%family%faith%home%'
         then 'PASS' else 'FAIL' end,
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'tasks_area_valid'), '(missing)')

  union all
  select 15, 'profiles covers the three human roles and excludes pong',
    case when (select pg_get_constraintdef(oid) from pg_constraint where conname = 'profiles_role_valid')
              not like '%pong%'
         and (select pg_get_constraintdef(oid) from pg_constraint where conname = 'profiles_role_valid')
              like '%fon%abigail%accountability%'
         then 'PASS' else 'FAIL' end,
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'profiles_role_valid'), '(missing)')

  union all
  select 16, 'No task data present yet (schema only, as expected in Phase 3)',
    case when (select count(*) from public.tasks) = 0 then 'PASS' else 'NOTE' end,
    format('%s task rows', (select count(*) from public.tasks))
)

select ord as "#", check_name as "check", status, detail from results
union all
select 99, 'OVERALL',
  case when exists (select 1 from results where status = 'FAIL') then 'FAIL' else 'PASS' end,
  format('%s passed, %s failed', (select count(*) from results where status = 'PASS'),
                                 (select count(*) from results where status = 'FAIL'))
order by 1;
