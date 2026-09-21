# Phase 4 plan — authentication & authorization

> **Status: PLANNING ONLY. Nothing here is implemented.**
>
> Revision 2, incorporating an independent review of revision 1. Contains no
> migrations, no application code and no dependencies. The SQL is illustrative
> design, not files to apply.
>
> - **Baseline:** merged `main` at `3dc59ae` (Phase 3).
> - **Not done:** no Supabase change, no Vercel change, no deploy, no app
>   connection, no user creation, no data import.
> - **Decisions D1–D6 are now RESOLVED** and recorded at the end. One
>   sub-question (D5a) is noted because it imposes on another person.

**Design principle:** an account grants nothing. Authorization comes from a
`profiles` row that only Fon can create. A stray signup lands with zero access
by construction, not by a rule someone has to remember.

Constraints:

- Supabase Auth on the **free tier**.
- **No dependence on any paid Vercel feature.**
- Default deny everywhere.
- Phase 3's sharing constraint, audit protections, **Check 18 residual
  (RES-001)** and **Check 19** are preserved unchanged.

---

## 0. One database role, three people

This is the single most important thing to understand before reading the
matrices, and revision 1 failed to state it.

**PostgREST authenticates every signed-in person as the same database role:
`authenticated`.** There is no per-person database role. Table `GRANT`s are
therefore *identical* for Fon, Abigail and the accountability viewer — they are
the outer envelope of what any signed-in person could possibly do.

**All separation between the three people is enforced by RLS policies**, which
evaluate `app.current_app_role()` per request. Grants say "this verb is
reachable by somebody"; policies say "by whom, on which rows".

Two consequences:

1. `DELETE` must be granted on `tasks` to `authenticated` for Fon's delete to
   work at all. Abigail is blocked from deleting **by the absence of a DELETE
   policy for her**, not by the grant. A reviewer reading only the grants would
   wrongly conclude she can delete.
2. Phase 3's Check 5 — "anon and authenticated hold no privilege on any public
   table" — **will necessarily start failing** the moment Phase 4 grants
   anything. It must be redefined as an exact allowlist, not relaxed or
   deleted. See §3.3.

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
| **abigail** | `area ∈ (family, home)` **and** `visibility = 'shared'` | same, stamped `created_by='abigail'`, `source='abigail'` | same rows; result must stay in those areas and stay shared | **none — D1: archive-only** |
| **accountability** | ✗ — no policy at all; reads `school_summary` only | ✗ | ✗ | ✗ |
| **unprofiled** | ✗ | ✗ | ✗ | ✗ |
| **anon** | ✗ | ✗ | ✗ | ✗ |

Abigail's `visibility = 'shared'` condition is load-bearing: without it she
would see Fon's private Family and Home tasks. It appears in both `USING` and
`WITH CHECK`, so she also cannot flip a task to private to hide it, nor move
one out of her areas.

**D1 resolved — Abigail has no DELETE policy in Phase 4.** She archives by
setting `status='archived'`, which her UPDATE policy permits. Archiving is
reversible; deleting someone else's task from a shared list is not, and is the
easiest accident to make and the hardest to notice.

**Work is covered by absence.** No policy mentions `area = 'work'` except
fon's, so every other role gets zero rows.

### `public.school_summary` (view — accountability's only door)

| Role | SELECT |
|---|---|
| **fon** | ✓ |
| **accountability** | ✓ |
| everyone else | ✗ |

Columns exposed: `id, title, status, priority, due_date, due_time,
completed_at, updated_at`.

**D6 resolved — the accountability viewer sees School task *titles*, and never
task *notes*.** Titles are necessary for the summary to mean anything
("Overdue: UMPI 311 paper"). `notes` is not in the view and accountability
holds no policy on `tasks`, so there is no path to it. This is a deliberate
disclosure decision, recorded here so it is never mistaken for an oversight:
**anything written in a School task title is visible to the accountability
viewer.**

### `public.area_notes`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| **fon** | all | all | all | **none — revised** |
| **abigail** | `area ∈ (family, home)` | same | same | none |
| **accountability** | `area = 'school'` only | ✗ | ✗ | ✗ |
| **unprofiled / anon** | ✗ | ✗ | ✗ | ✗ |

