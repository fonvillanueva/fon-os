import { beforeEach, describe, expect, it } from "vitest";

import { AREA_IDS } from "./areas.js";
import { isUuid } from "./model.js";
import {
  BACKUP_KEY,
  LEGACY_KEY,
  PRERESTORE_KEY,
  QUARANTINE_KEY,
  STORAGE_KEY,
  discardCorruptState,
  createInitialState,
  exportState,
  importState,
  migrateV1,
  normalizeState,
  peekState,
  readState,
  savePreRestoreBackup,
  writeState,
} from "./storage.js";

/** The exact shape the original sessionStorage build wrote. */
const LEGACY = {
  school: {
    status: "Grinding on UMPI 311 paper this week.",
    items: [
      { id: "s1", text: "Expand UMPI 311 draft", done: false, priority: "!!", dueDate: "2026-06-20" },
      { id: "s2", text: "Review lecture notes", done: true, priority: "!", dueDate: "" },
    ],
  },
  home: {
    status: "Nothing urgent.",
    items: [{ id: "h1", text: "Fix back porch light", done: false, priority: "—", dueDate: "" }],
  },
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("createInitialState", () => {
  it("seeds every area and carries the original tasks over", () => {
    const state = createInitialState();
    expect(Object.keys(state.areaNotes).sort()).toEqual([...AREA_IDS].sort());
    expect(state.tasks.length).toBeGreaterThan(0);
    expect(state.tasks.map((t) => t.title)).toContain("Fix back porch light");
  });

  it("starts Work and Inbox empty", () => {
    const state = createInitialState();
    expect(state.tasks.filter((t) => t.area === "work")).toHaveLength(0);
    expect(state.tasks.filter((t) => t.area === "inbox")).toHaveLength(0);
  });
});

describe("migrateV1", () => {
  it("flattens buckets into tasks and keeps the status notes", () => {
    const state = migrateV1(LEGACY);

    expect(state.tasks).toHaveLength(3);
    expect(state.areaNotes.school).toBe("Grinding on UMPI 311 paper this week.");
    expect(state.areaNotes.home).toBe("Nothing urgent.");
  });

  it("maps each task to the area it was filed under", () => {
    const byTitle = Object.fromEntries(migrateV1(LEGACY).tasks.map((t) => [t.title, t]));
    expect(byTitle["Expand UMPI 311 draft"].area).toBe("school");
    expect(byTitle["Fix back porch light"].area).toBe("home");
  });

  it("translates done into status and preserves due dates and priorities", () => {
    const byTitle = Object.fromEntries(migrateV1(LEGACY).tasks.map((t) => [t.title, t]));
    expect(byTitle["Review lecture notes"].status).toBe("done");
    expect(byTitle["Expand UMPI 311 draft"]).toMatchObject({ status: "open", priority: "!!", dueDate: "2026-06-20" });
  });

  it("returns null for junk rather than inventing a board", () => {
    expect(migrateV1(null)).toBeNull();
    expect(migrateV1({})).toBeNull();
    expect(migrateV1("nope")).toBeNull();
  });

  it("routes a task from a retired bucket into Inbox instead of losing it", () => {
    const state = migrateV1({ "man-k9": { status: "", items: [{ id: "x", text: "Old bucket task", done: false }] } });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({ title: "Old bucket task", area: "inbox" });
  });
});

describe("readState", () => {
  it("returns the seed on a completely fresh browser", () => {
    const { state, migrated, error } = readState();
    expect(error).toBeNull();
    expect(migrated).toBe(false);
    expect(state.tasks.length).toBeGreaterThan(0);
  });

  it("reads saved v2 state back", () => {
    const saved = normalizeState({ areaNotes: { work: "busy" }, tasks: [{ id: "a", title: "Call AB", area: "work" }] });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const { state, migrated } = readState();
    expect(migrated).toBe(false);
    expect(state.tasks).toHaveLength(1);
    expect(state.areaNotes.work).toBe("busy");
  });

  it("rescues data the sessionStorage build would have thrown away", () => {
    sessionStorage.setItem(LEGACY_KEY, JSON.stringify(LEGACY));

    const { state, migrated, error } = readState();
    expect(migrated).toBe(true);
    expect(error).toBeNull();
    expect(state.tasks).toHaveLength(3);
  });

  it("snapshots the pre-migration payload and leaves the legacy key untouched", () => {
    const raw = JSON.stringify(LEGACY);
    sessionStorage.setItem(LEGACY_KEY, raw);

    readState();

    expect(localStorage.getItem(BACKUP_KEY)).toBe(raw);
    expect(sessionStorage.getItem(LEGACY_KEY)).toBe(raw);
  });

  it("prefers saved v2 state over stale legacy data", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeState({ tasks: [{ id: "a", title: "Current", area: "work" }] })));
    sessionStorage.setItem(LEGACY_KEY, JSON.stringify(LEGACY));

    const { state, migrated } = readState();
    expect(migrated).toBe(false);
    expect(state.tasks).toHaveLength(1);
  });

  it("reports unreadable saved data as a corrupt status and leaves it in place", () => {
    localStorage.setItem(STORAGE_KEY, "{ this is not json");

    const result = readState();
    expect(result.status).toBe("corrupt");
    expect(result.error).toMatch(/could not be read/i);
    expect(result.corruptRaw).toBe("{ this is not json");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("{ this is not json");
  });
});

