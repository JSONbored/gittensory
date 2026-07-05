// Unsafe-`any` counter (#2017). Counts and locates explicit `any` type usage a PR ADDS in TypeScript — a type
// annotation (`: any`), an `as any` cast, or an `<any>` assertion/type-argument — a type-safety-erosion signal a
// reviewer can weigh. Structural regex only (no type-checker), pure, no network. Detection is gated to .ts/.tsx
// (and the .mts/.cts module variants), so JS or prose can't false-positive. String literals and same-line
// comments are blanked before matching (a cheap, best-effort avoidance per the issue — a bare `any` inside a
// multi-line block comment whose opener is on a previous line is not reconstructed, which is the safe direction).
// Line-cited via hunk headers, mirroring the sibling local analyzers (redos.ts).
import type { EnrichRequest, UnsafeAnyFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const TS_EXTS = new Set(["ts", "tsx", "mts", "cts"]);

// `\bany\b` in each shape keeps `anyOf`/`anything`/`Company` out. `annotation` is a `: any` type position;
// `cast` is an `as any`; `assertion` is `<any>` (the angle-bracket assertion and `Array<any>`/`Promise<any>`
// type arguments — all explicit `any` usage the reviewer wants surfaced).
const ANNOTATION_RE = /:\s*any\b/;
const CAST_RE = /\bas\s+any\b/;
const ASSERTION_RE = /<\s*any\s*>/;

/** The lowercased final path extension, or null. */
function extOf(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/** Blank string literals (via codeOnly) then strip same-line block/line comments, so only real code is matched.
 *  Cheap and single-line by design — cross-line comment state is not tracked. Pure. */
function toCode(line: string): string {
  return codeOnly(line)
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\/\/.*$/, "");
}

/** The explicit-`any` kinds present on one line, de-duplicated by kind. A line that is a JSDoc/comment
 *  continuation (`* … : any …`) is skipped so documentation prose is never counted. Pure. */
export function detectUnsafeAny(line: string): UnsafeAnyFinding["kind"][] {
  const code = toCode(line);
  if (code.trimStart().startsWith("*")) return [];
  const kinds: UnsafeAnyFinding["kind"][] = [];
  if (CAST_RE.test(code)) kinds.push("cast");
  if (ASSERTION_RE.test(code)) kinds.push("assertion");
  if (ANNOTATION_RE.test(code)) kinds.push("annotation");
  return kinds;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one TS file patch's added lines for explicit `any` usage, line-cited via hunk headers. Pure. */
export function scanPatchForUnsafeAny(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): UnsafeAnyFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const ext = extOf(path);
  if (!ext || !TS_EXTS.has(ext)) return [];

  const findings: UnsafeAnyFinding[] = [];
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
    // Skip pre-hunk preamble; inside a hunk `+++x`/`+++ x` is added content, not a header.
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      const body = line.slice(1);
      if (body.length <= MAX_LINE_CHARS) {
        for (const kind of detectUnsafeAny(body)) {
          findings.push({ file: path, line: newLine, kind });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line — do not advance the cursor
      // (same class as the redos / actions-pin fix).
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed .ts/.tsx file's added lines for explicit `any` usage. */
export async function scanUnsafeAny(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<UnsafeAnyFinding[]> {
  const findings: UnsafeAnyFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForUnsafeAny(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
