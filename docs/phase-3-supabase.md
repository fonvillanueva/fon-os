# Phase 3 — Supabase database foundation

The schema, the migrations, and the security posture. **Nothing in this phase
is wired to the running app.** `src/` is untouched; `fon-os.vercel.app` behaves
exactly as it does today, still reading and writing `localStorage`.

Phase 4 (authentication and policies) and Phase 5 (the Pong API) are designed in
[`phase-3-5-plan.md`](phase-3-5-plan.md) and are **not** implemented here.

---

## Status: the hosted project is not yet created

The migrations, tests and import tooling are complete and run offline against a
real Postgres. **Creating the hosted Supabase project needs you** — it requires
signing in to an account I have no access to.

See [What I need from you](#what-i-need-from-you) at the end.

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
| `audit_log` | Append-only record of Pong's writes. `UPDATE` and `DELETE` raise — including for `service_role`, which bypasses RLS but not triggers. No FK to `tasks`, so the log outlives the row. |
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
revoked, and `ALTER DEFAULT PRIVILEGES` stops future tables inheriting them —
so the denial does not rest on RLS alone. `supabase/tests/rls.test.mjs` proves
both halves: a role that has been *granted* `SELECT` still reads zero rows.

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

### Applying them

Paste each file into **Supabase Dashboard → SQL Editor** in filename order, or:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/20260921000100_vocabulary.sql
# …and so on, in filename order
```

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
3. Review `import.sql`, then paste it into the Supabase SQL editor.

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

I could not create the hosted project: there is no Supabase MCP server, CLI
credential or API token in this environment, and provisioning requires signing
in to your account. **Nothing was created, and no charge is possible from what
I did.**

To provision it — all on the Free plan, no card:

1. Go to **https://supabase.com/dashboard** and sign in (or sign up — free, no
   payment method requested).
2. Click **New project**.
3. Choose your personal organization. If you are asked to create one, pick the
   **Free** plan.
4. Fill in:
   - **Name**: `fon-os`
   - **Database password**: generate one and save it in your password manager.
     *Do not send it to me* — I do not need it, and it must not appear in this
     conversation or the repository.
   - **Region**: **West US (North California)** — the closest US West option.
     If it is not offered, **West US (Oregon)** is the next nearest.
   - **Plan**: confirm it says **Free**.
5. Click **Create new project** and wait for it to finish provisioning.
6. Then tell me, and paste **only** these two public values from
   **Project Settings → API**:
   - the **Project URL**
   - the **anon / public** key

**Do not paste the `service_role` key or the database password.** Neither is
needed for Phase 3, and this conversation is not a safe place for them.

If any screen offers a paid add-on, a larger compute size, a custom domain, or
asks for a card — **stop and tell me** rather than accepting.

Once the project exists I will apply the migrations and confirm the schema,
still without connecting the live app.
