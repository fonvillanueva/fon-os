import { useCallback, useEffect, useRef, useState } from "react";

import { applyPatch, createTask, moveTask as moveTaskTo, toggleDone } from "./model.js";
import {
  STORAGE_KEY,
  discardCorruptState,
  importState,
  peekState,
  readState,
  savePreRestoreBackup,
  writeState,
} from "./storage.js";

const MIGRATION_NOTICE =
  "Your tasks were moved from temporary session storage to permanent storage on this device. They will no longer disappear when you close the tab.";

const COEXIST_NOTICE =
  "An older session-storage board was also found on this device. It has not been merged, and a copy is saved under fon_os_backup_v1.";

/**
 * Owns the board.
 *
 * Storage is read once in a lazy initialiser — synchronously, so there is no
 * flash of empty state — and written as part of each mutation rather than in an
 * effect, because saving is a consequence of the user's action, not of
 * rendering. `stateRef` mirrors `state` so the updater stays pure.
 *
 * Two safety properties are enforced here rather than in the UI:
 *
 *  - When the saved board is unreadable, `readOnly` is set and every mutation
 *    is refused. The bytes on disk survive until the user discards them.
 *  - A write by another tab arrives as a `storage` event and is adopted, so two
 *    open tabs cannot overwrite each other from stale in-memory state.
 */
export function useTaskStore() {
  const [boot] = useState(readState);

  const stateRef = useRef(boot.state);
  const [state, setState] = useState(boot.state);
  const [error, setError] = useState(boot.error);
  const [readOnly, setReadOnly] = useState(boot.status === "corrupt");
  const [undo, setUndo] = useState(null);
  const [notice, setNotice] = useState(() => {
    if (boot.migrated) return MIGRATION_NOTICE;
    if (boot.legacyCoexists) return COEXIST_NOTICE;
    return null;
  });

  const phase = state === null ? "loading" : "ready";

  const commit = useCallback((next) => {
    stateRef.current = next;
    setState(next);
    setError(writeState(next));
  }, []);

  // Adopt writes made by another tab instead of clobbering them on the next edit.
  useEffect(() => {
    if (readOnly) return undefined;

    function onStorage(event) {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const incoming = peekState();
      if (!incoming) return;
      stateRef.current = incoming;
      setState(incoming);
    }

    globalThis.addEventListener?.("storage", onStorage);
    return () => globalThis.removeEventListener?.("storage", onStorage);
  }, [readOnly]);

  const mutate = useCallback(
    (fn) => {
      if (readOnly) {
        setError("The board is read-only until you decide what to do with the unreadable saved data.");
        return;
      }
      const prev = stateRef.current;
      if (prev === null) return;
      commit(fn(prev));
    },
    [commit, readOnly],
  );

  const mapTask = useCallback(
    (id, fn) =>
      mutate((prev) => ({ ...prev, tasks: prev.tasks.map((t) => (t.id === id ? fn(t) : t)) })),
    [mutate],
  );

  const addTask = useCallback(
    (input) => mutate((prev) => ({ ...prev, tasks: [...prev.tasks, createTask(input)] })),
    [mutate],
  );

  const updateTask = useCallback((id, patch) => mapTask(id, (t) => applyPatch(t, patch)), [mapTask]);
  const toggleTask = useCallback((id) => mapTask(id, toggleDone), [mapTask]);
  const moveTask = useCallback((id, areaId) => mapTask(id, (t) => moveTaskTo(t, areaId)), [mapTask]);

  /** Deletes are reversible: the row and its position are held for undo. */
  const removeTask = useCallback(
    (id) => {
      const prev = stateRef.current;
      if (readOnly || prev === null) {
        if (readOnly) setError("The board is read-only until you decide what to do with the unreadable saved data.");
        return;
      }
      const index = prev.tasks.findIndex((t) => t.id === id);
      if (index === -1) return;
      setUndo({ task: prev.tasks[index], index });
      commit({ ...prev, tasks: prev.tasks.filter((t) => t.id !== id) });
    },
    [commit, readOnly],
  );

  const undoRemove = useCallback(() => {
    const prev = stateRef.current;
    if (!undo || prev === null) return;
    const tasks = [...prev.tasks];
    tasks.splice(Math.min(undo.index, tasks.length), 0, undo.task);
    commit({ ...prev, tasks });
    setUndo(null);
  }, [commit, undo]);

  const dismissUndo = useCallback(() => setUndo(null), []);

  const setAreaNote = useCallback(
    (areaId, note) =>
      mutate((prev) => ({ ...prev, areaNotes: { ...prev.areaNotes, [areaId]: note } })),
    [mutate],
  );

  /** Parses and validates a backup without applying it, for the confirm step. */
  const prepareRestore = useCallback((json) => {
    const result = importState(json);
    if (result.error) {
      setError(result.error);
      return null;
    }
    return result.state;
  }, []);

  /** Applies a prepared restore, saving the outgoing board first. */
  const confirmRestore = useCallback(
    (next) => {
      if (readOnly || !next) return false;
      const outgoing = stateRef.current;
      const backedUp = outgoing ? savePreRestoreBackup(outgoing) : false;
      commit(next);
      setUndo(null);
      setNotice(
        backedUp
          ? `Restored ${next.tasks.length} tasks. The board you replaced was saved to fon_os_prerestore_backup.`
          : `Restored ${next.tasks.length} tasks. The previous board could not be backed up first.`,
      );
      return true;
    },
    [commit, readOnly],
  );

  /** Moves unreadable data to a quarantine key and starts from the seed. */
  const discardCorrupt = useCallback(() => {
    const fresh = discardCorruptState(boot.corruptRaw);
    stateRef.current = fresh;
    setState(fresh);
    setReadOnly(false);
    setError(null);
    setNotice("The unreadable board was set aside and a fresh board was started.");
  }, [boot.corruptRaw]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    state,
    phase,
    error,
    notice,
    readOnly,
    corruptRaw: boot.corruptRaw,
    undo,
    dismissNotice,
    dismissError,
    addTask,
    updateTask,
    toggleTask,
    moveTask,
    removeTask,
    undoRemove,
    dismissUndo,
    setAreaNote,
    prepareRestore,
    confirmRestore,
    discardCorrupt,
  };
}
