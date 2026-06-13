import { useState, useEffect } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const BUCKETS = [
  { id: "school",  label: "School",   icon: "📚", color: { text: "text-blue-400",    border: "border-blue-800",    tag: "bg-blue-900 text-blue-300",    bar: "bg-blue-400",    dim: "text-blue-600" } },
  { id: "mank9",   label: "Man K9",   icon: "🐕", color: { text: "text-amber-400",   border: "border-amber-800",   tag: "bg-amber-900 text-amber-300",   bar: "bg-amber-400",   dim: "text-amber-600" } },
  { id: "family",  label: "Family",   icon: "🏠", color: { text: "text-emerald-400", border: "border-emerald-800", tag: "bg-emerald-900 text-emerald-300", bar: "bg-emerald-400", dim: "text-emerald-600" } },
  { id: "faith",   label: "Faith",    icon: "✝️", color: { text: "text-purple-400",  border: "border-purple-800",  tag: "bg-purple-900 text-purple-300",  bar: "bg-purple-400",  dim: "text-purple-600" } },
  { id: "home",    label: "Home",     icon: "🔧", color: { text: "text-rose-400",    border: "border-rose-800",    tag: "bg-rose-900 text-rose-300",    bar: "bg-rose-400",    dim: "text-rose-600" } },
];

const PRIORITIES = ["—", "!", "!!"];