**Revised from revision 1:** no role gets DELETE on `area_notes`, and the verb
is not granted to `authenticated` at all. There are at most seven rows, one per
area; blanking a note is an UPDATE. Removing the verb removes a whole class of
question.

The School status note is displayed in Accountability View today, so it is
deliberately readable. It is the *area* note, not a task note.

### `public.profiles`

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| **any signed-in user** | own row only (`user_id = auth.uid()`) | ✗ | ✗ | ✗ |
| **anon** | ✗ | ✗ | ✗ | ✗ |

**D3 resolved — no client write path to `profiles` exists, permanently.** No
INSERT, UPDATE or DELETE policy is created in Phase 4 or any later phase, and
the verbs are not granted to `authenticated`. Roles are assigned only by
`service_role`/`postgres` via Dashboard or SQL. This is a standing prohibition,
not a Phase 4 convenience.

### `public.audit_log`, `public.idempotency_keys`, `public.import_batches`

| Role | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| **fon** | `audit_log` only | ✗ |
| everyone else | ✗ | ✗ |

`idempotency_keys` and `import_batches` get no grant and no policy for anyone.

---

## 2. Authentication flow

**Supabase Auth, email + password, free tier.**

### Enrollment — three people, invite only

1. Public sign-up **disabled** in the dashboard.
2. Fon creates each user via **Authentication → Users → Invite user**.
3. Fon then inserts the matching `profiles` row by SQL.
4. Nothing else grants access.

`profiles_one_per_role` enforces at most one holder of each role.

### Nothing auto-creates a profile

**This must be asserted, not assumed.** The plan requires tests proving:

- no trigger exists on `auth.users`;
- no function anywhere inserts into `public.profiles`;
- inserting a row into `auth.users` produces **zero** `profiles` rows;
- a user with no profile row reads zero rows from every table and the view.

If a future Supabase feature or a copy-pasted snippet ever added an
auto-provisioning trigger, these fail.

**Deliberately rejected:** a trigger on `auth.users` rejecting non-allowlisted
emails. That table is owned by `supabase_auth_admin`; a trigger there may not be
creatable by `postgres`, and a failing trigger breaks sign-in.

### Session handling

`@supabase/supabase-js` with the **publishable key only**, PKCE flow. Required
controls are in §7.

**UI hiding is cosmetic. The database is the boundary.**

---

## 3. RLS design, grants, functions, triggers, view

### 3.1 The role function — exact required properties

```sql
create or replace function app.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select p.role from public.profiles p where p.user_id = auth.uid() $$;

alter function app.current_app_role() owner to postgres;
```

Four properties, each **individually tested** because each is individually
load-bearing:

| Property | Required value | Why |
|---|---|---|
| Owner | `postgres` | A definer function runs as its owner. If it were owned by a lesser role it could not read `profiles`; if owned by `supabase_admin` it would run with more authority than intended. |
| `prosecdef` | `true` | Reads `profiles` without depending on that table's policies. |
| `proconfig` | contains `search_path=` (empty) | Blocks search-path hijacking — the classic definer-function attack. |
| `provolatile` | `s` (stable) | Lets Postgres evaluate it once per statement. |

Returns `null` for an unprofiled user, so every policy comparing against it
fails closed. Returns only the caller's own role; it cannot enumerate others.

**Prohibition: no policy on `public.profiles` may call
`app.current_app_role()`.** The function reads `profiles`; a profiles policy
calling it would be self-referential. The profiles SELECT policy must be
exactly `user_id = (select auth.uid())` and nothing more. A test asserts that
no policy expression on `profiles` mentions the function name.

### 3.2 Grants — complete enumeration

Phase 3 ran `revoke all on schema app from anon, authenticated`, so Phase 4
must re-grant narrowly. **This is the complete list; anything not here is an
over-grant and must fail Check 5.**

```sql
-- Schema
grant usage on schema app to authenticated;

-- Functions: exactly one is reachable
grant execute on function app.current_app_role() to authenticated;
revoke execute on function app.touch_updated_at()              from public;
revoke execute on function app.forbid_mutation()               from public;
revoke execute on function app.revoke_api_default_privileges() from public;

-- Future functions in app must not inherit PUBLIC EXECUTE
alter default privileges for role postgres in schema app
  revoke execute on functions from public, anon, authenticated;

-- Tables and view
grant select, insert, update, delete on public.tasks          to authenticated;
grant select, insert, update         on public.area_notes     to authenticated;
grant select                         on public.profiles       to authenticated;
grant select                         on public.school_summary to authenticated;
grant select                         on public.audit_log      to authenticated;
```

