// Test-skip-gaming analyzer. The test-ratio analyzer (test-ratio.ts) rewards a PR for adding test lines, but a
// test that is skipped, disabled, or narrowed to run alone never actually executes — padding the ratio signal
// without buying any real coverage. This analyzer flags two distinct shapes of that gaming, both diff-scoped
// (only lines the PR itself ADDS, never pre-existing code the diff doesn't touch):
//   1. A newly-added skip/disable marker in a test file (JS/TS `it.skip(`/`xdescribe(`/…, Python
//      `@pytest.mark.skip(if)`, JUnit `@Disabled`, Go `t.Skip(`) or a newly-added narrowing marker
//      (`it.only(`/`fdescribe(`/…) that silently excludes every sibling test from the run.
//   2. A CI workflow step that already runs a recognized test command and newly gains `continue-on-error: true`
//      or a literal `if: false` — neutered so the step can never fail the check regardless of outcome.
// Pure compute over `req.files[].patch`, no network. Reuses test-ratio.ts's isTestPath so the two analyzers
// agree on what a "test file" is.
import type { EnrichRequest, TestSkipGamingFinding } from "../types.js";
import { isWorkflowPath } from "../workflow-path.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const JS_TS_EXTS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]);
const PY_EXTS = new Set(["py"]);
const JVM_EXTS = new Set(["java", "kt", "kts"]);
const GO_EXTS = new Set(["go"]);

