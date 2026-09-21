import { beforeEach, describe, expect, it } from "vitest";

import { AREA_IDS } from "./areas.js";
import {
  BACKUP_KEY,
  LEGACY_KEY,
  STORAGE_KEY,
  createInitialState,
  exportState,
  importState,
  migrateV1,
  normalizeState,
  readState,
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

  it("reports an error and refuses to overwrite unreadable saved data", () => {
    localStorage.setItem(STORAGE_KEY, "{ this is not json");

    const { error } = readState();
    expect(error).toMatch(/could not be read/i);
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
  it("collapses duplicate ids so edits stay unambiguous", () => {
    const state = normalizeState({
      tasks: [
        { id: "dup", title: "first", area: "home" },
        { id: "dup", title: "second", area: "home" },
      ],
    });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].title).toBe("second");
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
