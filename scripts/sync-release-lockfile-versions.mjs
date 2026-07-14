#!/usr/bin/env node
// release-please's `extra-files` JSON-path updater doesn't reliably reach package-lock.json's
// per-workspace version fields, whose keys contain slashes (e.g. "packages/loopover-engine")
// nested under a manifest-mode component's own release-please-config.json block -- confirmed
// empirically (mcp-v0.7.0/engine-v0.2.0 dry runs both left package-lock.json un-synced, breaking
// `npm ci` with "Missing: @loopover/engine@0.1.0 from lock file"). This does the same
// single-line replacement a human would make by hand: find the workspace's own manifest-mirror
// entry, replace just its "version" value. No JSON.parse/stringify round-trip on the whole
// multi-thousand-line lockfile, which would risk reordering/reformatting far beyond the one line
// that actually changed.
import { readFileSync, writeFileSync } from "node:fs";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node sync-release-lockfile-versions.mjs <workspace-path> [<workspace-path> ...]");
  process.exit(1);
}

const lockPath = "package-lock.json";
let content = readFileSync(lockPath, "utf8");
let changed = false;

for (const workspacePath of targets) {
  const version = JSON.parse(readFileSync(`${workspacePath}/package.json`, "utf8")).version;
  const escapedKey = workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchors on the workspace's own block header + its "name" line (both stable, unique) so this
  // can't accidentally match a different package's "version" line elsewhere in the file.
  const pattern = new RegExp(`("${escapedKey}":\\s*\\{\\s*\\n\\s*"name":[^\\n]*\\n\\s*"version":\\s*")[^"]*(")`);
  if (!pattern.test(content)) {
    console.error(`${workspacePath}: pattern not found in ${lockPath} -- nothing changed.`);
    continue;
  }
  const updated = content.replace(pattern, `$1${version}$2`);
  if (updated === content) {
    console.log(`${workspacePath}: already at ${version}.`);
  } else {
    content = updated;
    changed = true;
    console.log(`${workspacePath}: synced to ${version}.`);
  }
}

if (changed) writeFileSync(lockPath, content);
