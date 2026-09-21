#!/usr/bin/env node
//
// Turns a Fon's OS backup file into an idempotent SQL script.
//
//   node supabase/import/generate-sql.mjs fon-os-backup-2026-09-21.json > import.sql
//
// Then paste import.sql into the Supabase SQL editor, or apply it with psql.
// This script never connects to a database and never reads a credential, so it
// is safe to run anywhere. Your phone's local copy is not touched: the backup
// file is read-only input.

import { readFile } from "node:fs/promises";

import { buildImportSql } from "./rows.mjs";

const [, , path, label = ""] = process.argv;

if (!path) {
  console.error("usage: node supabase/import/generate-sql.mjs <backup.json> [label]");
  process.exit(2);
}

try {
  const exported = JSON.parse(await readFile(path, "utf8"));
  process.stdout.write(buildImportSql(exported, { label }));
} catch (error) {
  console.error(`Could not build the import: ${error.message}`);
  process.exit(1);
}
