import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { expectViolation, freshDb, insertTask, resetDb } from "./harness.mjs";
import { uid } from "../../src/lib/model.js";

let db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await resetDb(db); });

describe("tasks: UUID compatibility (the Phase 2 promise)", () => {
  it("accepts ids the app generates, unchanged", async () => {
    const ids = Array.from({ length: 50 }, uid);
    for (const id of ids) await insertTask(db, { id });

    const { rows } = await db.query("select id from public.tasks order by id");
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it("rejects a legacy non-UUID id, so a pre-Phase-2 board cannot sneak in", async () => {
    const error = await expectViolation(() => insertTask(db, { id: "s1" }));
    expect(error.message).toMatch(/invalid input syntax for type uuid/i);
  });

  it("refuses two tasks with the same id", async () => {
    await insertTask(db);
    const error = await expectViolation(() => insertTask(db, { title: "Different title" }));
    expect(error.message).toMatch(/duplicate key|tasks_pkey/i);
  });

  it("generates a UUID when the caller omits one", async () => {
    const { rows } = await db.query(
      "insert into public.tasks (title, area, created_by) values ('x','inbox','pong') returning id",
    );
    expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe("tasks: the sharing invariant is enforced by the database", () => {
  it("allows shared in Family and Home", async () => {
    for (const area of ["family", "home"]) {
      await insertTask(db, { id: uid(), area, visibility: "shared" });
    }
    const { rows } = await db.query("select count(*)::int n from public.tasks where visibility='shared'");
    expect(rows[0].n).toBe(2);
  });

  it("refuses shared in every area Abigail cannot reach", async () => {
    for (const area of ["inbox", "school", "work", "reading", "faith"]) {
      const error = await expectViolation(() =>
        insertTask(db, { id: uid(), area, visibility: "shared" }),
      );
      expect(error.message).toMatch(/tasks_shared_only_in_shared_areas/);
    }
  });

  it("refuses an UPDATE that would move a shared task somewhere private", async () => {
    await insertTask(db, { area: "home", visibility: "shared" });
    const error = await expectViolation(() =>
      db.query("update public.tasks set area = 'work'"),
    );
    expect(error.message).toMatch(/tasks_shared_only_in_shared_areas/);
  });
});

describe("tasks: vocabulary constraints", () => {
  // `extra` isolates the constraint under test: an invalid visibility in a
  // private-only area would trip tasks_shared_only_in_shared_areas first.
  const cases = [
    ["area", "nonsense", /tasks_area_valid/, {}],
    ["status", "pending", /tasks_status_valid/, {}],
    ["priority", "!!!", /tasks_priority_valid/, {}],
    ["visibility", "public", /tasks_visibility_valid/, { area: "family" }],
    ["created_by", "stranger", /tasks_created_by_valid/, {}],
    ["source", "telepathy", /tasks_source_valid/, {}],
  ];

  it.each(cases)("rejects an invalid %s", async (column, value, pattern, extra) => {
    const error = await expectViolation(() => insertTask(db, { ...extra, [column]: value }));
    expect(error.message).toMatch(pattern);
  });

  it("accepts every area the app defines", async () => {
    for (const area of ["inbox", "school", "work", "reading", "family", "faith", "home"]) {
      await insertTask(db, { id: uid(), area });
    }
    const { rows } = await db.query("select count(*)::int n from public.tasks");
    expect(rows[0].n).toBe(7);
  });

  it("rejects a blank title", async () => {
    const error = await expectViolation(() => insertTask(db, { title: "   " }));
    expect(error.message).toMatch(/tasks_title_not_blank/);
  });

  it("rejects an empty-string owner, which must arrive as null", async () => {
    const error = await expectViolation(() => insertTask(db, { owner: "" }));
    expect(error.message).toMatch(/tasks_owner_not_blank/);
  });
});

describe("tasks: dates and completion state", () => {
  it("rejects a due time with no due date", async () => {
    const error = await expectViolation(() => insertTask(db, { due_time: "09:00" }));
    expect(error.message).toMatch(/tasks_due_time_requires_due_date/);
  });

  it("accepts a due time alongside a due date", async () => {
    const { rows } = await insertTask(db, { due_date: "2026-10-02", due_time: "09:00" });
    expect(rows[0].due_date).toBeTruthy();
  });

  it("refuses an open task that carries a completion time", async () => {
    const error = await expectViolation(() =>
      insertTask(db, { status: "open", completed_at: "2026-09-21T00:00:00Z" }),
    );
    expect(error.message).toMatch(/tasks_completed_at_matches_status/);
  });

  it("refuses a done task with no completion time", async () => {
    const error = await expectViolation(() => insertTask(db, { status: "done" }));
    expect(error.message).toMatch(/tasks_completed_at_matches_status/);
  });

  it("lets an archived task keep or drop its completion time", async () => {
    await insertTask(db, { id: uid(), status: "archived", completed_at: "2026-09-21T00:00:00Z" });
    await insertTask(db, { id: uid(), status: "archived", completed_at: null });
    const { rows } = await db.query("select count(*)::int n from public.tasks where status='archived'");
    expect(rows[0].n).toBe(2);
  });
});

describe("tasks: duplicate protection for Claude imports", () => {
  it("refuses two claude-import tasks sharing an import_key", async () => {
    await insertTask(db, { id: uid(), source: "claude-import", created_by: "claude-import", import_key: "psy380-ch7" });
    const error = await expectViolation(() =>
      insertTask(db, { id: uid(), source: "claude-import", created_by: "claude-import", import_key: "psy380-ch7" }),
    );
    expect(error.message).toMatch(/tasks_source_import_key_unique/);
  });

  it("does not treat null import_keys as duplicates of each other", async () => {
    for (let i = 0; i < 5; i += 1) await insertTask(db, { id: uid(), import_key: null });
    const { rows } = await db.query("select count(*)::int n from public.tasks");
    expect(rows[0].n).toBe(5);
  });

  it("allows the same key under a different source", async () => {
    await insertTask(db, { id: uid(), source: "claude-import", created_by: "claude-import", import_key: "shared-key" });
    await insertTask(db, { id: uid(), source: "manual", import_key: "shared-key" });
    const { rows } = await db.query("select count(*)::int n from public.tasks");
    expect(rows[0].n).toBe(2);
  });
});

describe("updated_at trigger", () => {
  it("stamps updated_at when the caller does not set it", async () => {
    await insertTask(db, { updated_at: "2020-01-01T00:00:00Z" });
    await db.query("update public.tasks set title = 'Renamed'");

    const { rows } = await db.query("select updated_at from public.tasks");
    expect(new Date(rows[0].updated_at).getFullYear()).toBeGreaterThan(2020);
  });

  it("respects an updated_at the caller sets deliberately, so imports keep history", async () => {
    await insertTask(db, { updated_at: "2020-01-01T00:00:00Z" });
    await db.query("update public.tasks set title = 'Renamed', updated_at = '2021-06-06T00:00:00Z'");

    const { rows } = await db.query("select updated_at from public.tasks");
    expect(new Date(rows[0].updated_at).toISOString()).toBe("2021-06-06T00:00:00.000Z");
  });
});

describe("area_notes", () => {
  it("holds one note per area and rejects an unknown area", async () => {
    await db.query("insert into public.area_notes (area, note) values ('school', 'Paper week')");
    const error = await expectViolation(() =>
      db.query("insert into public.area_notes (area, note) values ('nonsense', 'x')"),
    );
    expect(error.message).toMatch(/area_notes_area_valid/);
  });

  it("refuses a second row for the same area", async () => {
    await db.query("insert into public.area_notes (area) values ('home')");
    const error = await expectViolation(() =>
      db.query("insert into public.area_notes (area) values ('home')"),
    );
    expect(error.message).toMatch(/duplicate key|area_notes_pkey/i);
  });
});

describe("audit_log is append-only", () => {
  beforeEach(async () => {
    await db.query(
      "insert into public.audit_log (actor, action, task_id) values ('pong', 'task.create', $1)",
      ["3f1a6c2e-8b55-4a71-9d44-0c2e17ab9f10"],
    );
  });

  it("accepts inserts", async () => {
    const { rows } = await db.query("select count(*)::int n from public.audit_log");
    expect(rows[0].n).toBe(1);
  });

  it("raises on UPDATE", async () => {
    const error = await expectViolation(() => db.query("update public.audit_log set action = 'tampered'"));
    expect(error.message).toMatch(/append-only/);
  });

  it("raises on DELETE", async () => {
    const error = await expectViolation(() => db.query("delete from public.audit_log"));
    expect(error.message).toMatch(/append-only/);
  });

  // A FOR EACH ROW trigger never fires on TRUNCATE. Without a statement-level
  // guard the whole log could be emptied in one statement, leaving no trace —
  // which is precisely the actor the log exists to keep honest.
  it("raises on TRUNCATE as the table owner", async () => {
    const error = await expectViolation(() => db.query("truncate public.audit_log"));
    expect(error.message).toMatch(/append-only/);
  });

  it("raises on TRUNCATE as service_role, which bypasses RLS but not triggers", async () => {
    await db.exec(`
      grant usage on schema public to service_role;
      grant all on public.audit_log to service_role;
    `);
    await db.exec("set role service_role");
    const error = await expectViolation(() => db.query("truncate public.audit_log"));
    await db.exec("reset role");

    expect(error.message).toMatch(/append-only/);
  });

  it("keeps its rows after every refused attempt", async () => {
    for (const statement of [
      "update public.audit_log set action = 'tampered'",
      "delete from public.audit_log",
      "truncate public.audit_log",
    ]) {
      await expectViolation(() => db.query(statement));
    }
    const { rows } = await db.query("select count(*)::int n from public.audit_log");
    expect(rows[0].n).toBe(1);
  });

  it("survives deletion of the task it describes", async () => {
    await insertTask(db);
    await db.query("delete from public.tasks");
    const { rows } = await db.query("select count(*)::int n from public.audit_log");
    expect(rows[0].n).toBe(1);
  });
});

describe("the test harness still clears audit_log between cases", () => {
  // resetDb disables the triggers to truncate. If that ever silently stopped
  // working, every audit assertion above would leak state into the next test
  // and the suite would still be green.
  it("starts each case with an empty audit_log", async () => {
    const { rows } = await db.query("select count(*)::int n from public.audit_log");
    expect(rows[0].n).toBe(0);
  });

  it("re-enables both guards after resetting", async () => {
    const { rows } = await db.query(`
      select tgname, tgenabled from pg_trigger
      where tgrelid = 'public.audit_log'::regclass and not tgisinternal
      order by tgname
    `);
    expect(rows.map((r) => r.tgname)).toEqual(["audit_log_append_only", "audit_log_no_truncate"]);
    expect(rows.every((r) => r.tgenabled === "O")).toBe(true);
  });
});

describe("idempotency_keys and import_batches", () => {
  it("refuses a replayed idempotency key", async () => {
    await db.query("insert into public.idempotency_keys (key, actor) values ('req-1', 'pong')");
    const error = await expectViolation(() =>
      db.query("insert into public.idempotency_keys (key, actor) values ('req-1', 'pong')"),
    );
    expect(error.message).toMatch(/duplicate key|idempotency_keys_pkey/i);
  });

  it("refuses a malformed checksum", async () => {
    const error = await expectViolation(() =>
      db.query("insert into public.import_batches (kind, checksum) values ('local-json', 'not-a-sha')"),
    );
    expect(error.message).toMatch(/import_batches_checksum_valid/);
  });

  it("refuses the same payload twice", async () => {
    const sha = "a".repeat(64);
    await db.query("insert into public.import_batches (kind, checksum) values ('local-json', $1)", [sha]);
    const error = await expectViolation(() =>
      db.query("insert into public.import_batches (kind, checksum) values ('local-json', $1)", [sha]),
    );
    expect(error.message).toMatch(/import_batches_unique_payload/);
  });
});

describe("profiles (Phase 4 preparation)", () => {
  it("accepts the three human roles and rejects pong, which is not a person", async () => {
    for (const role of ["fon", "abigail", "accountability"]) {
      const { rows } = await db.query("insert into auth.users default values returning id");
      await db.query("insert into public.profiles (user_id, role) values ($1, $2)", [rows[0].id, role]);
    }

    const { rows: user } = await db.query("insert into auth.users default values returning id");
    const error = await expectViolation(() =>
      db.query("insert into public.profiles (user_id, role) values ($1, 'pong')", [user[0].id]),
    );
    expect(error.message).toMatch(/profiles_role_valid/);
  });

  it("allows only one holder of each role", async () => {
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const { rows } = await db.query("insert into auth.users default values returning id");
      ids.push(rows[0].id);
    }
    await db.query("insert into public.profiles (user_id, role) values ($1, 'fon')", [ids[0]]);
    const error = await expectViolation(() =>
      db.query("insert into public.profiles (user_id, role) values ($1, 'fon')", [ids[1]]),
    );
    expect(error.message).toMatch(/profiles_one_per_role/);
  });
});
