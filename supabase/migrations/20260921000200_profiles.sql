-- ─── PROFILES (Phase 4 preparation only) ──────────────────────────────────────
--
-- Maps a Supabase Auth user to one of the three human roles. This migration
-- creates the vocabulary and the table; it deliberately does NOT create any
-- policy, grant, trigger or sign-up hook. Authentication is Phase 4.
--
-- Pong is intentionally absent: it is not a person and gets no auth user. It
-- will authenticate to our own server-side API in Phase 5, which then talks to
-- Postgres. Pong appears only in the `actor` vocabulary, as an attribution
-- value on tasks and audit rows.

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null,
  display_name text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint profiles_role_valid
    check (role in ('fon', 'abigail', 'accountability'))
);

comment on table public.profiles is
  'Phase 4 preparation. No policies and no grants: unreachable until Phase 4 adds them.';
comment on column public.profiles.role is
  'fon = everything; abigail = Family and Home only; accountability = read-only School summary.';

-- At most one Fon and one accountability viewer; Abigail is likewise singular
-- today but the constraint is expressed per-role so it can be relaxed later.
create unique index if not exists profiles_one_per_role
  on public.profiles (role)
  where role in ('fon', 'abigail', 'accountability');

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function app.touch_updated_at();
