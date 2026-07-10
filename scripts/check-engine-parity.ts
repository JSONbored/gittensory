#!/usr/bin/env node
// Mechanical drift tripwire for hand-duplicated src/ <-> gittensory-engine file pairs (#4260). Most src/{review,
// settings,signals} modules are thin re-export shims over the engine, but ~15 twin files are still maintained in
// parallel — this script discovers those pairs, normalizes known-harmless import-path aliases, and fails CI when
// the normalized bodies diverge. Also compares the workspace-installed @jsonbored/gittensory-engine semver against
// the monorepo engine package's declared version (version-skew tripwire; no live-gate round-trip).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_PARITY_AREAS = Object.freeze(["review", "settings", "signals"] as const);
const ENGINE_SRC_ROOT = "packages/gittensory-engine/src";
const HOST_SRC_ROOT = "src";
const ENGINE_PACKAGE_JSON = "packages/gittensory-engine/package.json";
const MINER_ENGINE_PIN_FILE = "packages/gittensory-miner/expected-engine.version";
const ENGINE_PACKAGE_NAME = "@jsonbored/gittensory-engine";

export type EngineParityPair = {
  area: string;
  fileName: string;
  hostRelative: string;
  engineRelative: string;
  hostText: string;
  engineText: string;
};

export type EngineParityReadFile = (root: string, relativePath: string) => string;
export type EngineParityListDir = (root: string, relativePath: string) => string[];

function defaultReadFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function defaultListDir(root: string, relativePath: string): string[] {
  try {
    return readdirSync(join(root, relativePath));
  } catch {
    return [];
  }
}

/** Map equivalent relative import paths so import-only drift between host and engine copies does not false-fail. */
export function normalizeImportSpec(spec: string): string {
  let normalized = spec;
  if (normalized.endsWith(".js")) normalized = normalized.slice(0, -3);
  if (/^\.\.\/types\/[\w-]+$/.test(normalized)) normalized = "../types";
  if (normalized === "../focus-manifest/guidance") normalized = "../signals/focus-manifest";
  return normalized;
}

/** Normalize line endings and canonicalize relative `from` specifiers before byte comparison. */
export function normalizeEngineParityText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line.replace(/from\s+['"](\.\.\/[^'"]+)['"]/g, (_match, spec: string) => `from "${normalizeImportSpec(spec)}"`),
    )
    .join("\n");
}

