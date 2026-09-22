# Phase 4 plan — authentication & authorization

> **Status: PLANNING ONLY. Nothing here is implemented.**
>
> Revision 3, incorporating the closure review of revision 2 (head `3374bd5`),
> plus a §11 measurement correction made once PR #4 was built from `main`.
> Contains no migrations, no application code and no dependencies. The SQL is
> illustrative design, not files to apply.
>
> - **Baseline:** merged `main` at `3dc59ae` (Phase 3).
> - **Not done:** no Supabase change, no Vercel change, no deploy, no app
>   connection, no user creation, no data import.
> - **Decisions D1–D6 are RESOLVED** and recorded at the end. One sub-question
>   (D5a) remains open because it imposes on another person; revision 3 adds an
>   **invariant that keeps it genuinely open** rather than silently forced.
> - **Merge order matters:** prerequisite **PR #4 lands first**; PR #3 is then
>   rebased and may merge. See §12.

**Design principle:** an account grants nothing. Authorization comes from a
`profiles` row that only Fon can create. A stray signup lands with zero access
by construction, not by a rule someone has to remember.

Constraints:

- Supabase Auth on the **free tier**.
- **No dependence on any paid Vercel feature.**
- Default deny everywhere.
- Phase 3's sharing constraint, audit protections, **Check 18 residual
  (RES-001)** and **Check 19** are preserved unchanged.
- **Phase 4 grants no access to `audit_log`.** Audit reads are deferred to
  Phase 5, when the app actually has an audit surface (§1, §3.2).

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
2. Phase 3's Check 4 (*"Zero policies"*), Check 5 (*"anon and authenticated
   hold no privilege on any public table"*) and Check 6 **will necessarily
   start failing** the moment Phase 4 adds a policy or a grant. All three must
   be redefined as **exact, bidirectional allowlists** — not relaxed, not
   deleted. See §3.4.

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
| **every role, including fon** | ✗ | ✗ |

**All three tables get no grant and no policy for anyone — revised in
revision 3.** Revision 2 gave Fon a SELECT grant and a SELECT policy on
`audit_log`. Both are **removed from Phase 4 entirely**.

**Why.** Phase 4 ships no audit surface. Nothing in the app reads the audit
log, so the grant would buy nothing while permanently widening what a stolen
Fon session can reach — the audit trail is precisely the record an attacker
with Fon's session would want to read before deciding what to tamper with.
Access that no feature consumes is access that only an attacker uses.

