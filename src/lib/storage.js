// ─── STORAGE ──────────────────────────────────────────────────────────────────
//
// State lives in localStorage under a versioned envelope. Beyond "save the
// board", four things matter here:
//
//  1. The original app used *sessionStorage*, which threw every task away when
//     the tab closed. `readState` migrates that data across and leaves the
//     legacy key untouched, so the old build still works if we roll back.
//  2. Unreadable saved data puts the app into a read-only safety state. It is
//     never overwritten, not even by the first edit, until the user explicitly
//     discards it.
//  3. Tasks are stored as one flat array of UUID-keyed rows — the shape the
//     Supabase `tasks` table will use, so Phase 3 is a copy, not a reshape.
//  4. Colliding ids are re-keyed, never dropped. Losing a task silently is
//     worse than showing two tasks that share a title.

import { AREA_IDS } from "./areas.js";
import { normalizeTask, uid } from "./model.js";
import { SEED_AREA_NOTES, SEED_TASKS } from "./seed.js";

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = "fon_os_v2";
export const LEGACY_KEY = "fon_dashboard";
export const BACKUP_KEY = "fon_os_backup_v1";
export const PRERESTORE_KEY = "fon_os_prerestore_backup";
export const QUARANTINE_KEY = "fon_os_unreadable_v2";

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

/**
 * Coerces any parsed payload into a valid, complete state object.
 *
 * Duplicate ids are re-keyed rather than collapsed: two legacy buckets could
 * each contain an item called `s1`, and dropping one would silently lose a
 * real task.
 */
export function normalizeState(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const notes = { ...emptyAreaNotes() };

  if (input.areaNotes && typeof input.areaNotes === "object") {
    for (const id of AREA_IDS) {
      if (typeof input.areaNotes[id] === "string") notes[id] = input.areaNotes[id];
    }
  }

  const seen = new Set();
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map((raw) => {
    const task = normalizeTask(raw);
    if (seen.has(task.id)) {
      let fresh = uid();
      while (seen.has(fresh)) fresh = uid();
      task.id = fresh;
    }
    seen.add(task.id);
    return task;
  });

  return { version: SCHEMA_VERSION, areaNotes: notes, tasks };
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

/** Snapshots the legacy payload once, whenever one exists. */
function snapshotLegacy(local, raw) {
  if (!local || !raw) return;
  try {
    if (!local.getItem(BACKUP_KEY)) local.setItem(BACKUP_KEY, raw);
  } catch {
    // A full or blocked store must not break loading the board.
  }
}

/**
 * Loads state, migrating older storage forward. Never throws.
 *
 * @returns {{
 *   state: object,
 *   status: "ok" | "corrupt" | "unavailable",
 *   migrated: boolean,
 *   legacyCoexists: boolean,
 *   corruptRaw: string | null,
 *   error: string | null,
 * }}
 */
export function readState() {
  const local = safeStorage("localStorage");
  const session = safeStorage("sessionStorage");

  let legacyRaw = null;
  if (session) {
    try {
      legacyRaw = session.getItem(LEGACY_KEY);
    } catch {
      legacyRaw = null;
    }
  }

  const base = { migrated: false, legacyCoexists: false, corruptRaw: null, error: null };

  if (local) {
    let saved;
    try {
      saved = local.getItem(STORAGE_KEY);
    } catch {
      saved = null;
    }

    if (saved) {
      // Back the legacy board up even though we are not migrating it, so a
      // second tab that already migrated cannot leave it unreferenced.
      snapshotLegacy(local, legacyRaw);

      try {
        return {
          ...base,
          state: normalizeState(JSON.parse(saved)),
          status: "ok",
          legacyCoexists: Boolean(legacyRaw),
        };
      } catch {
        return {
          ...base,
          state: createInitialState(),
          status: "corrupt",
          corruptRaw: saved,
          error:
            "Your saved board could not be read. It has not been changed. Download a copy of the raw data, then choose whether to discard it and start fresh.",
        };
      }
    }
  }

  // First run on this browser: rescue anything the sessionStorage build left.
  if (legacyRaw) {
    try {
      const migrated = migrateV1(JSON.parse(legacyRaw));
      if (migrated) {
        snapshotLegacy(local, legacyRaw);
        return { ...base, state: migrated, status: local ? "ok" : "unavailable", migrated: true };
      }
    } catch {
      // Legacy data was unreadable; fall through to the seed.
    }
  }

  if (!local) {
    return {
      ...base,
      state: createInitialState(),
      status: "unavailable",
      error: "This browser is blocking local storage, so changes will not be saved.",
    };
  }

  return { ...base, state: createInitialState(), status: "ok" };
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

/** Re-reads the saved board, for reconciling a write made by another tab. */
export function peekState() {
  const local = safeStorage("localStorage");
  if (!local) return null;
  try {
    const saved = local.getItem(STORAGE_KEY);
    return saved ? normalizeState(JSON.parse(saved)) : null;
  } catch {
    return null;
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

/** Saves the board about to be replaced, so a restore is itself undoable. */
export function savePreRestoreBackup(state) {
  const local = safeStorage("localStorage");
  if (!local) return false;
  try {
    local.setItem(PRERESTORE_KEY, exportState(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves unreadable saved data aside and starts fresh. The original bytes are
 * kept under a timestamped quarantine key rather than deleted.
 */
export function discardCorruptState(corruptRaw) {
  const local = safeStorage("localStorage");
  if (!local) return createInitialState();
  try {
    if (corruptRaw) {
      local.setItem(`${QUARANTINE_KEY}_${new Date().toISOString().replace(/[:.]/g, "-")}`, corruptRaw);
    }
    local.removeItem(STORAGE_KEY);
  } catch {
    // Quarantining is best effort; starting fresh must still work.
  }
  const fresh = createInitialState();
  writeState(fresh);
  return fresh;
}
