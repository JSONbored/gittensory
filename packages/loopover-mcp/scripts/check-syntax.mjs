#!/usr/bin/env node
// Syntax-verifies every compiled/hand-written .js file in bin/ and lib/ via `node --check`. Replaces a
// previously hand-listed chain of individual `node --check <file>` commands in package.json's own
// "build" script -- that list had to be kept in sync by hand every time a file was added, removed, or
// migrated to TypeScript (#7291 / #7328). Glob-driven instead: covers every .js file in bin/lib
// automatically, migrated or not, with no list to fall out of date.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function listJsFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(dir, entry.name));
}

const files = [...listJsFiles("bin"), ...listJsFiles("lib")].sort();

const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    failures.push({ file, message: error.stderr?.toString().trim() || String(error) });
  }
}

if (failures.length > 0) {
  for (const { file, message } of failures) {
    console.error(`${file}:\n${message}\n`);
  }
  console.error(`node --check failed for ${failures.length} of ${files.length} file(s).`);
  process.exit(1);
}

console.log(`node --check passed for all ${files.length} files in bin/ and lib/.`);
