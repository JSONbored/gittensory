// Focused-test analyzer (part of #1499 quality-signal family). Flags a focused test a PR adds in a test file —
// `describe.only` / `it.only` / `test.only` (and `context`/`suite`/`specify`) — which silently skips every OTHER
// test in that file, so CI can stay green while most of the suite no longer runs. It is the test-file counterpart
// of the debug-leftover analyzer: that one scans NON-test source, this one scans test files only. Pure compute,
// no network. String-literal content is stripped before matching so a `"it.only"` inside a string is not flagged.
// Line-cited via hunk headers, mirroring the sibling local analyzers.
import type { FocusedTestFinding, EnrichRequest } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

// A `.only` chained onto a known test-block function — the cross-framework (Jest/Vitest/Mocha/Jasmine) way to
// focus one test/suite and skip the rest of the file. Restricted to those function names so an unrelated
// `stream.only(` never matches.
const FOCUSED_TEST_RE =
  /\b(?:describe|context|suite|it|test|specify)\s*\.\s*only\s*\(/;

/** Detect a focused-test (`.only`) call in one added line, or null. Pure. */
export function detectFocusedTest(line: string): FocusedTestFinding["kind"] | null {
  return FOCUSED_TEST_RE.test(codeOnly(line)) ? "only" : null;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one TEST file patch's added lines for focused-test calls, line-cited via hunk headers. Non-test files are
 *  skipped (a `.only` there is not a focused test). Pure. */
export function scanPatchForFocusedTest(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): FocusedTestFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isTestPath(path)) return [];
  const findings: FocusedTestFinding[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        const kind = detectFocusedTest(body);
        if (kind) {
          findings.push({ file: path, line: newLine, kind });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed test file's added lines for focused-test calls. */
export async function scanFocusedTest(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<FocusedTestFinding[]> {
  const findings: FocusedTestFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForFocusedTest(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
