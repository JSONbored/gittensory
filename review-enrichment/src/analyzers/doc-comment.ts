// Doc-comment drift analyzer (#1519). Flags JSDoc @param tags that don't match the adjacent
// function signature when the PR touches the relevant lines — stale tags for removed params
// and missing tags for added params. Pure compute; no network calls.
import type { EnrichRequest, DocCommentFinding } from "../types.js";

const MAX_FINDINGS = 20;
const MAX_LINE_CHARS = 2000;

// Only scan JS/TS files — JSDoc is idiomatic there.
const JS_TS_EXT = /\.(js|ts|jsx|tsx|mjs|cjs)$/i;

// --- JSDoc @param extraction ---

/** Extract @param names from a JSDoc block. Handles {Type} prefix and [optional] bracket notation. */
export function extractJsDocParams(block: string): string[] {
  const names: string[] = [];
  // @param {optional-type} [optional-bracket] name — all prefix forms via greedy optional groups
  const re = /@param\s+(?:\{[^}]*\}\s+)?\[?(\$?[a-zA-Z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const name = m[1]!;
    if (name !== "this") names.push(name); // TS `this` pseudo-param is not a real parameter
  }
  return names;
}

// --- Function signature parsing ---

// Split a comma-separated param list at top-level commas, respecting nested <>, (), [], {}.
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
    else if (c === ">" || c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last) parts.push(last);
  return parts.filter(Boolean);
}

/** Extract simple parameter names from a JS/TS parameter list string (between `(` and `)`).
 *  Returns hasDestructured=true when any top-level param is destructured — those functions are
 *  skipped to avoid false positives from wrapper-name mismatches (e.g. `@param options` vs `{ a, b }`). */
export function extractFunctionParams(
  paramList: string,
): { params: string[]; hasDestructured: boolean } {
  const params: string[] = [];
  let hasDestructured = false;
  for (const p of splitTopLevel(paramList)) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      hasDestructured = true;
      continue;
    }
    // Rest param: ...name or ...name: Type
    const rest = /^\.\.\.(\$?[a-zA-Z_]\w*)/.exec(trimmed);
    if (rest) {
      params.push(rest[1]!);
      continue;
    }
    // Normal: name, name?: Type, name: Type = default — extract just the identifier
    const norm = /^(\$?[a-zA-Z_]\w*)/.exec(trimmed);
    if (norm && norm[1] !== "this") params.push(norm[1]!);
  }
  return { params, hasDestructured };
}

// --- Detect function signatures ---

