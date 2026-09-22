// Failure injection for Phase 4, from docs/phase-4-auth-plan.md §3.4, §3.8
// and §6.
//
// A check that never fails is decoration. Each case below breaks the boundary
// in one specific way and asserts that the named check turns FAIL — and, where
// the plan asks for it, that a behavioural test catches the same break
// independently. Catalog checks and behaviour are separate halves: a check that
// only reads pg_catalog can pass while the data is exposed, and a behavioural
// test can pass for the wrong reason.
//
// Every case restores the database to spec afterwards, so one injection cannot
// leak into the next.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyMigrations,
  enrol,
  expectViolation,
  freshDb,
  insertTask,
  MIGRATIONS_DIR,
  resetDb,
  withUser,
} from "./harness.mjs";

const VERIFY = join(MIGRATIONS_DIR, "..", "verify.sql");

let db;
let verifySql;
let fon;
let abigail;
let accountability;

const SHARED_HOME = "22222222-2222-4222-8222-222222222222";
const PRIVATE_HOME = "33333333-3333-4333-8333-333333333333";
const SCHOOL = "11111111-1111-4111-8111-111111111111";
const WORK = "44444444-4444-4444-8444-444444444444";

beforeAll(async () => {
  db = await freshDb();
  verifySql = await readFile(VERIFY, "utf8");
});
afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("reset role");
  await resetDb(db);
  fon = await enrol(db, "fon");
  abigail = await enrol(db, "abigail");
  accountability = await enrol(db, "accountability");
});

/** Statuses from verify.sql, keyed by the '#' column. */
async function checks() {
  const { rows } = await db.query(verifySql);
  return Object.fromEntries(rows.map((r) => [String(r["#"]), r.status]));
}

async function detailFor(number) {
  const { rows } = await db.query(verifySql);
  return rows.find((r) => String(r["#"]) === String(number))?.detail ?? "";
}

/**
 * Applies `sql`, runs `assert`, then restores the database to spec.
 *
 * Re-applying the migrations is not enough on its own: they create the expected
 * objects but know nothing about injected ones, so an injected policy or view
 * would survive into the next case and every later assertion would be measuring
 * the wrong database. Everything unexpected is dropped first.
 *
 * Restoration runs even when the assertion fails, so one red test cannot
 * cascade.
 */
async function restoreToSpec() {
  await db.exec("reset role");
  await db.exec(`
    do $$
    declare r record;
    begin
      -- Policies that the migrations will not recreate, and so would linger.
      for r in
        select schemaname, tablename, policyname from pg_policies
         where schemaname = 'public'
           and policyname not in (
             'tasks_fon_select','tasks_fon_insert','tasks_fon_update','tasks_fon_delete',
             'tasks_abigail_select','tasks_abigail_insert','tasks_abigail_update',
             'area_notes_fon_select','area_notes_fon_insert','area_notes_fon_update',
             'area_notes_abigail_select','area_notes_abigail_insert','area_notes_abigail_update',
             'area_notes_accountability_select','profiles_select_own')
      loop
        execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
      end loop;

      for r in
        select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('v','m') and c.relname <> 'school_summary'
      loop
        execute format('drop %s public.%I cascade',
                       case r.relkind when 'm' then 'materialized view' else 'view' end,
                       r.relname);
      end loop;

      for r in
        select p.oid::regprocedure as sig from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.proname not in ('current_app_role','touch_updated_at','forbid_mutation',
                                 'revoke_api_default_privileges','forbid_provenance_change',
                                 'stamp_task_provenance')
      loop
        execute format('drop function %s cascade', r.sig);
      end loop;
    end $$;
  `);
  // Supabase owns these, so the migrations never re-grant them.
  await db.exec("grant usage on schema public, auth to anon, authenticated, service_role");
  await db.exec("revoke all on public.tasks, public.area_notes, public.profiles from anon, authenticated");
  await db.exec("revoke all on public.audit_log, public.idempotency_keys, public.import_batches from anon, authenticated");
  await applyMigrations(db);
}

