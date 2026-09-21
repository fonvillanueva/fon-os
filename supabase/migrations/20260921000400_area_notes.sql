-- ─── AREA NOTES ───────────────────────────────────────────────────────────────
--
-- The one-line status note shown at the top of each card in My View. Keyed by
-- area, so there is exactly one per area and an import is an upsert.

create table if not exists public.area_notes (
  area       text primary key,
  note       text not null default '',
  updated_at timestamptz not null default now(),

  constraint area_notes_area_valid
    check (area in ('inbox', 'school', 'work', 'reading', 'family', 'faith', 'home'))
);

comment on table public.area_notes is
  'Per-area status note. The School note is the only one the Accountability View may read in Phase 4.';

drop trigger if exists area_notes_touch_updated_at on public.area_notes;
create trigger area_notes_touch_updated_at
  before update on public.area_notes
  for each row execute function app.touch_updated_at();
