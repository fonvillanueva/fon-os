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
