import { useId, useMemo, useRef, useState } from "react";

import { AREAS, ACCOUNTABILITY_AREA, getArea, isShareable } from "./lib/areas.js";
import {
  PRIORITIES,
  byUrgency,
  formatDue,
  isOverdue,
  pct,
  tasksInArea,
} from "./lib/model.js";
import { exportState } from "./lib/storage.js";
import { useTaskStore } from "./lib/useTaskStore.js";

// ─── SHARED STYLES ────────────────────────────────────────────────────────────
//
// Focus rings are explicit because every field sets `outline-none`; without
// them the whole app is unusable by keyboard.

const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-900";
const FIELD = `bg-zinc-800 text-zinc-100 text-xs px-2 py-1.5 rounded border border-zinc-600 placeholder-zinc-600 ${FOCUS}`;
const FIELD_INNER = `bg-zinc-700 text-zinc-100 text-xs px-2 py-1.5 rounded border border-zinc-600 placeholder-zinc-500 ${FOCUS}`;

const SOURCE_LABELS = {
  "pong-voice": "Pong",
  "claude-import": "Claude",
  abigail: "Abigail",
};

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────

function ProgressBar({ value, barClass }) {
  return (
    <div
      className="h-1 bg-zinc-800 rounded-full overflow-hidden"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`h-full ${barClass} transition-all duration-500`} style={{ width: `${value}%` }} />
    </div>
  );
}

function PriorityBadge({ priority }) {
  if (priority === "!!") {
    return <span className="text-red-400 text-xs font-bold w-4 flex-shrink-0" title="High priority">!!</span>;
  }
  if (priority === "!") {
    return <span className="text-amber-400 text-xs font-bold w-4 flex-shrink-0" title="Priority">!</span>;
  }
  return <span className="w-4 flex-shrink-0" />;
}

