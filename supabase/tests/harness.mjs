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
    alter table public.audit_log disable trigger audit_log_append_only;
    truncate table public.audit_log restart identity cascade;
    alter table public.audit_log enable trigger audit_log_append_only;
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