`anon` receives **nothing, anywhere**. `idempotency_keys` and `import_batches`
receive no grant.

Two footguns this closes:

- Postgres grants `EXECUTE` to `PUBLIC` on new functions **by default**.
  Granting `USAGE` on the schema without the three revokes would newly expose
  the other functions.
- `ALTER DEFAULT PRIVILEGES` is **role-scoped** — the lesson RES-001 taught the
  hard way. It is written `for role postgres` because `postgres` creates the
  app-schema functions. If a future function is created by another role, the
  default does not apply to it, so the Check 5 allowlist remains the real
  backstop.

No sequence grants are needed: `audit_log.id` is an identity column and
`authenticated` cannot INSERT there.

### 3.3 Checks 5 and 6 redefined as exact allowlists

Phase 3's Check 5 asserts `authenticated` holds **no** privilege on any public
table. Phase 4 necessarily grants privileges, so the check must be redefined —
**tightened into an exact allowlist, never relaxed**.

- **Check 5 — `authenticated` holds exactly the expected privileges.** Compare
  the actual `(table, privilege)` set against the literal expected set from
  §3.2. **Any extra privilege fails; any missing privilege also fails.**
- **Check 6 — `anon` holds no privilege on any public table or view.**
  Unchanged in spirit, extended to views.

**Over-grant failure injection** (each must flip Check 5 to FAIL):

| Injection | Why it matters |
|---|---|
| `grant delete on public.area_notes to authenticated` | A verb no role should have |
| `grant select on public.import_batches to authenticated` | A table no role should reach |
| `grant insert on public.profiles to authenticated` | The self-elevation surface |
| `grant update on public.audit_log to authenticated` | Tamper surface |
| `grant select on public.tasks to anon` | Check 6 |
| Revoking an *expected* grant | The allowlist must be exact in both directions |

### 3.4 Policy shape

```sql
create policy tasks_abigail_select on public.tasks
for select to authenticated
using (
  (select app.current_app_role()) = 'abigail'
  and area in ('family', 'home')
  and visibility = 'shared'
);
```

`(select …)` makes Postgres evaluate the role once per query instead of once
per row — the Supabase RLS performance idiom. It changes the plan, not just the
constant factor.

Abigail's write policies repeat the predicate in `WITH CHECK`, so the
*resulting* row must also satisfy it. That blocks move-out, unshare, and
unshare-then-move.

### 3.5 Provenance: stamping scoped to app sessions

Two triggers on `public.tasks`.

**A. Immutability (all sessions, all roles).** `BEFORE UPDATE` rejects any
change to `id`, `created_at`, `created_by` or `source` — including for `fon`
and `service_role`. Mirrors Phase 2's `PATCHABLE_FIELDS`.

**B. Stamping (app sessions only).** `BEFORE INSERT` forces `created_by` and
`source` from the caller's app role — **but only when there is an app session**:

```sql
if auth.uid() is not null and (select app.current_app_role()) is not null then
  -- stamp
end if;
```

Exact mapping:

| App role | `created_by` | `source` |
|---|---|---|
| `fon` | `fon` | `manual` |
| `abigail` | `abigail` | `abigail` |
| `accountability` | — cannot insert (no policy, no reachable path) | — |

**Why the scoping matters, and what must be proved.** The Phase 3 importer runs
as a `BYPASSRLS` role with **no** `auth.uid()`, and carries `created_by` and
`source` from the exported board — including `pong-voice` and `claude-import`
values that no app role maps to. An unconditional stamping trigger would
silently rewrite every imported row's provenance to `fon`/`manual`, destroying
exactly the history Phase 2 and Phase 3 went to trouble to preserve.

**Required test:** run the Phase 3 generated import SQL as a `BYPASSRLS` role
against a Phase 4 database and assert every row's `created_by` and `source`
match the export byte for byte, including `pong-voice` and `claude-import`.
Plus the negative: an app-session insert claiming `created_by='fon'` from
Abigail's session is stamped back to `abigail`.

### 3.6 View design

