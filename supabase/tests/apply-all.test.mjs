// The single-paste schema file and the verification query are the two things
// Fon actually runs by hand in the Supabase SQL Editor, so they are tested the
// same way as the migrations: executed against a real Postgres.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, freshDb, publicTables, schemaSnapshot } from "./harness.mjs";
import { buildApplyAll } from "../../scripts/build-apply-all.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPLY_ALL = join(ROOT, "supabase", "apply-all.sql");
const VERIFY = join(ROOT, "supabase", "verify.sql");

let db;
afterEach(async () => { await db?.close(); db = null; });

async function runVerify(database) {
  const { rows } = await database.query(await readFile(VERIFY, "utf8"));
  return rows;
}

describe("apply-all.sql", () => {
  it("is in sync with the migration files", async () => {
    // Guards the generated file against drifting when a migration changes.
    expect(await readFile(APPLY_ALL, "utf8")).toBe(await buildApplyAll());
  });

  it("builds the same schema as applying the migrations one by one", async () => {
    db = await freshDb();
    const fromMigrations = await schemaSnapshot(db);
    await db.close();

    db = await freshDb({ migrate: false });
    await db.exec(await readFile(APPLY_ALL, "utf8"));

    expect(await publicTables(db)).toEqual([
      "area_notes", "audit_log", "idempotency_keys", "import_batches", "profiles", "tasks",
    ]);
    expect(await schemaSnapshot(db)).toEqual(fromMigrations);
  });

  it("is safe to paste twice", async () => {
    db = await freshDb({ migrate: false });
    const sql = await readFile(APPLY_ALL, "utf8");

    await db.exec(sql);
    const before = await schemaSnapshot(db);
    await expect(db.exec(sql)).resolves.not.toThrow();

    expect(await schemaSnapshot(db)).toEqual(before);
  });

  it("carries no credential", async () => {
    const sql = await readFile(APPLY_ALL, "utf8");
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret_|service_role_key|postgresql:\/\/[^\s]*:[^\s]*@/i);
  });
});

