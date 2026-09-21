# Phase 4 plan — authentication & authorization

> **Status: PLANNING ONLY. Nothing here is implemented.**
>
> This document exists so the security model can be reviewed *before* any of it
> is built. It contains no migrations, no application code and no dependencies.
> The SQL in it is illustrative design, not files to apply.
>
> - **Baseline:** merged `main` at `3dc59ae` (Phase 3).
> - **Not done:** no Supabase change, no Vercel change, no deploy, no app
>   connection, no user creation, no data import.
> - **Unresolved:** decisions **D1–D5** at the end are open and block
>   implementation.

**Design principle:** an account grants nothing. Authorization comes from a
`profiles` row that only Fon can create. A stray signup lands with zero access
by construction, not by a rule someone has to remember.

Constraints this plan works within:

- Supabase Auth on the **free tier**.
- **No dependence on paid Vercel SSO.**
- Default deny everywhere.
- Phase 3's sharing constraint, audit protections, **Check 18 residual
  (RES-001)** and **Check 19 compensating control** are preserved unchanged.

---

## 1. Role and permission matrix

Roles are the three values already constrained by `profiles_role_valid`:
**fon**, **abigail**, **accountability** — plus two states that are not roles:
**anon** (not signed in) and **authenticated-but-unprofiled** (an account with
no `profiles` row).

### `public.tasks`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| **fon** | all rows | all areas | all rows | all rows |
| **abigail** | `area ∈ (family, home)` **and** `visibility = 'shared'` | same, forced `created_by='abigail'`, `source='abigail'` | same rows; result must stay in those areas and stay shared | **UNRESOLVED — see D1** |
| **accountability** | ✗ — no policy at all; reads `school_summary` only | ✗ | ✗ | ✗ |
| **unprofiled** | ✗ | ✗ | ✗ | ✗ |
| **anon** | ✗ | ✗ | ✗ | ✗ |

Abigail's `visibility = 'shared'` condition is load-bearing: without it she
would see Fon's private Family and Home tasks. It appears in both `USING` and
`WITH CHECK`, so she also cannot flip a task to private to hide it, nor move
one out of her areas.

**Work is covered by absence.** No policy mentions `area = 'work'` except fon's,
so every other role gets zero rows. Work needs no special rule — it needs no
rule at all.

### `public.school_summary` (new view — accountability's only door)

| Role | SELECT |
|---|---|
| **fon** | ✓ |
| **accountability** | ✓ |
| everyone else | ✗ |

Columns exposed: `id, title, status, priority, due_date, due_time,
completed_at, updated_at`.

**`notes` is not in the view**, and accountability has no policy on `tasks`, so
there is no path to task notes. Row-level security cannot hide a column; a view
is the correct instrument.

### `public.area_notes`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| **fon** | all | all | all | all |
| **abigail** | `area ∈ (family, home)` | same | same | ✗ |
| **accountability** | `area = 'school'` only | ✗ | ✗ | ✗ |
| **unprofiled / anon** | ✗ | ✗ | ✗ | ✗ |

The School status note is displayed in Accountability View today, so it is
deliberately readable. It is the *area* note, not a task note.

### `public.profiles`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| **any signed-in user** | own row only (`user_id = auth.uid()`) | ✗ | ✗ | ✗ |
| **anon** | ✗ | ✗ | ✗ | ✗ |

**No write policy exists for anyone.** Roles are assigned only by
`service_role`/`postgres` — dashboard or SQL. This is what makes
self-elevation structurally impossible rather than rule-dependent.

### `public.audit_log`, `public.idempotency_keys`, `public.import_batches`

| Role | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| **fon** | `audit_log` only | ✗ |
| everyone else | ✗ | ✗ |

Phase 5 territory. `audit_log` read access for Fon is useful and harmless; its
append-only triggers already refuse `UPDATE`, `DELETE` and `TRUNCATE` for every
role including `service_role`.

---

## 2. Authentication flow

**Supabase Auth, email + password, free tier.** No Vercel SSO dependency.

### Enrollment — three people, invite only

1. Public sign-up **disabled** in the dashboard.
2. Fon creates each user via **Authentication → Users → Invite user**. Supabase
   emails an invite.
3. Fon then inserts the matching `profiles` row by SQL, one per person, with the
   role.
4. Nothing else grants access.

`profiles_one_per_role` already enforces at most one holder of each role, so a
second `fon` row is rejected by the database.

### Why unwanted signups are harmless

Two independent layers:

- **Dashboard:** sign-ups disabled, so no account can be created without Fon.
- **Database (the real one):** access is keyed on a `profiles` row. An account
  with no profile matches no policy and reads zero rows everywhere. If sign-ups
  were ever re-enabled by accident, a stranger would get an account that can
  see nothing.

