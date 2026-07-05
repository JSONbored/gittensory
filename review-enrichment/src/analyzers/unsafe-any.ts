// Unsafe-`any` counter (#2017, part of #1499). A LOCAL analyzer (no network) that counts and locates explicit `any`
// usages NEWLY ADDED in a TypeScript diff — `: any` annotations, `as any` casts, and `<any>` assertions — a
// type-safety-erosion signal a reviewer can weigh. Structural regex ONLY (no type-checker); occurrences inside
// string literals or comments are cheaply stripped first to avoid false positives. Fail-safe and bounded
// (maxFindings). Scans added lines of `.ts`/`.tsx` files only; ambient `.d.ts` declarations are skipped.
import type { EnrichRequest, UnsafeAnyFinding } from "../types.js";

const MAX_FINDINGS = 50;
const MAX_LINE_CHARS = 2000; // skip pathologically long (e.g. minified) lines rather than scan them
const TS_RE = /\.tsx?$/;
const SKIP_RE = /\.d\.ts$/; // ambient declarations legitimately use `any`; not hand-authored surface

// `cast`/`assertion` are matched before the broad `: any` so each syntactic form is labelled by its own pattern.
const PATTERNS: ReadonlyArray<{ re: RegExp; kind: UnsafeAnyFinding["kind"] }> = [
  { re: /\bas\s+any\b/g, kind: "cast" }, // `x as any`
  { re: /<\s*any\s*>/g, kind: "assertion" }, // `<any>x` (and, structurally, `Array<any>` — still an unsafe any)
  { re: /:\s*any\b/g, kind: "annotation" }, // `x: any`
];

/** Blank out string literals and comments so an `any` inside them is not counted. Cheap + line-local: a comment-only
 *  line (`//`, `*`, `/*`) yields empty; inline strings, `/* … */` spans, and `// …` tails are removed. Pure. */
export function stripStringsAndComments(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "") // string / template literals
    .replace(/\/\*.*?\*\//g, "") // inline block comments
    .replace(/\/\/.*$/, ""); // trailing line comment
}

/** The unsafe-`any` kinds on a single added code line, one entry per occurrence. Pure. */
export function findUnsafeAnyOnLine(line: string): Array<UnsafeAnyFinding["kind"]> {
  if (line.length > MAX_LINE_CHARS) return [];
  const code = stripStringsAndComments(line);
  const kinds: Array<UnsafeAnyFinding["kind"]> = [];
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    while (re.exec(code) !== null) kinds.push(kind);
  }
  return kinds;
}

/** Walk a unified-diff patch and report each unsafe-`any` on an ADDED line, with its new-file line number. Tracks
 *  the new-file cursor via hunk headers; `-`/`\` lines never advance it, `+++`/`---` headers are ignored. Pure. */
export function scanPatchForUnsafeAny(path: string, patch: string): UnsafeAnyFinding[] {
  const findings: UnsafeAnyFinding[] = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      if (!raw.startsWith("+++")) {
        for (const kind of findUnsafeAnyOnLine(raw.slice(1))) findings.push({ file: path, line: newLine, kind });
        newLine += 1;
      }
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      newLine += 1; // context line advances the new-file cursor
    }
  }
  return findings;
}

/** Analyzer entrypoint: added `any` usages across changed `.ts`/`.tsx` files. Local + fail-safe; bounded by
 *  maxFindings. */
export async function scanUnsafeAny(req: EnrichRequest): Promise<UnsafeAnyFinding[]> {
  const findings: UnsafeAnyFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch || !TS_RE.test(file.path) || SKIP_RE.test(file.path)) continue;
    for (const finding of scanPatchForUnsafeAny(file.path, file.patch)) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