function Chip({ className, children }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide ${className}`}>{children}</span>;
}

// ─── TASK ROW ─────────────────────────────────────────────────────────────────

function TaskRow({ task, area, now, onToggle, onDelete, onEdit, onMove }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [dueDate, setDueDate] = useState(task.dueDate);
  const [dueTime, setDueTime] = useState(task.dueTime);
  const [priority, setPriority] = useState(task.priority);
  const [visibility, setVisibility] = useState(task.visibility);
  const fieldId = useId();

  const overdue = isOverdue(task, now);
  const done = task.status === "done";
  const due = formatDue(task);
  const sourceLabel = SOURCE_LABELS[task.source];

  function startEditing() {
    setTitle(task.title);
    setNotes(task.notes);
    setDueDate(task.dueDate);
    setDueTime(task.dueTime);
    setPriority(task.priority);
    setVisibility(task.visibility);
    setEditing(true);
  }

  function commit() {
    onEdit({ title: title.trim() || task.title, notes, dueDate, dueTime, priority, visibility });
    setEditing(false);
  }

  function onFormKeyDown(event) {
    if (event.key === "Escape") setEditing(false);
  }

  if (editing) {
    return (
      <div className="bg-zinc-800 rounded-lg p-3 space-y-2" onKeyDown={onFormKeyDown}>
        <label className="sr-only" htmlFor={`${fieldId}-title`}>Task</label>
        <input
          autoFocus
          id={`${fieldId}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          className={`w-full ${FIELD_INNER}`}
        />

        <label className="sr-only" htmlFor={`${fieldId}-notes`}>Notes</label>
        <textarea
          id={`${fieldId}-notes`}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)…"
          className={`w-full resize-y ${FIELD_INNER}`}
        />

        <div className="flex gap-2 items-center flex-wrap">
          <label className="sr-only" htmlFor={`${fieldId}-priority`}>Priority</label>
          <select
            id={`${fieldId}-priority`}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={FIELD_INNER}
          >
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>

          <label className="sr-only" htmlFor={`${fieldId}-date`}>Due date</label>
          <input
            id={`${fieldId}-date`}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={FIELD_INNER}
          />

          {dueDate && (
            <>
              <label className="sr-only" htmlFor={`${fieldId}-time`}>Due time</label>
              <input
                id={`${fieldId}-time`}
                type="time"
                value={dueTime}
                onChange={(e) => setDueTime(e.target.value)}
                className={FIELD_INNER}
              />
            </>
          )}

          {isShareable(task.area) && (
            <>
              <label className="sr-only" htmlFor={`${fieldId}-visibility`}>Sharing</label>
              <select
                id={`${fieldId}-visibility`}
                value={visibility}
                onChange={(e) => setVisibility(e.target.value)}
                className={FIELD_INNER}
              >
                <option value="shared">Shared</option>
                <option value="private">Private</option>
              </select>
            </>
          )}
        </div>

        <div className="flex gap-2 items-center">
          <button type="button" onClick={commit} className={`text-xs px-3 py-1 rounded ${area.color.tag} ${FOCUS}`}>
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className={`text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded ${FOCUS}`}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`group flex items-start gap-2 py-1 rounded px-1 transition-colors ${overdue ? "bg-red-950/30" : "hover:bg-zinc-800/50"}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={done}
        aria-label={done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" complete`}
        className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border transition-all ${FOCUS} ${
          done ? `${area.color.bar} border-transparent` : "border-zinc-600 hover:border-zinc-400"
        }`}
      >
        {done && (
          <svg viewBox="0 0 10 10" className="w-full h-full p-0.5 text-zinc-950" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M1.5 5l2.5 2.5 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <PriorityBadge priority={task.priority} />

      <button
        type="button"
        onClick={startEditing}
        aria-label={`Edit "${task.title}"`}
        className={`flex-1 min-w-0 text-left text-xs leading-relaxed rounded ${FOCUS} ${
          done ? "line-through text-zinc-600" : overdue ? "text-red-300" : "text-zinc-300 hover:text-zinc-100"
        }`}
      >
        <span className="break-words">{task.title}</span>

        {due && (
          <span className={`ml-2 whitespace-nowrap ${overdue ? "text-red-400 font-bold" : "text-zinc-500"}`}>
            {overdue ? "OVERDUE · " : ""}{due}
          </span>
        )}

        <span className="inline-flex flex-wrap gap-1 ml-2 align-middle">
          {isShareable(task.area) && (
            task.visibility === "shared"
              ? <Chip className={area.color.tag}>shared</Chip>
              : <Chip className="bg-zinc-800 text-zinc-500">private</Chip>
          )}
          {sourceLabel && <Chip className="bg-zinc-800 text-zinc-500">{sourceLabel}</Chip>}
        </span>

        {task.notes && (
          <span className="block mt-0.5 text-zinc-500 break-words">{task.notes}</span>
        )}
      </button>

      {onMove && (
        <>
          <label className="sr-only" htmlFor={`move-${task.id}`}>Move &ldquo;{task.title}&rdquo; to an area</label>
          <select
            id={`move-${task.id}`}
            value=""
            onChange={(e) => { if (e.target.value) onMove(e.target.value); }}
            className={`flex-shrink-0 bg-zinc-800 text-zinc-400 text-[10px] px-1 py-0.5 rounded border border-zinc-700 ${FOCUS}`}
          >
            <option value="">Move to…</option>
            {AREAS.filter((a) => a.id !== task.area).map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </>
      )}

      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete "${task.title}"`}
        className={`opacity-60 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 text-zinc-500 hover:text-red-400 text-xs transition-opacity flex-shrink-0 rounded px-1 py-0.5 ${FOCUS}`}
      >
        ✕
      </button>
    </div>
  );
}

// ─── AREA CARD ────────────────────────────────────────────────────────────────

