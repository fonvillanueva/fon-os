// supabase/rollback-phase-4.sql, against real Postgres.
//
// A rollback is only trustworthy if the direction it fails in is the safe one.
// After this file runs the board must be UNREACHABLE again — Phase 3's
// default-deny — not open. And it must cost nobody their account and nobody
// their role assignment: losing a schema change should not mean re-enrolling
// three people, still less deleting them.

import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  applyMigrations,
  applyPhase4Rollback,
  ROLLBACK_PHASE_4_FILE,
  enrol,
  expectViolation,
  freshDb,
  insertTask,
  migrationFiles,
  readMigration,
  withUser,
} from "./harness.mjs";

const PHASE_4_MIGRATION = "20260922000700_phase4_auth.sql";

let db;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** A database with Phase 3 applied and Phase 4 deliberately left off. */
async function phase3OnlyDb() {
  const fresh = await freshDb({ migrate: false });
  for (const name of await migrationFiles()) {
    if (name === PHASE_4_MIGRATION) continue;
    await fresh.exec(await readMigration(name));
  }
  return fresh;
}

async function counts(database) {
  const { rows } = await database.query(`
    select
      (select count(*)::int from pg_policies where schemaname = 'public') as policies,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v') as views,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname = 'current_app_role') as role_fn,
      (select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'tasks' and not t.tgisinternal) as task_triggers,
      (select count(*)::int from public.profiles) as profiles,
      (select count(*)::int from auth.users) as users,
      (select count(*)::int from public.tasks) as tasks
  `);
  return rows[0];
}

describe("rollback returns the database to Phase 3 default-deny", () => {
  it("removes every policy, the view, the role function and both provenance triggers", async () => {
    db = await freshDb();
    const before = await counts(db);
    expect(before.policies).toBe(15);
    expect(before.views).toBe(1);
    expect(before.role_fn).toBe(1);

    await applyPhase4Rollback(db);

    const after = await counts(db);
    expect(after.policies).toBe(0);
    expect(after.views).toBe(0);
    expect(after.role_fn).toBe(0);
    // Only Phase 3's updated_at trigger survives on tasks.
    expect(after.task_triggers).toBe(1);
  });

  it("leaves the api roles holding nothing again", async () => {
    db = await freshDb();
    const { rows } = await db.query(`
      select c.relname, p.priv, r.rolname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)
        cross join (values ('anon'),('authenticated')) r(rolname)
       where n.nspname = 'public' and c.relkind in ('r','v')
         and has_table_privilege(r.rolname, c.oid, p.priv)
    `);
    expect(rows.length).toBeGreaterThan(0); // Phase 4 granted something

    await applyPhase4Rollback(db);

    const { rows: after } = await db.query(`
      select c.relname, p.priv, r.rolname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)
        cross join (values ('anon'),('authenticated')) r(rolname)
       where n.nspname = 'public' and c.relkind in ('r','v')
         and has_table_privilege(r.rolname, c.oid, p.priv)
    `);
    expect(after).toEqual([]);
  });

  it("also takes back USAGE on the app schema", async () => {
    db = await freshDb();
    await applyPhase4Rollback(db);
    const { rows } = await db.query(
      "select has_schema_privilege('authenticated','app','USAGE') as ok",
    );
    expect(rows[0].ok).toBe(false);
  });

  // The direction that matters. After rollback a signed-in person reads
  // nothing, rather than everything.
  it("leaves a previously-authorized person reading nothing", async () => {
    db = await freshDb();
    const fon = await enrol(db, "fon");
    await insertTask(db, { title: "Still here", area: "school" });

    await withUser(db, fon, async () => {
      const { rows } = await db.query("select title from public.tasks");
      expect(rows).toHaveLength(1);
    });

    await applyPhase4Rollback(db);

    await withUser(db, fon, async () => {
      const error = await expectViolation(() => db.query("select title from public.tasks"));
      expect(error.message).toMatch(/permission denied/i);
    });
  });
});

