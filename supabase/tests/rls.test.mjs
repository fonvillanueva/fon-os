import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, expectViolation, freshDb, insertTask, resetDb } from "./harness.mjs";

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

describe("default privileges for tables created later", () => {
  // ALTER DEFAULT PRIVILEGES with no FOR ROLE edits only the entries owned by
  // the role running it. Supabase seeds its own as supabase_admin, so an
  // unqualified revoke run as anyone else is a silent no-op — and every table
  // created afterwards lands with full anon grants and RLS off.
  async function withForeignDefaultAcl() {
    const database = await freshDb({ migrate: false });
    await database.exec("create role seeding_admin superuser");
    await database.exec(
      "alter default privileges for role seeding_admin in schema public grant all on tables to anon, authenticated",
    );
    return database;
  }

  async function defaultAclOwners(database) {
    const { rows } = await database.query(`
      select pg_get_userbyid(defaclrole) as owner
      from pg_default_acl
      where defaclnamespace = 'public'::regnamespace
        and (defaclacl::text like '%anon=%' or defaclacl::text like '%authenticated=%')
    `);
    return rows.map((r) => r.owner);
  }

  it("reproduces the hazard: an unqualified revoke leaves a foreign entry intact", async () => {
    const database = await withForeignDefaultAcl();
    try {
      await database.exec("alter default privileges in schema public revoke all on tables from anon, authenticated");
      expect(await defaultAclOwners(database)).toEqual(["seeding_admin"]);
    } finally {
      await database.close();
    }
  });

  it("the migration clears a default-ACL entry owned by another role", async () => {
    const database = await withForeignDefaultAcl();
    try {
      expect(await defaultAclOwners(database)).toEqual(["seeding_admin"]);
      await applyMigrations(database);
      expect(await defaultAclOwners(database)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("so a table that role creates afterwards grants anon nothing", async () => {
    const database = await withForeignDefaultAcl();
    try {
      await applyMigrations(database);
      await database.exec("set role seeding_admin; create table public.created_later (id int); reset role");

      const { rows } = await database.query(
        "select has_table_privilege('anon', 'public.created_later', 'SELECT') as granted",
      );
      expect(rows[0].granted).toBe(false);
    } finally {
      await database.close();
    }
  });

  it("clears entries for sequences and functions too, not only tables", async () => {
    const database = await freshDb({ migrate: false });
    try {
      await database.exec("create role seeding_admin superuser");
      await database.exec(`
        alter default privileges for role seeding_admin in schema public grant all on sequences to anon;
        alter default privileges for role seeding_admin in schema public grant execute on functions to authenticated;
      `);
      expect(await defaultAclOwners(database)).toHaveLength(2);

      await applyMigrations(database);
      expect(await defaultAclOwners(database)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("is idempotent — re-running finds nothing left to revoke", async () => {
    const database = await withForeignDefaultAcl();
    try {
      await applyMigrations(database);
      await expect(applyMigrations(database)).resolves.not.toThrow();
      expect(await defaultAclOwners(database)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  // Confirmed against the hosted project on 2026-09-21: supabase_admin owns the
  // public-schema entries there, so this is the path Supabase actually takes.
  it("skips with a warning, not an error, when membership of the owning role is missing", async () => {
    const database = await withForeignDefaultAcl();
    try {
      await database.exec("create role limited nologin; grant usage on schema public to limited");
      // The function must exist before a limited role can call it. `limited`
      // models the SQL Editor's role: able to run the migration, but not a
      // member of the role that owns the default-ACL entries.
      await applyMigrations(database);
      await database.exec("grant usage on schema app to limited");
      await database.exec(
        "alter default privileges for role seeding_admin in schema public grant all on tables to anon",
      );

      await database.exec("set role limited");
      await expect(database.exec("select app.revoke_api_default_privileges()")).resolves.not.toThrow();
      await database.exec("reset role");

      // It could not revoke, and says so rather than failing silently...
      expect(await defaultAclOwners(database)).toEqual(["seeding_admin"]);
      // ...and verify.sql is what catches it — see apply-all.test.mjs.
    } finally {
      await database.close();
    }
  });

  // Load-bearing for the risk assessment: a surviving entry owned by another
  // role affects only objects THAT role creates. Tables created by the role
  // running our migrations are unaffected.
  it("a surviving foreign entry does not affect tables created by another role", async () => {
    const database = await freshDb({ migrate: false });
    try {
      await database.exec("create role seeding_admin superuser");
      await database.exec(
        "alter default privileges for role seeding_admin in schema public grant all on tables to anon",
      );

      await database.exec("create table public.made_by_current_role (id int)");
      await database.exec("set role seeding_admin; create table public.made_by_admin (id int); reset role");

      const { rows } = await database.query(`
        select has_table_privilege('anon', 'public.made_by_current_role', 'SELECT') as by_us,
               has_table_privilege('anon', 'public.made_by_admin',        'SELECT') as by_them
      `);
      expect(rows[0].by_us).toBe(false);
      expect(rows[0].by_them).toBe(true);
    } finally {
      await database.close();
    }
  });

  it("leaves default privileges for other roles alone", async () => {
    const database = await freshDb({ migrate: false });
    try {
      await database.exec("create role seeding_admin superuser");
      await database.exec("create role reporting nologin");
      await database.exec("alter default privileges for role seeding_admin in schema public grant select on tables to reporting");

      await applyMigrations(database);

      const { rows } = await database.query(`
        select defaclacl::text as acl from pg_default_acl
        where defaclnamespace = 'public'::regnamespace
      `);
      expect(rows.some((r) => r.acl.includes("reporting="))).toBe(true);
    } finally {
      await database.close();
    }
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