**Deliberately rejected:** a trigger on `auth.users` rejecting non-allowlisted
emails. `auth.users` is owned by `supabase_auth_admin`; a trigger there may not
be creatable by `postgres`, and a failing trigger on that table breaks sign-in.
The profile-row requirement achieves the same outcome without touching
Supabase's own machinery.

### Session handling in the app

`@supabase/supabase-js` with the **publishable key only**, PKCE flow, session in
`localStorage`, auto-refresh. Unauthenticated users see a sign-in screen and no
board. The app reads its own `profiles` row once after sign-in to decide which
areas to render.

**UI hiding is cosmetic. The database is the boundary.**

---

## 3. RLS design, grants, functions, triggers, view

### 3.1 The role function

```sql
create or replace function app.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select p.role from public.profiles p where p.user_id = auth.uid() $$;
```

- **`security definer`** so it reads `profiles` without depending on that
  table's own policies, and cannot recurse.
- **`set search_path = ''`** with fully-qualified names — the standard
  hardening for definer functions.
- Returns `null` for an unprofiled user, so every policy comparing against it
  fails closed.
- Returns only the caller's own role; it cannot enumerate other users.

### 3.2 Grants — a real footgun

Phase 3 ran `revoke all on schema app from anon, authenticated`, so Phase 4
must re-grant narrowly:

```sql
grant usage on schema app to authenticated;
grant execute on function app.current_app_role() to authenticated;

revoke execute on function app.touch_updated_at()              from public;
revoke execute on function app.forbid_mutation()               from public;
revoke execute on function app.revoke_api_default_privileges() from public;
```

Postgres grants `EXECUTE` to `PUBLIC` on new functions **by default**. Granting
`USAGE` on the schema without those revokes would newly expose the other three
functions. `anon` gets nothing at all.

### 3.3 Policy shape

Every policy wraps the role call in a scalar subquery:

```sql
create policy tasks_abigail_select on public.tasks
for select to authenticated
using (
  (select app.current_app_role()) = 'abigail'
  and area in ('family', 'home')
  and visibility = 'shared'
);
```

`(select …)` makes Postgres evaluate it **once per query instead of once per
row** — the well-known Supabase RLS performance idiom. It changes the plan, not
just the constant factor.

Abigail's write policies repeat the same predicate in `WITH CHECK`, so the
*resulting* row must also satisfy it. That single detail blocks move-out,
unshare, and unshare-then-move.

### 3.4 Ownership and immutability rules

1. **Provenance is immutable.** A `BEFORE UPDATE` trigger on `tasks` rejects any
   change to `id`, `created_at`, `created_by` or `source` — for every role,
   including fon and `service_role`. This mirrors `PATCHABLE_FIELDS` from
   Phase 2 and stops attribution being rewritten after the fact.
2. **Abigail's inserts are stamped, not self-declared.** A `BEFORE INSERT`
   trigger forces `created_by`/`source` to match the caller's app role, so she
   cannot insert a row attributed to Fon or to Pong.
3. **Table ownership unchanged** — `postgres`. `FORCE` RLS stays on.
4. **The view is security-definer and carries its own role filter.** It bypasses
   `tasks` RLS by design, so the filter lives inside it.

### 3.5 View design

```sql
create view public.school_summary
with (security_invoker = false) as
select id, title, status, priority, due_date, due_time, completed_at, updated_at
from public.tasks
where area = 'school'
  and (select app.current_app_role()) in ('fon', 'accountability');
```

A definer view owned by `postgres` bypasses the underlying table's RLS, which is
precisely why accountability can read School rows without holding any `tasks`
policy — and precisely why the role filter must be inside the view.

**This is the one place a mistake would be invisible to Check 19**, which only
covers `relkind in ('r','p')`. Hence the new check below.

### 3.6 Preserving Phase 3

| Phase 3 property | Phase 4 effect |
|---|---|
| `tasks_shared_only_in_shared_areas` | Untouched. Abigail's policies sit inside it. |
| Audit triggers (`append_only`, `no_truncate`) | Untouched. |
| **Check 18 / RES-001** | **Unchanged — still FAIL, still not softened.** |
| **Check 19** | Unchanged, and now more load-bearing. |
| Lockdown array | Unchanged — Phase 4 adds **no tables**. |

**New Check 20:** every view in `public` must be either
`security_invoker = true` or on a documented allowlist with a stated role
filter. A definer view is exactly the gap Phase 4 introduces, so it gets its own
check plus failure injection.

---

## 4. Threat model and abuse cases

