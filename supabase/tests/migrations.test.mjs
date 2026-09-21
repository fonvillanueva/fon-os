import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  applyRollback,
  freshDb,
  insertTask,
  migrationFiles,
  publicTables,
  readMigration,
  schemaSnapshot,
} from "./harness.mjs";

const EXPECTED_TABLES = [
  "area_notes", "audit_log", "idempotency_keys", "import_batches", "profiles", "tasks",
];

let db;
afterEach(async () => { await db?.close(); db = null; });

describe("migration files", () => {
  it("apply in filename order and create every table", async () => {
    db = await freshDb();
    expect(await publicTables(db)).toEqual(EXPECTED_TABLES);
  });

  it("are ordered by a sortable timestamp prefix", async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(name).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    expect([...files].sort()).toEqual(files);
  });

  it("contain no credential-shaped literal", async () => {
    for (const name of await migrationFiles()) {
      const sql = await readMigration(name);
      expect(sql).not.toMatch(/service_role_key|eyJ[A-Za-z0-9_-]{10,}|postgres:\/\/[^\s]*:[^\s]*@/i);
    }
  });
});

describe("re-running migrations is safe", () => {
  it("applies twice without error", async () => {
    db = await freshDb();
    await expect(applyMigrations(db)).resolves.not.toThrow();
  });

  it("leaves the schema identical after a second run", async () => {
    db = await freshDb();
    const before = await schemaSnapshot(db);
    await applyMigrations(db);
    expect(await schemaSnapshot(db)).toEqual(before);
  });

  it("does not duplicate constraints, indexes, triggers or policies", async () => {
    db = await freshDb();
    const count = async () => {
      const { rows } = await db.query(`
        select
          (select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid
             join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'public')::int as constraints,
          (select count(*) from pg_indexes where schemaname = 'public')::int as indexes,
          (select count(*) from pg_trigger g join pg_class t on t.oid = g.tgrelid
             join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = 'public' and not g.tgisinternal)::int as triggers,
          (select count(*) from pg_policies where schemaname = 'public')::int as policies
      `);
      return rows[0];
    };

    const before = await count();
    await applyMigrations(db);
    expect(await count()).toEqual(before);
    expect(before.policies).toBe(0);
  });

  it("preserves existing rows when re-run", async () => {
    db = await freshDb();
    await insertTask(db, { title: "Survives a re-run" });
    await applyMigrations(db);

    const { rows } = await db.query("select title from public.tasks");
    expect(rows).toEqual([{ title: "Survives a re-run" }]);
  });
});

describe("rollback and recovery", () => {
  it("removes every table it created", async () => {
    db = await freshDb();
    await applyRollback(db);
    expect(await publicTables(db)).toEqual([]);
  });

  it("drops the internal app schema and its functions", async () => {
    db = await freshDb();
    await applyRollback(db);

    const { rows } = await db.query("select nspname from pg_namespace where nspname = 'app'");
    expect(rows).toEqual([]);
  });

  it("leaves the Supabase auth schema alone — rollback must not touch user accounts", async () => {
    db = await freshDb();
    await db.query("insert into auth.users (email) values ('fon@example.com')");
    await applyRollback(db);

    const { rows } = await db.query("select email from auth.users");
    expect(rows).toEqual([{ email: "fon@example.com" }]);
  });

  it("is safe to run on a database that never had the migrations", async () => {
    db = await freshDb({ migrate: false });
    await expect(applyRollback(db)).resolves.not.toThrow();
  });

  it("is safe to run twice", async () => {
    db = await freshDb();
    await applyRollback(db);
    await expect(applyRollback(db)).resolves.not.toThrow();
  });

  it("rebuilds an identical schema when migrations are re-applied afterwards", async () => {
    db = await freshDb();
    const before = await schemaSnapshot(db);

    await applyRollback(db);
    await applyMigrations(db);

    expect(await schemaSnapshot(db)).toEqual(before);
    const { rows } = await db.query("select count(*)::int n from pg_policies where schemaname='public'");
    expect(rows[0].n).toBe(0);
  });
});
