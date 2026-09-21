// ─── AREAS ────────────────────────────────────────────────────────────────────
//
// Order here is the order cards appear in My View. Inbox leads because it is
// the triage queue; the original five keep their original relative order.
//
// `defaultVisibility` decides whether a new task in this area is shared with
// Abigail. Only Family and Home are shared; everything else is private to Fon.

export const AREAS = [
  {
    id: "inbox",
    label: "Inbox",
    icon: "📥",
    defaultVisibility: "private",
    shareable: false,
    blurb: "Uncategorized captures. Sort these into an area.",
    color: { text: "text-slate-300", border: "border-slate-700", tag: "bg-slate-800 text-slate-200", bar: "bg-slate-400", dim: "text-slate-500" },
  },
  {
    id: "school",
    label: "School",
    icon: "📚",
    defaultVisibility: "private",
    shareable: false,
    blurb: "Coursework, readings, and deadlines.",
    color: { text: "text-blue-400", border: "border-blue-800", tag: "bg-blue-900 text-blue-300", bar: "bg-blue-400", dim: "text-blue-600" },
  },
  {
    id: "work",
    label: "Work",
    icon: "💼",
    defaultVisibility: "private",
    shareable: false,
    blurb: "Use initials or reference numbers — never client details.",
    color: { text: "text-indigo-400", border: "border-indigo-800", tag: "bg-indigo-900 text-indigo-300", bar: "bg-indigo-400", dim: "text-indigo-600" },
  },
  {
    id: "reading",
    label: "Reading",
    icon: "📖",
    defaultVisibility: "private",
    shareable: false,
    blurb: "Currently reading — notes and takeaways.",
    color: { text: "text-teal-400", border: "border-teal-800", tag: "bg-teal-900 text-teal-300", bar: "bg-teal-400", dim: "text-teal-600" },
  },
  {
    id: "family",
    label: "Family",
    icon: "🏠",
    defaultVisibility: "shared",
    shareable: true,
    blurb: "Shared with Abigail.",
    color: { text: "text-emerald-400", border: "border-emerald-800", tag: "bg-emerald-900 text-emerald-300", bar: "bg-emerald-400", dim: "text-emerald-600" },
  },
  {
    id: "faith",
    label: "Faith",
    icon: "✝️",
    defaultVisibility: "private",
    shareable: false,
    blurb: "Study, prayer, and practice.",
    color: { text: "text-purple-400", border: "border-purple-800", tag: "bg-purple-900 text-purple-300", bar: "bg-purple-400", dim: "text-purple-600" },
  },
  {
    id: "home",
    label: "Home",
    icon: "🔧",
    defaultVisibility: "shared",
    shareable: true,
    blurb: "Shared with Abigail.",
    color: { text: "text-rose-400", border: "border-rose-800", tag: "bg-rose-900 text-rose-300", bar: "bg-rose-400", dim: "text-rose-600" },
  },
];

export const AREA_IDS = AREAS.map((a) => a.id);

/** Areas Abigail may read and write. Mirrored server-side in Phase 4. */
export const ABIGAIL_AREAS = ["family", "home"];

/** The only area the Accountability View may summarise. */
export const ACCOUNTABILITY_AREA = "school";

/** Where Pong drops a capture it could not confidently categorise. */
export const FALLBACK_AREA = "inbox";

const BY_ID = new Map(AREAS.map((a) => [a.id, a]));

export function getArea(id) {
  return BY_ID.get(id);
}

export function isAreaId(id) {
  return BY_ID.has(id);
}

/** True only for areas Abigail can reach, so "shared" is meaningful there. */
export function isShareable(id) {
  const area = BY_ID.get(id);
  return Boolean(area && area.shareable);
}