```sql
create view public.school_summary
with (security_invoker = false, security_barrier = true) as
select id, title, status, priority, due_date, due_time, completed_at, updated_at
from public.tasks
where area = 'school'
  and (select app.current_app_role()) in ('fon', 'accountability');
```

- **`security_invoker = false`** — the view runs as its owner and bypasses
  `tasks` RLS by design, which is how accountability reads School rows while
  holding no `tasks` policy. The role filter therefore lives *inside* the view.
- **`security_barrier = true`** — **added in revision 2.** Without it, Postgres
  may push a user-supplied `WHERE` predicate *below* the view's own filter. A
  cheap leaky function in a predicate could then observe rows the filter was
  meant to exclude. The barrier forbids that reordering. It costs some
  optimisation freedom, which is irrelevant at seven areas and a few hundred
  rows.
- Owner: `postgres`, tested.

### 3.7 Check 20 — views, strengthened

Revision 1's Check 20 only asserted `security_invoker`. That is too weak: a
definer view whose role filter was *edited away* would still pass.

Check 20 asserts all of:

1. **Every ordinary view** (`relkind = 'v'`) in `public` is either
   `security_invoker = true`, or is on the allowlist — currently exactly
   `school_summary`.
2. **`school_summary`'s definition is pinned.** `pg_get_viewdef()` must contain
   the role filter and must **not** contain `notes`. Comparing the normalised
   definition text catches an edit that a property check would miss.
3. **`school_summary` has `security_barrier = true`.**
4. **No materialized views exist in `public`** (`relkind = 'm'`). RLS does not
   apply to materialized views *at all*, so one built over `tasks` would be an
   unprotected copy of the board. There is no legitimate need for one here, so
   the rule is a flat prohibition rather than a property check.
5. Every view's owner is `postgres`.

**Behavioral failure injection** — not just property injection:

| Injection | Expected |
|---|---|
| Recreate `school_summary` without the role filter | Check 20 FAIL **and** a behavioral test shows Abigail reading School rows |
| Recreate it including `notes` | Check 20 FAIL **and** accountability can read a note |
| Drop `security_barrier` | Check 20 FAIL |
| Set `security_invoker = true` | Check 20 FAIL (accountability holds no `tasks` policy, so the view returns nothing — a silent outage, caught) |
| Create `create materialized view public.mv as select * from public.tasks` | Check 20 FAIL |
| Create an unrelated definer view over `tasks` | Check 20 FAIL |

The behavioral half matters: a check that only reads catalog metadata can pass
while the data is exposed.

### 3.8 Preserving Phase 3

| Phase 3 property | Phase 4 effect |
|---|---|
| `tasks_shared_only_in_shared_areas` | Untouched. |
| Audit triggers | Untouched. |
| **Check 18 / RES-001** | **Unchanged — still FAIL, still not softened.** |
| **Check 19** | Unchanged. |
| Lockdown array | Unchanged — Phase 4 adds **no tables**. |
| Check 5 / 6 | **Redefined as exact allowlists** (§3.3). |
| Check 17 | See §5. |

**OVERALL remains an expected FAIL.** RES-001 is unfixable from this project,
Check 18 reports it honestly, and nothing in Phase 4 changes that. A green
board would mean the check had been weakened. A test asserts Check 18 still
fails after Phase 4, so nobody can quietly green it while adding policies.

---

## 4. Threat model

**Correction from revision 1.** Revision 1 listed MFA as a mitigation for
session theft. That is wrong: MFA gates *credential* use at sign-in and does
nothing for a session token already stolen from a live browser. The two are now
separate entries with the correct controls.