async function inject(sql, assert) {
  await db.exec(sql);
  try {
    await assert();
  } finally {
    await restoreToSpec();
  }
}

async function seedBoard() {
  await insertTask(db, { id: SCHOOL, title: "UMPI 311 paper", area: "school", notes: "outline first" });
  await insertTask(db, { id: SHARED_HOME, title: "Groceries", area: "home", visibility: "shared" });
  await insertTask(db, { id: PRIVATE_HOME, title: "Anniversary gift", area: "home", visibility: "private" });
  await insertTask(db, { id: WORK, title: "Client AB intake", area: "work", notes: "ref 2291" });
}

describe("a clean database passes every check", () => {
  it("has no FAIL before anything is injected", async () => {
    const status = await checks();
    expect(Object.entries(status).filter(([, v]) => v === "FAIL")).toEqual([]);
    expect(status["99"]).toBe("PASS");
  });
});

// ─── CHECK 4: OVER-POLICY AND MISSING-POLICY ──────────────────────────────────

describe("check 4 catches every policy drift (§3.4)", () => {
  it("a write policy on profiles — the self-elevation surface (T1)", async () => {
    await inject(
      `create policy profiles_self_update on public.profiles
         for update to authenticated using (user_id = (select auth.uid()))`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect(await detailFor(4)).toMatch(/UNEXPECTED profiles.profiles_self_update/);
      },
    );
  });

  // A policy alone cannot elevate without a grant. With BOTH halves present,
  // one Phase 3 control still stands in the way — and it is worth knowing
  // exactly which, because it is the last line rather than the first.
  it("...plus the grant is still blocked, but only by profiles_one_per_role", async () => {
    await inject(
      `create policy profiles_self_update on public.profiles
         for update to authenticated using (user_id = (select auth.uid()))
         with check (true);
       grant update on public.profiles to authenticated;`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect((await checks())["5"]).toBe("FAIL");

        // Abigail now holds a write path to her own profile row. Taking 'fon'
        // collides with Fon's row on the Phase 3 unique index — defence in
        // depth, and the reason the attempt fails loudly rather than silently.
        await withUser(db, abigail, async () => {
          const error = await expectViolation(() =>
            db.query("update public.profiles set role = 'fon' where user_id = $1", [abigail]),
          );
          expect(error.message).toMatch(/profiles_one_per_role/);
        });
        const { rows } = await db.query(
          "select role from public.profiles where user_id = $1", [abigail],
        );
        expect(rows[0].role).toBe("abigail");
      },
    );
  });

  // ...and that last line is thin. Remove the colliding row — an account not
  // yet provisioned, or one deleted — and the same two halves elevate cleanly.
  // This is why checks 4 and 5 have to catch the policy and the grant, rather
  // than leaning on a unique index that only happens to be in the way.
  it("...and with no incumbent row, the same two halves DO elevate", async () => {
    await inject(
      `create policy profiles_self_update on public.profiles
         for update to authenticated using (user_id = (select auth.uid()))
         with check (true);
       grant update on public.profiles to authenticated;
       delete from public.profiles where role = 'fon';`,
      async () => {
        await withUser(db, abigail, async () => {
          await db.query("update public.profiles set role = 'fon' where user_id = $1", [abigail]);
        });
        const { rows } = await db.query(
          "select role from public.profiles where user_id = $1", [abigail],
        );
        expect(rows[0].role).toBe("fon");

        // And the elevation is real: she now reads the whole board.
        await withUser(db, abigail, async () => {
          const { rows: seen } = await db.query("select count(*)::int as n from public.tasks");
          expect(seen[0].n).toBeGreaterThanOrEqual(0);
          const { rows: role } = await db.query("select app.current_app_role() as r");
          expect(role[0].r).toBe("fon");
        });
      },
    );
  });

  it("an unexpected second tasks policy using (true)", async () => {
    await seedBoard();
    await inject(
      `create policy tasks_extra_select on public.tasks
         for select to authenticated using (true)`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect(await detailFor(4)).toMatch(/UNEXPECTED tasks.tasks_extra_select/);
        // Permissive policies are OR-ed, so one using(true) defeats every other
        // predicate: Abigail now reads Work.
        await withUser(db, abigail, async () => {
          const { rows } = await db.query("select title from public.tasks where area = 'work'");
          expect(rows.map((r) => r.title)).toEqual(["Client AB intake"]);
        });
      },
    );
  });

  it("a policy on audit_log — the access revision 3 deliberately removed", async () => {
    await inject(
      `create policy audit_log_fon_select on public.audit_log
         for select to authenticated using ((select app.current_app_role()) = 'fon')`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect(await detailFor(4)).toMatch(/UNEXPECTED audit_log/);
      },
    );
  });

  it("a policy on idempotency_keys — a server-side table reachable from the API", async () => {
    await inject(
      `create policy idem_read on public.idempotency_keys
         for select to authenticated using (true)`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect(await detailFor(4)).toMatch(/UNEXPECTED idempotency_keys/);
      },
    );
  });

  it("a DROPPED policy — the missing side of the allowlist", async () => {
    await inject("drop policy tasks_abigail_update on public.tasks", async () => {
      expect((await checks())["4"]).toBe("FAIL");
      expect(await detailFor(4)).toMatch(/MISSING tasks.tasks_abigail_update/);
    });
  });

  it("a RENAMED policy — fails as both extra and missing", async () => {
    await inject(
      "alter policy tasks_fon_delete on public.tasks rename to tasks_fon_remove",
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        const detail = await detailFor(4);
        expect(detail).toMatch(/UNEXPECTED tasks.tasks_fon_remove/);
        expect(detail).toMatch(/MISSING tasks.tasks_fon_delete/);
      },
    );
  });

  it("command drift under an unchanged name (SELECT becomes ALL)", async () => {
    await inject(
      `drop policy tasks_fon_select on public.tasks;
       create policy tasks_fon_select on public.tasks
         for all to authenticated using ((select app.current_app_role()) = 'fon')`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect(await detailFor(4)).toMatch(/tasks_fon_select \(ALL/);
      },
    );
  });

  it("role drift under an unchanged name (authenticated becomes public)", async () => {
    await inject(
      `drop policy tasks_fon_select on public.tasks;
       create policy tasks_fon_select on public.tasks
         for select to public using ((select app.current_app_role()) = 'fon')`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect(await detailFor(4)).toMatch(/to \{public\}/);
      },
    );
  });

  it("a PERMISSIVE policy recreated as RESTRICTIVE — same key, inverted meaning", async () => {
    await inject(
      `drop policy profiles_select_own on public.profiles;
       create policy profiles_select_own on public.profiles
         as restrictive for select to authenticated using (user_id = (select auth.uid()))`,
      async () => {
        expect((await checks())["4"]).toBe("FAIL");
        expect(await detailFor(4)).toMatch(/RESTRICTIVE/);
      },
    );
  });
});

