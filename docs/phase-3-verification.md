# Phase 3 verification record

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
