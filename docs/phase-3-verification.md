# Phase 3 verification record

> ⚠️ **The 16/16 result below is superseded.** Two blockers found in independent
> review changed the schema: the default-privilege revoke is now role-scoped
> correctly, and `audit_log` gained a `TRUNCATE` guard. `verify.sql` now runs
> **19 checks**. The hosted project must be re-applied and re-verified; see
> [Re-verification after the review fixes](#re-verification-after-the-review-fixes)
> at the end. The record below is kept as the history of the first apply.

The Phase 3 schema was applied to the hosted Free-plan Supabase project via
`supabase/apply-all.sql` in the SQL Editor, and checked with
`supabase/verify.sql`. This is the captured result, for the independent review.

- **Date:** 2026-09-21
- **Project:** `fon-os`, organization plan badge shows **FREE**
- **Applied by:** Fon, by hand in the Supabase SQL Editor
- **Why by hand:** this session's egress policy blocks `*.supabase.co` and
  `api.supabase.com` (403 at the proxy), and a publishable key is a client key
  that cannot issue DDL. The database password and secret key were deliberately
  never requested. See `phase-3-supabase.md`.

## Result: OVERALL PASS — 16 passed, 0 failed

| # | Check | Status | Detail |
|---|---|---|---|
| 1 | All six tables exist | PASS | `area_notes, audit_log, idempotency_keys, import_batches, profiles, tasks` |
| 2 | RLS enabled on every table | PASS | 6 of 6 enabled |
| 3 | RLS FORCED on every table (applies to the owner too) | PASS | 6 of 6 forced |
| 4 | Zero policies (fail closed, nothing to remove later) | PASS | none — correct |
| 5 | No grants to anon or authenticated | PASS | none — correct |
| 6 | `tasks.id` is uuid (app-generated ids insert unchanged) | PASS | uuid |
| 7 | `tasks` has all 16 columns | PASS | 16 columns |
| 8 | Sharing invariant constraint present | PASS | `tasks_shared_only_in_shared_areas` |
| 9 | All 12 `tasks` CHECK constraints present | PASS | 12 of 12 |
| 10 | Partial unique index on `(source, import_key)` | PASS | `tasks_source_import_key_unique` |
| 11 | `audit_log` append-only trigger present | PASS | `audit_log_append_only` |
| 12 | `updated_at` triggers on tasks, area_notes, profiles | PASS | 3 of 3 |
| 13 | Internal `app` schema and its two functions exist | PASS | `forbid_mutation, touch_updated_at` |
| 14 | Area vocabulary lists all seven areas | PASS | `CHECK ((area = ANY (ARRAY['inbox'::text, 'school'::text, 'work'::text, 'reading'…` |
| 15 | `profiles` covers the three human roles and excludes pong | PASS | `CHECK ((role = ANY (ARRAY['fon'::text, 'abigail'::text, 'accountability'::text…` |
| 16 | No task data present yet (schema only, as expected in Phase 3) | PASS | 0 task rows |
| 99 | **OVERALL** | **PASS** | **16 passed, 0 failed** |

17 rows returned, matching the 16 checks plus the verdict.

Every value matches what the same SQL produces offline against Postgres 18, and
the `verify.sql` output is asserted row-for-row in
`supabase/tests/apply-all.test.mjs`.

---

## What this proves, and what it does not

Being precise about the boundary matters more than a clean bill of health.

### Proven on the hosted project

Checks 1–16 read the live `pg_catalog` and `information_schema` of the real
database. They establish that the schema, the constraints, the triggers, the
indexes named, and the **RLS configuration** are exactly as intended: RLS is
enabled and forced on all six tables, there are no policies, and `anon` and
`authenticated` hold no grants.

### Proven offline, against byte-identical SQL

The runtime *behaviour* of those constraints — that a shared Work task is
rejected, that a legacy `s1` id is refused, that the audit log raises on
`UPDATE`, that a granted-but-unpolicied role reads zero rows, that re-running
migrations is a no-op, that rollback is clean — is covered by 128 tests running
the same migration files against a real Postgres (PGlite 18) in CI. The
`apply-all.test.mjs` suite proves the pasted file produces a schema identical to
applying the migrations individually.

### Not yet proven anywhere: runtime denial on the hosted project

No request has been made to the live REST API with the publishable key, because
this session cannot reach it. Checks 4 and 5 show the *configuration* that
causes denial; they are not a live request that was refused.

**Closing that gap takes 30 seconds and is optional.** From any machine with
network access:

```bash
curl -s "https://<project-ref>.supabase.co/rest/v1/tasks?select=id" \
  -H "apikey: <publishable key>"
```

Expected: a PostgREST error such as
`{"code":"42501","message":"permission denied for table tasks"}` — **not** a
list of rows, and **not** `[]`. An empty array would mean the table is readable
and merely empty, which would contradict check 5 and should be reported.

Both values are safe to use here: the publishable key is public by design.

---

## Cost

The organization badge reads **FREE** throughout. One project, no payment
method, no paid compute, no add-on, no custom domain. Phase 3 costs $0.

Free-plan projects pause after roughly a week of inactivity. Restoring is free
and manual and **preserves data**. While this PR waits for review the project
will pause; that is expected and harmless. The app's JSON **Export backup**
remains the backup that depends on nothing — see `phase-3-supabase.md`.


---

## Re-verification after the review fixes

Two independent-review findings changed the schema after the result above was
recorded, so that result no longer describes the database.

| Finding | Change |
|---|---|
| **Phase 4 blocker** — `ALTER DEFAULT PRIVILEGES` is role-scoped, so the revoke was a silent no-op for entries owned by `supabase_admin` | Migration now revokes `FOR ROLE` each owning role; `verify.sql` gains checks 18 and 19 |
| **Phase 5 blocker** — a row-level trigger cannot fire on `TRUNCATE`, so the audit log could be emptied in one statement | Added statement-level `audit_log_no_truncate`; `verify.sql` check 12 now asserts both guards |

Both were reproduced offline before being fixed, and both fixes were confirmed
by reverting them and watching the new tests fail (14 failures for the
`TRUNCATE` guard, 5 for the default privileges).

### Step 1 — diagnostic (read-only)

Run in the Supabase SQL Editor. It reads catalog only, changes nothing, and
needs no credential beyond SQL Editor access:

```sql
select defaclrole::regrole              as for_role,
       defaclnamespace::regnamespace    as schema,
       defaclobjtype                    as objtype,
       defaclacl::text                  as acl
from pg_default_acl;
```

**Result — recorded 2026-09-21: the finding is load-bearing.**

24 rows returned. The **`public`-schema entries for sequences, tables and
functions are owned by `supabase_admin`**, and include grants to `anon` and
`authenticated`.

`supabase_admin` is not the role that ran `apply-all.sql` (the SQL Editor runs
as `postgres`), so **the three unqualified `ALTER DEFAULT PRIVILEGES` statements
in the first apply were a silent no-op on this project**, exactly as the review
predicted. Those entries are still live.

### What that does and does not expose

A default-ACL entry applies only to objects created **by the role that owns the
entry**. Reproduced in `rls.test.mjs`, "a surviving foreign entry does not
affect tables created by another role":

| Table created by | `anon` holds SELECT? |
|---|---|
| the role running our migrations (`postgres`) | **no** |
| `supabase_admin` | **yes** |

So the Phase 4 tables, created by `postgres` through these migrations, are not
exposed by the surviving entry. The exposure is narrower than "every future
table": it is **every future object in `public` created by `supabase_admin`** —
which includes some extension installs and platform operations, not routine
migration work.

That is a real gap worth closing, and it is not a reason to relax: it is
detected by check 18 (the entry itself) and check 19 (any table that ends up
without RLS, whoever created it).

### If Step 2 cannot clear it

`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` requires membership of
`supabase_admin`. On Supabase's managed platform `postgres` may not have it. The
migration anticipates this: the revoke is skipped, a `WARNING` prints the exact
remediation SQL, and **check 18 reports FAIL** rather than the failure passing
unnoticed. Tested in `rls.test.mjs`, "skips with a warning, not an error, when
membership of the owning role is missing".

If that happens, the honest position is: checks 18 and 19 remain the control,
every migration must continue to enable and force RLS on creation, and clearing
the entry needs a role that has the membership.

### Step 2 — re-apply

Paste `supabase/apply-all.sql` again. It is idempotent; it adds the `TRUNCATE`
guard and clears any foreign-owned default privileges.

**Result — recorded 2026-09-21: completed, no error.**

`app.revoke_api_default_privileges()` returned one row with a blank value, which
is how a `void`-returning function renders — the expected success shape. No
`WARNING` was displayed.

The function raises its `WARNING` only when at least one revoke was refused for
lack of membership. Taken at face value, no warning means every revoke
succeeded, i.e. the role running the SQL Editor does have the membership needed
to alter `supabase_admin`'s default privileges.

**That inference is not treated as proof**, for one reason: it is not
established that the Supabase SQL Editor surfaces `WARNING` messages at all. If
it does not, the absence of one carries no information.

So the outcome is settled by direct observation of the end state instead:
**check 18** reads `pg_default_acl` and reports FAIL, naming the owning role, if
any entry granting `anon` or `authenticated` in `public` survives. That reading
is independent of whether messages render, which is why the check exists.

### Step 3 — re-verify

Paste `supabase/verify.sql` again. Expect **19 checks plus the verdict — 20
rows — and OVERALL PASS**.

Check 18 is the one that settles Step 2: PASS means the default-ACL entries are
gone; FAIL names the role that still owns them, and the remediation is to run
the revoke as a role holding that membership.

**Result — recorded 2026-09-21: 20 rows, OVERALL FAIL, 18 passed, 1 failed.**

Check 12 **PASS** — `audit_log_append_only, audit_log_no_truncate`. The Phase 5
blocker fix is live.

Check 18 **FAIL** — `supabase_admin owns S, supabase_admin owns r,
supabase_admin owns f`. Everything else passed.

Attempting the revoke as the SQL Editor's role returned
`ERROR: 42501: permission denied to set role "supabase_admin"`. The entries
cannot be altered from this project. Recorded below as **RES-001**.

---

## RES-001 — accepted residual: `supabase_admin` default privileges

| | |
|---|---|
| **Status** | Accepted. Not fixable by this project. |
| **Owner** | Fon (project owner) |
| **Detected by** | `verify.sql` check 18 — which stays **FAIL** |
| **Compensating control** | `verify.sql` check 19 |
| **Review** | Re-assess if Supabase ever grants project owners control of these entries |

### What it is

Supabase seeds default privileges granting `anon` and `authenticated` on
tables, sequences and functions in `public`, owned by the `supabase_admin`
role. These are the platform's own defaults, present on every Supabase project;
they are not a misconfiguration of ours.

### Why it is not fixed

`ALTER DEFAULT PRIVILEGES` is scoped to the role owning the entry, and altering
another role's entries requires membership of it. `postgres` — the role the SQL
Editor runs as — is refused: `permission denied to set role "supabase_admin"`.
There is no path from a project owner's privileges to removing them.

### What it actually exposes

A default-ACL entry applies **only to objects created by the role that owns it**
(tested in `rls.test.mjs`, "a surviving foreign entry does not affect tables
created by another role"):

| Table created by | `anon` holds SELECT? |
|---|---|
| the role running our migrations | **no** |
| `supabase_admin` | **yes** |

So it does not touch the six Phase 3 tables, nor any table a reviewed migration
creates. It bites only for an object created in `public` by `supabase_admin` —
an extension install or a platform operation.

### Why check 18 stays FAIL

Because it is true. The entries are there. Softening the check, renaming it, or
excluding `supabase_admin` from it would produce a green board that no longer
describes the database — and the next reader would have no way to tell an
accepted residual from a regression. A check that lies to look green is worth
less than no check.

The board therefore reads **OVERALL FAIL**, permanently, until Supabase changes
what it is possible to do here. `verify.sql` emits a `NOTE` row pointing at this
entry so whoever runs it knows the FAIL is expected; that row carries no status
weight and cannot turn a failing board green, which is pinned by a test.

### Controls that stand in its place

1. **Check 19** — every table in `public`, not just the six, must have
   `relrowsecurity` **and** `relforcerowsecurity`. It inspects end state, so it
   is **path-independent**: it catches a table however it arrived, including
   `CREATE TABLE AS` and `SELECT INTO`, which a DDL-tag-based trigger misses.
   Failure-injection tests cover all of those.
2. **Explicit per-table lockdown in every migration** — see the rule below.

### Rejected: a DDL event trigger

A `ddl_command_end` event trigger that hardened new `public` tables was proposed
and **rejected in independent review**. Reproduced here rather than argued:

- **It fails open.** `BEGIN … EXCEPTION` opens a subtransaction, so a failure in
  the third statement rolls back the `enable` and `force` with it. The table
  ends up with **no RLS at all** — the exact condition the control existed to
  prevent — signalled only by a `WARNING` in logs nobody reads.
- **It misses the likely paths.** `CREATE TABLE AS` and `SELECT INTO` carry
  different command tags and were not covered.
- **It would break seeding migrations** and could half-break an extension that
  creates a table in `public`.

It is not in the migrations, and `migrations.test.mjs` asserts no event trigger
exists and that no migration file mentions one.

---

## Rule: every future migration locks its tables down explicitly

Any migration that creates a table in `public` **must**, in the same migration:

```sql
alter table public.<name> enable row level security;
alter table public.<name> force row level security;
revoke all on public.<name> from anon, authenticated;
```

In practice: add the table to the array in
`20260921000600_rls_fail_closed.sql`. This is the real preventive control — it
is explicit, reviewable in a diff, and it cannot fail open.

Two tests enforce it:

- `migrations.test.mjs`, "names every created table in the RLS lockdown list" —
  scans the migration files and fails if a created table is not listed.
- `migrations.test.mjs`, "ends with RLS enabled, forced, and no api-role
  privileges on all of them" — asserts the end state for every table.
