-- ─── TASKS ────────────────────────────────────────────────────────────────────
--
-- One row per task, mirroring the flat array the app already keeps in
-- localStorage (src/lib/model.js). Every field the app carries is represented,
-- so nothing is lost on import: provenance (created_by, source), ownership,
-- visibility, notes, priority, due date and time, completion state, and all
-- three timestamps.
--
-- `id` has a default but the app supplies its own v4 UUID, which is why Phase 2
-- made every id a real UUID. An import is a straight copy, not a re-key.

create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  notes        text not null default '',
  area         text not null,
  status       text not null default 'open',
  priority     text not null default '—',
  due_date     date,
  due_time     time,
  owner        text,
  visibility   text not null default 'private',
  created_by   text not null default 'fon',
  source       text not null default 'manual',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz,

  -- Set by the Claude school importer so a re-import updates rather than
  -- duplicates. Null for anything a human or Pong created.
  import_key   text,

  constraint tasks_title_not_blank
    check (length(btrim(title)) > 0),

  constraint tasks_area_valid
    check (area in ('inbox', 'school', 'work', 'reading', 'family', 'faith', 'home')),

  constraint tasks_status_valid
    check (status in ('open', 'done', 'archived')),

  constraint tasks_priority_valid
    check (priority in ('—', '!', '!!')),

  constraint tasks_visibility_valid
    check (visibility in ('private', 'shared')),

  constraint tasks_created_by_valid
    check (created_by in ('fon', 'abigail', 'pong', 'claude-import')),

  constraint tasks_source_valid
    check (source in ('manual', 'pong-voice', 'claude-import', 'abigail')),

  -- The Phase 2 sharing invariant, now enforced by the database. Abigail can
  -- only ever reach Family and Home, so a task outside those areas can never be
  -- marked shared — not by a bug, not by a bad import, not by direct SQL.
  constraint tasks_shared_only_in_shared_areas
    check (visibility = 'private' or area in ('family', 'home')),

  -- Mirrors normalizeTask: a time with no date is meaningless.
  constraint tasks_due_time_requires_due_date
    check (due_time is null or due_date is not null),

  -- open must have no completion time; done must have one. Archived is left
  -- permissive so a completed task keeps its history when it is archived.
  -- CASE rather than a biconditional so an unknown status falls through to
  -- tasks_status_valid, which reports the actual problem.
  constraint tasks_completed_at_matches_status
    check (
      case status
        when 'open' then completed_at is null
        when 'done' then completed_at is not null
        else true
      end
    ),

  -- The app stores an absent owner as "", which must not reach the database as
  -- a value distinct from "no owner".
  constraint tasks_owner_not_blank
    check (owner is null or length(btrim(owner)) > 0),

  constraint tasks_import_key_not_blank
    check (import_key is null or length(btrim(import_key)) > 0)
);

comment on table public.tasks is
  'Every task across all seven areas. RLS is enabled and forced with no policies: unreachable until Phase 4.';
comment on column public.tasks.id is
  'v4 UUID. The app generates its own ids, so an import copies them unchanged.';
comment on column public.tasks.visibility is
  'shared is only legal in family and home — see tasks_shared_only_in_shared_areas.';
comment on column public.tasks.import_key is
  'Stable key from a Claude school import file. Unique per source; null otherwise.';

-- Duplicate protection for re-imported Claude files. A partial index because
-- null import_keys must never collide with one another.
create unique index if not exists tasks_source_import_key_unique
  on public.tasks (source, import_key)
  where import_key is not null;

create index if not exists tasks_area_status_idx on public.tasks (area, status);
create index if not exists tasks_due_date_idx on public.tasks (due_date) where due_date is not null;
create index if not exists tasks_open_idx on public.tasks (area) where status = 'open';

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function app.touch_updated_at();