// Patterns that identify JS/TS function definitions (not calls or control structures).
const FUNC_PATTERNS: RegExp[] = [
  // Traditional: `function name(` or `async function name(` or `export (default)? function`
  /(?:^|\s)(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*\w+\s*[<(]/,
  // Class constructor
  /(?:^|\s)constructor\s*\(/,
  // Class methods with TS access/abstract/static/async/override modifiers
  /(?:^|\s)(?:(?:public|private|protected|static|abstract|override|async|readonly)\s+)+\w+\s*[<(]/,
  // Arrow functions assigned to a binding: `const name = async? (`
  /(?:^|\s)(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/,
];

function looksLikeFunction(line: string): boolean {
  return FUNC_PATTERNS.some((re) => re.test(line));
}

/** Extract a function name from a signature line (best-effort; falls back to `<anonymous>`). */
function extractFunctionName(line: string): string {
  let m = /function\s+(\w+)/.exec(line);
  if (m) return m[1]!;
  if (/constructor\s*\(/.test(line)) return "constructor";
  m =
    /(?:public|private|protected|static|abstract|override|async|readonly)(?:\s+(?:public|private|protected|static|abstract|override|async|readonly))*\s+(\w+)\s*[<(]/.exec(
      line,
    );
  if (m) return m[1]!;
  m = /(?:const|let|var)\s+(\w+)\s*=/.exec(line);
  if (m) return m[1]!;
  return "<anonymous>";
}

/** Find the param list body (between the first balanced `(` and `)`) in concatenated signature
 *  lines. Returns null when parens are unbalanced — we skip rather than guess. */
function extractParamListBody(text: string): string | null {
  const open = text.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

// --- Diff reconstruction ---

interface ReconLine {
  content: string;
  isAdded: boolean;
  newLine: number;
}

/** Reconstruct the new-file view from a unified diff patch, tagging `+` lines as `isAdded`. */
export function reconstructLines(patch: string): ReconLine[] {
  const result: ReconLine[] = [];
  let lineNum = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      lineNum = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      result.push({ content: raw.slice(1), isAdded: true, newLine: lineNum++ });
    } else if (!raw.startsWith("-")) {
      // context line (starts with space, or empty in some diff tools)
      result.push({ content: raw.slice(1), isAdded: false, newLine: lineNum++ });
    }
  }
  return result;
}

// --- Core scanning ---

/** Scan one file's patch for doc-comment drift.
 *
 *  Strategy: reconstruct the new-file view from hunk lines, then slide a window over
 *  JSDoc-to-function pairs. When any line in the window is a `+` diff line and the JSDoc
 *  has at least one @param, compare the tags to the signature's param list. */
export function scanPatchForDocDrift(
  path: string,
  patch: string,
): DocCommentFinding[] {
  const findings: DocCommentFinding[] = [];
  const lines = reconstructLines(patch);
  const n = lines.length;
  let i = 0;

  while (i < n && findings.length < MAX_FINDINGS) {
    const content = lines[i]!.content;
    if (content.length > MAX_LINE_CHARS) {
      i++;
      continue;
    }

    if (!content.trimStart().startsWith("/**")) {
      i++;
      continue;
    }

    // Collect the JSDoc block through the line that contains `*/`.
    const docStart = i;
    let docEnd = i;
    if (!content.includes("*/")) {
      docEnd++;
      while (docEnd < n && !lines[docEnd]!.content.includes("*/")) docEnd++;
    }
    const docBlock = lines
      .slice(docStart, docEnd + 1)
      .map((l) => l.content)
      .join("\n");

    // Skip blank lines between JSDoc and the function definition.
    let fnIdx = docEnd + 1;
    while (fnIdx < n && lines[fnIdx]!.content.trim() === "") fnIdx++;

    if (fnIdx >= n || !looksLikeFunction(lines[fnIdx]!.content)) {
      i = docEnd + 1;
      continue;
    }

    // Only flag when this PR actually touched something in the JSDoc-signature window.
    const windowHasChange = lines
      .slice(docStart, fnIdx + 1)
      .some((l) => l.isAdded);
    if (!windowHasChange) {
      i = docEnd + 1;
      continue;
    }

    const docParams = extractJsDocParams(docBlock);
    if (docParams.length === 0) {
      i = docEnd + 1;
      continue;
    }

    // Look across up to 8 lines to handle multi-line signatures.
    const sigText = lines
      .slice(fnIdx, Math.min(fnIdx + 8, n))
      .map((l) => l.content)
      .join(" ");
    const paramListBody = extractParamListBody(sigText);
    if (paramListBody === null) {
      // Can't parse the param list — skip rather than produce a false positive.
      i = docEnd + 1;
      continue;
    }

    const { params: fnParams, hasDestructured } =
      extractFunctionParams(paramListBody);
    if (hasDestructured) {
      // JSDoc typically names the wrapper object (e.g. `@param options`), not the inner
      // keys — a mismatch here is expected convention, not drift.
      i = docEnd + 1;
      continue;
    }

    const fnName = extractFunctionName(lines[fnIdx]!.content);
    const fnLine = lines[fnIdx]!.newLine;
    const fnParamSet = new Set(fnParams);
    const docParamSet = new Set(docParams);

    // Stale: @param in JSDoc for a param that no longer exists in the signature.
    for (const dp of docParams) {
      if (!fnParamSet.has(dp)) {
        findings.push({ file: path, line: fnLine, fn: fnName, kind: "stale-param", param: dp });
        if (findings.length >= MAX_FINDINGS) return findings;
      }
    }

    // Missing: param in signature with no corresponding @param in the JSDoc.
    for (const fp of fnParams) {
      if (!docParamSet.has(fp)) {
        findings.push({ file: path, line: fnLine, fn: fnName, kind: "missing-param", param: fp });
        if (findings.length >= MAX_FINDINGS) return findings;
      }
    }

    i = docEnd + 1;
  }

  return findings;
}

/** Analyzer entrypoint: scan every JS/TS file in the PR for doc-comment drift. */
export async function scanDocComment(
  req: EnrichRequest,
): Promise<DocCommentFinding[]> {
  const findings: DocCommentFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch || !JS_TS_EXT.test(file.path)) continue;
    for (const finding of scanPatchForDocDrift(file.path, file.patch)) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