function AreaCard({ area, tasks, note, now, store }) {
  const { color } = area;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [draftPriority, setDraftPriority] = useState("—");
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(note);
  const fieldId = useId();

  const progress = pct(tasks);
  const overdueCount = tasks.filter((t) => isOverdue(t, now)).length;
  const isInbox = area.id === "inbox";

  const ordered = useMemo(() => {
    const sorter = byUrgency(now);
    return [...tasks].sort((a, b) => {
      const doneDelta = Number(a.status === "done") - Number(b.status === "done");
      return doneDelta !== 0 ? doneDelta : sorter(a, b);
    });
  }, [tasks, now]);

  function addTask() {
    if (!draft.trim()) return;
    store.addTask({ title: draft.trim(), area: area.id, priority: draftPriority, dueDate: draftDate });
    setDraft("");
    setDraftDate("");
    setDraftPriority("—");
    setAdding(false);
  }

  function saveNote() {
    store.setAreaNote(area.id, noteDraft);
    setEditingNote(false);
  }

  return (
    <section className={`rounded-xl border ${color.border} bg-zinc-900 flex flex-col`} aria-labelledby={`${fieldId}-heading`}>
      {/* Header */}
      <div className={`px-4 pt-4 pb-3 border-b ${color.border}`}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h2 id={`${fieldId}-heading`} className={`text-xs font-bold uppercase tracking-widest ${color.text}`}>
            <span aria-hidden="true">{area.icon}</span> {area.label}
          </h2>
          <div className="flex items-center gap-2 flex-shrink-0">
            {overdueCount > 0 && (
              <span className="text-xs bg-red-900 text-red-300 px-1.5 py-0.5 rounded font-bold">
                {overdueCount} overdue
              </span>
            )}
            <span className="text-xs text-zinc-500">{progress}%</span>
          </div>
        </div>
        <ProgressBar value={progress} barClass={color.bar} />
      </div>

      {/* Status note */}
      <div className={`px-4 py-2 border-b ${color.border}`}>
        {editingNote ? (
          <div className="flex gap-2">
            <label className="sr-only" htmlFor={`${fieldId}-note`}>{area.label} status note</label>
            <input
              autoFocus
              id={`${fieldId}-note`}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveNote(); if (e.key === "Escape") setEditingNote(false); }}
              className={`flex-1 min-w-0 ${FIELD}`}
            />
            <button type="button" onClick={saveNote} className={`text-xs px-2 py-1 rounded ${color.tag} ${FOCUS}`}>
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setNoteDraft(note); setEditingNote(true); }}
            className={`w-full text-left text-xs text-zinc-500 italic hover:text-zinc-300 transition-colors rounded ${FOCUS}`}
          >
            {note || "Set a status note…"}
          </button>
        )}
      </div>

      {/* Tasks */}
      <div className="px-4 py-3 flex-1 space-y-0.5 min-h-[140px]">
        {ordered.length === 0 ? (
          <p className="text-zinc-600 text-xs italic">
            {isInbox ? "Inbox is clear. Captures Pong can't categorize land here." : "Nothing here yet."}
          </p>
        ) : (
          ordered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              area={area}
              now={now}
              onToggle={() => store.toggleTask(task.id)}
              onDelete={() => store.removeTask(task.id)}
              onEdit={(patch) => store.updateTask(task.id, patch)}
              onMove={isInbox ? (areaId) => store.moveTask(task.id, areaId) : undefined}
            />
          ))
        )}
      </div>

      {/* Add */}
      <div className={`px-4 pb-4 pt-3 border-t ${color.border}`}>
        {adding ? (
          <div className="space-y-2">
            <label className="sr-only" htmlFor={`${fieldId}-new`}>New {area.label} task</label>
            <input
              autoFocus
              id={`${fieldId}-new`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addTask(); if (e.key === "Escape") setAdding(false); }}
              placeholder="Add item…"
              className={`w-full ${FIELD}`}
            />
            <div className="flex gap-2 items-center flex-wrap">
              <label className="sr-only" htmlFor={`${fieldId}-new-priority`}>Priority</label>
              <select
                id={`${fieldId}-new-priority`}
                value={draftPriority}
                onChange={(e) => setDraftPriority(e.target.value)}
                className={FIELD}
              >
                {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
              </select>

              <label className="sr-only" htmlFor={`${fieldId}-new-date`}>Due date</label>
              <input
                id={`${fieldId}-new-date`}
                type="date"
                value={draftDate}
                onChange={(e) => setDraftDate(e.target.value)}
                className={FIELD}
              />

              <button type="button" onClick={addTask} className={`ml-auto text-xs px-3 py-1 rounded ${color.tag} ${FOCUS}`}>
                Add
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className={`text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded ${FOCUS}`}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`text-xs ${color.text} opacity-40 hover:opacity-100 focus-visible:opacity-100 transition-opacity rounded ${FOCUS}`}
          >
            + Add item
          </button>
        )}
      </div>
    </section>
  );
}

