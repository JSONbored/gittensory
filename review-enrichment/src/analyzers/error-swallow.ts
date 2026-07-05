// Error-swallow analyzer (#2014). Flags newly-added catch/except blocks that silently discard errors —
// empty bodies, unused bindings, or a lone `return null` with no log/rethrow. Pure compute over added diff
// lines; no network. JS/TS/Python only; Python `except: pass` is intentionally allowed.
import type { EnrichRequest, ErrorSwallowFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;
const MAX_MULTILINE_ADDED_LINES = 50;

const SOURCE_EXTS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py"]);

const JS_CATCH_RE = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\))?\s*\{([\s\S]*)\}/;
const PYTHON_EXCEPT_RE = /^\s*except\b(?:\s+([^:\n]+?))?(?:\s+as\s+([A-Za-z_]\w*))?\s*:\s*(.*)$/;

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

function sourceExtOf(path: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? match[1]!.toLowerCase() : null;
}

export function isErrorSwallowSourcePath(path: string): boolean {
  const ext = sourceExtOf(path);
  return Boolean(ext && SOURCE_EXTS.has(ext) && !isTestPath(path));
}

function isAddedPatchLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

function bodySwallowsError(body: string, binding: string | null, isPython: boolean): ErrorSwallowFinding["kind"] | null {
  const inner = codeOnly(body).trim();
  if (!inner) return "empty-catch";
  if (isPython && /^pass(?:\s+#.*)?$/.test(inner)) return null;

  if (/^return\s+(?:null|None)\s*;?$/.test(inner) && !/\bthrow\b/.test(inner) && !mentionsLogOrBinding(inner, binding)) {
    return "return-null";
  }

  if (/\bthrow\b/.test(inner)) return null;
  if (mentionsLogOrBinding(inner, binding)) return null;

  if (binding) return "unused-binding";
  return null;
}

function mentionsLogOrBinding(body: string, binding: string | null): boolean {
  if (binding && new RegExp(`\\b${binding.replace(/[$]/g, "\\$")}\\b`).test(body)) return true;
  return /\b(console\.|logger\.|log\.|print\s*\(|Sentry\.|captureException\b|reportError\b|\.error\s*\(|\.warn\s*\()/i.test(body);
}

function classifyJsCatchText(text: string): ErrorSwallowFinding["kind"] | null {
  const match = JS_CATCH_RE.exec(codeOnly(text));
  if (!match) return null;
  return bodySwallowsError(match[2] ?? "", match[1] ?? null, false);
}

function braceBlockComplete(text: string): boolean {
  const code = codeOnly(text);
  let depth = 0;
  let seenOpen = false;
  for (const ch of code) {
    if (ch === "{") {
      depth += 1;
      seenOpen = true;
    } else if (ch === "}") {
      depth -= 1;
    }
  }
  return seenOpen && depth <= 0;
}

/** Collect consecutive added lines until a `{`/`}` block closes. Pure. */
function collectAddedBraceBlock(lines: string[], startIndex: number): { text: string; lineCount: number } | null {
  let text = "";
  let lineCount = 0;
  for (let i = startIndex; i < lines.length && lineCount < MAX_MULTILINE_ADDED_LINES; i += 1) {
    const line = lines[i]!;
    if (!isAddedPatchLine(line)) break;
    text += (lineCount > 0 ? "\n" : "") + line.slice(1);
    lineCount += 1;
    if (braceBlockComplete(text)) break;
  }
  return lineCount > 0 ? { text, lineCount } : null;
}

/** Classify one added JS/TS catch (single- or multi-line text), or null when clean / out of scope. Pure. */
export function detectJsCatchSwallow(line: string): ErrorSwallowFinding["kind"] | null {
  if (!/\bcatch\b/.test(line)) return null;
  return classifyJsCatchText(line);
}

/** Classify one added Python except line (and optional immediate next added body line), or null. Pure. */
export function detectPythonExceptSwallow(line: string, nextAddedLine?: string | null): ErrorSwallowFinding["kind"] | null {
  const match = PYTHON_EXCEPT_RE.exec(line);
  if (!match) return null;
  const binding = match[2] ?? null;
  let body = (match[3] ?? "").trim();
  if (!body && nextAddedLine) body = nextAddedLine.trim();
  if (/^\s*pass\s*$/.test(body) || body === "pass") return null;
  return bodySwallowsError(body, binding, true);
}

function pythonExceptUsesNextAddedLine(line: string): boolean {
  const match = PYTHON_EXCEPT_RE.exec(line);
  return Boolean(match && !(match[3] ?? "").trim());
}

/** Scan one file patch's added lines for error-swallowing catch blocks, line-cited via hunk headers. Pure. */
export function scanPatchForErrorSwallow(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): ErrorSwallowFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isErrorSwallowSourcePath(path)) return [];

  const isPython = /\.pyi?$/i.test(path);
  const findings: ErrorSwallowFinding[] = [];
  const lines = patch.split("\n");
  let newLine = 0;
  let inHunk = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const line = lines[index]!;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (isAddedPatchLine(line)) {
      const body = line.slice(1);
      if (body.length > MAX_LINE_CHARS) {
        newLine += 1;
        continue;
      }

      let kind: ErrorSwallowFinding["kind"] | null = null;
      let skipAddedLines = 0;

      if (isPython) {
        const nextLine = lines[index + 1];
        const nextAdded = nextLine && isAddedPatchLine(nextLine) ? nextLine.slice(1) : null;
        kind = detectPythonExceptSwallow(body, nextAdded);
        if (pythonExceptUsesNextAddedLine(body) && nextAdded) skipAddedLines = 1;
      } else if (/\bcatch\b/.test(body)) {
        kind = detectJsCatchSwallow(body);
        if (!kind) {
          const block = collectAddedBraceBlock(lines, index);
          if (block) {
            kind = classifyJsCatchText(block.text);
            skipAddedLines = block.lineCount - 1;
          }
        }
      }

      if (kind) {
        findings.push({ file: path, line: newLine, kind });
        if (findings.length >= maxFindings) return findings;
      }

      newLine += 1 + skipAddedLines;
      index += skipAddedLines;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine += 1;
    }
  }

  return findings;
}

/** Analyzer entrypoint: scan every changed non-test source file's added lines for error swallowing. */
export async function scanErrorSwallow(req: EnrichRequest, signal?: AbortSignal): Promise<ErrorSwallowFinding[]> {
  const findings: ErrorSwallowFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForErrorSwallow(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
