// ─── TASK MODEL ───────────────────────────────────────────────────────────────
//
// One flat task shape, deliberately close to the columns the Supabase `tasks`
// table will use in Phase 3, so the migration is a straight copy rather than a
// reshape. Everything is normalised on the way in: nothing downstream has to
// defend against a missing field.

import { AREA_IDS, FALLBACK_AREA, getArea, isShareable } from "./areas.js";

export const PRIORITIES = ["—", "!", "!!"];
export const STATUSES = ["open", "done", "archived"];
export const VISIBILITIES = ["private", "shared"];
export const SOURCES = ["manual", "pong-voice", "claude-import", "abigail"];
export const ACTORS = ["fon", "abigail", "pong", "claude-import"];

export function uid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Collision-resistant fallback for older Safari and non-secure contexts.
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** `YYYY-MM-DD`, or "" when absent or malformed. */
function dateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

/** `HH:MM` (24h), or "" when absent or malformed. */
function timeString(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "";
}

function timestamp(value, fallback) {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return fallback;
}

/**
 * Coerces any shape — legacy v1 item, hand-edited JSON, API payload — into a
 * valid task. An unknown or missing area lands in Inbox rather than vanishing.
 */
export function normalizeTask(raw, { now = new Date().toISOString() } = {}) {
  const input = raw && typeof raw === "object" ? raw : {};

  // v1 items carried `text` and a boolean `done`.
  const title = text(input.title) || text(input.text) || "Untitled";
  const legacyStatus = input.done === true ? "done" : "open";

  const area = AREA_IDS.includes(input.area) ? input.area : FALLBACK_AREA;
  const status = oneOf(input.status, STATUSES, legacyStatus);
  const createdAt = timestamp(input.createdAt, now);

  const areaConfig = getArea(area);
  // Hard invariant: only Family and Home are reachable by Abigail, so a task
  // outside those areas can never be marked shared — not by a patch, not by an
  // import, not by a hand-edited backup file.
  const visibility = isShareable(area)
    ? oneOf(input.visibility, VISIBILITIES, areaConfig ? areaConfig.defaultVisibility : "private")
    : "private";

  return {
    id: typeof input.id === "string" && input.id ? input.id : uid(),
    title,
    notes: typeof input.notes === "string" ? input.notes : "",
    area,
    status,
    priority: oneOf(input.priority, PRIORITIES, "—"),
    dueDate: dateString(input.dueDate),
    dueTime: dateString(input.dueDate) ? timeString(input.dueTime) : "",
    owner: text(input.owner),
    visibility,
    createdBy: oneOf(input.createdBy, ACTORS, "fon"),
    source: oneOf(input.source, SOURCES, "manual"),
    createdAt,
    updatedAt: timestamp(input.updatedAt, createdAt),
    completedAt: status === "done" ? timestamp(input.completedAt, createdAt) : null,
  };
}

/** Builds a brand-new task. `area` decides the default sharing scope. */
export function createTask(input = {}) {
  const now = new Date().toISOString();
  return normalizeTask({ ...input, createdAt: now, updatedAt: now }, { now });
}

/**
 * The only fields a patch may touch. Provenance (`id`, `createdAt`,
 * `createdBy`, `source`) and the derived `completedAt` are deliberately absent:
 * this is an allowlist, not a denylist, so a caller — including the Pong API in
 * Phase 5 — cannot rewrite a task's history by adding a field to its payload.
 */
export const PATCHABLE_FIELDS = [
  "title",
  "notes",
  "area",
  "status",
  "priority",
  "dueDate",
  "dueTime",
  "owner",
  "visibility",
];

/** Applies a patch, keeping `updatedAt` and `completedAt` honest. */
export function applyPatch(task, patch = {}) {
  const now = new Date().toISOString();

  const allowed = {};
  for (const field of PATCHABLE_FIELDS) {
    if (Object.hasOwn(patch, field)) allowed[field] = patch[field];
  }

  const next = normalizeTask({ ...task, ...allowed }, { now });

  next.id = task.id;
  next.createdAt = task.createdAt;
  next.createdBy = task.createdBy;
  next.source = task.source;
  next.updatedAt = now;

  if (next.status === "done") {
    next.completedAt = task.status === "done" ? task.completedAt : now;
  } else {
    next.completedAt = null;
  }
  return next;
}

export function toggleDone(task) {
  return applyPatch(task, { status: task.status === "done" ? "open" : "done" });
}

/**
 * Moves a task to another area.
 *
 * Sharing never widens by accident: only an Inbox capture (which has no
 * meaningful scope yet) adopts its destination's default. Anything already
 * filed keeps the scope it had, and `normalizeTask` forces it back to private
 * if the destination is not shareable.
 */
export function moveTask(task, areaId) {
  const destination = getArea(areaId);
  if (!destination) return task;
  const visibility =
    task.area === FALLBACK_AREA ? destination.defaultVisibility : task.visibility;
  return applyPatch(task, { area: areaId, visibility });
}

// ─── QUERIES ──────────────────────────────────────────────────────────────────

/** Tasks still on the board (archived items are hidden, never deleted). */
export function isActive(task) {
  return task.status !== "archived";
}

export function tasksInArea(tasks, areaId) {
  return tasks.filter((t) => t.area === areaId && isActive(t));
}

/** Local end-of-day when no time is given, so a due date is not overdue at 00:01. */
export function dueAt(task) {
  if (!task.dueDate) return null;
  const at = new Date(`${task.dueDate}T${task.dueTime || "23:59"}:59`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function isOverdue(task, now = new Date()) {
  if (task.status !== "open") return false;
  const at = dueAt(task);
  return at !== null && at < now;
}

export function pct(tasks) {
  const active = tasks.filter(isActive);
  if (!active.length) return 0;
  return Math.round((active.filter((t) => t.status === "done").length / active.length) * 100);
}

export function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatTime(timeStr) {
  if (!timeStr) return "";
  const d = new Date(`2000-01-01T${timeStr}:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatDue(task) {
  if (!task.dueDate) return "";
  const date = formatDate(task.dueDate);
  const time = formatTime(task.dueTime);
  return time ? `${date} · ${time}` : date;
}

/** Highest-signal open work first: overdue, then priority, then due date. */
export function byUrgency(now = new Date()) {
  const weight = { "!!": 0, "!": 1, "—": 2 };
  return (a, b) => {
    const overdueDelta = Number(isOverdue(b, now)) - Number(isOverdue(a, now));
    if (overdueDelta !== 0) return overdueDelta;
    const priorityDelta = weight[a.priority] - weight[b.priority];
    if (priorityDelta !== 0) return priorityDelta;
    const aDue = dueAt(a);
    const bDue = dueAt(b);
    if (aDue && bDue) return aDue - bDue;
    if (aDue) return -1;
    if (bDue) return 1;
    return 0;
  };
}
