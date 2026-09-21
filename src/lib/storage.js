// ─── STORAGE ──────────────────────────────────────────────────────────────────
//
// State lives in localStorage under a versioned envelope. Two things matter
// here beyond "save the board":
//
//  1. The original app used *sessionStorage*, which threw every task away when
//     the tab closed. `readState` migrates that data across on first run and
//     leaves the legacy key untouched, so the old build still works if we roll
//     back.
//  2. Tasks are stored as one flat array rather than nested under each area.
//     That is the shape the Supabase `tasks` table will use, so Phase 3 is a
//     copy rather than a reshape.

import { AREA_IDS } from "./areas.js";
import { normalizeTask } from "./model.js";
import { SEED_AREA_NOTES, SEED_TASKS } from "./seed.js";

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = "fon_os_v2";
export const LEGACY_KEY = "fon_dashboard";
export const BACKUP_KEY = "fon_os_backup_v1";

function safeStorage(kind) {
  try {
    const store = globalThis[kind];
    if (!store) return null;
    // Safari in private mode exposes the API but throws on write.
    const probe = "__fon_os_probe__";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

function emptyAreaNotes() {
  return Object.fromEntries(AREA_IDS.map((id) => [id, ""]));
}

export function createInitialState() {
  return normalizeState({
    version: SCHEMA_VERSION,
    areaNotes: SEED_AREA_NOTES,
    tasks: SEED_TASKS,
  });
}

/** Coerces any parsed payload into a valid, complete state object. */
export function normalizeState(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const notes = { ...emptyAreaNotes() };

  if (input.areaNotes && typeof input.areaNotes === "object") {
    for (const id of AREA_IDS) {
      if (typeof input.areaNotes[id] === "string") notes[id] = input.areaNotes[id];
    }
  }

  const tasks = Array.isArray(input.tasks) ? input.tasks.map((t) => normalizeTask(t)) : [];

  // Duplicate ids would make edits ambiguous; last write wins.
  const byId = new Map(tasks.map((t) => [t.id, t]));

  return { version: SCHEMA_VERSION, areaNotes: notes, tasks: [...byId.values()] };
}

/**
 * Converts the original `{ bucket: { status, items[] } }` shape into v2.
 * Exported so the migration is unit-testable on its own.
 */
export function migrateV1(legacy) {
  if (!legacy || typeof legacy !== "object") return null;

  const areaNotes = {};
  const tasks = [];

  for (const [areaId, bucket] of Object.entries(legacy)) {
    if (!bucket || typeof bucket !== "object") continue;
    if (typeof bucket.status === "string") areaNotes[areaId] = bucket.status;
    if (!Array.isArray(bucket.items)) continue;
    for (const item of bucket.items) {
      // `area` comes from the bucket key; unknown keys fall through to Inbox.
      tasks.push({ ...item, area: areaId });
    }
  }

  if (!tasks.length && !Object.keys(areaNotes).length) return null;
  return normalizeState({ areaNotes, tasks });
}

/**
 * Loads state, migrating older storage forward. Never throws — a corrupt or
 * unavailable store degrades to the seed with an `error` explaining why.
 */
export function readState() {
  const local = safeStorage("localStorage");

  if (local) {
    try {
      const raw = local.getItem(STORAGE_KEY);
      if (raw) return { state: normalizeState(JSON.parse(raw)), migrated: false, error: null };
    } catch {
      return {
        state: createInitialState(),
        migrated: false,
        error: "Saved data could not be read and was not overwritten. Export a backup before making changes.",
      };
    }
  }

  // First run on this browser: rescue anything the sessionStorage build left.
  const session = safeStorage("sessionStorage");
  if (session) {
    try {
      const raw = session.getItem(LEGACY_KEY);
      if (raw) {
        const migrated = migrateV1(JSON.parse(raw));
        if (migrated) {
          // Keep an untouched copy of the pre-migration payload.
          if (local && !local.getItem(BACKUP_KEY)) local.setItem(BACKUP_KEY, raw);
          return { state: migrated, migrated: true, error: null };
        }
      }
    } catch {
      // Legacy data was unreadable; fall through to the seed.
    }
  }

  if (!local) {
    return {
      state: createInitialState(),
      migrated: false,
      error: "This browser is blocking local storage, so changes will not be saved.",
    };
  }

  return { state: createInitialState(), migrated: false, error: null };
}

/** @returns {string|null} an error message, or null on success. */
export function writeState(state) {
  const local = safeStorage("localStorage");
  if (!local) return "This browser is blocking local storage, so changes will not be saved.";
  try {
    local.setItem(STORAGE_KEY, JSON.stringify({ ...state, savedAt: new Date().toISOString() }));
    return null;
  } catch {
    return "Changes could not be saved — local storage is full or unavailable.";
  }
}

// ─── BACKUP / RESTORE ─────────────────────────────────────────────────────────

export function exportState(state) {
  return JSON.stringify(
    { app: "fon-os", version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...state },
    null,
    2,
  );
}

/** @returns {{ state: object, error: null } | { state: null, error: string }} */
export function importState(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { state: null, error: "That file is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    return { state: null, error: "That file is not a Fon's OS backup." };
  }
  return { state: normalizeState(parsed), error: null };
}