const SEED = {
  school: {
    status: "Grinding on UMPI 311 paper this week.",
    items: [
      { id: "s1", text: "Expand UMPI 311 draft by 1–2 pages with integrated source quotes", done: false, priority: "!!", dueDate: "2026-06-20" },
      { id: "s2", text: "Review lecture notes before next quiz", done: false, priority: "!", dueDate: "" },
      { id: "s3", text: "Read Getting to Maybe", done: false, priority: "—", dueDate: "" },
      { id: "s4", text: "Identify 2 pre-law electives for next term", done: false, priority: "—", dueDate: "" },
    ],
  },
  mank9: {
    status: "Operations stable. Working on SOP documentation.",
    items: [
      { id: "m1", text: "Confirm training schedule for active handlers", done: false, priority: "!", dueDate: "" },
      { id: "m2", text: "Draft core SOPs for Man K9 operations", done: false, priority: "!", dueDate: "" },
      { id: "m3", text: "Define handoff boundaries with Fon K9 (dad + sister)", done: false, priority: "—", dueDate: "" },
      { id: "m4", text: "Review open client follow-ups", done: false, priority: "—", dueDate: "" },
    ],
  },
  family: {
    status: "Focused on presence this week — Santiago and Abigail.",
    items: [
      { id: "f1", text: "One-on-one time with Santiago", done: false, priority: "!", dueDate: "" },
      { id: "f2", text: "Check in with Abigail on her week", done: false, priority: "!", dueDate: "" },
      { id: "f3", text: "Plan family reset or trip", done: false, priority: "—", dueDate: "" },
      { id: "f4", text: "Build financial margin for law school transition", done: false, priority: "—", dueDate: "" },
    ],
  },
  faith: {
    status: "Consistent with morning Bible study this week.",
    items: [
      { id: "r1", text: "Complete this week's personal Bible study", done: false, priority: "!", dueDate: "" },
      { id: "r2", text: "Catch up on Patreon Bible study session", done: false, priority: "!", dueDate: "" },
      { id: "r3", text: "Work through apologetics reading", done: false, priority: "—", dueDate: "" },
    ],
  },
  home: {
    status: "Nothing urgent. A few deferred projects on the list.",
    items: [
      { id: "h1", text: "Fix back porch light", done: false, priority: "—", dueDate: "" },
      { id: "h2", text: "Buy: air filter replacements", done: false, priority: "—", dueDate: "" },
      { id: "h3", text: "Buy: Santiago's new shoes", done: false, priority: "!", dueDate: "" },
      { id: "h4", text: "Deep clean garage", done: false, priority: "—", dueDate: "" },
    ],
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function isOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate + "T23:59:59") < new Date();
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function pct(items) {
  if (!items.length) return 0;
  return Math.round((items.filter(i => i.done).length / items.length) * 100);
}

let _id = 100;
function uid() { return "i" + (_id++); }

// ─── STORAGE ─────────────────────────────────────────────────────────────────

function loadData() {
  try {
    const raw = sessionStorage.getItem("fon_dashboard");
    if (raw) return JSON.parse(raw);
  } catch {}
  return SEED;
}

function saveData(data) {
  try { sessionStorage.setItem("fon_dashboard", JSON.stringify(data)); } catch {}
}

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

function ProgressBar({ value, barClass }) {
  return (
    <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
      <div className={`h-full ${barClass} transition-all duration-500`} style={{ width: `${value}%` }} />
    </div>
  );
}

function PriorityBadge({ priority }) {
  if (priority === "!!") return <span className="text-red-400 text-xs font-bold w-4 flex-shrink-0">!!</span>;
  if (priority === "!")  return <span className="text-amber-400 text-xs font-bold w-4 flex-shrink-0">!</span>;
  return <span className="w-4 flex-shrink-0" />;
}

function TaskRow({ item, bucketId, color, onToggle, onDelete, onEdit }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(item.text);
  const [dateVal, setDateVal] = useState(item.dueDate || "");
  const [pri, setPri] = useState(item.priority || "—");
  const overdue = bucketId === "school" && !item.done && isOverdue(item.dueDate);

  function commit() {
    onEdit({ text: val.trim() || item.text, dueDate: dateVal, priority: pri });
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="bg-zinc-800 rounded-lg p-3 space-y-2">
        <input
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="w-full bg-zinc-700 text-zinc-100 text-xs px-2 py-1.5 rounded border border-zinc-600 outline-none"
        />
        <div className="flex gap-2 items-center">
          <select
            value={pri}
            onChange={e => setPri(e.target.value)}
            className="bg-zinc-700 text-zinc-300 text-xs px-2 py-1 rounded border border-zinc-600 outline-none"
          >
            {PRIORITIES.map(p => <option key={p}>{p}</option>)}
          </select>
          {bucketId === "school" && (
            <input
              type="date"
              value={dateVal}
              onChange={e => setDateVal(e.target.value)}
              className="bg-zinc-700 text-zinc-300 text-xs px-2 py-1 rounded border border-zinc-600 outline-none"
            />
          )}
          <button onClick={commit} className={`ml-auto text-xs px-3 py-1 rounded ${color.tag}`}>Save</button>
          <button onClick={() => setEditing(false)} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`group flex items-start gap-2 py-1 rounded px-1 transition-colors ${overdue ? "bg-red-950/30" : "hover:bg-zinc-800/50"}`}>
      <button
        onClick={onToggle}
        className={`mt-0.5 w-4 h-4 flex-shrink-0 rounded border transition-all ${
          item.done ? `${color.bar} border-transparent` : "border-zinc-600 hover:border-zinc-400"
        }`}
      >
        {item.done && (
          <svg viewBox="0 0 10 10" className="w-full h-full p-0.5 text-zinc-950" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1.5 5l2.5 2.5 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <PriorityBadge priority={item.priority} />
      <span
        onClick={() => setEditing(true)}
        className={`flex-1 text-xs leading-relaxed cursor-pointer ${
          item.done ? "line-through text-zinc-600" : overdue ? "text-red-300" : "text-zinc-300 hover:text-zinc-100"
        }`}
      >
        {item.text}
        {bucketId === "school" && item.dueDate && (
          <span className={`ml-2 text-xs ${overdue ? "text-red-400 font-bold" : "text-zinc-500"}`}>
            {overdue ? "OVERDUE · " : ""}{formatDate(item.dueDate)}
          </span>
        )}
      </span>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs transition-opacity flex-shrink-0"
      >✕</button>
    </div>
  );
}

function BucketCard({ bucket, data, onUpdate }) {
  const { color } = bucket;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [draftPri, setDraftPri] = useState("—");
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState(data.status);

  const p = pct(data.items);
  const overdueCount = bucket.id === "school"
    ? data.items.filter(i => !i.done && isOverdue(i.dueDate)).length
    : 0;

  function addItem() {
    if (!draft.trim()) return;
    onUpdate({
      ...data,
      items: [...data.items, { id: uid(), text: draft.trim(), done: false, priority: draftPri, dueDate: draftDate }],
    });
    setDraft(""); setDraftDate(""); setDraftPri("—"); setAdding(false);
  }

  function toggle(id) {
    onUpdate({ ...data, items: data.items.map(i => i.id === id ? { ...i, done: !i.done } : i) });
  }

  function remove(id) {
    onUpdate({ ...data, items: data.items.filter(i => i.id !== id) });
  }

  function editItem(id, patch) {
    onUpdate({ ...data, items: data.items.map(i => i.id === id ? { ...i, ...patch } : i) });
  }

  function saveStatus() {
    onUpdate({ ...data, status: statusDraft });
    setEditingStatus(false);
  }

  return (
    <div className={`rounded-xl border ${color.border} bg-zinc-900 flex flex-col`}>
      {/* Header */}
      <div className={`px-4 pt-4 pb-3 border-b ${color.border}`}>
        <div className="flex items-center justify-between mb-2">
          <span className={`text-xs font-bold uppercase tracking-widest ${color.text}`}>
            {bucket.icon} {bucket.label}
          </span>
          <div className="flex items-center gap-2">
            {overdueCount > 0 && (
              <span className="text-xs bg-red-900 text-red-300 px-1.5 py-0.5 rounded font-bold">
                {overdueCount} overdue
              </span>
            )}
            <span className="text-xs text-zinc-500">{p}%</span>
          </div>
        </div>
        <ProgressBar value={p} barClass={color.bar} />
      </div>

      {/* Status note */}
      <div className={`px-4 py-2 border-b ${color.border}`}>
        {editingStatus ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={statusDraft}
              onChange={e => setStatusDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveStatus(); if (e.key === "Escape") setEditingStatus(false); }}
              className="flex-1 bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-600 outline-none"
            />
            <button onClick={saveStatus} className={`text-xs px-2 py-1 rounded ${color.tag}`}>Save</button>
          </div>
        ) : (
          <p
            onClick={() => { setEditingStatus(true); setStatusDraft(data.status); }}
            className="text-xs text-zinc-500 italic cursor-pointer hover:text-zinc-300 transition-colors"
          >
            {data.status || "Set a status note…"}
          </p>
        )}
      </div>

      {/* Items */}
      <div className="px-4 py-3 flex-1 space-y-0.5 min-h-[140px]">
        {data.items.length === 0 && (
          <p className="text-zinc-600 text-xs italic">Nothing here yet.</p>
        )}
        {data.items.map(item => (
          <TaskRow
            key={item.id}
            item={item}
            bucketId={bucket.id}
            color={color}
            onToggle={() => toggle(item.id)}
            onDelete={() => remove(item.id)}
            onEdit={patch => editItem(item.id, patch)}
          />
        ))}
      </div>

      {/* Add row */}
      <div className={`px-4 pb-4 pt-3 border-t ${color.border}`}>
        {adding ? (
          <div className="space-y-2">
            <input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addItem(); if (e.key === "Escape") setAdding(false); }}
              placeholder="Add item…"
              className="w-full bg-zinc-800 text-zinc-100 text-xs px-3 py-1.5 rounded border border-zinc-600 outline-none placeholder-zinc-600"
            />
            <div className="flex gap-2 items-center">
              <select
                value={draftPri}
                onChange={e => setDraftPri(e.target.value)}
                className="bg-zinc-800 text-zinc-300 text-xs px-2 py-1 rounded border border-zinc-600 outline-none"
              >
                {PRIORITIES.map(p => <option key={p}>{p}</option>)}
              </select>
              {bucket.id === "school" && (
                <input
                  type="date"
                  value={draftDate}
                  onChange={e => setDraftDate(e.target.value)}
                  className="bg-zinc-800 text-zinc-300 text-xs px-2 py-1 rounded border border-zinc-600 outline-none"
                />
              )}
              <button onClick={addItem} className={`ml-auto text-xs px-3 py-1 rounded ${color.tag}`}>Add</button>
              <button onClick={() => setAdding(false)} className="text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className={`text-xs ${color.text} opacity-40 hover:opacity-100 transition-opacity`}
          >
            + Add item
          </button>
        )}
      </div>
    </div>
  );
}