| # | Abuse case | Control | Residual |
|---|---|---|---|
| T1 | **Self-elevation** — Abigail `UPDATE profiles SET role='fon'` | No write policy on `profiles` for anyone | None. Requires `service_role`. |
| T2 | **Signup then expect access** — stranger registers | No `profiles` row → `current_app_role()` is `null` → every policy fails | None |
| T3 | **Cross-area read** — Abigail selects `area='work'` | Her policy pins `area ∈ (family, home)`; zero rows | None |
| T4 | **Private-task read** — Abigail reads Fon's private Family tasks | `visibility='shared'` in `USING` | None |
| T5 | **Move-out** — Abigail sets `area='school'` | `WITH CHECK` rejects | None |
| T6 | **Unshare-to-hide** — Abigail sets `visibility='private'` | `WITH CHECK` rejects | None |
| T7 | **Attribution forgery** — Abigail inserts `created_by='fon'` | Insert trigger stamps from the caller's role | None |
| T8 | **Provenance rewrite** — any role edits `created_by` after insert | Immutability trigger, all roles | `DROP TRIGGER` needs owner rights |
| T9 | **Accountability reads task notes** | No `tasks` policy; view omits `notes` | None via the API |
| T10 | **Accountability writes anything** | No write policy anywhere | None |
| T11 | **Key theft** — publishable key read from page source | Public by design; grants nothing without a session, and a session still hits RLS | None |
| T12 | **`service_role` reaches the browser** | Never in a `VITE_` variable; `secrets.test.mjs` fails the build | None |
| T13 | **Session theft** (shared device, XSS) | Sessions in `localStorage` are readable by any script on the origin | **Real.** No third-party scripts today. Mitigate with short JWT expiry; MFA deferred — see **D5** |
| T14 | **Audit tampering** | Append-only triggers refuse `UPDATE`/`DELETE`/`TRUNCATE` for all roles | `DROP TABLE` needs owner |
| T15 | **Badly-written future view leaks rows** | New Check 20 + failure injection | Only as good as the check |
| T16 | **RES-001** — `supabase_admin` default ACLs | Check 18 (detect) + Check 19 (compensate) | Accepted, unchanged |
| T17 | **Pong as a user** | `profiles_role_valid` rejects `'pong'`; no auth user exists for it | None |

**T13 is the one genuinely new risk Phase 4 introduces** and it cannot be
designed away on the free tier — it is inherent to browser sessions. Recorded
here rather than buried.

---

## 5. Migration and rollback sequence

Each step is independently reversible, and **the app is switched over last**.