| # | Abuse case | Control | Residual |
|---|---|---|---|
| T1 | **Self-elevation** — Abigail `UPDATE profiles SET role='fon'` | No write policy and no write grant on `profiles`, permanently (D3) | None. Requires `service_role`. |
| T2 | **Signup then expect access** | No `profiles` row → role is `null` → every policy fails | None |
| T3 | **Cross-area read** — Abigail selects `area='work'` | Policy pins `area ∈ (family, home)` | None |
| T4 | **Private-task read** | `visibility='shared'` in `USING` | None |
| T5 | **Move-out** — Abigail sets `area='school'` | `WITH CHECK` rejects | None |
| T6 | **Unshare-to-hide** | `WITH CHECK` rejects | None |
| T7 | **Attribution forgery** | Insert trigger stamps from caller's role | None |
| T8 | **Provenance rewrite** | Immutability trigger, all roles | `DROP TRIGGER` needs owner |
| T9 | **Accountability reads task notes** | No `tasks` policy; `notes` absent from the view; Check 20 pins the definition | **Titles are visible by design — D6** |
| T10 | **Accountability writes** | No write policy, no write grant | None |
| T11 | **Over-grant creep** — a later migration grants too much | Check 5 exact allowlist + over-grant injection | Only as good as the check |
| T12 | **Leaky-function predicate on the view** | `security_barrier = true` | None known |
| T13 | **Session theft** (XSS, shared device) | **CSP**, JWT expiry ≤ 1 h, refresh-token rotation, explicit sign-out (§7). **Not MFA.** | Real but bounded. A stolen token expires within the hour and cannot be refreshed after rotation detects reuse. |
| T14 | **Credential compromise** (password reuse, phishing) | **TOTP MFA** (D5) | Fon covered before import; others per D5a |
| T15 | **Audit tampering** | Append-only triggers, all roles | `DROP TABLE` needs owner |
| T16 | **Materialized view over `tasks`** | RLS does not apply to matviews; Check 20 forbids them in `public` | None while checked |
| T17 | **Import rewrites provenance** | Stamping scoped to app sessions; import-preservation test | None |
| T18 | **`service_role` reaches the browser** | Never in a `VITE_` variable; `secrets.test.mjs` | None |
| T19 | **Auto-provisioned profile** | Tests assert nothing creates profiles (§2) | None while checked |
| T20 | **RES-001** | Check 18 (detect) + Check 19 (compensate) | Accepted, unchanged |
| T21 | **Pong as a user** | `profiles_role_valid` rejects `'pong'`; no auth user | None |

---

## 5. Migration and rollback sequence

| # | Step | PR / manual | Reversible by |
|---|---|---|---|
| 1 | Tailwind scope prerequisite | **PR #4** | `git revert` |
| 2 | Disable public sign-ups | manual | Re-enable |
| 3 | Create three auth users | manual | Delete users (manual, never scripted) |
| 4 | DB migration: role function, grants, triggers, policies, view, Check 20, Checks 5/6 | **PR #5** | `supabase/rollback-phase-4.sql` |
| 5 | Insert three `profiles` rows | manual SQL | `delete from public.profiles` |
| 6 | Run `verify.sql` | manual | — |
| 7 | MFA for Fon; JWT ≤ 1 h; refresh rotation | manual | — |
| 8 | App wiring, CSP, sign-out, external-script test | **PR #6** | `git revert` |
| 9 | **Import real data — last** | manual | Data retained; `localStorage` untouched |
| 10 | Re-run `verify.sql` | manual | — |

**Import is deliberately last**, after the session controls in step 7–8 exist.
Revision 1 had it before app wiring; the review was right that real data should
not enter a system whose session handling is not yet hardened.

### Rollback is database-only

`supabase/rollback-phase-4.sql` drops **only** the policies, grants, triggers,
view and function added by Phase 4. Its required properties, each tested:

- **It must not touch `auth.users`.** Deleting people's accounts is a separate,
  deliberate, manual Dashboard action. It is never scripted, never part of a
  rollback file, and never bundled with a schema change. Losing a schema change
  should not cost someone their account.
- It must not delete `profiles` rows — role assignments survive a policy
  rollback so a re-apply does not need re-enrolment.
- Safe to run twice, and on a database that never had Phase 4.
- After it runs, the database is back to Phase 3 default-deny — the **safe**
  direction, not the open one.

### Check 17 changes after import — expected

Check 17 reads *"No task data present yet (schema only, as expected in
Phase 3)"*. It is written `PASS` at zero rows, else `NOTE`. After step 9 it
becomes **NOTE with a row count**. `NOTE` carries no status weight, so OVERALL
is unaffected. This is expected and must not be mistaken for a regression; the
check's wording should be updated in PR #5 to describe both phases.

---

## 6. Automated tests

Real Postgres via PGlite, offline, no credentials. The harness gains an
`auth.uid()` stub reading `request.jwt.claims` as Supabase does, plus a
`withUser(role, fn)` helper.