describe("rollback is database-only", () => {
  // Deleting somebody's account is a separate, deliberate, manual action. It is
  // never scripted and never bundled with a schema change.
  it("does not touch auth.users", async () => {
    db = await freshDb();
    await enrol(db, "fon");
    await enrol(db, "abigail");
    const before = await counts(db);
    expect(before.users).toBe(2);

    await applyPhase4Rollback(db);

    expect((await counts(db)).users).toBe(2);
  });

  it("never mentions auth.users in the file at all", async () => {
    const sql = await readFile(ROLLBACK_PHASE_4_FILE, "utf8");
    // Comments explain why it must not; no statement may act on it.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/auth\.users/i);
    expect(statements).not.toMatch(/\bdrop\s+table\b/i);
    expect(statements).not.toMatch(/\bdelete\s+from\b/i);
    expect(statements).not.toMatch(/\btruncate\b/i);
  });

  it("keeps every profiles row, so a re-apply needs no re-enrolment", async () => {
    db = await freshDb();
    await enrol(db, "fon");
    await enrol(db, "abigail");
    await enrol(db, "accountability");

    await applyPhase4Rollback(db);

    const { rows } = await db.query("select role from public.profiles order by role");
    expect(rows.map((r) => r.role)).toEqual(["abigail", "accountability", "fon"]);
  });

  it("keeps every task row and its provenance byte for byte", async () => {
    db = await freshDb();
    const fixtures = [
      ["pong", "pong-voice"],
      ["claude-import", "claude-import"],
      ["abigail", "abigail"],
    ];
    for (const [i, [createdBy, source]] of fixtures.entries()) {
      await insertTask(db, {
        id: `00000000-0000-4000-8000-00000000000${i}`,
        title: `row ${i}`,
        area: "inbox",
        created_by: createdBy,
        source,
      });
    }

    await applyPhase4Rollback(db);

    const { rows } = await db.query(
      "select created_by, source from public.tasks order by title",
    );
    expect(rows.map((r) => [r.created_by, r.source])).toEqual(fixtures);
  });

  it("leaves the Phase 3 schema entirely intact", async () => {
    db = await freshDb();
    await applyPhase4Rollback(db);

    const { rows } = await db.query(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      "area_notes", "audit_log", "idempotency_keys", "import_batches", "profiles", "tasks",
    ]);

    // RLS stays enabled and forced — that is what makes the rollback safe.
    const { rows: rls } = await db.query(`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relrowsecurity and c.relforcerowsecurity
    `);
    expect(rls[0].n).toBe(6);
  });

  it("leaves the Phase 3 audit guards in place", async () => {
    db = await freshDb();
    await db.query("insert into public.audit_log (actor, action) values ('fon','created')");
    await applyPhase4Rollback(db);
    const error = await expectViolation(() => db.query("update public.audit_log set action = 'y'"));
    expect(error.message).toMatch(/append-only/i);
  });
});

describe("rollback is safe to run more than once, and on a database that never had Phase 4", () => {
  it("applies twice without error", async () => {
    db = await freshDb();
    await applyPhase4Rollback(db);
    await expect(applyPhase4Rollback(db)).resolves.not.toThrow();
    expect((await counts(db)).policies).toBe(0);
  });

  it("applies cleanly to a Phase 3 database that never saw Phase 4", async () => {
    db = await phase3OnlyDb();
    expect((await counts(db)).policies).toBe(0);
    await expect(applyPhase4Rollback(db)).resolves.not.toThrow();
    expect((await counts(db)).policies).toBe(0);
  });

  it("re-applying Phase 4 afterwards rebuilds it exactly", async () => {
    db = await freshDb();
    await applyPhase4Rollback(db);
    await applyMigrations(db);

    const after = await counts(db);
    expect(after.policies).toBe(15);
    expect(after.views).toBe(1);
    expect(after.role_fn).toBe(1);

    // And the boundary works again end to end.
    const abigail = await enrol(db, "abigail");
    await insertTask(db, { title: "Work item", area: "work" });
    await withUser(db, abigail, async () => {
      const { rows } = await db.query("select title from public.tasks");
      expect(rows).toEqual([]);
    });
  });
});
