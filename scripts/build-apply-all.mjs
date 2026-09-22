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

const HEADER = `-- ─── FON'S OS — DATABASE SCHEMA (PHASE 3 + PHASE 4) ──────────────────────────
--
-- GENERATED FILE. Do not edit by hand.
-- Source: supabase/migrations/*.sql   Rebuild: npm run db:build-apply-all
--
-- Paste the whole file into the Supabase SQL Editor and run it, or:
--   psql "$SUPABASE_DB_URL" -f supabase/apply-all.sql
--
-- Safe to run more than once: every statement is guarded, so re-running is a
-- no-op and will not duplicate a constraint, index, trigger or policy, or
-- disturb rows.
--
-- Phase 3 creates the tables with RLS enabled and FORCED. Phase 4 adds the
-- first policies: fifteen of them, every one scoped to a person's role in
-- public.profiles. An account with no profiles row still reaches nothing, and
-- nothing here creates one — enrolment stays a deliberate manual step.
--
-- NOT granted by this file: any access to audit_log, idempotency_keys or
-- import_batches; any write path to profiles; any DELETE for Abigail.
--
-- Afterwards, run supabase/verify.sql to confirm the result. Check 18 is
-- EXPECTED to FAIL on Supabase — accepted residual RES-001.
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