| # | Step | Reversible by |
|---|---|---|
| 1 | Disable public sign-ups (dashboard) | Re-enable |
| 2 | Create the three auth users (dashboard) | Delete users |
| 3 | Migration: role function, grants, triggers, policies, `school_summary`, Check 20 | `supabase/rollback-phase-4.sql` |
| 4 | Insert three `profiles` rows (SQL, service-role) | `delete from public.profiles` |
| 5 | Run `verify.sql` — expect 20 checks + CONTEXT + OVERALL | — |
| 6 | Import the board from an **Export backup** file | Data stays; app still reads `localStorage` |
| 7 | Ship the app change behind sign-in (**PR #4**) | `git revert` |
| 8 | Verify live, then decide on Vercel SSO (**D4**) | — |

**Rollback is clean because Phase 4 is purely additive.** Dropping every policy
returns the database to Phase 3's default-deny — the *safe* direction, not the
open one. Reverting the app commit returns it to `localStorage`, which is still
present on the devices and is never erased by the import.

---

## 6. Automated tests

Same approach as Phase 3: real Postgres via PGlite, offline, no credentials. The
harness gains an `auth.uid()` stub reading `request.jwt.claims` exactly as
Supabase does, plus a `withUser(role, fn)` helper.

**Positive:** each role reaches precisely its matrix row, no more.

**Cross-user negative — the core of the suite:**

- Abigail selects `work` / `school` / `faith` / `reading` / `inbox` → 0 rows
- Abigail selects a **private** Family task → 0 rows
- Abigail updates a private Family task → 0 rows affected
- Abigail moves a task to `school` → `WITH CHECK` violation
- Abigail sets `visibility='private'` → violation
- Abigail inserts `created_by='fon'` → stamped back to `abigail`
- Accountability: any `INSERT`/`UPDATE`/`DELETE` → denied
- Accountability: `select * from tasks` → 0 rows
- `school_summary` has **no `notes` column**
- Unprofiled user → 0 rows on every table and the view
- `anon` → permission denied on every table
- **Self-elevation:** every role attempts `UPDATE`/`INSERT`/`DELETE` on
  `profiles` → denied; each reads only its own row
- Provenance immutability → rejected for all roles

**Failure injection** — the check must be shown to fail, not merely to pass:

- Drop `visibility='shared'` from Abigail's policy → the private-task test fails
- Drop the `WITH CHECK` → the move-out test fails
- Make `school_summary` `security_invoker = true` → Check 20 FAIL
- Add a `security definer` view with no role filter → Check 20 FAIL
- Add any write policy to `profiles` → the self-elevation test fails
- Drop the immutability trigger → the provenance test fails

Plus every Phase 3 suite still green, and **a test asserting Check 18 still
FAILs** — so nobody quietly "fixes" the board while adding policies.

---

## 7. Environment variables

| Variable | Value type | Vercel | Local `.env` | Browser? |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | Project API URL (**not** the dashboard URL) | ✅ all environments | ✅ | **Yes** — public |
| `VITE_SUPABASE_ANON_KEY` | Publishable key (`sb_publishable_…`) | ✅ all environments | ✅ | **Yes** — public |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key (`sb_secret_…`) | ❌ **not needed in Phase 4** | Only for an admin script | **Never** |
| `SUPABASE_DB_URL` | Connection string with password | ❌ | Only for `psql` | **Never** |

**Phase 4 needs exactly two variables in Vercel, both public.** No secret is
required anywhere in this phase.

**No value is requested or recorded in this repository.** `.env.example` already
carries placeholders only, and `secrets.test.mjs` fails the build if a secret
is ever given a `VITE_` prefix or a key is committed. The repository is public.

---

## 8. Manual dashboard steps

One at a time, each confirmed before the next.

1. **Authentication → Sign In / Providers → Email → turn OFF "Allow new users
   to sign up."** Confirm it reads disabled.
2. **Authentication → Users → Invite user** ×3 (Fon, Abigail, the
   accountability person). Send back only the **user UUIDs** — never passwords.
3. *(Optional)* **Authentication → Sessions → set JWT expiry to 1 hour** —
   mitigates T13.
4. **Project Settings → API → copy the Project URL and publishable key** into
   Vercel environment variables. Fon does this; the values are never needed in
   this conversation or the repository.

Steps 3–4 come after the migration is applied and verified.

---

## 9. Proposed PR #3 scope

**In scope:** role function and grants; the two triggers; RLS policies for all
six tables; the `school_summary` view; Check 20 and its failure injection; the
Phase 4 test suite; `supabase/rollback-phase-4.sql`; documentation.

**Explicitly out of scope:** connecting the live app to Supabase (**PR #4**);
the data import; Phase 5 Pong; any Vercel SSO change; any role-management UI.

Splitting the database boundary from the app wiring means the security model
gets reviewed on its own, against tests, before any UI depends on it.

### Acceptance criteria

1. Every matrix cell has a passing test, positive and negative.
2. Every failure injection above flips its check to FAIL.
3. **Check 18 still FAILs; RES-001 documented unchanged.**
4. Check 19 still passes; no new tables; lockdown array unchanged.
5. Check 20 exists, passes, and is failure-injected.
6. `anon` and unprofiled users reach zero rows on every table and the view.
7. No write path to `profiles` exists for any authenticated role.
8. `service_role` appears in no `VITE_` variable; secrets sweep clean.
9. Migrations re-runnable; rollback safe twice and on a clean database; leaves
   `auth.users` intact.
10. Full suite, lint, build and generated-SQL identity all green.
11. **Production bundle byte-identical to `main`** — PR #3 touches no `src/`.
12. Nothing merged, deployed, connected or imported.

---

## Unresolved decisions — D1–D5

**These are open. Implementation is blocked until they are settled.** The
recommendations are defaults, not conclusions.

### D1 — Abigail's delete rights · UNRESOLVED

Full delete in Family/Home, delete only her own tasks, or archive-only?

**Recommendation:** delete only rows she created; archive anything else.
Deleting someone else's task from a shared list is the easiest accident to make
and the hardest to notice.

### D2 — Can Abigail see Fon's *private* Family/Home tasks? · UNRESOLVED

This plan says **no**.

**Consequence to confirm:** a task added without being marked shared is
invisible to her. That needs to match how the two of you actually use the
shared lists.

### D3 — Role-management surface · UNRESOLVED

Dashboard/SQL only, or an in-app admin screen for Fon?

**Recommendation:** dashboard/SQL only. Three people, rarely changing; an admin
write path is the single most dangerous thing that could be added here.

### D4 — Vercel SSO timing · UNRESOLVED

**Recommendation:** keep it on through Phase 4, disable only after PR #4 ships
and is reviewed. Two gates cost nothing while the first one is being verified.

### D5 — MFA · UNRESOLVED

The free tier supports TOTP.

**Recommendation:** defer. This is the main mitigation for **T13**, so it is a
real trade-off rather than a formality — revisit once the accounts hold live
data.

---

## Note, not a decision

Supabase's **built-in email sender is rate-limited** (a few messages per hour)
and is intended for development. For three invites and occasional password
resets that is fine. If resets ever feel unreliable, custom SMTP is the fix and
is free to configure.
