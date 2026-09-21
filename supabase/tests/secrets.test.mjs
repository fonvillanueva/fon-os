// Enforces the boundary between public configuration and secrets.
//
// Vite inlines every VITE_-prefixed variable into the browser bundle, so the
// prefix *is* the boundary. These tests fail if a secret ever crosses it, or if
// a real key is committed.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every tracked text file we author, excluding build output and dependencies. */
async function sourceFiles(dir = ROOT, acc = []) {
  const skip = new Set(["node_modules", ".git", "dist", "coverage", ".vercel"]);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, acc);
    else if (/\.(js|jsx|mjs|cjs|ts|tsx|sql|json|md|html|css|webmanifest|example)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const SECRET_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL", "PONG_API_TOKEN"];

describe("secrets never reach the browser bundle", () => {
  it("no secret is given a VITE_ prefix anywhere", async () => {
    const offenders = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, "utf8");
      for (const name of SECRET_NAMES) {
        if (text.includes(`VITE_${name}`)) offenders.push(`${file}: VITE_${name}`);
      }
      if (/VITE_[A-Z0-9_]*(SERVICE_ROLE|SECRET|PASSWORD|PRIVATE_KEY|DB_URL)/.test(text)) {
        offenders.push(`${file}: secret-shaped VITE_ variable`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("nothing under src/ reads a server-only secret", async () => {
    const offenders = [];
    for (const file of await sourceFiles(join(ROOT, "src"))) {
      const text = await readFile(file, "utf8");
      for (const name of SECRET_NAMES) {
        if (text.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the import tooling needs no credential at all", async () => {
    for (const name of ["rows.mjs", "generate-sql.mjs"]) {
      const text = await readFile(join(ROOT, "supabase", "import", name), "utf8");
      for (const secret of SECRET_NAMES) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/createClient|fetch\(|https?:\/\/[a-z0-9-]+\.supabase\.co/i);
    }
  });
});

describe("no real credential is committed", () => {
  it("contains no JWT, connection string with a password, or Supabase project URL", async () => {
    const offenders = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, "utf8");
      // Supabase keys are JWTs: three base64url segments starting with eyJ.
      if (/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./.test(text)) offenders.push(`${file}: JWT`);
      // A real postgres URL with credentials filled in (placeholders use <…>).
      if (/postgresql:\/\/(?!<)[^\s:]+:(?!<)[^\s@]+@/.test(text)) offenders.push(`${file}: db url`);
      // A concrete project ref rather than the <project-ref> placeholder.
      if (/https:\/\/(?!<)[a-z]{20}\.supabase\.co/.test(text)) offenders.push(`${file}: project url`);
    }
    expect(offenders).toEqual([]);
  });

  it("the committed env template holds placeholders only", async () => {
    const text = await readFile(join(ROOT, ".env.example"), "utf8");
    for (const line of text.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      expect(value, `${match[1]} must be a placeholder`).toMatch(/<.+>/);
    }
  });

  it("git ignores real env files but keeps the template", async () => {
    const text = await readFile(join(ROOT, ".gitignore"), "utf8");
    const lines = text.split("\n").map((l) => l.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
  });
});
