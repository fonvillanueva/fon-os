# Phases 3–5: backend, roles, and Pong

This is the design for the work that has **not** been built yet. It is written
down first so the security model can be reviewed before any of it exists.

Decisions already made: **Supabase** (Postgres + Auth + Row Level Security), with
authorization enforced in the database rather than in the UI.

---

## Phase 3 — Database

### `tasks`

The columns mirror `src/lib/model.js` one-for-one, which is why Phase 2 flattened
the board into a single task array. Migration is a copy, not a reshape.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | Already satisfied client-side: every id the app produces is a v4 UUID, so the copy needs no id rewrite. |
| `title` | `text not null` | |
| `notes` | `text not null default ''` | |
| `area` | `text not null` | `check (area in ('inbox','school','work','reading','family','faith','home'))` |
| `status` | `text not null default 'open'` | `check (status in ('open','done','archived'))` |
| `priority` | `text not null default '—'` | `check (priority in ('—','!','!!'))` |
| `due_date` | `date` | |
| `due_time` | `time` | |
| `owner` | `text` | |
| `visibility` | `text not null default 'private'` | `check (visibility in ('private','shared'))` |
| `created_by` | `text not null` | `fon` \| `abigail` \| `pong` \| `claude-import` |
| `source` | `text not null default 'manual'` | `manual` \| `pong-voice` \| `claude-import` \| `abigail` |
| `created_at` | `timestamptz not null default now()` | |
| `updated_at` | `timestamptz not null default now()` | |
| `completed_at` | `timestamptz` | |
| `import_key` | `text` | unique per source; makes Claude re-import idempotent |

The sharing invariant from Phase 2 becomes a database constraint, so it holds
even against direct SQL:

```sql
constraint shared_only_in_shared_areas
  check (visibility = 'private' or area in ('family','home'))
```

### `area_notes`, `audit_log`, `idempotency_keys`

- `area_notes` — one row per area, `area` pk, `note text`.
- `audit_log` — append-only: `id`, `at`, `actor`, `action`, `task_id`,
  `before jsonb`, `after jsonb`, `request_id`. **Every Pong write writes a row.**
  No role has `delete` on this table.
- `idempotency_keys` — `key` pk, `actor`, `task_id`, `response jsonb`,
  `created_at`. Replaying a key returns the stored response instead of acting
  again. This is what stops a repeated voice request creating two tasks.

### Migration and rollback

Phase 2 data lives in the browser. The path in is: **Export backup** in My View
→ a one-shot importer loads that JSON into Supabase → the app switches its
read path from `localStorage` to Supabase.

The export is already insert-ready: ids are v4 UUIDs, ids are unique (collisions
are re-keyed on load, never dropped), and `visibility` already satisfies the
`shared_only_in_shared_areas` constraint above.

Rollback is the reverse and stays available because `src/lib/storage.js` is
untouched: point the app back at local storage and re-import the export file.
The export remains the canonical off-site backup at every step.

---

## Phase 4 — Roles

Three Supabase Auth accounts, with a `profiles` table mapping `auth.uid()` to a
role: `fon`, `abigail`, `accountability`.

| | Fon | Abigail | Accountability | Pong |
|---|---|---|---|---|
| Family, Home | read/write | **read/write** | — | read/write |
| School | read/write | — | **read-only summary** | read/write |
| Work, Faith, Reading, Inbox | read/write | — | — | read/write |
| Private notes | read/write | — | — | not returned |
| Admin settings, integration credentials | read/write | — | — | — |
| Delete a task | yes | in her areas | — | **never** |

RLS policies are written against `area` and the caller's role, so a direct
`GET /rest/v1/tasks?area=eq.work` as Abigail returns **zero rows** — the
boundary does not depend on the UI hiding a card. That is the specific thing
the Phase 4 tests must prove.

The Accountability role gets a `school_summary` view (progress, priorities,
deadlines, overdue) with `select` only and **no** access to `tasks.notes`.

---

## Phase 5 — Pong

A narrow server-side API. Pong is a conversational front end to Fon's OS, not a
second task database.

### Allowed

| Operation | Endpoint |
|---|---|
| Add a task | `POST /api/pong/tasks` |
| Read tasks and priorities | `GET /api/pong/tasks` |
| Mark complete | `POST /api/pong/tasks/:id/complete` |
| Reschedule | `POST /api/pong/tasks/:id/reschedule` |
| Move between areas | `POST /api/pong/tasks/:id/move` |
| Update when explicit | `PATCH /api/pong/tasks/:id` |

`PATCH` accepts only `model.js`'s `PATCHABLE_FIELDS`. Provenance is not
patchable, by construction.

### Forbidden

- **No delete.** There is no delete endpoint and the Pong role has no `delete`
  grant. "Remove that" archives (`status: 'archived'`), which is reversible.
- No user, role, or permission changes.
- No access to secrets or integration credentials.
- **No real-world actions.** Pong cannot send a message, place a call, contact
  a client, move an external appointment, or make a purchase. This integration
  reaches the task table and nothing else.

### Captured text is never a command

> "Anthony told me to give a client a call"

creates a Work task — `"Call client regarding Anthony's request"` — and does
nothing else. A captured note describes something to do later; it is never
authorization to do it now. This holds for notes arriving from Pong, from a
Claude import file, and from any other source.

### Controls

- **Authentication** — a bearer token held server-side only. It is never sent
  to the browser, and the Supabase service-role key is never exposed to a
  client. Pong authenticates to our API; our API talks to Supabase.
- **Validation** — every field parsed and bounded before it reaches SQL; an
  unknown area lands in Inbox rather than being rejected or guessed.
- **Role enforcement** — the Pong token maps to a restricted database role, so
  RLS is the backstop even if a handler is wrong.
- **Rate limiting** — per-token, per-minute, sized for speech, not scripts.
- **Idempotency** — every mutating request carries a key; replays return the
  original response. Duplicate voice requests cannot create duplicate tasks.
- **Audit log** — actor, action, before, after, request id, for every write.

### Ambiguity

When a capture is unclear, Pong either files it in **Inbox** or asks **one**
short clarifying question. It does not guess an area or a date.

### Confirmations

Short enough for the glasses:

> Added to Work: Call Anthony about client rescheduling — tomorrow morning.

### Deployment note (blocking, needs a decision)

Vercel SSO protection is currently enabled on all `*.vercel.app` domains for
this project. A Pong endpoint deployed as-is would be intercepted by Vercel's
login page rather than reaching our handler. Options, in order of preference:

1. Add a custom domain for the app and serve the API there (SSO applies to
   preview/`.vercel.app` only).
2. Use a Vercel Protection Bypass token scoped to the API routes.
3. Disable SSO protection — **not recommended**, it is currently the only thing
   protecting the deployment.

No endpoint gets exposed publicly without Fon's explicit go-ahead.

---

## Privacy: Work tasks

Work may involve confidential clients. The design assumes titles use **initials
or internal reference numbers** — `"Call A.B. re: rescheduling"`, `"File ref
#2291 status update"` — and the Work card says so in its status note.

Diagnoses, case details, legal strategy, and health information are **not** to
be stored in Fon's OS unless and until a compliant workflow is deliberately
designed and approved. Nothing in Phases 3–5 creates a place for that material.