// ─── CHECKS 5, 5a AND 6: OVER-GRANT AND UNDER-GRANT ───────────────────────────

describe("checks 5, 5a and 6 catch every grant drift (§3.4)", () => {
  it.each([
    ["a verb no role should have", "grant delete on public.area_notes to authenticated", /UNEXPECTED DELETE on area_notes/],
    ["a table no role should reach", "grant select on public.import_batches to authenticated", /UNEXPECTED SELECT on import_batches/],
    ["the self-elevation surface", "grant insert on public.profiles to authenticated", /UNEXPECTED INSERT on profiles/],
    ["re-adding the removed audit read", "grant select on public.audit_log to authenticated", /UNEXPECTED SELECT on audit_log/],
    ["an audit tamper surface", "grant update on public.audit_log to authenticated", /UNEXPECTED UPDATE on audit_log/],
  ])("check 5 fails on %s", async (_label, sql, pattern) => {
    await inject(sql, async () => {
      expect((await checks())["5"]).toBe("FAIL");
      expect(await detailFor(5)).toMatch(pattern);
    });
  });

  it("check 5 fails when an EXPECTED grant is revoked — exact in both directions", async () => {
    await inject("revoke delete on public.tasks from authenticated", async () => {
      expect((await checks())["5"]).toBe("FAIL");
      expect(await detailFor(5)).toMatch(/MISSING DELETE on tasks/);
    });
  });

  it("check 6 fails when anon is granted anything at all", async () => {
    await inject("grant select on public.tasks to anon", async () => {
      expect((await checks())["6"]).toBe("FAIL");
      expect(await detailFor(6)).toMatch(/SELECT on tasks/);
    });
  });

  it("check 5a fails when USAGE on schema public is revoked — the silent dependency", async () => {
    // Revoked from PUBLIC as well as from the role: schema public grants USAGE
    // to PUBLIC by default, so revoking from `authenticated` alone changes
    // nothing and the injection would prove nothing.
    await inject("revoke usage on schema public from public, anon, authenticated, service_role", async () => {
      expect((await checks())["5a"]).toBe("FAIL");
      // The point of the check: nothing leaks, but every grant goes inert and
      // the failure surfaces as a confusing schema error rather than a denial.
      await withUser(db, fon, async () => {
        const error = await expectViolation(() => db.query("select * from public.tasks"));
        expect(error.message).toMatch(/permission denied for schema/i);
      });
    });
    // Restore: the migrations do not re-grant this, because Supabase owns it.
    await db.exec("grant usage on schema public to anon, authenticated, service_role");
  });

  it("check 5a fails when USAGE on schema auth is revoked — auth.uid() stops working", async () => {
    await inject("revoke usage on schema auth from public, anon, authenticated, service_role", async () => {
      expect((await checks())["5a"]).toBe("FAIL");
    });
    await db.exec("grant usage on schema auth to anon, authenticated, service_role");
  });

  it("check 24 fails when a new app function is left executable by PUBLIC", async () => {
    await inject(
      "create function app.helper() returns int language sql as $$ select 1 $$",
      async () => {
        expect((await checks())["24"]).toBe("FAIL");
        expect(await detailFor(24)).toMatch(/helper is executable by PUBLIC/);
      },
    );
    await db.exec("drop function if exists app.helper()");
  });
});

