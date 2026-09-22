-- ─── PHASE 3 + PHASE 4 VERIFICATION ───────────────────────────────────────────
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
--
-- PHASE 4 CHANGED FOUR CHECKS AND ADDED FIVE. Checks 4, 5 and 6 asserted the
-- pre-Phase-4 posture — zero policies, zero privileges — which Phase 4
-- necessarily breaks. They are TIGHTENED into exact allowlists, never relaxed:
-- an extra policy or privilege fails, and so does a missing one. A check
-- rewritten to accept anything is how a board goes green while the boundary
-- rots. Checks 5a and 20-23 are new. Check 17's wording now covers both phases.

with expected_tables(name) as (
  values ('area_notes'), ('audit_log'), ('idempotency_keys'),
         ('import_batches'), ('profiles'), ('tasks')
),

-- The Phase 4 expected policy set, from docs/phase-4-auth-plan.md §3.3. This
-- literal IS the specification; check 4 compares the catalog against it in both
-- directions. Keyed on (table, policy name, command, roles).
--
-- Exactly 15 rows. audit_log, idempotency_keys and import_batches appear
-- nowhere, deliberately (§1).
expected_policies(tablename, policyname, cmd, roles) as (
  values
    ('tasks',      'tasks_fon_select',                 'SELECT', '{authenticated}'),
    ('tasks',      'tasks_fon_insert',                 'INSERT', '{authenticated}'),
    ('tasks',      'tasks_fon_update',                 'UPDATE', '{authenticated}'),
    ('tasks',      'tasks_fon_delete',                 'DELETE', '{authenticated}'),
    ('tasks',      'tasks_abigail_select',             'SELECT', '{authenticated}'),
    ('tasks',      'tasks_abigail_insert',             'INSERT', '{authenticated}'),
    ('tasks',      'tasks_abigail_update',             'UPDATE', '{authenticated}'),
    ('area_notes', 'area_notes_fon_select',            'SELECT', '{authenticated}'),
    ('area_notes', 'area_notes_fon_insert',            'INSERT', '{authenticated}'),
    ('area_notes', 'area_notes_fon_update',            'UPDATE', '{authenticated}'),
    ('area_notes', 'area_notes_abigail_select',        'SELECT', '{authenticated}'),
    ('area_notes', 'area_notes_abigail_insert',        'INSERT', '{authenticated}'),
    ('area_notes', 'area_notes_abigail_update',        'UPDATE', '{authenticated}'),
    ('area_notes', 'area_notes_accountability_select', 'SELECT', '{authenticated}'),
    ('profiles',   'profiles_select_own',              'SELECT', '{authenticated}')
),

-- The Phase 4 expected privilege set for `authenticated`, from §3.2. Symmetric
-- with the policy set above: that one says by whom and on which rows, this one
-- says which verbs are reachable at all.
expected_grants(relname, priv) as (
  values
    ('tasks',          'SELECT'), ('tasks',      'INSERT'),
    ('tasks',          'UPDATE'), ('tasks',      'DELETE'),
    ('area_notes',     'SELECT'), ('area_notes', 'INSERT'), ('area_notes', 'UPDATE'),
    ('profiles',       'SELECT'),
    ('school_summary', 'SELECT')
),