**Function properties (§3.1):** owner is `postgres`; `prosecdef` true;
`proconfig` contains an empty `search_path`; `provolatile` is `s`; no policy on
`profiles` references the function name.

**Positive:** each role reaches precisely its matrix row, no more.

**Cross-user negative:**

- Abigail selects `work` / `school` / `faith` / `reading` / `inbox` → 0 rows
- Abigail selects a **private** Family task → 0 rows
- Abigail updates a private Family task → 0 rows affected
- Abigail moves a task to `school` → `WITH CHECK` violation
- Abigail sets `visibility='private'` → violation
- **Abigail attempts DELETE on a shared Family task → denied (D1)**
- Abigail archives a shared Family task → allowed
- Abigail inserts `created_by='fon'` → stamped back to `abigail`
- Accountability: any write → denied; `select * from tasks` → 0 rows
- **`school_summary` exposes `title` and has no `notes` column (D6)**
- Unprofiled user → 0 rows on every table and the view
- `anon` → permission denied on every table and the view
- Every role attempts write on `profiles` → denied; each reads only its own row
- Provenance immutability → rejected for all roles
- **Phase 3 import preserves `created_by`/`source` byte for byte (§3.5)**
- **Nothing auto-creates a profile (§2)**

**Failure injection:** every row in §3.3 and §3.7, plus: drop
`visibility='shared'` → private-task test fails; drop `WITH CHECK` → move-out
test fails; add a write policy to `profiles` → self-elevation test fails; drop
the immutability trigger → provenance test fails; **make stamping
unconditional → the import-preservation test fails.**

Plus all Phase 3 suites green and **a test asserting Check 18 still FAILs**.

---

## 7. Session and browser controls — required before real data import

These are **blocking prerequisites for step 9**, not polish.

| Control | Requirement | Where |
|---|---|---|
| **CSP** | Content-Security-Policy restricting `script-src` to `'self'`, and `connect-src` to `'self'` plus the Supabase project origin. No `unsafe-inline` for scripts. | Response headers (`vercel.json`) — PR #6 |
| **JWT expiry** | **≤ 1 hour.** | Supabase Dashboard |
| **Refresh-token rotation** | Enabled, with reuse detection | Supabase Dashboard |
| **Explicit sign-out** | A visible control calling `supabase.auth.signOut()`, clearing local session state | PR #6 |
| **External-script test** | An automated test asserting the built `index.html` and bundle load **no third-party origin** | PR #6 |

Rationale: the session lives in browser storage, so its realistic compromise
path is a script on the origin. CSP plus the external-script test keep that
surface at zero; short expiry and rotation bound the damage if a token does
escape. **MFA does not help here** — it gates sign-in, not a stolen token.

---

## 8. Environment variables

| Variable | Value type | Vercel | Local `.env` | Browser? |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | Project API URL (**not** the dashboard URL) | ✅ all environments | ✅ | **Yes** — public |
| `VITE_SUPABASE_ANON_KEY` | Publishable key (`sb_publishable_…`) | ✅ all environments | ✅ | **Yes** — public |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key (`sb_secret_…`) | ❌ not needed in Phase 4 | Only for an admin script | **Never** |
| `SUPABASE_DB_URL` | Connection string with password | ❌ | Only for `psql` | **Never** |

**Phase 4 needs exactly two variables in Vercel, both public.** No value is
requested or recorded in this repository, which is public. `secrets.test.mjs`
fails the build if a secret is given a `VITE_` prefix or a key is committed.

---

## 9. Manual dashboard steps

One at a time, each confirmed before the next.

1. **Authentication → Sign In / Providers → Email → turn OFF "Allow new users
   to sign up."**
2. **Authentication → Users → Invite user** ×3. Send back only **user UUIDs** —
   never passwords.
3. **Authentication → Sessions → JWT expiry ≤ 1 hour; enable refresh-token
   rotation with reuse detection.**
4. **Fon enrolls TOTP MFA** (D5) — before step 9 of §5.
5. **Project Settings → API → copy Project URL and publishable key** into Vercel
   environment variables. Fon does this; the values are never needed here.

---

## 10. Vercel deployment protection — verified, not assumed

Read from the Vercel project API on 2026-09-21:

```
ssoProtection: { enabled: true, deploymentType: "all_except_custom_domains" }
passwordProtection: { enabled: false }
trustedIps: { enabled: false }
domains: fon-os.vercel.app,
         fon-os-fon-villanueva-s-projects.vercel.app,
         fon-os-git-main-fon-villanueva-s-projects.vercel.app
```

**Exact scope:** `all_except_custom_domains` covers **every deployment reached
through a `*.vercel.app` URL — production included**, and exempts custom
domains. The project currently has **no custom domain**, so at present it
covers everything.

**This is broader than "preview-scoped."** Recording that plainly because D4 was
framed as preview-scoped, and the setting reported by the API is not.

**D4 resolved — leave it exactly as it is, permanently, and depend on nothing
about it.** Two reasons:

1. Whether this scope is a free or paid capability on this account is **not
   determinable from the API response**, and this plan must not depend on a
   paid feature. Leaving the setting untouched avoids resolving that question
   and avoids any risk of a change implying an upgrade.
2. It is defence in depth, not the boundary. **Supabase Auth plus RLS is the
   boundary**, and it must be sufficient on its own. If Vercel protection
   vanished tomorrow — plan change, billing change, custom domain added — the
   security posture would be unchanged.

**Open item for Fon, not a blocker:** confirm in the Vercel dashboard which
plan this account is on and whether this protection scope is included at that
tier. If it turns out to require payment, **nothing in this plan needs to
change** — turn it off and the Supabase boundary stands alone. Adding a custom
domain later would exempt that domain from this protection, which is another
reason not to lean on it.

---

## 11. Tailwind scope — a separate prerequisite (PR #4)

**This is not a Phase 4 security matter and is not bundled with it.**

### The problem

Tailwind scans the whole project for class-name candidates, including `docs/`.
Ordinary English in documentation generates unused CSS utilities. Revision 1 of
this very document added `.invisible{visibility:hidden}` to the production
bundle, purely because the word *"invisible"* appears in the threat model.

### The change

Add to `src/App.css`, beside the existing `supabase/` exclusion:

```css
@source not "../docs";
@source not "../scripts";
```

### Measured effect

Computed by building with and without the exclusion:

| Class | Present before | Present after | Verdict |
|---|---|---|---|
| `.invisible` | yes | **no** | removed |
| `.fixed` | yes | **no** | removed |
| `.visible` | yes | **yes** | **retained** — generated from `src/App.test.jsx`, which stays scanned |

**51 bytes removed. No rule that any element uses is affected.**

*(Revision 1 reported `.visible` as also removed. That was wrong — an artifact
of diffing on `}` boundaries, which shift when a neighbouring rule disappears.
Corrected by checking each class directly in both files.)*

### Required verification in PR #4

Both removed classes must be shown **unused by the application**, not merely
unused-looking:

- `invisible` appears **nowhere** in `src/` or `index.html`.
- `fixed` appears **nowhere** in `src/` or `index.html` — it originated in
  `docs/`.
- Distinguish the `focus-visible:` *variant* used throughout `src/App.jsx` from
  the `.visible` *utility*; they are unrelated, and `.visible` is retained
  anyway.
- A rendering check at desktop and iPhone widths before and after.

**No security impact. No rendering impact.**

### Bundle acceptance, restated

The "byte-identical to `main`" criterion from Phases 1–3 **cannot survive any
change under `docs/`** and is therefore retired in its old form.

**New baseline: the build produced by PR #4** (post-exclusion). From PR #5
onward:

- **PR #5** (database + docs) must be byte-identical to the **post-exclusion
  baseline** — it touches no `src/`, and `docs/` no longer affects the bundle.
- **PR #6** changes the app deliberately; byte-identity does not apply. It is
  reviewed on behaviour, not bytes.

---

## 12. PR sequence — renumbered, no shared numbers

Revision 1 used "PR #3" for both this plan and the database work. Corrected:

| PR | Contents | State |
|---|---|---|
| **#3** | **This plan document only** | Draft, planning only |
| **#4** | Tailwind scope prerequisite (`src/App.css`) | Not started |
| **#5** | Database: role function, grants, triggers, policies, view, Checks 5/6/20, rollback file, tests | Not started |
| **#6** | App wiring: sign-in, session handling, CSP, sign-out, external-script test | Not started |