/** True when the host copy is only a thin re-export of the engine module (not a hand-duplicated twin). */
export function isThinEngineReExportShim(srcText: string): boolean {
  const stripped = srcText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .join("\n");
  return /^export\s+(\{[\s\S]*\}|\*)\s+from\s+['"][^'"]*gittensory-engine[^'"]*['"];?\s*$/.test(stripped);
}

/** True when the engine twin is a placeholder stub (e.g. check-names) rather than a full parallel copy.
 *  Thresholds mirror the 2026-07-08 audit: engine stubs were <250 non-whitespace chars while host copies were
 *  3×+ larger (check-names ~14 lines vs engine ~2; review-thread-findings ~98 vs ~2). */
export function isEngineStubPair(srcText: string, engineText: string): boolean {
  const compact = (text: string) => text.replace(/\s/g, "").length;
  const engineCompact = compact(engineText);
  const srcCompact = compact(srcText);
  return engineCompact > 0 && srcCompact > engineCompact * 3 && engineCompact < 250;
}

/**
 * Discover in-scope hand-duplicated twins under src/{review,settings,signals} that also exist in the engine tree
 * and are neither host shims nor engine stubs.
 */
export function discoverEngineParityPairs({
  root,
  listDir = defaultListDir,
  readFile = defaultReadFile,
}: {
  root: string;
  listDir?: EngineParityListDir;
  readFile?: EngineParityReadFile;
}): EngineParityPair[] {
  const pairs: EngineParityPair[] = [];
  for (const area of ENGINE_PARITY_AREAS) {
    const hostDir = join(HOST_SRC_ROOT, area);
    const engineDir = join(ENGINE_SRC_ROOT, area);
    const hostFiles = listDir(root, hostDir).filter((name) => name.endsWith(".ts"));
    const engineFiles = new Set(listDir(root, engineDir).filter((name) => name.endsWith(".ts")));
    for (const fileName of hostFiles.sort()) {
      if (!engineFiles.has(fileName)) continue;
      const hostRelative = join(hostDir, fileName);
      const engineRelative = join(engineDir, fileName);
      const hostText = readFile(root, hostRelative);
      const engineText = readFile(root, engineRelative);
      if (isThinEngineReExportShim(hostText)) continue;
      if (isEngineStubPair(hostText, engineText)) continue;
      pairs.push({ area, fileName, hostRelative, engineRelative, hostText, engineText });
    }
  }
  return pairs;
}

/**
 * Compare normalized bodies of every discovered pair. Returns `{ failures, pairsChecked }` — pure given injectable IO.
 */
export function checkEngineParityDrift({
  root,
  readFile = defaultReadFile,
  listDir = defaultListDir,
}: {
  root: string;
  readFile?: EngineParityReadFile;
  listDir?: EngineParityListDir;
}): { failures: string[]; pairsChecked: EngineParityPair[] } {
  const pairs = discoverEngineParityPairs({ root, readFile, listDir });
  const failures: string[] = [];
  for (const pair of pairs) {
    const normalizedHost = normalizeEngineParityText(pair.hostText);
    const normalizedEngine = normalizeEngineParityText(pair.engineText);
    if (normalizedHost !== normalizedEngine) {
      failures.push(
        [
          `${pair.hostRelative} and ${pair.engineRelative} have drifted apart (normalized comparison).`,
          `Edit both copies together or convert the host file to a thin engine re-export shim.`,
        ].join("\n"),
      );
    }
  }
  return { failures, pairsChecked: pairs };
}

/** Parse `major.minor.patch` prefix; non-numeric prerelease segments compare as equal at the patch level. */
export function parseSemverCore(version: string): [number, number, number] | null {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two semver strings. Returns `-1` (installed behind expected), `0` (equal), or `1` (installed ahead).
 * Unparseable versions are treated as behind so the skew check fails loudly.
 */
export function compareSemver(installed: string, expected: string): -1 | 0 | 1 {
  const installedCore = parseSemverCore(installed);
  const expectedCore = parseSemverCore(expected);
  if (!installedCore || !expectedCore) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (installedCore[index]! < expectedCore[index]!) return -1;
    if (installedCore[index]! > expectedCore[index]!) return 1;
  }
  return 0;
}

/** Human-readable skew label for doctor output and test assertions. */
export function describeEngineVersionSkew(installed: string, expected: string): "behind" | "equal" | "ahead" {
  const comparison = compareSemver(installed, expected);
  if (comparison < 0) return "behind";
  if (comparison > 0) return "ahead";
  return "equal";
}

export function defaultResolveInstalledEngineVersion(root: string): string | null {
  try {
    const engineEntry = join(root, "node_modules", ENGINE_PACKAGE_NAME, "package.json");
    if (!existsSync(engineEntry)) return null;
    return JSON.parse(readFileSync(engineEntry, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export function defaultReadExpectedEngineVersion(root: string, readFile: EngineParityReadFile = defaultReadFile): string | null {
  try {
    const text = readFile(root, ENGINE_PACKAGE_JSON);
    return JSON.parse(text).version ?? null;
  } catch {
    return null;
  }
}

export type EngineVersionSkewResult = {
  failures: string[];
  installed: string | null;
  expected: string | null;
  skew: string;
};

/**
 * Version-skew tripwire: installed @jsonbored/gittensory-engine must be >= the monorepo engine package version.
 * Returns `{ failures, installed, expected, skew }`.
 */
export function checkEngineVersionSkew({
  root,
  readFile = defaultReadFile,
  resolveInstalled = defaultResolveInstalledEngineVersion,
  readExpected = (r) => defaultReadExpectedEngineVersion(r, readFile),
}: {
  root: string;
  readFile?: EngineParityReadFile;
  resolveInstalled?: (root: string) => string | null;
  readExpected?: (root: string) => string | null;
}): EngineVersionSkewResult {
  const failures: string[] = [];
  const installed = resolveInstalled(root);
  const expected = readExpected(root);
  const skew = installed && expected ? describeEngineVersionSkew(installed, expected) : "unknown";

  if (!expected) {
    failures.push(`Could not read expected engine version from ${ENGINE_PACKAGE_JSON}.`);
  } else if (!installed) {
    failures.push(`${ENGINE_PACKAGE_NAME} is not installed under node_modules (cannot verify version skew).`);
  } else if (compareSemver(installed, expected) < 0) {
    failures.push(
      `${ENGINE_PACKAGE_NAME} version skew: installed ${installed} is behind expected minimum ${expected}.`,
    );
  }

  return { failures, installed, expected, skew };
}

/** Fail when the published-miner pin drifts from the monorepo engine package version. */
export function checkMinerEngineVersionPinSync({
  root,
  readFile = defaultReadFile,
  readExpected = (r) => defaultReadExpectedEngineVersion(r, readFile),
}: {
  root: string;
  readFile?: EngineParityReadFile;
  readExpected?: (root: string) => string | null;
}): { failures: string[]; expected: string | null; pin: string | null } {
  const failures: string[] = [];
  const expected = readExpected(root);
  let pin: string | null = null;
  try {
    pin = readFile(root, MINER_ENGINE_PIN_FILE).trim() || null;
  } catch {
    pin = null;
  }
  if (expected && pin && expected !== pin) {
    failures.push(
      `${MINER_ENGINE_PIN_FILE} (${pin}) is out of sync with ${ENGINE_PACKAGE_JSON} (${expected}).`,
    );
  } else if (expected && !pin) {
    failures.push(`Could not read miner engine version pin from ${MINER_ENGINE_PIN_FILE}.`);
  }
  return { failures, expected, pin };
}

// ── Gate-logic version-bump tripwire (#4518) ────────────────────────────────────────────────────────────────
// The hand-duplicated GATE-DECISION engine pair. Unlike ENGINE_PARITY_AREAS' area-scanned twins (same
// directory name, same filename in both trees, expected to be byte-identical after import normalization),
// this pair lives at DIFFERENT paths on each side and the engine copy is a DELIBERATE SUBSET (no check-run-
// formatting/issue-advisory code a miner's local prediction never needs — only the actual gate-decision
// functions: evaluateGateCheck, isConfiguredGateBlocker, buildPullRequestAdvisory, and their helpers). A
// byte-comparison check (even normalized) would false-fail here on both legitimate scope differences and
// harmless style differences (e.g. `?? 0` vs an explicit null/undefined check, or an extracted helper
// function) that a straight text diff can't distinguish from a real logic change. So instead of content
// parity, this enforces a LIGHTER, MECHANICAL tripwire (#4518's own framing, vs #4257's heavier behavioral
// cross-check): touch EITHER twin's gate-decision logic and you must ALSO bump
// packages/gittensory-engine/package.json's version, so a stale locally-installed engine copy (the
// #2333/#2334 local iterate-loop's eventual dependency) has a real, discoverable signal for how far behind
// main's actual gate-decision rules it is — rather than silently, indefinitely drifting the way
// linkedIssueSatisfactionGateMode (#1961/#3906) did before this issue's own audit found it missing entirely
// from the engine copy (ported back in this same PR).
export const GATE_LOGIC_TWIN_FILES = Object.freeze(["src/rules/advisory.ts", "packages/gittensory-engine/src/advisory/gate-advisory.ts"] as const);

export type GateLogicVersionBumpResult = { failures: string[]; touchedTwins: string[] };

/**
 * Pure: given the set of files THIS PR changed and whether the engine package's version string itself
 * changed, fail when a gate-logic twin was touched without a version bump. Neither twin touched, or a bump
 * present alongside a touched twin, both pass — this never fires for the common case (a PR touching neither
 * file at all).
 */
export function checkGateLogicVersionBump({
  changedFiles,
  engineVersionChanged,
}: {
  changedFiles: string[];
  engineVersionChanged: boolean;
}): GateLogicVersionBumpResult {
  const changed = new Set(changedFiles);
  const touchedTwins = GATE_LOGIC_TWIN_FILES.filter((file) => changed.has(file));
  if (touchedTwins.length === 0 || engineVersionChanged) return { failures: [], touchedTwins };
  return {
    touchedTwins,
    failures: [
      [
        `This PR changes gate-decision logic (${touchedTwins.join(", ")}) without bumping`,
        `${ENGINE_PACKAGE_JSON}'s version. Either twin changing the live gate's rules means a locally-installed`,
        `${ENGINE_PACKAGE_NAME} copy is now stale relative to main -- bump the version (even a patch bump)`,
        `so that staleness has a real, discoverable signal (see checkEngineVersionSkew /`,
        `checkMinerEngineVersionPinSync).`,
      ].join(" "),
    ],
  };
}

/** Real IO: the list of files this PR changed, via `git diff --name-only <base>...HEAD`. Fails SAFE to an
 *  empty list (never blocks a PR over an unrelated git/environment hiccup — this is a cost-control-style
 *  mechanical tripwire, not a correctness gate). */
export function defaultGetChangedFiles(root: string, baseRef: string = "origin/main"): string[] {
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd: root, encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Real IO: whether packages/gittensory-engine/package.json's `version` field differs from the base ref's
 *  copy. Fails SAFE to `true` (already-changed) when the base ref's copy can't be resolved (e.g. the file is
 *  new on this branch, or a shallow clone) -- an environment limitation must never masquerade as "you forgot
 *  to bump it". */
export function defaultDidEngineVersionChange(root: string, baseRef: string = "origin/main"): boolean {
  try {
    const baseText = execFileSync("git", ["show", `${baseRef}:${ENGINE_PACKAGE_JSON}`], { cwd: root, encoding: "utf8" });
    const baseVersion = JSON.parse(baseText).version ?? null;
    const currentVersion = defaultReadExpectedEngineVersion(root);
    return baseVersion !== currentVersion;
  } catch {
    return true;
  }
}

/** @internal CLI entry for the gate-logic version-bump tripwire, kept SEPARATE from runEngineParityMain
 *  (below) rather than folded into its default check set: that function's own regression-guard tests assert
 *  a clean `failures: []` result for `process.cwd()` unconditionally, which a git-diff-dependent check must
 *  never risk breaking on an environment without a resolvable `origin/main` (a shallow clone, a detached
 *  fetch, ...). This check gets its own opt-in CLI flag and CI step instead. */
export function runGateLogicVersionBumpMain(root: string = process.cwd(), baseRef?: string): number {
  const changedFiles = defaultGetChangedFiles(root, baseRef);
  const engineVersionChanged = defaultDidEngineVersionChange(root, baseRef);
  const { failures } = checkGateLogicVersionBump({ changedFiles, engineVersionChanged });

  if (failures.length > 0) {
    console.error(`Gate-logic version-bump check found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(failure);
    return 1;
  }

  console.log("Gate-logic version-bump check ok.");
  return 0;
}

/** Run both the file-pair drift check and the version-skew check. */
export function runEngineParityChecks(options: {
  root: string;
  readFile?: EngineParityReadFile;
  listDir?: EngineParityListDir;
  resolveInstalled?: (root: string) => string | null;
  readExpected?: (root: string) => string | null;
}): {
  failures: string[];
  pairsChecked: EngineParityPair[];
  versionSkew: EngineVersionSkewResult;
} {
  const drift = checkEngineParityDrift(options);
  const skew = checkEngineVersionSkew(options);
  const pinSync = checkMinerEngineVersionPinSync(options);
  return {
    failures: [...drift.failures, ...skew.failures, ...pinSync.failures],
    pairsChecked: drift.pairsChecked,
    versionSkew: skew,
  };
}

/** @internal Exported for subprocess-free unit tests of the CLI success/failure paths. */
export function runEngineParityMain(root: string = process.cwd()): number {
  const { failures, pairsChecked, versionSkew } = runEngineParityChecks({ root });

  if (failures.length > 0) {
    console.error(`Engine-parity check found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(failure);
    return 1;
  }

  console.log(
    `Engine-parity check ok: ${pairsChecked.length} hand-duplicated file pair(s) agree; ` +
      `${ENGINE_PACKAGE_NAME} ${versionSkew.installed} is ${versionSkew.skew} vs expected ${versionSkew.expected}.`,
  );
  return 0;
}

function main(): void {
  if (process.argv.includes("--gate-logic-version-bump")) {
    process.exit(runGateLogicVersionBumpMain(process.cwd()));
    return;
  }
  process.exit(runEngineParityMain(process.cwd()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