-- Every privilege a table-like object can carry, so the comparison below is
-- over the full space rather than only the verbs we expected to find.
all_privs(priv) as (
  values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
         ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
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
  -- Phase 3 asserted zero policies. Phase 4 adds fifteen, so this becomes an
  -- EXACT, BIDIRECTIONAL allowlist instead: a policy in the catalog but not in
  -- expected_policies is an over-policy, and one in expected_policies but not
  -- in the catalog is a missing control. Both fail, and the detail says which.
  --
  -- permissive is pinned too: a policy silently switched to RESTRICTIVE keeps
  -- its key but inverts its meaning.
  select 4, 'Policies match the expected set exactly (extra AND missing both fail)',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(drift, '; ' order by drift), 'exactly the 15 expected policies — correct')
  from (
    select case
             when e.policyname is null then
               format('UNEXPECTED %s.%s (%s to %s, %s)',
                      a.tablename, a.policyname, a.cmd, a.roles, a.permissive)
             else
               format('MISSING %s.%s (%s to %s)', e.tablename, e.policyname, e.cmd, e.roles)
           end as drift
    from expected_policies e
    full outer join (
      select tablename, policyname, cmd, roles::text as roles, permissive
      from pg_policies where schemaname = 'public'
    ) a
      on  a.tablename  = e.tablename
      and a.policyname = e.policyname
      and a.cmd        = e.cmd
      and a.roles      = e.roles
      and a.permissive = 'PERMISSIVE'
    where e.policyname is null or a.policyname is null
  ) policy_drift

  union all
  -- Phase 3 asserted that `authenticated` held nothing. Phase 4 grants a narrow
  -- set, so this becomes an exact allowlist over the FULL privilege space —
  -- extra fails, and missing fails too.
  --
  -- has_table_privilege is grantor-independent and covers privileges held
  -- indirectly through role membership, which information_schema.role_table_grants
  -- does not show unless the grantee role is currently enabled.
  select 5, 'authenticated holds exactly the expected privileges, no more and no less',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(drift, ', ' order by drift), 'exactly the 9 expected grants — correct')
  from (
    select case when e.relname is null
                then format('UNEXPECTED %s on %s', a.priv, a.relname)
                else format('MISSING %s on %s', e.priv, e.relname)
           end as drift
    from expected_grants e
    full outer join (
      select c.relname::text as relname, p.priv
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join all_privs p
      where n.nspname = 'public'
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege('authenticated', c.oid, p.priv)
    ) a on a.relname = e.relname and a.priv = e.priv
    where e.relname is null or a.relname is null
  ) grant_drift

  union all
  -- The silent dependency. Phase 4 relies on `authenticated` already holding
  -- USAGE on schema public and never grants it; without this line, a later
  -- cleanup could revoke it and every grant above would quietly become inert,
  -- failing with `permission denied for schema` rather than a row-level denial.
  select 5.5, 'Check 5a: authenticated retains USAGE on schemas public and auth',
    case when has_schema_privilege('authenticated', 'public', 'USAGE')
          and has_schema_privilege('authenticated', 'auth', 'USAGE')
         then 'PASS' else 'FAIL' end,
    format('public=%s auth=%s%s',
           has_schema_privilege('authenticated', 'public', 'USAGE'),
           has_schema_privilege('authenticated', 'auth', 'USAGE'),
           case when has_schema_privilege('authenticated', 'public', 'USAGE')
                 and has_schema_privilege('authenticated', 'auth', 'USAGE')
                then ' — correct'
                else ' — REVOKED: table grants go inert, or auth.uid() fails in every policy' end)

  union all
  -- anon is the one role whose allowlist is empty, in both phases. Read through
  -- has_table_privilege so a privilege inherited via role membership counts.
  select 6, 'anon holds no privilege on any public table or view',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(format('%s on %s', priv, relname), ', '), 'none — correct')
  from (
    select c.relname, p.priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join all_privs p
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('anon', c.oid, p.priv)
  ) anon_held

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
  -- PASS at zero rows (Phase 3, schema only) and NOTE with a count once the
  -- Phase 3 import has run (Phase 4 step 10). NOTE carries no status weight, so
  -- OVERALL is unaffected either way. A row count here is expected after
  -- import and must not be read as a regression.
  select 17, 'Task data: none in Phase 3; a row count is expected after the Phase 4 import',
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

  union all
  -- ─── PHASE 4 ───────────────────────────────────────────────────────────────
  --
  -- Check 19 covers tables. Views need their own check, because a view needs no
  -- policy to leak: school_summary deliberately bypasses RLS on tasks, so its
  -- definition IS the access control and has to be pinned as such.
  --
  -- Five assertions, any one of which failing fails the check:
  --   1. every ordinary view is security_invoker, or is the one allowlisted
  --      definer view
  --   2. school_summary's definition still carries the role filter and still
  --      has no `notes` — a property check alone would miss an edited filter
  --   3. school_summary has security_barrier, so a caller's leaky predicate
  --      cannot be pushed below the view's own filter
  --   4. NO materialized views in public: RLS does not apply to them at all,
  --      so one over tasks would be an unprotected copy of the board
  --   5. every view is owned by postgres
  select 20, 'Views: school_summary is the only definer view, its definition is pinned, no matviews',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(problem, '; ' order by problem), 'view surface correct')
  from (
    select format('%s is a definer view but is not allowlisted', c.relname) as problem
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and c.relname <> 'school_summary'
      and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%'

    union all
    select format('materialized view %s exists in public (RLS never applies to matviews)', c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'm'

    union all
    select format('view %s is owned by %s, not postgres', c.relname, pg_get_userbyid(c.relowner))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
      and pg_get_userbyid(c.relowner) <> 'postgres'

    union all
    select 'school_summary is missing'
    where not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'school_summary' and c.relkind = 'v')

    union all
    select problem from (
      select case
        when coalesce(array_to_string(c.reloptions, ','), '') not like '%security_barrier=true%'
          then 'school_summary has lost security_barrier'
        when coalesce(array_to_string(c.reloptions, ','), '') like '%security_invoker=true%'
          then 'school_summary is security_invoker: accountability holds no tasks policy, so it would return nothing'
        when pg_get_viewdef(c.oid, true) not like '%current_app_role%'
          then 'school_summary has lost its role filter'
        when pg_get_viewdef(c.oid, true) not like '%accountability%'
          then 'school_summary no longer admits accountability'
        when pg_get_viewdef(c.oid, true) like '%notes%'
          then 'school_summary exposes notes'
        end as problem
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'school_summary' and c.relkind = 'v'
    ) def_check
    where problem is not null
  ) view_problems

  union all
  -- The dependency the plan described but did not state. A definer object runs
  -- as its owner, and FORCE ROW LEVEL SECURITY makes even the table owner
  -- subject to RLS — so app.current_app_role() reading profiles, and
  -- school_summary reading tasks, both work ONLY because postgres additionally
  -- holds BYPASSRLS (or is a superuser).
  --
  -- Lose that and nothing leaks; everything stops. current_app_role() returns
  -- NULL for everyone and the view returns zero rows: a total, silent outage
  -- that no other check here would explain. Reproduced in
  -- supabase/tests/phase4-auth.test.mjs.
  select 21, 'Definer objects are owned by a role that reads through FORCE RLS',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(format('%s is owned by %s, which has neither BYPASSRLS nor SUPERUSER', obj, owner), '; '),
             'owner bypasses RLS — correct')
  from (
    select 'function app.current_app_role()' as obj, pg_get_userbyid(p.proowner) as owner,
           r.rolsuper, r.rolbypassrls
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'app' and p.proname = 'current_app_role'
    union all
    select 'view public.school_summary', pg_get_userbyid(c.relowner), r.rolsuper, r.rolbypassrls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
    where n.nspname = 'public' and c.relname = 'school_summary' and c.relkind = 'v'
  ) definers
  where not (rolsuper or rolbypassrls)

  union all
  -- Each of these four properties is individually load-bearing (§3.1), so each
  -- is reported individually rather than as one opaque pass/fail.
  select 22, 'app.current_app_role() is a stable security-definer with an empty search_path',
    case when count(*) = 1 and bool_and(ok) then 'PASS' else 'FAIL' end,
    coalesce(string_agg(detail, '; '), 'function is missing')
  from (
    select (p.prosecdef
            and p.provolatile = 's'
            and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%'
            and pg_get_userbyid(p.proowner) = 'postgres') as ok,
           format('owner=%s definer=%s volatility=%s config=%s',
                  pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile,
                  coalesce(array_to_string(p.proconfig, ','), '(none)')) as detail
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'current_app_role'
  ) fn

  union all
  -- The D5a invariant. While MFA enrolment for Abigail and the accountability
  -- viewer is undecided, no policy may gate on an assurance claim: a policy
  -- requiring aal2 would return ZERO ROWS to whoever has not enrolled — not an
  -- access error, not a prompt, just an empty board that reads like data loss.
  --
  -- Scans every policy expression, so it binds policies written later too.
  select 24, 'app functions: none executable by PUBLIC or anon, exactly one by authenticated',
    case when count(*) filter (where problem is not null) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(problem, '; ') filter (where problem is not null),
             'one reachable function, none public — correct')
  from (
    select format('%s is executable by PUBLIC', p.proname) as problem
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proacl is null

    union all
    select format('%s is executable by anon', p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'EXECUTE')

    union all
    select case when array_agg(p.proname::text order by p.proname) <> array['current_app_role']::text[]
                then format('authenticated can execute %s',
                            array_to_string(array_agg(p.proname order by p.proname), ', '))
           end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) fn_privs

  union all
  select 23, 'No policy gates on an MFA assurance claim (D5a invariant)',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    coalesce(string_agg(format('%s.%s', tablename, policyname), ', '), 'no assurance gating — correct')
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* '(aal[0-9]|assurance|auth\.jwt)'
),

final(ord, label, check_name, status, detail) as (
  select ord, case when ord = 5.5 then '5a' else trim(to_char(ord, '999')) end,
         check_name, status, detail
  from results
  union all
  -- Context row. Status is NOTE, so it changes no check and no verdict: the
  -- OVERALL count below still sees check 18's FAIL.
  select 98, '98', 'CONTEXT: check 18 is a platform-owned default ACL this project cannot alter',
    'NOTE',
    'Accepted residual RES-001 — see docs/phase-3-verification.md. Every other check is application-controlled.'
  union all
  select 99, '99', 'OVERALL',
    case when exists (select 1 from results where status = 'FAIL') then 'FAIL' else 'PASS' end,
    format('%s passed, %s failed', (select count(*) from results where status = 'PASS'),
                                   (select count(*) from results where status = 'FAIL'))
)

select label as "#", check_name as "check", status, detail from final order by ord;
