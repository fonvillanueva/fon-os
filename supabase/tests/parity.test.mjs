// Guards against the database and the app drifting apart. Every list in the
// migrations is mirrored from src/lib, so if someone adds an area to the app
// and forgets the migration — or vice versa — these fail.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshDb } from "./harness.mjs";
import { AREAS, AREA_IDS, ABIGAIL_AREAS } from "../../src/lib/areas.js";
import { ACTORS, PRIORITIES, SOURCES, STATUSES, VISIBILITIES, createTask } from "../../src/lib/model.js";

let db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });

/** The literal values a CHECK constraint accepts, read back from the catalog. */
async function checkValues(table, constraint) {
  const { rows } = await db.query(
    `select pg_get_constraintdef(oid) as def
       from pg_constraint
      where conname = $1 and conrelid = $2::regclass`,
    [constraint, `public.${table}`],
  );
  expect(rows, `constraint ${constraint} should exist`).toHaveLength(1);
  return [...rows[0].def.matchAll(/'((?:[^']|'')*)'/g)]
    .map((m) => m[1].replace(/''/g, "'"))
    .sort();
}

describe("the database vocabulary matches the app", () => {
  it.each([
    ["tasks", "tasks_area_valid", () => AREA_IDS],
    ["tasks", "tasks_status_valid", () => STATUSES],
    ["tasks", "tasks_priority_valid", () => PRIORITIES],
    ["tasks", "tasks_visibility_valid", () => VISIBILITIES],
    ["tasks", "tasks_created_by_valid", () => ACTORS],
    ["tasks", "tasks_source_valid", () => SOURCES],
    ["area_notes", "area_notes_area_valid", () => AREA_IDS],
  ])("%s.%s accepts exactly what the app can produce", async (table, constraint, expected) => {
    expect(await checkValues(table, constraint)).toEqual([...expected()].sort());
  });

  it("the shared-area constraint names exactly the areas Abigail can reach", async () => {
    const values = await checkValues("tasks", "tasks_shared_only_in_shared_areas");
    const areas = values.filter((v) => AREA_IDS.includes(v));
    expect(areas).toEqual([...ABIGAIL_AREAS].sort());

    // And those are precisely the areas the app marks shareable.
    expect(areas).toEqual(AREAS.filter((a) => a.shareable).map((a) => a.id).sort());
  });
});

describe("every task field has a home in the database", () => {
  const COLUMN_FOR = {
    id: "id", title: "title", notes: "notes", area: "area", status: "status",
    priority: "priority", dueDate: "due_date", dueTime: "due_time", owner: "owner",
    visibility: "visibility", createdBy: "created_by", source: "source",
    createdAt: "created_at", updatedAt: "updated_at", completedAt: "completed_at",
  };

  it("maps all fifteen model fields onto columns, losing none", async () => {
    const { rows } = await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='tasks'",
    );
    const columns = new Set(rows.map((r) => r.column_name));
    const fields = Object.keys(createTask({ title: "x", area: "home" }));

    expect(fields.sort()).toEqual(Object.keys(COLUMN_FOR).sort());
    for (const field of fields) {
      expect(columns.has(COLUMN_FOR[field]), `no column for model field "${field}"`).toBe(true);
    }
  });

  it("stores ids as uuid, so the app's generated ids insert unchanged", async () => {
    const { rows } = await db.query(
      "select data_type from information_schema.columns where table_name='tasks' and column_name='id'",
    );
    expect(rows[0].data_type).toBe("uuid");
  });

  it("requires the columns the app always supplies, and allows null only where the app allows empty", async () => {
    const { rows } = await db.query(
      "select column_name, is_nullable from information_schema.columns where table_schema='public' and table_name='tasks'",
    );
    const nullable = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable === "YES"]));

    for (const required of ["id", "title", "notes", "area", "status", "priority", "visibility", "created_by", "source", "created_at", "updated_at"]) {
      expect(nullable[required], `${required} should be NOT NULL`).toBe(false);
    }
    for (const optional of ["due_date", "due_time", "owner", "completed_at", "import_key"]) {
      expect(nullable[optional], `${optional} should be nullable`).toBe(true);
    }
  });
});

describe("roles prepared for Phase 4", () => {
  it("profiles covers the three human roles and excludes Pong", async () => {
    const roles = await checkValues("profiles", "profiles_role_valid");
    expect(roles).toEqual(["abigail", "accountability", "fon"]);
    expect(roles).not.toContain("pong");
  });

  it("Pong exists only as an attribution value, never as an account", async () => {
    expect(ACTORS).toContain("pong");
    expect(await checkValues("tasks", "tasks_created_by_valid")).toContain("pong");
  });
});