Import happens **after #6**, manually.

### Acceptance criteria — PR #5 (database)

1. Every matrix cell has a passing test, positive and negative.
2. Every failure injection in §3.3, §3.7 and §6 flips its check to FAIL.
3. **Check 18 still FAILs; RES-001 documented unchanged; OVERALL still FAIL.**
4. Check 19 passes; no new tables; lockdown array unchanged.
5. Checks 5 and 6 are exact allowlists and reject both over- and under-grants.
6. Check 20 pins the view definition, covers views and materialized views, and
   has behavioral injections.
7. `current_app_role()` owner, definer state, empty search path and volatility
   are each asserted; no `profiles` policy references it.
8. Provenance stamping is app-session-scoped, and **the Phase 3 import
   preserves `created_by`/`source` exactly**.
9. Nothing auto-creates a `profiles` row.
10. `anon` and unprofiled users reach zero rows on every table and the view.
11. No write path to `profiles` for any authenticated role.
12. Rollback is database-only, **leaves `auth.users` untouched**, safe twice and
    on a clean database.
13. Secrets sweep clean; no secret in a `VITE_` variable.
14. Full suite, lint, build, generated-SQL identity green.
15. Bundle byte-identical to the **post-PR-#4 baseline**.
16. Nothing merged, deployed, connected or imported.

### Acceptance criteria — PR #6 (app wiring)

1. Unauthenticated users see sign-in and no board data.
2. CSP present; `script-src 'self'`; `connect-src` limited to self + Supabase.
3. External-script test passes: no third-party origin in the built output.
4. Explicit sign-out clears the session.
5. **Family and Home tasks visibly show shared vs private (D2).**
6. Accountability View renders from `school_summary` only.
7. Keyboard accessibility and loading/empty/error states preserved.

---

## Resolved decisions

### D1 — Abigail's delete rights · RESOLVED

**Archive-only. No DELETE policy for Abigail in Phase 4**, and her UPDATE
policy permits `status='archived'`. `DELETE` is granted to `authenticated` only
because Fon needs it; Abigail is blocked by policy.

### D2 — Abigail and private Family/Home tasks · RESOLVED

**She sees only `shared` tasks, never Fon's private ones.** Enforced in `USING`
and `WITH CHECK`.

**Recorded app requirement for PR #6:** Family and Home tasks must **visibly
indicate sharing state**, so it is never ambiguous whether Abigail can see a
given item. Phase 2 already ships `shared`/`private` chips in those two areas;
PR #6 must preserve and verify them.

### D3 — Role management · RESOLVED

**Dashboard/SQL only, permanently.** No client write path to `profiles` — no
policy and no grant — in Phase 4 or later. A standing prohibition.

### D4 — Vercel deployment protection · RESOLVED

**Leave the current setting exactly as it is, permanently, and depend on
nothing about it.** Exact verified scope and reasoning in §10. The Supabase
boundary must stand alone.

### D5 — MFA · RESOLVED

**Fon enrolls TOTP MFA before real data import** (§5 step 7, §9 step 4).

**D5a — open sub-question for Fon.** The recommendation is that Abigail and the
accountability viewer **also enroll at account creation**, because MFA
retrofitted later is the step that never happens. This imposes a requirement on
other people, so it is Fon's call, not this plan's. If either does not enroll,
they remain gated by invite-only enrollment, the profile-row requirement and
the policies; the residual is credential compromise (T14) for that person only.

**Threat-model correction:** MFA mitigates **credential compromise (T14)**.
Session theft (T13) is mitigated by **CSP, short JWT lifetime, refresh-token
rotation and explicit sign-out** — §7.

### D6 — Accountability and School task content · RESOLVED

**The accountability viewer may see School task titles through
`school_summary`, and never task notes.** Titles are required for the summary
to be meaningful. `notes` is excluded from the view, accountability holds no
`tasks` policy, and Check 20 pins the definition so the exclusion cannot be
edited away unnoticed.

**Consequence, recorded deliberately:** anything written into a School task
title is visible to the accountability viewer. Detail that should not be shared
belongs in `notes`.

---

## Note, not a decision

Supabase's built-in email sender is rate-limited (a few messages per hour) and
intended for development. For three invites and occasional password resets that
is fine. If resets become unreliable, custom SMTP is free to configure.
