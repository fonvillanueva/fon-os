#!/usr/bin/env node
//
// Concatenates supabase/migrations/*.sql into supabase/apply-all.sql, so the
// whole schema can be applied in one paste into the Supabase SQL Editor.
//
// The output is committed, and supabase/tests/apply-all.test.mjs fails if it
// ever drifts from the migration files. Run: npm run db:build-apply-all

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
export const APPLY_ALL = join(ROOT, "supabase", "apply-all.sql");

const HEADER = `-- ─── FON'S OS — PHASE 3 SCHEMA ────────────────────────────────────────────────
--
-- GENERATED FILE. Do not edit by hand.
-- Source: supabase/migrations/*.sql   Rebuild: npm run db:build-apply-all
--
-- Paste the whole file into the Supabase SQL Editor and run it, or:
--   psql "$SUPABASE_DB_URL" -f supabase/apply-all.sql
--
-- Safe to run more than once: every statement is guarded, so re-running is a
-- no-op and will not duplicate a constraint, index or trigger, or disturb rows.
--
-- This creates tables with RLS enabled, forced, and NO policies. That denies
-- every row to every role except one holding BYPASSRLS. Nothing can read the
-- board until Phase 4 adds policies. That is intended.
--
-- Afterwards, run supabase/verify.sql to confirm the result.
`;

export async function buildApplyAll() {
  const files = (await readdir(MIGRATIONS)).filter((n) => n.endsWith(".sql")).sort();
  const parts = [HEADER];

  for (const name of files) {
    const sql = (await readFile(join(MIGRATIONS, name), "utf8")).trimEnd();
    parts.push(
      `\n-- ═══════════════════════════════════════════════════════════════════════════\n` +
        `-- ${name}\n` +
        `-- ═══════════════════════════════════════════════════════════════════════════\n\n` +
        `${sql}\n`,
    );
  }
  return parts.join("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await writeFile(APPLY_ALL, await buildApplyAll());
  console.log(`Wrote ${APPLY_ALL}`);
}
