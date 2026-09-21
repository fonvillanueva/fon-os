import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshDb, resetDb } from "./harness.mjs";
import { buildImportSql, checksum, toRows } from "../import/rows.mjs";
import { createTask, isUuid } from "../../src/lib/model.js";
import { createInitialState, exportState, normalizeState } from "../../src/lib/storage.js";

/** What "Export backup" in My View produces. */
function backup(state) {
  return JSON.parse(exportState(state));
}

let db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await resetDb(db); });

async function apply(exported, options) {
  await db.exec(buildImportSql(exported, options));
}

async function taskTitles() {
  const { rows } = await db.query("select title from public.tasks order by title");
  return rows.map((r) => r.title);
}

describe("importing a real export", () => {
  it("loads every task and area note", async () => {
    const state = createInitialState();
    await apply(backup(state));

    const { rows } = await db.query("select count(*)::int n from public.tasks");
    expect(rows[0].n).toBe(state.tasks.length);

    const { rows: notes } = await db.query("select count(*)::int n from public.area_notes");
    expect(notes[0].n).toBeGreaterThan(0);
  });

  it("preserves every field, losing no provenance", async () => {
    const task = createTask({
      title: "Call A.B. re: rescheduling",
      notes: "Ref #2291",
      area: "work",
      priority: "!!",
      dueDate: "2026-10-02",
      dueTime: "09:00",
      owner: "fon",
      createdBy: "pong",
      source: "pong-voice",
    });
    await apply(backup(normalizeState({ tasks: [task], areaNotes: {} })));

    const { rows } = await db.query("select * from public.tasks");
    expect(rows[0]).toMatchObject({
      id: task.id,
      title: "Call A.B. re: rescheduling",
      notes: "Ref #2291",
      area: "work",
      status: "open",
      priority: "!!",
      owner: "fon",
      visibility: "private",
      created_by: "pong",
      source: "pong-voice",
    });
    expect(rows[0].due_date).toBeTruthy();
    expect(rows[0].due_time).toBeTruthy();
    expect(new Date(rows[0].created_at).toISOString()).toBe(task.createdAt);
  });

  it("carries a completed task's completion time across", async () => {
    const done = { ...createTask({ title: "Done", area: "home" }), status: "done", completedAt: "2026-09-01T10:00:00.000Z" };
    await apply(backup(normalizeState({ tasks: [done] })));

    const { rows } = await db.query("select status, completed_at from public.tasks");
    expect(rows[0].status).toBe("done");
    expect(new Date(rows[0].completed_at).toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("keeps the app's UUIDs rather than re-keying them", async () => {
    const state = createInitialState();
    await apply(backup(state));

    const { rows } = await db.query("select id from public.tasks");
    const ids = rows.map((r) => r.id);
    expect(ids.every(isUuid)).toBe(true);
    expect([...ids].sort()).toEqual([...state.tasks.map((t) => t.id)].sort());
  });

  it("maps an absent owner to null, not an empty string", async () => {
    await apply(backup(normalizeState({ tasks: [createTask({ title: "No owner", area: "home" })] })));
    const { rows } = await db.query("select owner from public.tasks");
    expect(rows[0].owner).toBeNull();
  });
});

describe("the import is idempotent", () => {
  it("applying the same export twice changes nothing", async () => {
    const exported = backup(createInitialState());

    await apply(exported);
    const first = await taskTitles();
    const { rows: batchesAfterFirst } = await db.query("select count(*)::int n from public.import_batches");

    await apply(exported);
    expect(await taskTitles()).toEqual(first);

    const { rows: batchesAfterSecond } = await db.query("select count(*)::int n from public.import_batches");
    expect(batchesAfterSecond[0].n).toBe(batchesAfterFirst[0].n);
    expect(batchesAfterSecond[0].n).toBe(1);
  });

  it("applying it ten times still yields one row per task", async () => {
    const state = createInitialState();
    const exported = backup(state);
    for (let i = 0; i < 10; i += 1) await apply(exported);

    const { rows } = await db.query("select count(*)::int n from public.tasks");
    expect(rows[0].n).toBe(state.tasks.length);
  });

  it("produces a stable checksum for an unchanged board", async () => {
    const state = createInitialState();
    expect(checksum(toRows(backup(state)))).toBe(checksum(toRows(backup(state))));
  });

  it("produces a different checksum once a task changes", async () => {
    const state = createInitialState();
    const changed = { ...state, tasks: [...state.tasks, createTask({ title: "New", area: "home" })] };
    expect(checksum(toRows(backup(changed)))).not.toBe(checksum(toRows(backup(state))));
  });
});

// Independent review found that FORCE row level security applies to the table
// owner too, so the documented "paste it into the SQL Editor" path only works
// for a role that can bypass RLS. These pin the behaviour in both directions.
describe("the import refuses to run as a role that cannot bypass RLS", () => {
  async function asRole(role, fn) {
    await db.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      // The failed statement aborts the transaction the script opened.
      await db.exec("rollback");
      await db.exec("reset role");
    }
  }

  beforeEach(async () => {
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'importer') then
          create role importer nologin;
        end if;
      end $$;
      grant usage on schema public to importer;
      grant all on public.tasks, public.area_notes, public.import_batches to importer;
    `);
  });

  it("stops at the preflight with a role-shaped message, not a data-shaped one", async () => {
    const sql = buildImportSql(backup(createInitialState()));

    const error = await asRole("importer", async () => {
      try {
        await db.exec(sql);
        return null;
      } catch (e) {
        return e;
      }
    });

    expect(error).not.toBeNull();
    expect(error.message).toMatch(/cannot bypass row level security/i);
    // The bare RLS error is what the preflight exists to replace.
    expect(error.message).not.toMatch(/violates row-level security policy/i);
  });

  it("writes nothing at all when it refuses", async () => {
    await asRole("importer", async () => {
      try { await db.exec(buildImportSql(backup(createInitialState()))); } catch { /* expected */ }
    });

    const { rows } = await db.query(`
      select (select count(*) from public.tasks)::int          as tasks,
             (select count(*) from public.import_batches)::int as batches
    `);
    expect(rows[0]).toEqual({ tasks: 0, batches: 0 });
  });

  it("still imports normally for a role that can bypass RLS", async () => {
    const state = createInitialState();
    await apply(backup(state));

    const { rows } = await db.query("select count(*)::int n from public.tasks");
    expect(rows[0].n).toBe(state.tasks.length);
  });

  // Regression: BYPASSRLS is a role ATTRIBUTE, not a privilege, so it is not
  // inherited through membership. An earlier preflight aggregated
  // pg_has_role(..., 'USAGE') over inherited roles and reported "can bypass"
  // for a role that demonstrably could not — passing the guard, then failing on
  // the first INSERT with the very error the guard exists to pre-empt.
  it("refuses a role that is a MEMBER of a BYPASSRLS role but lacks the attribute", async () => {
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'bypasser') then
          create role bypasser nologin bypassrls;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'member_only') then
          create role member_only nologin inherit;
        end if;
      end $$;
      grant bypasser to member_only;
      grant usage on schema public to member_only;
      grant all on public.tasks, public.area_notes, public.import_batches to member_only;
    `);

    // Precondition: membership is real, the attribute is not.
    const { rows: pre } = await db.query(`
      select (select rolbypassrls from pg_roles where rolname = 'member_only') as has_attribute,
             pg_has_role('member_only', 'bypasser', 'USAGE')                   as is_member
    `);
    expect(pre[0]).toEqual({ has_attribute: false, is_member: true });

    const error = await asRole("member_only", async () => {
      try {
        await db.exec(buildImportSql(backup(createInitialState())));
        return null;
      } catch (e) {
        return e;
      }
    });

    expect(error).not.toBeNull();
    expect(error.message).toMatch(/cannot bypass row level security/i);
    expect(error.message).not.toMatch(/violates row-level security policy/i);

    const { rows } = await db.query(`
      select (select count(*) from public.tasks)::int          as tasks,
             (select count(*) from public.import_batches)::int as batches
    `);
    expect(rows[0]).toEqual({ tasks: 0, batches: 0 });
  });

  it("reads the executing role's own attributes, not those of inherited roles", async () => {
    const sql = buildImportSql(backup(createInitialState()));
    expect(sql).toMatch(/rolname = current_user/);
    expect(sql).toMatch(/rolbypassrls or r\.rolsuper/);
    // The inherited-roles form is what produced the false positive.
    expect(sql).not.toMatch(/pg_has_role/);
  });

  it("accepts a superuser, which bypasses RLS without the explicit attribute", async () => {
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'super_importer') then
          create role super_importer nologin superuser;
        end if;
      end $$;
    `);
    await db.exec("set role super_importer");
    await expect(db.exec(buildImportSql(backup(createInitialState())))).resolves.not.toThrow();
    await db.exec("reset role");

    const { rows } = await db.query("select count(*)::int n from public.tasks");
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("carries the preflight in the generated script itself, not just the docs", async () => {
    const sql = buildImportSql(backup(createInitialState()));
    expect(sql).toMatch(/rolbypassrls/);
    expect(sql).toMatch(/insufficient_privilege/);
    // It must come before any write.
    expect(sql.indexOf("rolbypassrls")).toBeLessThan(sql.indexOf("insert into public."));
  });
});

describe("the import never destroys data", () => {
  it("updates a changed task in place instead of duplicating it", async () => {
    const task = createTask({ title: "Original title", area: "home" });
    await apply(backup(normalizeState({ tasks: [task] })));

    const edited = { ...task, title: "Edited title", updatedAt: "2030-01-01T00:00:00.000Z" };
    await apply(backup(normalizeState({ tasks: [edited] })));

    const { rows } = await db.query("select id, title from public.tasks");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: task.id, title: "Edited title" });
  });

  it("refuses to let an older export roll back a newer row", async () => {
    const task = createTask({ title: "Old title", area: "home" });
    const newer = { ...task, title: "Newer title", updatedAt: "2030-01-01T00:00:00.000Z" };

    await apply(backup(normalizeState({ tasks: [newer] })));
    await apply(backup(normalizeState({ tasks: [{ ...task, title: "Stale title", updatedAt: "2020-01-01T00:00:00.000Z" }] })));

    const { rows } = await db.query("select title from public.tasks");
    expect(rows[0].title).toBe("Newer title");
  });

  it("leaves tasks that are not in the file untouched", async () => {
    const kept = createTask({ title: "Already in the database", area: "faith" });
    await apply(backup(normalizeState({ tasks: [kept] })));

    await apply(backup(normalizeState({ tasks: [createTask({ title: "From a second device", area: "home" })] })));

    expect(await taskTitles()).toEqual(["Already in the database", "From a second device"]);
  });

  it("does not mutate the export object it was handed", async () => {
    const exported = backup(createInitialState());
    const snapshot = JSON.stringify(exported);

    buildImportSql(exported);
    toRows(exported);

    expect(JSON.stringify(exported)).toBe(snapshot);
  });

  it("emits no DELETE, TRUNCATE or DROP", async () => {
    const sql = buildImportSql(backup(createInitialState()));
    expect(sql).not.toMatch(/\b(delete|truncate|drop)\b/i);
  });
});

describe("the import cannot smuggle anything past the database", () => {
  it("re-applies the sharing invariant to a hand-edited backup", async () => {
    const tampered = { tasks: [{ id: createTask({ title: "x", area: "work" }).id, title: "Client note", area: "work", visibility: "shared" }] };
    await apply(tampered);

    const { rows } = await db.query("select visibility from public.tasks");
    expect(rows[0].visibility).toBe("private");
  });

  it("files a task from an unknown area into Inbox rather than failing or dropping it", async () => {
    await apply({ tasks: [{ title: "From a retired bucket", area: "man-k9" }] });

    const { rows } = await db.query("select area, title from public.tasks");
    expect(rows[0]).toMatchObject({ area: "inbox", title: "From a retired bucket" });
  });

  it("re-keys colliding ids so no task is lost", async () => {
    const shared = "3f1a6c2e-8b55-4a71-9d44-0c2e17ab9f10";
    await apply({ tasks: [
      { id: shared, title: "First", area: "home" },
      { id: shared, title: "Second", area: "home" },
    ] });

    expect(await taskTitles()).toEqual(["First", "Second"]);
  });

  it("escapes quotes rather than breaking out of the statement", async () => {
    await apply({ tasks: [{ title: "Buy Santiago's shoes'); drop table public.tasks; --", area: "home" }] });

    const { rows } = await db.query("select title from public.tasks");
    expect(rows[0].title).toBe("Buy Santiago's shoes'); drop table public.tasks; --");
  });
});

describe("area notes", () => {
  it("upserts rather than duplicating", async () => {
    await apply(backup(normalizeState({ areaNotes: { school: "First note" }, tasks: [] })));
    await apply(backup(normalizeState({ areaNotes: { school: "Second note" }, tasks: [] })));

    const { rows } = await db.query("select area, note from public.area_notes");
    expect(rows).toEqual([{ area: "school", note: "Second note" }]);
  });

  it("skips empty notes rather than writing blank rows", async () => {
    await apply(backup(normalizeState({ areaNotes: { school: "" }, tasks: [] })));
    const { rows } = await db.query("select count(*)::int n from public.area_notes");
    expect(rows[0].n).toBe(0);
  });
});
