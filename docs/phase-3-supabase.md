# Phase 3 — Supabase database foundation

The schema, the migrations, and the security posture. **Nothing in this phase
is wired to the running app.** `src/` is untouched; `fon-os.vercel.app` behaves
exactly as it does today, still reading and writing `localStorage`.

Phase 4 (authentication and policies) and Phase 5 (the Pong API) are designed in
[`phase-3-5-plan.md`](phase-3-5-plan.md) and are **not** implemented here.

---

## Status: applied and verified ✅

The Free-plan project exists and **the schema is applied**. `verify.sql`
reports **OVERALL PASS — 16 passed, 0 failed**, with 0 task rows as expected
for Phase 3. The captured result is recorded in
[`phase-3-verification.md`](phase-3-verification.md).

The live app is still untouched: nothing connects to this database, and the
production bundle is byte-identical to `main`.

### Why Fon applied it rather than this session

**The schema could not be applied from this session**, for two independent
reasons:

1. **Network.** This environment's egress policy blocks `*.supabase.co` and
   `api.supabase.com` (HTTP 403 at the proxy). I cannot reach the project at
   all, with any credential.
2. **Credentials, by design.** The publishable key is a *client* key. It talks
   to PostgREST and is subject to RLS; it cannot issue `CREATE TABLE`. Applying
   DDL needs the database password or a Management API token — both of which
   are secrets that should not be handed to this session, and neither of which
   was requested.