describe("writeState", () => {
  it("round-trips through storage", () => {
    const state = normalizeState({ tasks: [{ id: "a", title: "Air filters", area: "home" }] });
    expect(writeState(state)).toBeNull();
    expect(readState().state.tasks[0].title).toBe("Air filters");
  });

  it("records when it was saved", () => {
    writeState(createInitialState());
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).savedAt).toBeTruthy();
  });
});

describe("normalizeState", () => {
  // H2 regression: colliding ids used to be collapsed, silently losing a task.
  it("re-keys duplicate ids instead of dropping the task", () => {
    const shared = "3f1a6c2e-8b55-4a71-9d44-0c2e17ab9f10";
    const state = normalizeState({
      tasks: [
        { id: shared, title: "first", area: "home" },
        { id: shared, title: "second", area: "home" },
      ],
    });

    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.map((t) => t.title)).toEqual(["first", "second"]);
    expect(state.tasks[0].id).not.toBe(state.tasks[1].id);
    expect(state.tasks.every((t) => isUuid(t.id))).toBe(true);
  });

  it("keeps every task when many ids collide", () => {
    const shared = "3f1a6c2e-8b55-4a71-9d44-0c2e17ab9f10";
    const state = normalizeState({
      tasks: Array.from({ length: 25 }, (_, i) => ({ id: shared, title: `t${i}`, area: "home" })),
    });

    expect(state.tasks).toHaveLength(25);
    expect(new Set(state.tasks.map((t) => t.id)).size).toBe(25);
  });

  it("fills in every area note and survives junk input", () => {
    expect(Object.keys(normalizeState(null).areaNotes).sort()).toEqual([...AREA_IDS].sort());
    expect(normalizeState({ tasks: "not an array" }).tasks).toEqual([]);
  });
});