// JS/TS: `it`/`test`/`describe` called through `.skip(`, or the Jasmine/Jest `x`-prefixed disabled forms.
const JS_SKIP_RE = /\b(?:it|test|describe)\.skip\s*\(|\bx(?:describe|it|test)\s*\(/;
// JS/TS: `.only(` narrows the run to that one block; `fit(`/`fdescribe(` are Jasmine/Jest's focused forms.
// The leading `\b` means a real identifier ending in "fit"/"describe" (e.g. `profit(`, `xdescribe` handled
// above) cannot match — only the exact focused-test call shape does.
const JS_ONLY_RE = /\b(?:it|test|describe)\.only\s*\(|\bf(?:it|describe)\s*\(/;
const PY_SKIP_RE = /@pytest\.mark\.skip(?:if)?\b/;
const JVM_SKIP_RE = /@Disabled\b/;
const GO_SKIP_RE = /\bt\.Skip\s*\(/;

type LangRule = { skip: RegExp; only?: RegExp };
const LANG_RULES: Record<string, LangRule> = {};
for (const ext of JS_TS_EXTS) LANG_RULES[ext] = { skip: JS_SKIP_RE, only: JS_ONLY_RE };
for (const ext of PY_EXTS) LANG_RULES[ext] = { skip: PY_SKIP_RE };
for (const ext of JVM_EXTS) LANG_RULES[ext] = { skip: JVM_SKIP_RE };
for (const ext of GO_EXTS) LANG_RULES[ext] = { skip: GO_SKIP_RE };

// A YAML sequence-item step header (`- name:`, `- run:`, `- uses:`, a bare `- id:`, …). Requires a `key:`
// immediately after the dash so an ordinary scalar list entry under `with:`/`args:` (e.g. `- --fix`) is never
// mistaken for a new step.
const STEP_BOUNDARY_RE = /^\s*-\s+[A-Za-z][\w-]*\s*:/;
// A single-line `run: <command>`, with or without the step's own leading `- ` (the common one-line-step
// shorthand `- run: npm test`). A `run: |`/`run: >` block scalar's continuation lines are not tracked (no
// cross-line state), mirroring migration-safety.ts's precedent of skipping statements split across lines.
const RUN_KEY_RE = /^\s*(?:-\s+)?run\s*:(.*)$/i;
const TEST_COMMAND_RE =
  /\b(?:npm|yarn|pnpm)\s+(?:run\s+)?test\b|\b(?:python3?\s+-m\s+)?pytest\b|\bgo\s+test\b|\bmvn\b[^\n]*\btest\b|\bgradlew?\b[^\n]*\btest\b|\bjest\b|\bvitest\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bcargo\s+test\b|\bmake\s+test\b|\btox\b/i;
const CONTINUE_ON_ERROR_TRUE_RE = /^\s*continue-on-error\s*:\s*(['"]?)true\1\s*(?:#.*)?$/i;
const STEP_IF_FALSE_RE = /^\s*if\s*:\s*(['"]?)false\1\s*(?:#.*)?$/i;

function sourceExtOf(path: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? match[1]!.toLowerCase() : null;
}

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Whether `path` is a location this analyzer scans: a test file (skip/only markers) or a GitHub Actions
 *  workflow file (neutered test steps). Pure. */
export function isTestSkipGamingRelevantPath(path: string): boolean {
  return isWorkflowPath(path) || isTestPath(path);
}

function pushFinding(
  findings: TestSkipGamingFinding[],
  file: string,
  line: number,
  kind: TestSkipGamingFinding["kind"],
  maxFindings: number,
): boolean {
  findings.push({ file, line, kind });
  return findings.length >= maxFindings;
}

/** Scan one TEST file's patch for a newly added skip/disable or only/narrowing marker on an ADDED line. Pure. */
function scanTestFileMarkers(
  path: string,
  patch: string,
  limits: ScanLimits,
  maxFindings: number,
): TestSkipGamingFinding[] {
  const rules = LANG_RULES[sourceExtOf(path) ?? ""];
  const findings: TestSkipGamingFinding[] = [];
  if (!rules) return findings;

  let newLine = 0;
  let inHunk = false;

  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (!line.startsWith("+")) {
      // A `\ No newline at end of file` marker is not a content line, so it must not advance the
      // new-file line counter — mirrors the sibling analyzers (e.g. iac-misconfig.ts).
      if (!line.startsWith("-") && !line.startsWith("\\")) newLine++;
      continue;
    }

    const body = line.slice(1);
    if (body.length <= MAX_LINE_CHARS) {
      let kind: TestSkipGamingFinding["kind"] | null = null;
      if (rules.skip.test(body)) kind = "skip-marker";
      else if (rules.only?.test(body)) kind = "only-marker";
      if (kind && pushFinding(findings, path, newLine, kind, maxFindings)) {
        return findings;
      }
    }

    newLine++;
  }

  return findings;
}

/** Scan one WORKFLOW file's patch for a step that already runs a recognized test command and newly gains
 *  `continue-on-error: true` or a literal `if: false` (both are ADDED lines; only the gain is flagged, never a
 *  pre-existing marker the diff doesn't touch). Step identity/test-command state resets at each hunk boundary,
 *  same as the sibling regex analyzers: a step whose `run:` line falls outside the diff's context window is
 *  fail-quiet, not flagged. */
function scanWorkflowSteps(
  path: string,
  patch: string,
  limits: ScanLimits,
  maxFindings: number,
): TestSkipGamingFinding[] {
  const findings: TestSkipGamingFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  let stepHasTestCommand = false;
  let pendingGains: Array<{ line: number; kind: TestSkipGamingFinding["kind"] }> = [];

  // Reports the buffered gains for the step just finished, only when that step runs a recognized test
  // command, then resets for the next step. Returns true once the finding cap is hit.
  const flushStep = (): boolean => {
    let stop = false;
    if (stepHasTestCommand) {
      for (const gain of pendingGains) {
        if (pushFinding(findings, path, gain.line, gain.kind, maxFindings)) {
          stop = true;
          break;
        }
      }
    }
    pendingGains = [];
    stepHasTestCommand = false;
    return stop;
  };

  for (const line of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (flushStep()) return findings;
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // Removed lines describe the OLD file only (a removed marker is a fix, never gaming) and a `\ No newline`
    // marker is not a content line — neither advances the new-file line counter nor updates step state.
    if (line.startsWith("-") || line.startsWith("\\")) continue;

    const added = line.startsWith("+");
    const body = line.slice(1);

    if (STEP_BOUNDARY_RE.test(body) && flushStep()) return findings;

    if (body.length <= MAX_LINE_CHARS) {
      // Context AND added lines both describe the new file, so either can establish "this step runs tests" —
      // only the GAIN itself (below) is restricted to an added line.
      const runMatch = RUN_KEY_RE.exec(body);
      if (runMatch && TEST_COMMAND_RE.test(runMatch[1]!)) stepHasTestCommand = true;

      if (added) {
        if (CONTINUE_ON_ERROR_TRUE_RE.test(body)) {
          pendingGains.push({ line: newLine, kind: "ci-continue-on-error" });
        } else if (STEP_IF_FALSE_RE.test(body)) {
          pendingGains.push({ line: newLine, kind: "ci-neutralized-if" });
        }
      }
    }

    newLine++;
  }
  flushStep();

  return findings;
}

/** Scan one changed file's patch for test-skip-gaming findings. Dispatches by path: a workflow file is scanned
 *  for neutered test steps, a test file for skip/only markers, anything else yields nothing. Pure. */
export function scanPatchForTestSkipGaming(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): TestSkipGamingFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  if (isWorkflowPath(path)) return scanWorkflowSteps(path, patch, limits, maxFindings);
  if (isTestPath(path)) return scanTestFileMarkers(path, patch, limits, maxFindings);
  return [];
}

/** Analyzer entrypoint: added test-file and workflow-file patch lines → test-skip-gaming findings. No network. */
export async function scanTestSkipGaming(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<TestSkipGamingFinding[]> {
  const findings: TestSkipGamingFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch || !isTestSkipGamingRelevantPath(file.path)) continue;
    for (const finding of scanPatchForTestSkipGaming(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
