import { useCallback, useRef, useState } from "react";

import { applyPatch, createTask, moveTask as moveTaskTo, toggleDone } from "./model.js";
import { importState, readState, writeState } from "./storage.js";

const MIGRATION_NOTICE =
  "Your tasks were moved from temporary session storage to permanent storage on this device. They will no longer disappear when you close the tab.";

/**
 * Owns the board.
 *
 * Storage is read once in a lazy initialiser — synchronously, so there is no
 * flash of empty state — and written as part of each mutation rather than in an
 * effect, because saving is a consequence of the user's action, not of
 * rendering. `stateRef` mirrors `state` so the updater stays pure.
 *
 * `phase` is the seam Phase 3 needs: when the board comes from Supabase instead
 * of localStorage, the initial value becomes "loading" and nothing else here or
 * in the UI has to change shape.
 */
export function useTaskStore() {
  // Lazy initialiser: readState() runs exactly once, before the first paint.
  const [boot] = useState(readState);

  const stateRef = useRef(boot.state);
  const [state, setState] = useState(boot.state);
  const [error, setError] = useState(boot.error);
  const [notice, setNotice] = useState(boot.migrated ? MIGRATION_NOTICE : null);

  const phase = state === null ? "loading" : "ready";

  const commit = useCallback((next) => {
    stateRef.current = next;
    setState(next);
    setError(writeState(next));
  }, []);

  const mutate = useCallback(
    (fn) => {
      const prev = stateRef.current;
      if (prev === null) return;
      commit(fn(prev));
    },
    [commit],
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

  const removeTask = useCallback(
    (id) => mutate((prev) => ({ ...prev, tasks: prev.tasks.filter((t) => t.id !== id) })),
    [mutate],
  );

  const setAreaNote = useCallback(
    (areaId, note) =>
      mutate((prev) => ({ ...prev, areaNotes: { ...prev.areaNotes, [areaId]: note } })),
    [mutate],
  );

  const restore = useCallback(
    (json) => {
      const result = importState(json);
      if (result.error) {
        setError(result.error);
        return false;
      }
      commit(result.state);
      setNotice(`Restored ${result.state.tasks.length} tasks from backup.`);
      return true;
    },
    [commit],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    state,
    phase,
    error,
    notice,
    dismissNotice,
    dismissError,
    addTask,
    updateTask,
    toggleTask,
    moveTask,
    removeTask,
    setAreaNote,
    restore,
  };
}