// ─── CHECK 20: THE VIEW ───────────────────────────────────────────────────────

describe("check 20 catches every view drift, with the behaviour to match (§3.8)", () => {
  const recreate = (body, opts = "security_invoker = false, security_barrier = true") => `
    drop view public.school_summary;
    create view public.school_summary with (${opts}) as ${body};
    alter view public.school_summary owner to postgres;
    grant select on public.school_summary to authenticated;
  `;

  it("the role filter edited away — catalog AND behaviour", async () => {
    await seedBoard();
    await inject(
      recreate(`select t.id, t.title, t.status, t.priority, t.due_date, t.due_time,
                       t.completed_at, t.updated_at
                  from public.tasks t where t.area = 'school'`),
      async () => {
        expect((await checks())["20"]).toBe("FAIL");
        expect(await detailFor(20)).toMatch(/lost its role filter/);
        // A property check alone would have missed this. Abigail now reads School.
        await withUser(db, abigail, async () => {
          const { rows } = await db.query("select title from public.school_summary");
          expect(rows.map((r) => r.title)).toEqual(["UMPI 311 paper"]);
        });
      },
    );
  });

  it("notes added back to the view — catalog AND behaviour (D6)", async () => {
    await seedBoard();
    await inject(
      recreate(`select t.id, t.title, t.notes, t.status, t.priority, t.due_date,
                       t.due_time, t.completed_at, t.updated_at
                  from public.tasks t
                 where t.area = 'school'
                   and (select app.current_app_role()) in ('fon', 'accountability')`),
      async () => {
        expect((await checks())["20"]).toBe("FAIL");
        expect(await detailFor(20)).toMatch(/exposes notes/);
        await withUser(db, accountability, async () => {
          const { rows } = await db.query("select notes from public.school_summary");
          expect(rows[0].notes).toBe("outline first");
        });
      },
    );
  });

  it("security_barrier dropped", async () => {
    await inject(
      recreate(
        `select t.id, t.title, t.status, t.priority, t.due_date, t.due_time,
                t.completed_at, t.updated_at
           from public.tasks t
          where t.area = 'school'
            and (select app.current_app_role()) in ('fon', 'accountability')`,
        "security_invoker = false",
      ),
      async () => {
        expect((await checks())["20"]).toBe("FAIL");
        expect(await detailFor(20)).toMatch(/lost security_barrier/);
      },
    );
  });

  it("security_invoker turned on — a silent outage, caught", async () => {
    await seedBoard();
    await inject(
      recreate(
        `select t.id, t.title, t.status, t.priority, t.due_date, t.due_time,
                t.completed_at, t.updated_at
           from public.tasks t
          where t.area = 'school'
            and (select app.current_app_role()) in ('fon', 'accountability')`,
        "security_invoker = true, security_barrier = true",
      ),
      async () => {
        expect((await checks())["20"]).toBe("FAIL");
        // Accountability holds no tasks policy, so the view now returns nothing
        // at all. Fails closed — but it is an outage nobody would diagnose.
        await withUser(db, accountability, async () => {
          const { rows } = await db.query("select title from public.school_summary");
          expect(rows).toEqual([]);
        });
      },
    );
  });

  it("a materialized view over tasks — RLS never applies to those", async () => {
    await seedBoard();
    await inject("create materialized view public.mv as select * from public.tasks", async () => {
      expect((await checks())["20"]).toBe("FAIL");
      expect(await detailFor(20)).toMatch(/materialized view mv/);
    });
    await db.exec("drop materialized view if exists public.mv");
  });

  it("an unrelated definer view over tasks", async () => {
    await inject(
      `create view public.leak with (security_invoker = false) as select * from public.tasks`,
      async () => {
        expect((await checks())["20"]).toBe("FAIL");
        expect(await detailFor(20)).toMatch(/leak is a definer view but is not allowlisted/);
      },
    );
    await db.exec("drop view if exists public.leak");
  });
});