// ─── ACCOUNTABILITY VIEW ──────────────────────────────────────────────────────
//
// Deliberately narrow: the School summary only. No other area, no notes on
// anything else, and nothing here mutates state. Phase 4 puts a real read-only
// account behind this; today it is already read-only by construction.

function AccountabilityView({ tasks, note, now }) {
  const area = getArea(ACCOUNTABILITY_AREA);
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  const schoolTasks = tasks.filter((t) => t.area === ACCOUNTABILITY_AREA);
  const progress = pct(schoolTasks);
  const overdue = schoolTasks.filter((t) => isOverdue(t, now));
  const priorities = schoolTasks
    .filter((t) => t.status === "open" && t.priority !== "—")
    .sort(byUrgency(now))
    .slice(0, 3);
  const upcoming = schoolTasks
    .filter((t) => t.status === "open" && t.dueDate && !isOverdue(t, now))
    .sort(byUrgency(now))
    .slice(0, 3);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="text-center mb-8">
        <h1 className="text-xl font-bold text-zinc-100 mb-1">Fon&rsquo;s Week</h1>
        <p className="text-zinc-500 text-sm">{today}</p>
      </div>

      <section className={`rounded-xl border ${area.color.border} bg-zinc-900 p-5`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className={`font-bold text-sm ${area.color.text}`}>
            <span aria-hidden="true">{area.icon}</span> {area.label}
          </h2>
          <span className={`text-2xl font-bold ${area.color.text}`}>{progress}%</span>
        </div>
        <ProgressBar value={progress} barClass={area.color.bar} />

        {note && <p className="text-zinc-400 text-xs mt-3 italic">&ldquo;{note}&rdquo;</p>}

        {schoolTasks.length === 0 && (
          <p className="text-zinc-600 text-xs mt-3 italic">No schoolwork on the board yet.</p>
        )}

        {overdue.length > 0 && (
          <div className="mt-3 bg-red-950/40 border border-red-800 rounded-lg p-3">
            <h3 className="text-red-400 text-xs font-bold mb-1">Overdue</h3>
            {overdue.map((t) => (
              <p key={t.id} className="text-red-300 text-xs">
                · {t.title} <span className="text-red-500">({formatDue(t)})</span>
              </p>
            ))}
          </div>
        )}

        {priorities.length > 0 && (
          <div className="mt-3">
            <h3 className="text-zinc-500 text-xs mb-1 uppercase tracking-wide">Priority this week</h3>
            {priorities.map((t) => <p key={t.id} className="text-zinc-300 text-xs">· {t.title}</p>)}
          </div>
        )}

        {upcoming.length > 0 && (
          <div className="mt-3">
            <h3 className="text-zinc-500 text-xs mb-1 uppercase tracking-wide">Upcoming deadlines</h3>
            {upcoming.map((t) => (
              <p key={t.id} className="text-zinc-300 text-xs">
                · {t.title} <span className="text-zinc-500">({formatDue(t)})</span>
              </p>
            ))}
          </div>
        )}
      </section>

      <p className="text-center text-zinc-700 text-xs pt-2">Read-only · School summary · Updated by Fon</p>
    </div>
  );
}

// ─── BACKUP CONTROLS ──────────────────────────────────────────────────────────