So it was a two-paste job for Fon — about a minute — using the files described
in [Applying the schema](#applying-the-schema) below. Those files remain the
way to rebuild this database, or to stand up a fresh one.

---

## Schema

Six tables in `public`, plus an internal `app` schema holding two trigger
functions.

### `tasks`

One row per task, mirroring `src/lib/model.js` field for field, so an import
loses nothing.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | Defaults to `gen_random_uuid()`, but the app supplies its own v4 UUID and it is copied unchanged. |
| `title` | `text not null` | Must not be blank. |
| `notes` | `text not null default ''` | |
| `area` | `text not null` | One of the seven areas. |
| `status` | `text not null default 'open'` | `open` / `done` / `archived`. |
| `priority` | `text not null default '—'` | `—` / `!` / `!!`. |
| `due_date` | `date` | |
| `due_time` | `time` | Only legal alongside a `due_date`. |
| `owner` | `text` | `null` when absent — never `''`. |
| `visibility` | `text not null default 'private'` | `shared` only in Family and Home. |
| `created_by` | `text not null` | `fon` / `abigail` / `pong` / `claude-import`. |
| `source` | `text not null default 'manual'` | `manual` / `pong-voice` / `claude-import` / `abigail`. |
| `created_at` `updated_at` | `timestamptz not null` | |
| `completed_at` | `timestamptz` | |
| `import_key` | `text` | Unique per source. Set by the Claude school importer. |

Constraints worth calling out:

- **`tasks_shared_only_in_shared_areas`** — `visibility = 'private' or area in ('family','home')`.
  The Phase 2 sharing invariant is now enforced by the database, so a bug, a bad
  import, or direct SQL cannot create a shared Work task.
- **`tasks_completed_at_matches_status`** — `open` must have no completion time,
  `done` must have one. `archived` is left permissive so a finished task keeps
  its history when archived.
- **`tasks_source_import_key_unique`** — a partial unique index on
  `(source, import_key) where import_key is not null`. Re-importing a Claude
  file updates rather than duplicating; the many `null` keys never collide.
- **`tasks_owner_not_blank`** — forces the importer to translate the app's `""`
  into a real `null`.

### The other five

| Table | Purpose |
|---|---|
| `area_notes` | One status note per area. Keyed by `area`, so import is an upsert. |
| `profiles` | **Phase 4 preparation.** Maps an `auth.users` id to `fon` / `abigail` / `accountability`, one holder each. No policies, no grants, no sign-up hook. |
| `audit_log` | Tamper-evident record of Pong's writes. **`UPDATE`, `DELETE` and `TRUNCATE` all raise**, for every role including `service_role`, which bypasses RLS but not triggers. `DROP TABLE` remains available to the owner — accepted, because it is not silent and needs owner rights, whereas `TRUNCATE` looks like a data operation and leaves an intact, empty table. No FK to `tasks`, so the log outlives the row. |
| `idempotency_keys` | Phase 5 replay protection: a duplicate voice request returns the stored response instead of creating a second task. |
| `import_batches` | `unique (kind, checksum)` — applying the same export twice is a no-op before any task row is touched. |

**Pong has no `profiles` row.** It is not a person and gets no auth user. In
Phase 5 it will authenticate to our own server-side API, which then talks to
Postgres. `pong` exists only as an attribution value on tasks and audit rows.

---

## Security: fail closed, with no exceptions to clean up later

Every table has RLS **enabled and forced**, and there are **zero policies**.

In Postgres, RLS with no policies denies every row to every role that is not a
superuser and does not hold `BYPASSRLS`. That is deliberate: there is no
permissive temporary policy that someone has to remember to remove. Phase 4
writes the first policy; until then `anon` and `authenticated` reach nothing.

`FORCE` extends the denial to the table owner, so a later migration running as
the owner cannot quietly read the board.

The default grants Supabase hands `anon` and `authenticated` are explicitly
revoked, so the denial does not rest on RLS alone. `supabase/tests/rls.test.mjs`
proves both halves: a role that has been *granted* `SELECT` still reads zero rows.

### Accepted residual: Supabase's own default privileges

The migration revokes default privileges per owning role (below), but on
Supabase the entries are owned by `supabase_admin` and **a project owner cannot
alter them**. `verify.sql` check 18 reports this as a permanent **FAIL**, which
is deliberate — see **RES-001** in
[`phase-3-verification.md`](phase-3-verification.md). Check 19 is the
compensating control. A DDL event trigger was proposed as an alternative and
rejected in review for failing open; it is not in the migrations.

### Default privileges are revoked per owning role

`ALTER DEFAULT PRIVILEGES` with no `FOR ROLE` edits only the entries owned by
the role *running* it. Supabase seeds its own entries for `anon` and
`authenticated` as `supabase_admin`, so an unqualified revoke executed as anyone
else is a **silent no-op** — and any table created later lands with full
`anon` privileges and RLS off.

The migration therefore enumerates every role owning such an entry in `public`
and revokes explicitly `FOR ROLE` each one. If membership of that role is
missing, the statement is skipped with a loud `WARNING` naming the exact
remediation SQL, and `verify.sql` check 18 reports **FAIL** — the failure is
never silent. Check 19 independently catches any table in `public` that ends up
without RLS enabled and forced, including one created through the dashboard.

### The one exception, stated plainly

**`service_role` holds `BYPASSRLS`.** Whoever has that key reads and writes
every task regardless of policy. There is a test pinning this so the
consequence stays visible.

### Keys and where they live

| Key | Where it belongs | Safe in the browser? |
|---|---|---|
| Project URL | `VITE_SUPABASE_URL` | **Yes** — public. |
| `anon` key | `VITE_SUPABASE_ANON_KEY` | **Yes** — a public identifier that grants nothing while RLS denies everything. |
| `service_role` key | Server environment variable only | **Never.** |
| Database URL (with password) | Server / your machine only | **Never.** |
| Pong API token (Phase 5) | Server environment variable only | **Never.** |

Vite inlines every `VITE_`-prefixed variable into the JavaScript bundle, so the
prefix *is* the boundary. [`.env.example`](../.env.example) is the committed
template and holds placeholders only; real `.env` files are git-ignored.
`supabase/tests/secrets.test.mjs` fails the build if a secret is ever given a
`VITE_` prefix, if anything under `src/` references one, or if a JWT or a
password-bearing connection string is committed.

**No secret is needed anywhere in Phase 3.** The import tooling is pure: it
reads a file and writes SQL, with no network call and no credential.

---

## Migrations

`supabase/migrations/*.sql`, applied in filename order:

| File | What it creates |
|---|---|
| `…000100_vocabulary.sql` | `app` schema, `touch_updated_at`, `forbid_mutation` |
| `…000200_profiles.sql` | `profiles` (Phase 4 prep) |
| `…000300_tasks.sql` | `tasks`, constraints, indexes |
| `…000400_area_notes.sql` | `area_notes` |
| `…000500_audit_idempotency_imports.sql` | `audit_log`, `idempotency_keys`, `import_batches` |
| `…000600_rls_fail_closed.sql` | RLS enabled + forced everywhere, grants revoked |

They are **re-runnable**: applying them twice is a no-op and does not duplicate
a constraint, index or trigger, or disturb existing rows. Tested.

Allowed-value lists are mirrored from `src/lib/areas.js` and `src/lib/model.js`.
`supabase/tests/parity.test.mjs` reads the `CHECK` definitions back out of the
Postgres catalog and compares them to the app's exported constants, so the two
cannot drift apart silently.

### Applying the schema

Two pastes into **Supabase Dashboard → SQL Editor**:

1. **Apply.** Paste the whole of [`supabase/apply-all.sql`](../supabase/apply-all.sql)
   and run it. That file is every migration concatenated in order, generated by
   `npm run db:build-apply-all`, with a test that fails if it drifts from the
   migration files. It is safe to run twice.
2. **Verify.** Paste the whole of [`supabase/verify.sql`](../supabase/verify.sql)
   and run it. It reads only the catalog — creates nothing, changes nothing —
   and returns 16 checks plus an overall verdict. **Every row should say PASS.**
   Copy the result back for the review record.

Or, if you prefer a terminal and have the connection string:

```bash
psql "$SUPABASE_DB_URL" -f supabase/apply-all.sql
psql "$SUPABASE_DB_URL" -f supabase/verify.sql
```

The individual files under `supabase/migrations/` remain the source of truth
and can be applied one at a time instead, in filename order.

### What `verify.sql` checks

**19 checks, a context note, and an overall verdict (21 rows).** Six tables exist; RLS enabled **and
forced** on all six; zero policies; `anon`/`authenticated` hold no privilege on
any public table (via grantor-independent `has_table_privilege`, which also sees
privileges inherited through role membership) and no catalogued grants either;
`tasks.id` is `uuid`; all 16 columns; all 12 `CHECK` constraints by name; the
partial unique index; **both** audit guards; the three `updated_at` triggers;
the internal `app` schema functions; the seven-area vocabulary; `profiles`
excluding Pong; no task data yet; **no default privileges granting `anon` or
`authenticated`**; and **every** table in `public` — not just the six — has RLS
enabled and forced.

Check 18 is expected to FAIL on Supabase — accepted residual RES-001, not
softened. Check 19 is its compensating control.

`supabase/tests/apply-all.test.mjs` proves the query is not merely
rubber-stamping. It deliberately disables RLS, un-forces RLS, adds a policy,
grants `anon` access directly and through an intermediary role, seeds a
foreign-owned default privilege, creates an unprotected table via plain
`CREATE TABLE`, `CREATE TABLE AS`, `SELECT INTO` and a different owning role,
drops a constraint, and drops each audit guard in turn — asserting the report
goes **FAIL** every time. It also asserts the context note cannot turn a
failing board green.

### Rollback

[`supabase/rollback.sql`](../supabase/rollback.sql) drops everything Phase 3
created, in reverse dependency order. It is safe to run twice, safe on a
database that never had the migrations, and **leaves `auth.users` alone** so
rollback never touches accounts. Re-applying the migrations afterwards rebuilds
an identical schema. All four properties are tested.

It is destructive to task data, so take a backup first — see below.

---

## Getting your local board into the database

Your tasks live in `localStorage` on your iPhone and in any browser you have
used. **I cannot reach that data, and nothing here tries to.** The path is:

1. On the device that has the board, open My View → **Export backup**. You get
   `fon-os-backup-YYYY-MM-DD.json`.
2. Generate SQL from it — no credentials, no network:
   ```bash
   node supabase/import/generate-sql.mjs fon-os-backup-2026-09-21.json "iPhone" > import.sql
   ```
3. Review `import.sql`, then run it **as a role that can bypass RLS** — see
   below.

### Which role may run the import

Every table carries **FORCE** row level security with no policies, and FORCE
applies to the table owner too. So an ordinary owner's `INSERT` is refused:

| Executing role | `INSERT` into `public.tasks` |
|---|---|
| table owner, no `BYPASSRLS` | **refused** — `new row violates row-level security policy` |
| a role holding `BYPASSRLS` (e.g. `service_role`) | allowed |

The generated script therefore opens with a **preflight** that checks
`rolbypassrls` across the executing role and everything it inherits, and raises
`insufficient_privilege` with a role-shaped message before writing anything. A
refused run leaves **zero** rows and zero import batches — tested.

**This is why the import path is not yet declared ready.** Whether the Supabase
SQL Editor's role carries `BYPASSRLS` on this project has not been confirmed,
and it is a one-line read-only query to settle. Until it is, the documented
route is: run the import as a role known to hold `BYPASSRLS`. If the SQL Editor
role does not, the alternatives are `psql` as a `BYPASSRLS` role, or a
server-side import in Phase 4 using the service-role key.

**Your local copy is never touched.** The export is read-only input, and the app
keeps reading `localStorage` exactly as before. Nothing about this phase changes
what is on your phone.

The generated script:

- **Is idempotent.** Running it ten times leaves one row per task. The batch
  checksum short-circuits an unchanged re-import.
- **Only inserts and updates.** It contains no `DELETE`, `TRUNCATE` or `DROP` —
  asserted by a test.
- **Is last-write-wins by `updated_at`**, so re-importing an older export from a
  second device cannot roll back a newer row.
- **Leaves rows not in the file untouched**, so two devices can be merged by
  importing each in turn.
- **Cannot smuggle anything past the database.** It runs the file through the
  app's own `normalizeState` first — re-keying colliding ids, filing unknown
  areas into Inbox, re-applying the sharing invariant — and the constraints
  catch anything that survives.

---

## Free plan: what it costs and how it pauses

**$0/month.** One project on the Supabase Free plan. No payment method, no
paid compute, no add-ons, no custom domain.

### Free-plan projects pause after inactivity

A Free-plan project **pauses after about a week with no API or database
activity.** A paused project stops serving requests until you restore it.

- **Restoring is free and manual**: Supabase Dashboard → the project → **Restore
  project**. It takes a minute or two.
- **Your data is preserved** across a pause. A pause is not a deletion.
- The Free plan allows a limited number of *active* projects, which is why this
  phase creates exactly one.

Practically: while Phase 3 sits unmerged and unused, **the project will pause,
and that is fine.** Phase 4 onwards keeps it awake through normal use.

### The JSON export is the independent backup, and stays that way

Free-plan projects do **not** include point-in-time recovery, and automated
daily backups are limited. So the app's own **Export backup** remains the
backup mechanism that does not depend on Supabase at all:

- It is a plain JSON file you hold, readable without any database.
- It survives a paused project, a deleted project, a forgotten password, and
  leaving Supabase entirely.
- `importState` in `src/lib/storage.js` restores it into the browser with no
  server involved, and `generate-sql.mjs` restores it into Postgres.

**Keep exporting periodically even after Phase 4.** The database becoming the
source of truth does not make the independent copy less useful — it makes it
more so. Nothing in Phase 3 removes or weakens it.

---

## What I need from you

Nothing further for Phase 3 — it is applied and verified.

One **optional** 30-second check would close the last verification gap: a live
request proving the publishable key is refused by the real project. The command
is in [`phase-3-verification.md`](phase-3-verification.md#not-yet-proven-anywhere-runtime-denial-on-the-hosted-project).

If any screen offers a paid add-on, a larger compute size, a custom domain, or
asks for a card — **stop and tell me** rather than accepting. Nothing in this
phase requires any of them.

### Do not send

- The **database password**
- The **`service_role` / secret key** (`sb_secret_…`)
- Any **Management API / personal access token**

None of them is needed, and this conversation is not a safe place for them. If
one has already been pasted somewhere it should not be, rotate it in
**Project Settings → API**.

### Keys: which is which

The key formats changed recently, so the names are worth pinning down:

| Key | Old name | Public? | Where it belongs |
|---|---|---|---|
| `sb_publishable_…` | `anon` key | **Yes** — safe in the browser and in page source | `VITE_SUPABASE_ANON_KEY` |
| `sb_secret_…` | `service_role` key | **No** — bypasses RLS entirely | Server environment variable only. Not needed in Phase 3. |

The publishable key grants nothing on its own while RLS denies everything, which
is exactly the state this phase leaves the database in.

Note also that a project's **dashboard** URL
(`supabase.com/dashboard/project/<ref>`) is not its **API** URL
(`https://<ref>.supabase.co`). Phase 4 will need the API one.
