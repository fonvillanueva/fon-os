-- ─── AUDIT / IDEMPOTENCY / IMPORT BOOKKEEPING ─────────────────────────────────
--
-- Three tables Phase 5 depends on. Created now so the schema is complete and
-- reviewable, but nothing writes to them yet.

-- Append-only record of every write Pong makes. No foreign key to tasks: the
-- log must outlive the row it describes.
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  action     text not null,
  task_id    uuid,
  before     jsonb,
  after      jsonb,
  request_id text,

  constraint audit_log_actor_valid
    check (actor in ('fon', 'abigail', 'pong', 'claude-import')),
  constraint audit_log_action_not_blank
    check (length(btrim(action)) > 0)
);

comment on table public.audit_log is
  'Append-only. UPDATE and DELETE raise, including for service_role, which bypasses RLS but not triggers.';

create index if not exists audit_log_task_id_idx on public.audit_log (task_id);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app.forbid_mutation();

-- Replay protection for Pong. A repeated voice request carrying the same key
-- returns the stored response instead of acting twice.
create table if not exists public.idempotency_keys (
  key        text primary key,
  actor      text not null,
  task_id    uuid,
  response   jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),

  constraint idempotency_keys_actor_valid
    check (actor in ('fon', 'abigail', 'pong', 'claude-import')),
  constraint idempotency_keys_key_not_blank
    check (length(btrim(key)) > 0),
  constraint idempotency_keys_expiry_after_creation
    check (expires_at > created_at)
);

comment on table public.idempotency_keys is
  'Phase 5 replay protection: duplicate voice requests must not create duplicate tasks.';

create index if not exists idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

-- One row per applied import file. The checksum makes re-running the same
-- export a no-op at the batch level, before any task row is touched.
create table if not exists public.import_batches (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  source_label text not null default '',
  checksum     text not null,
  task_count   integer not null default 0,
  imported_at  timestamptz not null default now(),

  constraint import_batches_kind_valid
    check (kind in ('local-json', 'claude-school')),
  constraint import_batches_checksum_valid
    check (checksum ~ '^[0-9a-f]{64}$'),
  constraint import_batches_task_count_non_negative
    check (task_count >= 0),
  constraint import_batches_unique_payload
    unique (kind, checksum)
);

comment on table public.import_batches is
  'Duplicate protection for imports: the same payload can be applied repeatedly with no effect.';
comment on column public.import_batches.checksum is
  'SHA-256 of the canonicalised payload, lowercase hex.';