function AccountabilityView({ data }) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="text-center mb-8">
        <h2 className="text-xl font-bold text-zinc-100 mb-1">Fon's Week</h2>
        <p className="text-zinc-500 text-sm">{today}</p>
      </div>

      {BUCKETS.map(bucket => {
        const bdata = data[bucket.id];
        const p = pct(bdata.items);
        const { color } = bucket;
        const overdueItems = bucket.id === "school"
          ? bdata.items.filter(i => !i.done && isOverdue(i.dueDate))
          : [];
        const highPri = bdata.items.filter(i => !i.done && (i.priority === "!!" || i.priority === "!"));

        return (
          <div key={bucket.id} className={`rounded-xl border ${color.border} bg-zinc-900 p-5`}>
            <div className="flex items-center justify-between mb-3">
              <span className={`font-bold text-sm ${color.text}`}>{bucket.icon} {bucket.label}</span>
              <span className={`text-2xl font-bold ${color.text}`}>{p}%</span>
            </div>
            <ProgressBar value={p} barClass={color.bar} />

            {bdata.status && (
              <p className="text-zinc-400 text-xs mt-3 italic">"{bdata.status}"</p>
            )}

            {overdueItems.length > 0 && (
              <div className="mt-3 bg-red-950/40 border border-red-800 rounded-lg p-3">
                <p className="text-red-400 text-xs font-bold mb-1">Overdue</p>
                {overdueItems.map(i => (
                  <p key={i.id} className="text-red-300 text-xs">· {i.text} <span className="text-red-500">({formatDate(i.dueDate)})</span></p>
                ))}
              </div>
            )}

            {highPri.length > 0 && (
              <div className="mt-3">
                <p className="text-zinc-500 text-xs mb-1 uppercase tracking-wide">Priority this week</p>
                {highPri.slice(0, 3).map(i => (
                  <p key={i.id} className="text-zinc-300 text-xs">· {i.text}</p>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <p className="text-center text-zinc-700 text-xs pt-2">Read-only · Updated by Fon</p>
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [data, setData] = useState(() => loadData());
  const [view, setView] = useState("dashboard"); // "dashboard" | "accountability"

  useEffect(() => { saveData(data); }, [data]);

  function updateBucket(id, updated) {
    setData(prev => ({ ...prev, [id]: updated }));
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      {/* Top bar */}
      <div className="border-b border-zinc-800 px-4 md:px-8 py-4 flex items-center justify-between">
        <div>
          <span className="text-zinc-100 font-bold tracking-tight">Fon's OS</span>
          <span className="text-zinc-600 text-xs ml-3 hidden md:inline">Personal command center</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setView("dashboard")}
            className={`text-xs px-3 py-1.5 rounded transition-all ${
              view === "dashboard" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            My View
          </button>
          <button
            onClick={() => setView("accountability")}
            className={`text-xs px-3 py-1.5 rounded transition-all ${
              view === "accountability" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Accountability View
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 md:px-8 py-6">
        {view === "dashboard" ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {BUCKETS.map(bucket => (
                <BucketCard
                  key={bucket.id}
                  bucket={bucket}
                  data={data[bucket.id]}
                  onUpdate={updated => updateBucket(bucket.id, updated)}
                />
              ))}
            </div>
            <p className="text-center text-zinc-700 text-xs mt-6">
              Click any item to edit · hover to delete · click status note to update it
            </p>
          </>
        ) : (
          <AccountabilityView data={data} />
        )}
      </div>
    </div>
  );
}
