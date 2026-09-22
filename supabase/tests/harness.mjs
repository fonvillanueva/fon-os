// Applies the real migration files to a real Postgres (PGlite, Postgres 18
// compiled to WASM) so the tests exercise the SQL that will run on Supabase,
// not a paraphrase of it. No network, no hosted project, no credentials.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, "..", "migrations");
export const ROLLBACK_FILE = join(HERE, "..", "rollback.sql");
export const ROLLBACK_PHASE_4_FILE = join(HERE, "..", "rollback-phase-4.sql");

/**
 * Objects Supabase provides that a bare Postgres does not. Creating them here
 * — rather than inside a migration — keeps the migrations honest: they are
 * exactly what will be applied to the hosted project.
 */
const SUPABASE_BOOTSTRAP = `
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique
  );
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin bypassrls;
    end if;
  end;
  $$;
  grant usage on schema public to anon, authenticated, service_role;

  -- Supabase grants USAGE on the auth schema to the API roles, which is what
  -- lets a policy call auth.uid() while running as the authenticated role.
  -- Mirrored here because Phase 4 depends on it; verify.sql check 5a pins it.
  grant usage on schema auth to anon, authenticated, service_role;

  -- Supabase's own auth.uid(). Reproduced faithfully: it reads the 'sub' claim
  -- out of the request.jwt.claims GUC that PostgREST sets per request, and
  -- returns NULL when there is no session. Phase 4's role function and its
  -- stamping trigger both hinge on that NULL, so the stub must behave the same.
  --
  -- The inner nullif matters: a signed-out session leaves the GUC set to the
  -- empty string, and ''::jsonb is a hard error rather than a null.
  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select nullif(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', ''
    )::uuid
  $$;

  -- Supabase's auth.jwt(). Present only so the D5a invariant is testable: a
  -- policy gating on an assurance claim has to be creatable before a check can
  -- be shown to catch it. Nothing in the migrations uses it, by design.
  create or replace function auth.jwt()
  returns jsonb
  language sql
  stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    )
  $$;
`;

export async function migrationFiles() {
  const names = await readdir(MIGRATIONS_DIR);
  return names.filter((n) => n.endsWith(".sql")).sort();
}

export async function readMigration(name) {
  return readFile(join(MIGRATIONS_DIR, name), "utf8");
}

/** @returns {Promise<PGlite>} a database with every migration applied. */
export async function freshDb({ migrate = true } = {}) {
  const db = await new PGlite();
  await db.exec(SUPABASE_BOOTSTRAP);
  if (migrate) await applyMigrations(db);
  return db;
}

export async function applyMigrations(db) {
  for (const name of await migrationFiles()) {
    await db.exec(await readMigration(name));
  }
}

export async function applyRollback(db) {
  await db.exec(await readFile(ROLLBACK_FILE, "utf8"));
}

export async function applyPhase4Rollback(db) {
  await db.exec(await readFile(ROLLBACK_PHASE_4_FILE, "utf8"));
}

/** Fixed ids per role, so failures name a recognisable user rather than a nonce. */
export const USER_IDS = {
  fon: "00000000-0000-4000-8000-00000000f0f0",
  abigail: "00000000-0000-4000-8000-0000000ab1ba",
  accountability: "00000000-0000-4000-8000-00000000acc0",
};

/** Creates an auth.users row plus its profiles row, and returns the user id. */
export async function enrol(db, role, { id, email } = {}) {
  const userId = id ?? USER_IDS[role];
  if (!userId) throw new Error(`no fixed user id for role ${role}`);
  await db.query("insert into auth.users (id, email) values ($1, $2)", [
    userId,
    email ?? `${role}@example.test`,
  ]);
  await db.query("insert into public.profiles (user_id, role) values ($1, $2)", [userId, role]);
  return userId;
}

/** An auth.users row with NO profile — the state a stray signup lands in. */
export async function signUpWithoutProfile(db, id = "00000000-0000-4000-8000-00000000ffff") {
  await db.query("insert into auth.users (id, email) values ($1, 'stray@example.test')", [id]);
  return id;
}

/**
 * Runs `fn` as a signed-in PostgREST session: role `authenticated`, with
 * request.jwt.claims carrying `sub`, exactly as Supabase presents it. Pass a
 * null userId for a signed-out session.
 *
 * The role and the GUC are always restored, including when `fn` throws, so one
 * failing expectation cannot leak a role into the next test.
 */
export async function withUser(db, userId, fn) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    userId === null ? "" : JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  await db.exec("set role authenticated");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

/** Same, for `anon`: no session at all. */
export async function withAnon(db, fn) {
  await db.query("select set_config('request.jwt.claims', '', false)");
  await db.exec("set role anon");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

/**
 * Empties every table without touching the schema. Booting PGlite costs about
 * two seconds, so tests share one engine and reset between cases.
 */
export async function resetDb(db) {
  await db.exec(`
    truncate table
      public.tasks,
      public.area_notes,
      public.profiles,
      public.idempotency_keys,
      public.import_batches,
      auth.users
    restart identity cascade;
    -- audit_log refuses TRUNCATE as well as UPDATE/DELETE, so both guards have
    -- to come off. DISABLE TRIGGER USER covers them without touching internal
    -- constraint triggers, and survives a third guard being added later.
    alter table public.audit_log disable trigger user;
    truncate table public.audit_log restart identity cascade;
    alter table public.audit_log enable trigger user;
  `);
}

/** Table and column inventory, for comparing schema states across runs. */
export async function schemaSnapshot(db) {
  const { rows } = await db.query(`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name
  `);
  return rows;
}

export async function publicTables(db) {
  const { rows } = await db.query(`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `);
  return rows.map((r) => r.tablename);
}

/** A minimal valid task row, so each test varies only the field it is about. */
export function taskRow(overrides = {}) {
  return {
    id: "3f1a6c2e-8b55-4a71-9d44-0c2e17ab9f10",
    title: "Read chapter 4",
    area: "school",
    status: "open",
    priority: "—",
    visibility: "private",
    created_by: "fon",
    source: "manual",
    ...overrides,
  };
}

export async function insertTask(db, overrides = {}) {
  const row = taskRow(overrides);
  const keys = Object.keys(row);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  return db.query(
    `insert into public.tasks (${keys.join(", ")}) values (${placeholders}) returning *`,
    Object.values(row),
  );
}

/** Runs `fn` and returns the Postgres error, asserting that one was raised. */
export async function expectViolation(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}