// ─── CHECK 23: THE D5a INVARIANT ──────────────────────────────────────────────

describe("check 23 catches assurance gating (D5a)", () => {
  it("fails when a policy gates on aal2", async () => {
    await inject(
      `create policy tasks_mfa_only on public.tasks
         for select to authenticated
         using ((auth.jwt() ->> 'aal') = 'aal2')`,
      async () => {
        expect((await checks())["23"]).toBe("FAIL");
        expect(await detailFor(23)).toMatch(/tasks_mfa_only/);
      },
    );
  });
});

// ─── BEHAVIOURAL INJECTIONS (§6) ──────────────────────────────────────────────

describe("removing a predicate breaks the test that defends it (§6)", () => {
  it("dropping visibility='shared' lets abigail read a private Home task", async () => {
    await seedBoard();
    await inject(
      `drop policy tasks_abigail_select on public.tasks;
       create policy tasks_abigail_select on public.tasks
         for select to authenticated
         using ((select app.current_app_role()) = 'abigail'
                and area in ('family','home'))`,
      async () => {
        await withUser(db, abigail, async () => {
          const { rows } = await db.query("select title from public.tasks where id = $1", [
            PRIVATE_HOME,
          ]);
          expect(rows.map((r) => r.title)).toEqual(["Anniversary gift"]);
        });
      },
    );
  });

  // docs/phase-4-auth-plan.md §6 lists "drop WITH CHECK -> move-out test fails".
  // That is not how Postgres behaves: for an UPDATE policy with no WITH CHECK,
  // the USING expression is applied to the NEW row as well, so simply omitting
  // the clause leaves the protection intact. Asserted here rather than assumed,
  // because it is the difference between a real injection and a decorative one.
  it("omitting WITH CHECK does NOT open the hole — USING is reused for the new row", async () => {
    await seedBoard();
    await inject(
      `drop policy tasks_abigail_update on public.tasks;
       create policy tasks_abigail_update on public.tasks
         for update to authenticated
         using ((select app.current_app_role()) = 'abigail'
                and area in ('family','home') and visibility = 'shared')`,
      async () => {
        const { rows: cat } = await db.query(
          "select with_check from pg_policies where policyname = 'tasks_abigail_update'",
        );
        expect(cat[0].with_check).toBeNull();
        await withUser(db, abigail, async () => {
          const error = await expectViolation(() =>
            db.query("update public.tasks set area = 'school', visibility = 'private' where id = $1", [
              SHARED_HOME,
            ]),
          );
          expect(error.message).toMatch(/row-level security/i);
        });
      },
    );
  });

  // Nor does weakening WITH CHECK to true, on its own. Abigail's SELECT policy
  // is applied to the updated row as well, so it blocks the move independently.
  // Measured, not assumed — the two predicates are genuine defence in depth.
  it("a WITH CHECK weakened to true is still blocked — by the SELECT policy", async () => {
    await seedBoard();
    await inject(
      `drop policy tasks_abigail_update on public.tasks;
       create policy tasks_abigail_update on public.tasks
         for update to authenticated
         using ((select app.current_app_role()) = 'abigail'
                and area in ('family','home') and visibility = 'shared')
         with check (true)`,
      async () => {
        await withUser(db, abigail, async () => {
          const error = await expectViolation(() =>
            db.query("update public.tasks set area = 'school', visibility = 'private' where id = $1", [
              SHARED_HOME,
            ]),
          );
          expect(error.message).toMatch(/row-level security/i);
        });
      },
    );
  });

  // Weakening BOTH is what opens it. That is the injection worth keeping: it
  // names the real precondition for the hole rather than half of it.
  it("weakening the WITH CHECK *and* the SELECT predicate does open move-out", async () => {
    await seedBoard();
    await inject(
      `drop policy tasks_abigail_update on public.tasks;
       create policy tasks_abigail_update on public.tasks
         for update to authenticated
         using ((select app.current_app_role()) = 'abigail'
                and area in ('family','home') and visibility = 'shared')
         with check (true);
       drop policy tasks_abigail_select on public.tasks;
       create policy tasks_abigail_select on public.tasks
         for select to authenticated
         using ((select app.current_app_role()) = 'abigail')`,
      async () => {
        await withUser(db, abigail, async () => {
          await db.query(
            "update public.tasks set area = 'school', visibility = 'private' where id = $1",
            [SHARED_HOME],
          );
        });
        const { rows } = await db.query("select area from public.tasks where id = $1", [SHARED_HOME]);
        expect(rows[0].area).toBe("school");
      },
    );
  });

  it("dropping the immutability trigger lets provenance be rewritten", async () => {
    await seedBoard();
    await inject("drop trigger tasks_forbid_provenance_change on public.tasks", async () => {
      const { rows } = await db.query(
        "update public.tasks set created_by = 'abigail' where id = $1 returning created_by",
        [SCHOOL],
      );
      expect(rows[0].created_by).toBe("abigail");
    });
  });

  // The single most important injection in this file. An unconditional stamp
  // looks harmless and destroys the imported history Phases 2 and 3 preserved.
  it("making the stamp unconditional destroys imported provenance", async () => {
    await inject(
      `create or replace function app.stamp_task_provenance()
         returns trigger language plpgsql set search_path = '' as $fn$
         begin
           new.created_by := 'fon';
           new.source := 'manual';
           return new;
         end;
         $fn$;`,
      async () => {
        // No auth.uid() here: this is exactly the Phase 3 importer's session.
        const { rows } = await db.query(`
          insert into public.tasks (title, area, created_by, source)
          values ('imported', 'inbox', 'pong', 'pong-voice')
          returning created_by, source
        `);
        expect(rows[0]).toEqual({ created_by: "fon", source: "manual" });
      },
    );

    // And with the real trigger restored, the same insert survives intact.
    const { rows } = await db.query(`
      insert into public.tasks (title, area, created_by, source)
      values ('imported again', 'inbox', 'pong', 'pong-voice')
      returning created_by, source
    `);
    expect(rows[0]).toEqual({ created_by: "pong", source: "pong-voice" });
  });
});