**Deferred to Phase 5**, where it can be designed against a real audit view
with its own column selection, retention answer and read-path test, rather than
granted speculatively now. Until then the table keeps Phase 3's posture: RLS
enabled and forced, **zero policies**, reachable only by `service_role` or
`postgres`.

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
-- public: NOT granted here. `authenticated` already holds USAGE on schema
-- public and Phase 3 never revoked it. Phase 4 depends on that silently, so
-- §3.4 asserts it rather than leaving it as an unstated assumption.

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
```

`anon` receives **nothing, anywhere**. `audit_log`, `idempotency_keys` and
`import_batches` receive **no grant** — see §1 for why `audit_log` is deferred
to Phase 5.

Two footguns this closes:

- Postgres grants `EXECUTE` to `PUBLIC` on new functions **by default**.
  Granting `USAGE` on the schema without the three revokes would newly expose
  the other functions.
- `ALTER DEFAULT PRIVILEGES` is **role-scoped** — the lesson RES-001 taught the
  hard way. It is written `for role postgres` because `postgres` creates the
  app-schema functions. If a future function is created by another role, the
  default does not apply to it, so the Check 5 allowlist remains the real
  backstop.

No sequence grants are needed. The only identity column is `audit_log.id`, and
`authenticated` now reaches that table for nothing at all.

**`authenticated` must retain `USAGE` on schema `public`.** Table grants are
unreachable without it — every one of the grants above would silently become
inert and the app would fail with a confusing *permission denied for schema*
rather than a row-level denial. Phase 3 revoked `all on schema app` but never
touched `public`, so the privilege is held today and Phase 4 simply relies on
it. Relying on something unasserted is how it gets revoked by a later cleanup,
so §3.4 pins it.

### 3.3 Policies — complete enumeration

**This table is the source of truth for Check 4.** It is deliberately symmetric
with the grant enumeration in §3.2: that one says which verbs are reachable at
all, this one says by whom and on which rows. Anything present in the database
and absent here is an over-policy; anything here and absent from the database is
a missing control. **Both fail.**

Every policy is `PERMISSIVE`, `to authenticated`, and names the app role via
`(select app.current_app_role())`.

| # | Table | Policy name | Command | Roles | Row predicate (abbreviated) |
|---|---|---|---|---|---|
| 1 | `tasks` | `tasks_fon_select` | SELECT | `{authenticated}` | role = `fon` |
| 2 | `tasks` | `tasks_fon_insert` | INSERT | `{authenticated}` | role = `fon` |
| 3 | `tasks` | `tasks_fon_update` | UPDATE | `{authenticated}` | role = `fon` |
| 4 | `tasks` | `tasks_fon_delete` | DELETE | `{authenticated}` | role = `fon` |
| 5 | `tasks` | `tasks_abigail_select` | SELECT | `{authenticated}` | role = `abigail` ∧ `area ∈ (family, home)` ∧ `visibility = 'shared'` |
| 6 | `tasks` | `tasks_abigail_insert` | INSERT | `{authenticated}` | same, in `WITH CHECK` |
| 7 | `tasks` | `tasks_abigail_update` | UPDATE | `{authenticated}` | same, in **both** `USING` and `WITH CHECK` |
| 8 | `area_notes` | `area_notes_fon_select` | SELECT | `{authenticated}` | role = `fon` |
| 9 | `area_notes` | `area_notes_fon_insert` | INSERT | `{authenticated}` | role = `fon` |
| 10 | `area_notes` | `area_notes_fon_update` | UPDATE | `{authenticated}` | role = `fon` |
| 11 | `area_notes` | `area_notes_abigail_select` | SELECT | `{authenticated}` | role = `abigail` ∧ `area ∈ (family, home)` |
| 12 | `area_notes` | `area_notes_abigail_insert` | INSERT | `{authenticated}` | same, in `WITH CHECK` |
| 13 | `area_notes` | `area_notes_abigail_update` | UPDATE | `{authenticated}` | same, both clauses |
| 14 | `area_notes` | `area_notes_accountability_select` | SELECT | `{authenticated}` | role = `accountability` ∧ `area = 'school'` |
| 15 | `profiles` | `profiles_select_own` | SELECT | `{authenticated}` | `user_id = (select auth.uid())` — **must not** call `current_app_role()` (§3.1) |

**Exactly 15 policies. Nothing else, on any table.**

| Table | Expected policy count | Why |
|---|---|---|
| `tasks` | 7 | No DELETE for abigail (D1); no accountability policy at all |
| `area_notes` | 7 | No DELETE for anyone |
| `profiles` | 1 | Read-own only; no write path ever (D3) |
| **`audit_log`** | **0** | **Deferred to Phase 5 (§1)** |
| `idempotency_keys` | 0 | Server-side only |
| `import_batches` | 0 | Server-side only |

Three absences are load-bearing and easy to mistake for oversights, so they are
stated rather than implied: **accountability holds no policy on `tasks`** (it
reads only the view, §3.7); **abigail holds no DELETE** (D1); **no role holds
any policy on `audit_log`** (§1).

### 3.4 Checks 4, 5 and 6 redefined as exact, bidirectional allowlists

Phase 3's Check 4 asserts **zero policies** and Checks 5/6 assert **zero
privileges** for `anon` and `authenticated`. Phase 4 necessarily adds both, so
all three must be redefined — **tightened into exact allowlists, never
relaxed**. A check rewritten to `count(*) >= 0` is how a board goes green while
the boundary rots.

**Check 4 — the policy set matches §3.3 exactly.** The comparison is a full
outer join between the actual and expected sets, keyed on
**`(tablename, policyname, cmd, roles)`**, and it additionally pins
`permissive = 'PERMISSIVE'` — a policy silently switched to `RESTRICTIVE`
keeps its key but inverts its meaning. **An unmatched row on either side
fails**, and the detail column names which side and which policy, so a failure
says *what* drifted rather than only *that* something did.

**Check 5 — `authenticated` holds exactly the expected privileges.** Compare
the actual `(table, privilege)` set against the literal expected set from
§3.2. **Any extra privilege fails; any missing privilege also fails.** The
expected set contains **no row for `audit_log`, `idempotency_keys` or
`import_batches`.**

**Check 5a — `authenticated` retains `USAGE` on schema `public`.**
`has_schema_privilege('authenticated', 'public', 'USAGE')` must be true. Phase 4
depends on it and never grants it (§3.2); without this the dependency is silent.

**Check 6 — `anon` holds no privilege on any public table or view.** Phase 3's
Check 5 already covers `relkind in ('r','p','v','m','f')`, so views are in
scope today; Check 6 reads `information_schema.role_table_grants`, which also
includes views. Unchanged in substance, and it must stay at **zero** — `anon`
is the one role whose allowlist is empty.

**Over-policy failure injection** (each must flip **Check 4** to FAIL):

| Injection | Why it matters |
|---|---|
| `create policy profiles_self_update on public.profiles for update to authenticated using (user_id = (select auth.uid()))` | **The self-elevation surface (T1).** Must fail Check 4 *and* flip the D3 behavioral test — a policy alone is not enough to elevate without a grant, which is exactly why the catalog check must catch it before someone later adds the grant. |
| `create policy tasks_extra_select on public.tasks for select to authenticated using (true)` | **An unexpected second `tasks` policy.** Permissive policies are OR-ed, so one `using (true)` silently defeats every other row predicate. Must fail Check 4 *and* a behavioral test showing Abigail reading Work. |
| `create policy audit_log_fon_select on public.audit_log …` | The access revision 3 deliberately removed, re-added by habit |
| `create policy … on public.idempotency_keys …` | A server-side table reachable from the API |
| Drop `tasks_abigail_update` | **Missing** side of the allowlist |
| Rename `tasks_fon_delete` | Fails as both extra *and* missing |
| Change `tasks_fon_select` to `for all` | Command drift under an unchanged name |
| Change a policy's roles to `public` | Role drift under an unchanged name |
| Recreate `profiles_select_own` as `restrictive` | Same key, inverted meaning |

**Over-grant failure injection** (each must flip **Check 5** or **6** to FAIL):

| Injection | Why it matters |
|---|---|
| `grant delete on public.area_notes to authenticated` | A verb no role should have |
| `grant select on public.import_batches to authenticated` | A table no role should reach |
| `grant insert on public.profiles to authenticated` | The self-elevation surface |
| `grant select on public.audit_log to authenticated` | **Re-adding the Phase 4 access removed in revision 3** |
| `grant update on public.audit_log to authenticated` | Tamper surface |
| `grant select on public.tasks to anon` | Check 6 |
| Revoking an *expected* grant | The allowlist must be exact in both directions |
| `revoke usage on schema public from authenticated` | Check 5a — the silent dependency |

**Phase 3 test files that must be amended, by name.** These assert the Phase 3
posture directly and **will fail the moment PR #5 lands** unless converted in
the same PR. They are not collateral damage to be fixed afterwards; converting
them *is* part of the change:

| File | Test | Required amendment |
|---|---|---|
| `supabase/tests/rls.test.mjs` | *"defines no policies at all — the denial is structural, not a rule to remove later"* | Becomes the Check 4 allowlist: the policy set equals §3.3 exactly, both directions |
| `supabase/tests/rls.test.mjs` | *"a signed-in user reaches nothing before Phase 4"* (suite) | Retitled and split: `anon` and **unprofiled** users still reach nothing; profiled users reach exactly their matrix row |
| `supabase/tests/rls.test.mjs` | *"denies authenticated the internal app schema"* | Narrowed: `authenticated` holds `USAGE` on `app` and `EXECUTE` on `current_app_role()` **only**, and still cannot execute the other three functions |
| `supabase/tests/migrations.test.mjs` | *"ends with RLS enabled, forced, and no api-role privileges on all of them"* | Becomes the Check 5/5a/6 allowlist |
| `supabase/tests/migrations.test.mjs` | *"does not duplicate constraints, indexes, triggers or policies"* | Extended to cover the 15 new policies on re-run |

`schema.test.mjs`, `parity.test.mjs`, `apply-all.test.mjs`, `import.test.mjs`
and `secrets.test.mjs` are expected to pass **unchanged**. If any of them needs
editing, that is a signal Phase 4 changed something it promised not to, and the
edit needs justifying in review rather than making.

### 3.5 Policy shape

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

### 3.6 Provenance: stamping scoped to app sessions

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

### 3.7 View design

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
  holding no `tasks` policy (§3.3, rows 1–7 are `fon` and `abigail` only). The
  role filter therefore lives *inside* the view.
- **`security_barrier = true`** — **added in revision 2.** Without it, Postgres
  may push a user-supplied `WHERE` predicate *below* the view's own filter. A
  cheap leaky function in a predicate could then observe rows the filter was
  meant to exclude. The barrier forbids that reordering. It costs some
  optimisation freedom, which is irrelevant at seven areas and a few hundred
  rows.
- Owner: `postgres`, tested.

### 3.8 Check 20 — views, strengthened

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

**Behavioral failure injection** — not just property injection. Check 20 covers
views; **Check 4 covers policies** (§3.4) and the two are independent, because a
view needs no policy to leak:

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

### 3.9 Preserving Phase 3

| Phase 3 property | Phase 4 effect |
|---|---|
| `tasks_shared_only_in_shared_areas` | Untouched. |
| Audit triggers | Untouched. |
| **Check 18 / RES-001** | **Unchanged — still FAIL, still not softened.** |
| **Check 19** | Unchanged. |
| Lockdown array | Unchanged — Phase 4 adds **no tables**. |
| `audit_log` posture | **Unchanged from Phase 3** — RLS forced, zero policies, no grant. Phase 4 adds no access (§1). |
| Phase 3 test suites | **Green only after Checks 4, 5 and 6 are converted** in the same PR — see the named files in §3.4. |
| **Check 4** | **Redefined as an exact, bidirectional policy allowlist** (§3.3, §3.4). |
| Check 5 / 5a / 6 | **Redefined as exact allowlists** (§3.4). |
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
| T14 | **Credential compromise** (password reuse, phishing) | **TOTP MFA** (D5). **No policy may gate on an MFA assurance claim** while D5a is open — see the D5a invariant | Fon covered before import; Abigail and accountability remain exposed until D5a is decided |
| T15 | **Audit tampering** | Append-only triggers, all roles; **no API role holds any grant or policy on `audit_log`** (§1) | `DROP TABLE` needs owner |
| T15a | **Audit *reading* by a stolen session** | **Removed as a Phase 4 capability in revision 3.** No grant, no policy; reachable only by `service_role`/`postgres`. Check 4 and Check 5 both fail if either is re-added | None in Phase 4. Re-opens in Phase 5 and must be designed there, not inherited |
| T16 | **Materialized view over `tasks`** | RLS does not apply to matviews; Check 20 forbids them in `public` | None while checked |
| T17 | **Import rewrites provenance** | Stamping scoped to app sessions; import-preservation test | None |
| T18 | **`service_role` reaches the browser** | Never in a `VITE_` variable; `secrets.test.mjs` | None |
| T19 | **Auto-provisioned profile** | Tests assert nothing creates profiles (§2) | None while checked |
| T20 | **RES-001** | Check 18 (detect) + Check 19 (compensate) | Accepted, unchanged |
| T21 | **Pong as a user** | `profiles_role_valid` rejects `'pong'`; no auth user | None |
| T22 | **Lockout by assurance gating** — a policy or project setting requires `aal2`, locking out whoever has not enrolled | **D5a invariant:** no PR #5 policy may reference `auth.jwt()` assurance level or any MFA claim, and project-wide MFA enforcement stays **off** while D5a is open. Asserted by test | None while asserted. Revisit deliberately when D5a is decided |

---

## 5. Migration and rollback sequence

| # | Step | PR / manual | Reversible by |
|---|---|---|---|
| 1 | Tailwind scope prerequisite — **lands before PR #3 merges** | **PR #4** | `git revert` |
| 2 | Rebase PR #3 onto the post-#4 `main`, then merge the plan | — | `git revert` |
| 3 | Disable public sign-ups | manual | Re-enable |
| 4 | Create three auth users | manual | Delete users (manual, never scripted) |
| 5 | DB migration: role function, grants, triggers, policies, view, **Checks 4 / 5 / 5a / 6 / 20**, converted Phase 3 suites | **PR #5** | `supabase/rollback-phase-4.sql` |
| 6 | Insert three `profiles` rows | manual SQL | `delete from public.profiles` |
| 7 | Run `verify.sql` | manual | — |
| 8 | MFA **for Fon**; JWT ≤ 1 h; refresh rotation. **Project-wide MFA enforcement stays off** (D5a invariant) | manual | — |
| 9 | App wiring, CSP, sign-out, external-script test | **PR #6** | `git revert` |
| 10 | **Import real data — last** | manual | Data retained; `localStorage` untouched |
| 11 | Re-run `verify.sql` | manual | — |

**Import is deliberately last**, after the session controls in steps 8–9 exist.
Revision 1 had it before app wiring; the review was right that real data should
not enter a system whose session handling is not yet hardened.

**PR #4 is deliberately first, ahead of this plan's own merge.** Until the
Tailwind exclusions land, any change under `docs/` — including this document —
alters the shipped CSS bundle. Merging PR #3 first would put a documentation
change into `main` that silently changes production CSS, which is the exact
defect PR #4 exists to remove. So: **#4, then rebase and merge #3, then #5,
then #6.**

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
Phase 3)"*. It is written `PASS` at zero rows, else `NOTE`. After step 10 it
becomes **NOTE with a row count**. `NOTE` carries no status weight, so OVERALL
is unaffected. This is expected and must not be mistaken for a regression; the
check's wording should be updated in PR #5 to describe both phases.

Step numbers above shifted by one from revision 2, because the PR #3 rebase-and-
merge is now an explicit step rather than an assumption.

---

## 6. Automated tests

Real Postgres via PGlite, offline, no credentials. The harness gains an
`auth.uid()` stub reading `request.jwt.claims` as Supabase does, plus a
`withUser(role, fn)` helper.

**Function properties (§3.1):** owner is `postgres`; `prosecdef` true;
`proconfig` contains an empty `search_path`; `provolatile` is `s`; no policy on
`profiles` references the function name.

**Catalog shape (§3.3, §3.4):** the policy set equals the 15 rows of §3.3
exactly, keyed on `(tablename, policyname, cmd, roles)` and pinned to
`PERMISSIVE`, failing on an unmatched row from **either** side; the grant set
equals §3.2 exactly; `authenticated` holds `USAGE` on schema `public`;
`audit_log`, `idempotency_keys` and `import_batches` carry **zero** policies and
**zero** grants.

**D5a invariant:** no policy expression anywhere references `auth.jwt()`,
`aal1`, `aal2` or any assurance-level claim. Asserted by scanning every
`pg_policies.qual` and `with_check` expression, so it holds for policies added
later as well as the 15 above.

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
- **Every role selects `audit_log` → permission denied (no grant, no policy)**
- **Every role selects `idempotency_keys` / `import_batches` → permission denied**
- Provenance immutability → rejected for all roles
- **Phase 3 import preserves `created_by`/`source` byte for byte (§3.6)**
- **Nothing auto-creates a profile (§2)**

**Failure injection:** every row in §3.4 and §3.8, plus: drop
`visibility='shared'` → private-task test fails; drop `WITH CHECK` → move-out
test fails; add a write policy to `profiles` → self-elevation test fails; drop
the immutability trigger → provenance test fails; **make stamping
unconditional → the import-preservation test fails.**

**Suite statement, corrected.** Revision 2 said "all Phase 3 suites green",
which was wrong as written: three Phase 3 tests assert the *pre-Phase-4*
posture and **must** go red the moment PR #5 lands. The accurate statement is:

> **All Phase 3 suites are green only after Checks 4, 5 and 6 have been
> converted to allowlists** — in the same PR, in the files named in §3.4.
> `schema.test.mjs`, `parity.test.mjs`, `apply-all.test.mjs`,
> `import.test.mjs` and `secrets.test.mjs` are green **unchanged**; the
> conversions are confined to `rls.test.mjs` and `migrations.test.mjs`.

A Phase 3 test going red is therefore expected exactly once, for exactly these
assertions. A red anywhere else is a regression, not a conversion.

Plus **a test asserting Check 18 still FAILs**.

---

## 7. Session and browser controls — required before real data import

These are **blocking prerequisites for step 10** (the import), not polish.

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
4. **Fon enrolls TOTP MFA** (D5) — before step 10 of §5. **Leave project-wide
   MFA enforcement OFF** while D5a is open (the D5a invariant).
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
Ordinary English in documentation generates unused CSS utilities.

Two separate instances, and revision 2 of this document conflated them:

- **On `main` today:** the word *"fixed"* in `docs/claude-import.md` and
  `docs/phase-3-verification.md` generates `.fixed{position:fixed}`.
- **On this planning branch only:** the word *"invisible"* in the threat model
  of this very document generates `.invisible{visibility:hidden}`. That rule
  does **not** exist on `main`, because its only other source is `supabase/`,
  already excluded since Phase 3.

### The change

Add to `src/App.css`, beside the existing `supabase/` exclusion:

```css
@source not "../docs";
@source not "../scripts";
```

**The adjacent comment must be corrected in the same commit.** `src/App.css`
currently explains the single `supabase/` exclusion like this:

> *Only supabase/ is excluded, deliberately: docs/ and scripts/ were already
> being scanned before Phase 3, and excluding them too would change the shipped
> CSS. This keeps the built stylesheet byte-identical to main.*

Every clause of that becomes false the moment the two lines above are added —
it names the exclusion as deliberate, gives a reason that no longer holds, and
claims a byte-identity property the change itself retires. A comment that
contradicts the three lines under it is worse than no comment, because the next
reader trusts it. PR #4 rewrites it to state what is actually true: all three
directories are excluded, documentation and scripts are not stylesheet inputs,
and the byte-identity baseline is the post-#4 build (below).

### Measured effect — corrected against `main`

Revision 2 stated **51 bytes and two rules removed**. That figure was measured
on *this planning branch*, not on `main`, and it is wrong for PR #4 as built.
The corrected measurement, taken from `main` at `3dc59ae`:

| Variant | CSS bytes | Δ | md5 | Rules removed |
|---|---|---|---|---|
| baseline (`main`) | 24 491 | — | `baf6880ea9bb` | — |
| `scripts/` only | 24 491 | **0** | `baf6880ea9bb` | none |
| `docs/` only | 24 469 | **−22** | `bfc854089977` | `.fixed` |
| **`docs/` + `scripts/` (PR #4)** | **24 469** | **−22** | `bfc854089977` | `.fixed` |

**Against current `main`, PR #4 removes exactly one generated rule —
`.fixed{position:fixed}` — reducing the production CSS by 22 bytes.**

Per class:

| Class | On `main` before | After PR #4 | Verdict |
|---|---|---|---|
| `.fixed` | present | **absent** | **removed — the 22 bytes** |
| `.invisible` | **absent** | absent | **never existed on `main`** — its only remaining source is `supabase/`, excluded since Phase 3 |
| `.visible` | present | **present** | **retained** — generated from `src/App.test.jsx`, which stays scanned |

**Excluding `scripts/` is a byte-identical no-op** — same md5 as baseline.
`scripts/` holds two build scripts whose only utility-shaped token is `block`,
which `src/` already generates. It is included so that a future script cannot
quietly grow the bundle.

### Where the 51 came from, and why the sequencing still holds

This document's own prose is what generates `.invisible`. Merging PR #3 adds
that word to `docs/`, and on a tree where `docs/` is still scanned it would add
`.invisible{visibility:hidden}` — **29 bytes** — to the shipped stylesheet.

```
22  .fixed{position:fixed}          removed by PR #4, from main, now
29  .invisible{visibility:hidden}   absent on main; introduced by PR #3's prose
──                                  unless PR #4 has already landed
51  the figure revision 2 reported
```

The arithmetic reconciles exactly, which is what confirms the explanation
rather than leaving it a guess: revision 2 compared against the planning branch
instead of against `main`.

**A second live instance, found while writing this correction.** The sentence
above about a future script quietly growing the bundle put the word *"grow"*
into `docs/`, which emitted `.grow{flex-grow:1}` — 18 more bytes. So this
branch now carries **47 bytes** over `main`: 29 for `.invisible`, 18 for
`.grow`. The wording is deliberately left as it stands rather than contorted to
dodge the scanner, because that trade is backwards: documentation should read
well and the build should stop reading documentation. Both rules vanish once
PR #4 has landed and this branch is rebased.

**PR #4 therefore removes 22 bytes immediately and prevents the further 29
bytes when PR #3 later merges.** That is precisely why **PR #4 must land before
PR #3** (§12) — the sequencing requirement is unchanged and, if anything, this
correction is the clearest statement of its reason.

*(Revision 1 also reported `.visible` as removed. That was wrong too — an
artifact of diffing on `}` boundaries, which shift when a neighbouring rule
disappears. Corrected by checking each class directly in both files.)*

### Required verification in PR #4

The removed class must be shown **unused by the application**, not merely
unused-looking:

- `fixed` appears **nowhere** in `src/` or `index.html` — it originated in
  `docs/`. This is the one rule PR #4 actually removes.
- `invisible` appears **nowhere** in `src/` or `index.html` either, and is
  **not in the `main` baseline at all** — verify its absence rather than its
  removal.
- Distinguish the `focus-visible:` *variant* used throughout `src/App.jsx` from
  the `.visible` *utility*; they are unrelated, and `.visible` is retained
  anyway.
- A rendering check at desktop and iPhone widths before and after.
- **The adjacent comment is rewritten, not left stale** — no sentence in
  `src/App.css` may still claim `docs/` and `scripts/` are scanned, or that the
  bundle is byte-identical to `main`.

**No security impact. No rendering impact.**

### Bundle acceptance, restated

The "byte-identical to `main`" criterion from Phases 1–3 **cannot survive any
change under `docs/`** and is therefore retired in its old form.

**New baseline: the build produced by PR #4** (post-exclusion) — CSS
`bfc854089977`, 24 469 bytes; the JS bundle is unchanged by PR #4. From PR #5
onward:

- **PR #5** (database + docs) must be byte-identical to the **post-exclusion
  baseline** — it touches no `src/`, and `docs/` no longer affects the bundle.
- **PR #6** changes the app deliberately; byte-identity does not apply. It is
  reviewed on behaviour, not bytes.

---

## 12. PR sequence and merge order

Revision 1 used "PR #3" for both this plan and the database work. Corrected,
and revision 3 fixes the **order** as well as the numbers:

| Order | PR | Contents | State |
|---|---|---|---|
| **1st** | **#4** | Tailwind scope prerequisite: the two `@source not` lines **and** the corrected adjacent comment (`src/App.css`) | **Open at `001018d`, not merged** |
| **2nd** | **#3** | **This plan document only** — rebased onto the post-#4 `main`, then merged | Draft, planning only |
| **3rd** | **#5** | Database: role function, grants, triggers, policies, view, **Checks 4 / 5 / 5a / 6 / 20**, rollback file, converted `rls.test.mjs` and `migrations.test.mjs` | Not started |
| **4th** | **#6** | App wiring: sign-in, session handling, CSP, sign-out, external-script test | Not started |

**PR #3 must not merge before PR #4.** The numbers are creation order, not
merge order, and they disagree here. Until #4 lands, every change under `docs/`
alters the shipped CSS — so merging this plan first would land a documentation
commit that changes production CSS, which is the precise defect #4 removes.

Import happens **after #6**, manually.

### Acceptance criteria — PR #5 (database)

1. Every matrix cell has a passing test, positive and negative.
2. Every failure injection in §3.4, §3.8 and §6 flips its check to FAIL —
   including **every over-policy injection**, the `profiles` write policy and
   the unexpected second `tasks` policy among them.
3. **Check 18 still FAILs; RES-001 documented unchanged; OVERALL still FAIL.**
4. Check 19 passes; no new tables; lockdown array unchanged.
5. **Checks 4, 5, 5a and 6 are exact, bidirectional allowlists:**
   - **Check 4** — the policy set matches the 15 rows of §3.3, keyed on
     `(table, policy name, command, roles)` and pinned to `PERMISSIVE`,
     rejecting both extra and missing policies.
   - **Checks 5 / 6** — the grant sets match §3.2 exactly, rejecting both over-
     and under-grants.
   - **Check 5a** — `authenticated` retains `USAGE` on schema `public`.
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
14. **Phase 3 suites green only after Checks 4, 5 and 6 are converted** — the
    conversions confined to `rls.test.mjs` and `migrations.test.mjs` (§3.4,
    §6), with `schema`, `parity`, `apply-all`, `import` and `secrets` green
    **unchanged**. Lint, build and generated-SQL identity green.
15. **`audit_log`, `idempotency_keys` and `import_batches` carry zero grants and
    zero policies**, and a test proves every role is denied on all three.
16. **D5a invariant holds:** no policy references `auth.jwt()` assurance level
    or any MFA claim, and project-wide MFA enforcement is off.
17. Bundle byte-identical to the **post-PR-#4 baseline**.
18. **PR #4 has already merged, and PR #3 was rebased onto it and merged**,
    before this PR opens.
19. Nothing merged, deployed, connected or imported.

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

**Fon enrolls TOTP MFA before real data import** (§5 step 8, §9 step 4).

**D5a — open sub-question for Fon.** The recommendation is that Abigail and the
accountability viewer **also enroll at account creation**, because MFA
retrofitted later is the step that never happens. This imposes a requirement on
other people, so it is Fon's call, not this plan's. If either does not enroll,
they remain gated by invite-only enrollment, the profile-row requirement and
the policies; the residual is credential compromise (T14) for that person only.

#### The D5a invariant — added in revision 3

An open decision quietly becomes a closed one if the implementation starts
depending on one answer. Two things in PR #5 would do exactly that, so both are
prohibited while D5a is undecided:

1. **No PR #5 policy may reference `auth.jwt()` assurance level or any MFA
   assurance claim** — no `aal1`, no `aal2`, no
   `auth.jwt()->>'aal'`, no equivalent. A policy that requires `aal2` would
   silently return **zero rows** to whoever has not enrolled: not an access
   error, not a prompt, just an empty board that looks like data loss. §6
   asserts this by scanning every policy expression, so it also binds policies
   written later.
2. **Project-wide MFA enforcement stays off** in the Supabase dashboard while
   enrollment for Abigail and accountability is undecided. Turning it on
   without their enrollment locks them out of sign-in entirely — and the person
   it would not inconvenience is Fon, who has already enrolled, which is
   precisely why it is easy to switch on without noticing who it hurts (T22).

**Fon's own requirement is unchanged:** TOTP enrollment before real data import
(§5 step 8, §9 step 4). Fon enrolling is an individual act that costs nobody
else anything. Requiring it of others is a decision about other people, and it
stays open until they are actually asked.

Both prohibitions lift the moment D5a is decided — in either direction. This is
a hold, not a position on the answer.

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
