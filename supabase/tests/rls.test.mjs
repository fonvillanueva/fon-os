import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { expectViolation, freshDb, insertTask, resetDb } from "./harness.mjs";

const TABLES = [
  "tasks", "area_notes", "profiles", "audit_log", "idempotency_keys", "import_batches",
];

let db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("reset role");
  await resetDb(db);
});

describe("every table is locked down", () => {
  it.each(TABLES)("has RLS enabled and forced on %s", async (table) => {
    const { rows } = await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass",
      [`public.${table}`],
    );
    expect(rows[0].relrowsecurity).toBe(true);
    // FORCE extends the denial to the table owner, so a later migration
    // running as owner cannot quietly read the board.
    expect(rows[0].relforcerowsecurity).toBe(true);
  });

  it("defines no policies at all — the denial is structural, not a rule to remove later", async () => {
    const { rows } = await db.query("select tablename, policyname from pg_policies where schemaname = 'public'");
    expect(rows).toEqual([]);
  });

  it.each(TABLES)("grants anon and authenticated nothing on %s", async (table) => {
    const { rows } = await db.query(
      `select grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = $1
          and grantee in ('anon', 'authenticated')`,
      [table],
    );
    expect(rows).toEqual([]);
  });

  it("leaves no public table uncovered", async () => {
    const { rows } = await db.query(`
      select c.relname
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and (not c.relrowsecurity or not c.relforcerowsecurity)
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe("a signed-in user reaches nothing before Phase 4", () => {
  beforeEach(async () => {
    await insertTask(db, { area: "work", title: "Confidential client matter" });
    await db.query("insert into public.area_notes (area, note) values ('school', 'Paper week')");
  });

  it.each(["anon", "authenticated"])("denies %s any read of tasks", async (role) => {
    await db.exec(`set role ${role}`);
    const error = await expectViolation(() => db.query("select * from public.tasks"));
    expect(error.message).toMatch(/permission denied/i);
    await db.exec("reset role");
  });

  it.each(["anon", "authenticated"])("denies %s any write to tasks", async (role) => {
    await db.exec(`set role ${role}`);
    const error = await expectViolation(() =>
      db.query("insert into public.tasks (title, area, created_by) values ('x','inbox','fon')"),
    );
    expect(error.message).toMatch(/permission denied/i);
    await db.exec("reset role");
  });

  it.each(TABLES)("denies authenticated any read of %s", async (table) => {
    await db.exec("set role authenticated");
    const error = await expectViolation(() => db.query(`select * from public.${table}`));
    expect(error.message).toMatch(/permission denied/i);
    await db.exec("reset role");
  });

  it("denies authenticated the internal app schema", async () => {
    await db.exec("set role authenticated");
    const error = await expectViolation(() => db.query("select app.touch_updated_at()"));
    expect(error.message).toMatch(/permission denied|does not exist/i);
    await db.exec("reset role");
  });
});

describe("RLS holds even where a grant exists", () => {
  // Proves the denial does not rest on the revoked grants alone: a role that
  // has been granted SELECT still reads zero rows, because no policy permits any.
  it("returns no rows to a granted, non-bypassing role", async () => {
    await insertTask(db, { title: "Private task" });

    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'probe') then
          create role probe nologin;
        end if;
      end $$;
      grant usage on schema public to probe;
      grant select, insert, update, delete on public.tasks to probe;
    `);

    await db.exec("set role probe");
    const { rows } = await db.query("select * from public.tasks");
    expect(rows).toEqual([]);

    const { rows: affected } = await db.query("update public.tasks set title = 'hijacked' returning id");
    expect(affected).toEqual([]);
    await db.exec("reset role");

    const { rows: actual } = await db.query("select title from public.tasks");
    expect(actual[0].title).toBe("Private task");
  });
});

describe("service_role is the documented exception", () => {
  // Supabase's service_role holds BYPASSRLS. This test pins that fact so the
  // consequence is visible in the suite: whoever holds that key reads
  // everything, which is why it must never leave a server environment variable.
  it("bypasses RLS, which is why the key never reaches the browser", async () => {
    await insertTask(db, { title: "Private task" });
    await db.exec("grant usage on schema public to service_role");
    await db.exec("grant select on public.tasks to service_role");

    await db.exec("set role service_role");
    const { rows } = await db.query("select title from public.tasks");
    await db.exec("reset role");

    expect(rows).toHaveLength(1);
  });
});
