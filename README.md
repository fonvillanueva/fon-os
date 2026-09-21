# Fon's OS

Personal command center. A dark, keyboard-friendly task board across seven
areas: **Inbox, School, Work, Reading, Family, Faith, Home**.

- **My View** — add, edit, complete, prioritise, schedule, and triage.
- **Accountability View** — a read-only School summary: progress, priorities,
  upcoming deadlines, and overdue work. Nothing else is exposed.

React + Vite + Tailwind, deployed on Vercel.

## Commands

| | |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run test` | Test suite |
| `npm run lint` | ESLint |
| `npm run icons` | Regenerate every icon asset from the vector source |

## Where data lives

State is one versioned object in `localStorage` under `fon_os_v2`:

```
{ version: 2, savedAt, areaNotes: { [area]: string }, tasks: Task[] }
```

`tasks` is a **flat array** — the same shape as the future Supabase `tasks`
table — so moving to a database is a copy rather than a reshape. `src/lib/model.js`
defines and normalises the task; nothing downstream has to defend against a
missing field.

Task ids are **v4 UUIDs**, including in the seed and in the no-Web-Crypto
fallback, so the board is already compatible with the Phase 3
`tasks.id uuid` column and no id is rewritten on first save.

### Storage migration (automatic, already applied)

The original build stored the board in **`sessionStorage`**, which meant every
task was destroyed when the tab closed. On first load, the app now:

1. Reads `localStorage["fon_os_v2"]` if it exists, otherwise
2. Finds the old `sessionStorage["fon_dashboard"]` payload, converts it, and
   saves it to `localStorage`, showing a one-time notice, otherwise
3. Falls back to the seed board.

The legacy key is **not deleted**, and a verbatim copy of it is kept at
`localStorage["fon_os_backup_v1"]` — taken **whenever legacy data is present**,
not only when migrating, so a second tab that already migrated cannot leave it
unreferenced. If a legacy board and a migrated board coexist, the app says so
and does not merge them.

Legacy ids are re-keyed to UUIDs during migration. **Colliding ids are re-keyed,
never dropped** — two legacy buckets could each hold an item called `s1`, and
collapsing them would silently lose a real task.

### If the saved board cannot be read

The app enters a **read-only safety state**: the recovery screen replaces the
board, the view switcher is hidden, and every mutation is refused at the store,
not just hidden in the UI. Your stored bytes are never written over.

From there you can **Download raw data** — it may be repairable, or contain
tasks worth copying out by hand — and only an explicit, twice-confirmed
**Discard and start fresh** moves on. Even then the original is *moved aside*
under a timestamped `fon_os_unreadable_v2_…` key rather than deleted.

### Multiple tabs

Each tab listens for `storage` events and adopts a board saved by another tab,
so two open tabs cannot overwrite each other from stale in-memory state.

## Backup and rollback

**Export backup** at the bottom of My View downloads the whole board as JSON.
Do an export before any migration.

**Restore backup** asks first: it shows how many tasks are on the board and how
many are in the file, and saves the board you are replacing to
`localStorage["fon_os_prerestore_backup"]` before applying anything — so a
restore is itself reversible.

**Deleting a task** shows an *Undo* banner that puts the row back at its
original position. The delete control stays visible on touch devices, where
there is no hover to reveal it.

To roll back to the pre-change app entirely:

```bash
git revert <merge-or-commit-sha>    # or: git checkout main -- .
npm ci && npm run build
```

Old data is still in `sessionStorage["fon_dashboard"]` (same tab), in
`localStorage["fon_os_backup_v1"]`, and — after any restore — in
`localStorage["fon_os_prerestore_backup"]`, so reverting the code does not cost
you the board. Reverting does, however, return you to the sessionStorage behaviour where
tasks vanish when the tab closes — export first.

## Icons and PWA

All assets are generated from one vector source by `scripts/generate-icons.mjs`:
a charcoal rounded square, an electric-blue geometric **F**, and a block command
cursor on its baseline. The mark sits inside a 363px radius of the 1024px
canvas, well within the 409.6px maskable safe circle, so iOS and Android can
crop without clipping it.

| File | Use |
|---|---|
| `public/icon-master.svg` | Vector master |
| `public/icon-1024.png` | Raster master |
| `public/apple-touch-icon.png` | iPhone Home Screen (180×180, full-bleed — iOS applies its own mask) |
| `public/icon-192.png`, `icon-512.png` | Manifest, `purpose: any` |
| `public/icon-maskable-512.png` | Manifest, `purpose: maskable` |
| `public/favicon.svg`, `favicon.ico`, `favicon-{16,32,48}.png` | Browser |

Edit the geometry in `scripts/generate-icons.mjs` and run `npm run icons`.

### ⚠️ iPhone Home Screen shortcut must be re-added

**iOS caches Home Screen icons aggressively and will not pick up the new one on
its own.** After deploying, on the iPhone:

1. Press and hold the existing Fon's OS icon → **Remove Bookmark** / **Delete**.
2. Open the site in Safari.
3. **Share → Add to Home Screen.**

The shortcut will then show the new icon and the title **Fon's OS**. Until you
do this, the old generic icon stays on the Home Screen no matter what is
deployed. A hard refresh in Safari (or clearing website data for the site) helps
if the icon still looks stale.

## Permissions

Areas carry a sharing scope. Only **Family** and **Home** may contain `shared`
tasks; everywhere else `visibility` is forced to `private` by
`normalizeTask`, so it cannot be bypassed by a patch, an import, or a
hand-edited backup file. Moving a task never widens its sharing — only an Inbox
capture, which has no meaningful scope yet, adopts its destination's default.

Login, roles, and the Pong API are **not built yet**. See
[`docs/phase-3-5-plan.md`](docs/phase-3-5-plan.md) for the Supabase schema, the
RLS model for Fon / Abigail / Accountability, and the scoped Pong interface.
[`docs/claude-import.md`](docs/claude-import.md) documents the reviewed school
import format.

### Work tasks and confidentiality

Work may involve confidential clients. Use **initials or internal reference
numbers** in titles — `Call A.B. re: rescheduling`, `File ref #2291 status
update`. Do not store diagnoses, case details, legal strategy, or health
information in Fon's OS.