describe("verify.sql", () => {
  it("reports PASS for every check against a correctly migrated database", async () => {
    db = await freshDb();
    const rows = await runVerify(db);

    const failures = rows.filter((r) => r.status === "FAIL");
    expect(failures).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ check: "OVERALL", status: "PASS" });
  });

  // Nineteen Phase 3 checks, six added by Phase 4 (5a and 20-24), plus the
  // context note and the overall verdict.
  it("covers twenty-five checks plus a context note and an overall verdict", async () => {
    db = await freshDb();
    const rows = await runVerify(db);
    expect(rows).toHaveLength(27);
    expect(rows.filter((r) => r.status === "NOTE")).toHaveLength(1);
    // The Phase 4 additions are present and numbered as the plan describes.
    const numbers = rows.map((r) => String(r["#"]));
    for (const n of ["5a", "20", "21", "22", "23", "24"]) expect(numbers).toContain(n);
  });

  // The context row explains why check 18 fails on Supabase. It must never be
  // able to turn a failing board green.
  it("the context note carries no status weight", async () => {
    db = await freshDb();
    await db.exec("create role seeding_admin superuser");
    await db.exec(
      "alter default privileges for role seeding_admin in schema public grant all on tables to anon",
    );

    const rows = await runVerify(db);
    const note = rows.find((r) => r.status === "NOTE");
    const check18 = rows.find((r) => r.check.includes("No default privileges"));

    expect(note.check).toMatch(/^CONTEXT:/);
    expect(check18.status).toBe("FAIL");
    expect(rows.at(-1)).toMatchObject({ check: "OVERALL", status: "FAIL" });
    expect(rows.at(-1).detail).toMatch(/1 failed/);
  });

  it("still reports OVERALL PASS when nothing is wrong, note included", async () => {
    db = await freshDb();
    const rows = await runVerify(db);
    expect(rows.filter((r) => r.status === "FAIL")).toEqual([]);
    expect(rows.at(-1)).toMatchObject({ check: "OVERALL", status: "PASS" });
  });

  it("fails loudly if RLS is switched off", async () => {
    db = await freshDb();
    await db.exec("alter table public.tasks disable row level security");

    const rows = await runVerify(db);
    expect(rows.find((r) => r.check.includes("RLS enabled")).status).toBe("FAIL");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if someone adds a policy outside the expected set", async () => {
    db = await freshDb();
    await db.exec("create policy temp_open on public.tasks for select using (true)");

    const rows = await runVerify(db);
    const check4 = rows.find((r) => r.check.includes("Policies match the expected set"));
    expect(check4.status).toBe("FAIL");
    expect(check4.detail).toMatch(/UNEXPECTED tasks.temp_open/);
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if an expected policy is dropped", async () => {
    db = await freshDb();
    await db.exec("drop policy tasks_fon_select on public.tasks");

    const rows = await runVerify(db);
    const check4 = rows.find((r) => r.check.includes("Policies match the expected set"));
    expect(check4.status).toBe("FAIL");
    expect(check4.detail).toMatch(/MISSING tasks.tasks_fon_select/);
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if anon is granted access", async () => {
    db = await freshDb();
    await db.exec("grant select on public.tasks to anon");

    const rows = await runVerify(db);
    expect(rows.find((r) => r.check.includes("anon holds no privilege")).status).toBe("FAIL");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if authenticated is granted more than the expected set", async () => {
    db = await freshDb();
    await db.exec("grant select on public.audit_log to authenticated");

    const rows = await runVerify(db);
    const check5 = rows.find((r) => r.check.includes("authenticated holds exactly"));
    expect(check5.status).toBe("FAIL");
    expect(check5.detail).toMatch(/UNEXPECTED SELECT on audit_log/);
    expect(rows.at(-1).status).toBe("FAIL");
  });

  // The privilege check reads has_table_privilege, which sees privileges held
  // indirectly through role membership. information_schema.role_table_grants
  // does not, so this case distinguishes the two.
  it("fails loudly if anon inherits access through another role", async () => {
    db = await freshDb();
    await db.exec(`
      create role intermediary nologin;
      grant select on public.tasks to intermediary;
      grant intermediary to anon;
    `);

    const rows = await runVerify(db);
    expect(rows.find((r) => r.check.includes("anon holds no privilege")).status).toBe("FAIL");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if a default privilege grants anon on future tables", async () => {
    db = await freshDb();
    await db.exec("create role seeding_admin superuser");
    await db.exec(
      "alter default privileges for role seeding_admin in schema public grant all on tables to anon",
    );

    const rows = await runVerify(db);
    const check = rows.find((r) => r.check.includes("No default privileges"));
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("seeding_admin");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if a table appears in public without RLS", async () => {
    db = await freshDb();
    await db.exec("create table public.added_via_dashboard (id int)");

    const rows = await runVerify(db);
    const check = rows.find((r) => r.check.includes("EVERY table"));
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("added_via_dashboard");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  // Check 19 is the compensating control for the accepted platform residual, so
  // its value rests on being path-independent. A preventive DDL trigger keyed on
  // command tags misses these two — CREATE TABLE AS emits 'CREATE TABLE AS' and
  // SELECT INTO emits 'SELECT INTO'. A check on end state does not care how the
  // table arrived.
  it.each([
    ["CREATE TABLE AS", "create table public.materialised as select 1 as id"],
    ["SELECT INTO", "select 1 as id into public.selected_into"],
  ])("catches a table created by %s", async (_label, statement) => {
    db = await freshDb();
    await db.exec(statement);

    const rows = await runVerify(db);
    const check = rows.find((r) => r.check.includes("EVERY table"));
    expect(check.status).toBe("FAIL");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("catches a table left unprotected whoever created it", async () => {
    db = await freshDb();
    await db.exec("create role other_owner superuser");
    await db.exec("set role other_owner; create table public.made_elsewhere (id int); reset role");

    const rows = await runVerify(db);
    const check = rows.find((r) => r.check.includes("EVERY table"));
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("made_elsewhere");
  });

  it("fails loudly if a table has RLS enabled but not forced", async () => {
    db = await freshDb();
    await db.exec("alter table public.tasks no force row level security");

    const rows = await runVerify(db);
    expect(rows.find((r) => r.check.includes("RLS FORCED")).status).toBe("FAIL");
    expect(rows.find((r) => r.check.includes("EVERY table")).detail).toContain("tasks");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if the audit truncate guard is dropped", async () => {
    db = await freshDb();
    await db.exec("drop trigger audit_log_no_truncate on public.audit_log");

    const rows = await runVerify(db);
    const check = rows.find((r) => r.check.includes("audit_log guards"));
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("audit_log_no_truncate");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if the append-only guard is dropped", async () => {
    db = await freshDb();
    await db.exec("drop trigger audit_log_append_only on public.audit_log");

    const rows = await runVerify(db);
    const check = rows.find((r) => r.check.includes("audit_log guards"));
    expect(check.status).toBe("FAIL");
    expect(check.detail).toContain("audit_log_append_only");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("fails loudly if a constraint is dropped", async () => {
    db = await freshDb();
    await db.exec("alter table public.tasks drop constraint tasks_shared_only_in_shared_areas");

    const rows = await runVerify(db);
    expect(rows.find((r) => r.check.includes("Sharing invariant")).status).toBe("FAIL");
    expect(rows.find((r) => r.check.includes("CHECK constraints")).detail).toContain("tasks_shared_only_in_shared_areas");
    expect(rows.at(-1).status).toBe("FAIL");
  });

  it("changes nothing it inspects", async () => {
    db = await freshDb();
    const before = await schemaSnapshot(db);
    await runVerify(db);
    expect(await schemaSnapshot(db)).toEqual(before);
  });
});

describe("apply-all and migrations agree with the app", () => {
  it("leaves a database that still passes the parity expectations", async () => {
    db = await freshDb({ migrate: false });
    await db.exec(await readFile(APPLY_ALL, "utf8"));
    await applyMigrations(db); // re-running the individual files on top is also a no-op

    const rows = await runVerify(db);
    expect(rows.at(-1).status).toBe("PASS");
  });
});