function BackupControls({ state, onPickBackup }) {
  const inputRef = useRef(null);

  function download() {
    const blob = new Blob([exportState(state)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fon-os-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.rel = "noopener";
    // iOS Safari ignores a click on an anchor that is not in the document, and
    // revoking the object URL synchronously cancels the download in flight.
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then(onPickBackup);
    event.target.value = "";
  }

  return (
    <div className="flex items-center justify-center gap-3 text-xs text-zinc-700">
      <button type="button" onClick={download} className={`hover:text-zinc-400 transition-colors rounded px-1 ${FOCUS}`}>
        Export backup
      </button>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={`hover:text-zinc-400 transition-colors rounded px-1 ${FOCUS}`}
      >
        Restore backup
      </button>
      <input ref={inputRef} type="file" accept="application/json,.json" onChange={upload} className="sr-only" tabIndex={-1} />
    </div>
  );
}

/** Restoring replaces the whole board, so it asks first and says what it will do. */
function RestoreConfirm({ current, incoming, onConfirm, onCancel }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="restore-title"
      className="mx-auto mt-4 max-w-md rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-3 text-xs text-amber-100"
    >
      <h2 id="restore-title" className="font-bold mb-2">Replace the current board?</h2>
      <p className="mb-2">
        This replaces all {current.tasks.length} tasks currently on the board with the{" "}
        {incoming.tasks.length} tasks in the backup file.
      </p>
      <p className="mb-3 text-amber-200/70">
        The board you are replacing is saved first, so this can be undone.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded bg-amber-900 px-3 py-1 font-bold text-amber-100 hover:bg-amber-800 ${FOCUS}`}
        >
          Replace board
        </button>
        <button type="button" onClick={onCancel} className={`rounded px-3 py-1 text-amber-200/70 hover:text-amber-100 ${FOCUS}`}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Shown instead of the board when the saved data cannot be parsed. The real
 * data is still on disk and stays there until "Discard and start fresh".
 * Showing the seed board here would be a lie, and the first edit would
 * overwrite whatever was actually stored.
 */
function RecoveryScreen({ corruptRaw, onDiscard }) {
  const [confirming, setConfirming] = useState(false);

  function downloadRaw() {
    const blob = new Blob([corruptRaw ?? ""], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fon-os-unreadable-${new Date().toISOString().slice(0, 10)}.json`;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 py-8">
      <div className="rounded-xl border border-red-800 bg-red-950/40 p-5 text-xs text-red-100">
        <h2 className="mb-2 text-sm font-bold text-red-300">Saved board could not be read</h2>
        <p className="mb-2">
          The data stored in this browser is not valid and could not be loaded. It has{" "}
          <strong>not</strong> been changed or deleted, and the board is read-only so nothing can
          overwrite it.
        </p>
        <p className="mb-4 text-red-200/70">
          Download the raw data first — it may still be repairable, or contain tasks worth copying
          out by hand.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={downloadRaw}
            className={`rounded bg-zinc-800 px-3 py-1.5 font-bold text-zinc-100 hover:bg-zinc-700 ${FOCUS}`}
          >
            Download raw data
          </button>

          {confirming ? (
            <>
              <button
                type="button"
                onClick={onDiscard}
                className={`rounded bg-red-900 px-3 py-1.5 font-bold text-red-100 hover:bg-red-800 ${FOCUS}`}
              >
                Yes, discard and start fresh
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className={`rounded px-3 py-1.5 text-red-200/70 hover:text-red-100 ${FOCUS}`}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className={`rounded border border-red-800 px-3 py-1.5 text-red-200 hover:bg-red-900/40 ${FOCUS}`}
            >
              Discard and start fresh
            </button>
          )}
        </div>

        {confirming && (
          <p className="mt-3 text-red-200/70">
            The unreadable data is moved aside under a timestamped key rather than deleted, and a
            fresh board is started.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── BANNERS ──────────────────────────────────────────────────────────────────

function Banner({ tone, children, onDismiss }) {
  const tones = {
    error: "bg-red-950/60 border-red-800 text-red-200",
    info: "bg-zinc-900 border-zinc-700 text-zinc-300",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`mx-4 md:mx-8 mt-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-xs ${tones[tone]}`}>
      <p className="flex-1">{children}</p>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className={`flex-shrink-0 opacity-60 hover:opacity-100 rounded ${FOCUS}`}>
        ✕
      </button>
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

export default function App() {
  const store = useTaskStore();
  const [view, setView] = useState("dashboard"); // "dashboard" | "accountability"
  const [pendingRestore, setPendingRestore] = useState(null);

  function onPickBackup(json) {
    const prepared = store.prepareRestore(json);
    if (prepared) setPendingRestore(prepared);
  }

  // One clock for the whole render pass, so every overdue check agrees.
  const now = new Date();

  const tabClass = (active) =>
    `text-xs px-3 py-1.5 rounded transition-all ${FOCUS} ${
      active ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
    }`;

  return (
    <div className="app-shell min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      {/* Top bar */}
      <header className="border-b border-zinc-800 px-4 md:px-8 py-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-zinc-100 font-bold tracking-tight">Fon&rsquo;s OS</span>
          <span className="text-zinc-600 text-xs ml-3 hidden md:inline">Personal command center</span>
        </div>
        {!store.readOnly && (
        <nav className="flex gap-2 flex-shrink-0" aria-label="Views">
          <button type="button" onClick={() => setView("dashboard")} aria-current={view === "dashboard"} className={tabClass(view === "dashboard")}>
            My View
          </button>
          <button type="button" onClick={() => setView("accountability")} aria-current={view === "accountability"} className={tabClass(view === "accountability")}>
            Accountability View
          </button>
        </nav>
        )}
      </header>

      {store.notice && <Banner tone="info" onDismiss={store.dismissNotice}>{store.notice}</Banner>}
      {store.error && !store.readOnly && <Banner tone="error" onDismiss={store.dismissError}>{store.error}</Banner>}

      {store.undo && (
        <div role="status" className="mx-4 md:mx-8 mt-4 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-xs text-zinc-300">
          <p className="flex-1">
            Deleted &ldquo;{store.undo.task.title}&rdquo;.
          </p>
          <button type="button" onClick={store.undoRemove} className={`flex-shrink-0 rounded bg-zinc-700 px-3 py-1 font-bold text-zinc-100 hover:bg-zinc-600 ${FOCUS}`}>
            Undo
          </button>
          <button type="button" onClick={store.dismissUndo} aria-label="Dismiss" className={`flex-shrink-0 opacity-60 hover:opacity-100 rounded ${FOCUS}`}>
            ✕
          </button>
        </div>
      )}

      <main className="px-4 md:px-8 py-6">
        {store.readOnly ? (
          <RecoveryScreen corruptRaw={store.corruptRaw} onDiscard={store.discardCorrupt} />
        ) : store.phase === "loading" || store.state === null ? (
          <p className="text-center text-zinc-600 text-xs py-12" role="status">Loading your board…</p>
        ) : view === "dashboard" ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {AREAS.map((area) => (
                <AreaCard
                  key={area.id}
                  area={area}
                  tasks={tasksInArea(store.state.tasks, area.id)}
                  note={store.state.areaNotes[area.id] ?? ""}
                  now={now}
                  store={store}
                />
              ))}
            </div>
            <p className="text-center text-zinc-700 text-xs mt-6">
              Click any item to edit · hover to delete · click status note to update it
            </p>
            <div className="mt-3">
              <BackupControls state={store.state} onPickBackup={onPickBackup} />
            </div>
            {pendingRestore && (
              <RestoreConfirm
                current={store.state}
                incoming={pendingRestore}
                onConfirm={() => {
                  store.confirmRestore(pendingRestore);
                  setPendingRestore(null);
                }}
                onCancel={() => setPendingRestore(null)}
              />
            )}
          </>
        ) : (
          <AccountabilityView
            tasks={store.state.tasks}
            note={store.state.areaNotes[ACCOUNTABILITY_AREA] ?? ""}
            now={now}
          />
        )}
      </main>
    </div>
  );
}