describe("export and import", () => {
  it("round-trips a board without losing anything", () => {
    const original = normalizeState({
      areaNotes: { school: "note" },
      tasks: [{ id: "a", title: "Read chapter", area: "school", priority: "!!", dueDate: "2026-05-05" }],
    });

    const { state, error } = importState(exportState(original));
    expect(error).toBeNull();
    expect(state.tasks).toEqual(original.tasks);
    expect(state.areaNotes).toEqual(original.areaNotes);
  });

  it("rejects a file that is not a backup", () => {
    expect(importState("not json").error).toMatch(/not valid JSON/i);
    expect(importState('{"hello":"world"}').error).toMatch(/not a Fon's OS backup/i);
  });

  it("re-applies the sharing invariant to an edited backup file", () => {
    const tampered = JSON.stringify({ tasks: [{ id: "a", title: "Client note", area: "work", visibility: "shared" }] });
    expect(importState(tampered).state.tasks[0].visibility).toBe("private");
  });
});

// ─── H1 ───────────────────────────────────────────────────────────────────────

describe("unreadable saved data (H1)", () => {
  const CORRUPT = '{"tasks":[{"id":"a","title":"Real task"';

  it("does not overwrite the stored bytes just by reading", () => {
    localStorage.setItem(STORAGE_KEY, CORRUPT);
    readState();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(CORRUPT);
  });

  it("hands back the raw payload so it can be rescued", () => {
    localStorage.setItem(STORAGE_KEY, CORRUPT);
    expect(readState().corruptRaw).toBe(CORRUPT);
  });

  it("quarantines rather than deletes when the user discards it", () => {
    localStorage.setItem(STORAGE_KEY, CORRUPT);
    const fresh = discardCorruptState(CORRUPT);

    const quarantined = Object.keys(localStorage).filter((k) => k.startsWith(QUARANTINE_KEY));
    expect(quarantined).toHaveLength(1);
    expect(localStorage.getItem(quarantined[0])).toBe(CORRUPT);

    expect(fresh.tasks.length).toBeGreaterThan(0);
    expect(readState().status).toBe("ok");
  });
});

// ─── M1 ───────────────────────────────────────────────────────────────────────

describe("multiple tabs and coexisting legacy data (M1)", () => {
  it("snapshots the legacy board even when v2 already exists", () => {
    const raw = JSON.stringify(LEGACY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createInitialState()));
    sessionStorage.setItem(LEGACY_KEY, raw);

    const result = readState();

    expect(result.status).toBe("ok");
    expect(result.legacyCoexists).toBe(true);
    expect(localStorage.getItem(BACKUP_KEY)).toBe(raw);
    expect(sessionStorage.getItem(LEGACY_KEY)).toBe(raw);
  });

  it("does not clobber a snapshot taken by the tab that migrated first", () => {
    localStorage.setItem(BACKUP_KEY, "first tab snapshot");
    sessionStorage.setItem(LEGACY_KEY, JSON.stringify(LEGACY));

    readState();

    expect(localStorage.getItem(BACKUP_KEY)).toBe("first tab snapshot");
  });

  it("reports no coexistence when there is no legacy data", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createInitialState()));
    expect(readState().legacyCoexists).toBe(false);
  });

  it("peekState re-reads what another tab wrote", () => {
    writeState(normalizeState({ tasks: [{ title: "Written by tab A", area: "home" }] }));
    expect(peekState().tasks[0].title).toBe("Written by tab A");
  });

  it("peekState returns null when nothing is saved or the save is unreadable", () => {
    expect(peekState()).toBeNull();
    localStorage.setItem(STORAGE_KEY, "{ broken");
    expect(peekState()).toBeNull();
  });
});

// ─── M3 ───────────────────────────────────────────────────────────────────────

describe("pre-restore backup (M3)", () => {
  it("saves the outgoing board so a restore can be reversed", () => {
    const outgoing = normalizeState({ tasks: [{ title: "About to be replaced", area: "home" }] });
    expect(savePreRestoreBackup(outgoing)).toBe(true);

    const saved = JSON.parse(localStorage.getItem(PRERESTORE_KEY));
    expect(saved.tasks[0].title).toBe("About to be replaced");
  });
});

// ─── M5 ───────────────────────────────────────────────────────────────────────

describe("UUID task ids (M5)", () => {
  it("ships a seed board whose ids are already valid UUIDs", () => {
    const state = createInitialState();
    expect(state.tasks).not.toHaveLength(0);
    expect(state.tasks.every((t) => isUuid(t.id))).toBe(true);
  });

  it("re-keys legacy string ids during migration", () => {
    const state = migrateV1(LEGACY);
    expect(state.tasks.every((t) => isUuid(t.id))).toBe(true);
    expect(state.tasks.map((t) => t.id)).not.toContain("s1");
  });

  it("re-keys non-UUID ids arriving in a backup file", () => {
    const { state } = importState(JSON.stringify({ tasks: [{ id: "not-a-uuid", title: "x", area: "home" }] }));
    expect(isUuid(state.tasks[0].id)).toBe(true);
  });

  it("keeps ids stable across a save and reload", () => {
    const first = createInitialState();
    writeState(first);
    expect(readState().state.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
  });
});
