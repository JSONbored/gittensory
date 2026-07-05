// Magic-number analyzer (#2018). Flags newly-added numeric literals in non-test source when a named constant would
// make the intent clearer. Pure local compute over added diff lines: no network, no checkout, no cross-file state.
// Precision-first: common sentinels/scales are allowlisted, const NAME = <n> declarations are treated as already
// named, array indexes and enum/member initializers are suppressed, and string/comment content is blanked first.
import type { EnrichRequest, MagicNumberFinding } from "../types.js";
import { codeOnly } from "./secret-log.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;
const REPORT_CHARS = 40;

const SOURCE_EXTS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rb",
  "dart",
  "java",
  "kt",
  "kts",
  "scala",
  "groovy",
  "cs",
  "swift",
  "php",
  "rs",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
]);

const NAMED_CONST_RE =
  /^\s*(?:export\s+)?(?:(?:const|let|var|readonly|final|val)\s+|static\s+(?:readonly\s+)?|public\s+static\s+final\s+\w+\s+|private\s+static\s+final\s+\w+\s+)?[A-Z][A-Z0-9_]{1,}\s*[:=]/;
const ENUM_MEMBER_RE = /^\s*[A-Z][A-Za-z0-9_]*\s*=\s*[-+]?(?:0[xob])?[0-9]/;
const NUMERIC_SEPARATOR_RE = /_/g;

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

type NumericToken = {
  value: string;
  start: number;
  end: number;
};

function sourceExtOf(path: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? match[1]!.toLowerCase() : null;
}

/** Whether a file can contain source literals this analyzer should judge. Test paths are intentionally silent. */
export function isMagicNumberSourcePath(path: string): boolean {
  const ext = sourceExtOf(path);
  return Boolean(ext && SOURCE_EXTS.has(ext) && !isTestPath(path));
}

function previousCodeChar(line: string, index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const ch = line[i]!;
    if (ch !== " " && ch !== "\t") return ch;
  }
  return null;
}

function nextCodeChar(line: string, index: number): string | null {
  for (let i = index; i < line.length; i++) {
    const ch = line[i]!;
    if (ch !== " " && ch !== "\t") return ch;
  }
  return null;
}

function isIdentifierChar(ch: string | null): boolean {
  return Boolean(ch && /[A-Za-z0-9_$]/.test(ch));
}

function isDigit(ch: string | undefined): boolean {
  return Boolean(ch && ch >= "0" && ch <= "9");
}

function isSignPartOfNumber(line: string, i: number): boolean {
  const ch = line[i];
  if (ch !== "-" && ch !== "+") return false;
  if (!isDigit(line[i + 1]) && line[i + 1] !== ".") return false;
  if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") return true;
  const prev = previousCodeChar(line, i);
  return !prev || "([{:;,=+-*/%!<>?&|^~".includes(prev);
}

function readDigits(line: string, i: number, radix: "binary" | "octal" | "decimal" | "hex"): number {
  const re =
    radix === "binary"
      ? /[01_]/
      : radix === "octal"
        ? /[0-7_]/
        : radix === "hex"
          ? /[0-9A-Fa-f_]/
          : /[0-9_]/;
  while (i < line.length && re.test(line[i]!)) i++;
  return i;
}

/** Extract numeric tokens with source spans from one code-only line. Skips property suffixes and identifiers. */
export function extractNumericTokens(line: string): NumericToken[] {
  const tokens: NumericToken[] = [];
  let i = 0;
  while (i < line.length) {
    const start = i;
    let sign = "";
    if (isSignPartOfNumber(line, i)) {
      sign = line[i]!;
      i++;
    }
    const numberStart = i;
    const prev = start > 0 ? line[start - 1]! : null;
    if (isIdentifierChar(prev) || prev === ".") {
      i = Math.max(start + 1, i);
      continue;
    }

    if (line[i] === "0" && /[xX]/.test(line[i + 1] ?? "")) {
      i += 2;
      const digitsStart = i;
      i = readDigits(line, i, "hex");
      if (i === digitsStart) continue;
    } else if (line[i] === "0" && /[bB]/.test(line[i + 1] ?? "")) {
      i += 2;
      const digitsStart = i;
      i = readDigits(line, i, "binary");
      if (i === digitsStart) continue;
    } else if (line[i] === "0" && /[oO]/.test(line[i + 1] ?? "")) {
      i += 2;
      const digitsStart = i;
      i = readDigits(line, i, "octal");
      if (i === digitsStart) continue;
    } else {
      if (line[i] === ".") {
        if (!isDigit(line[i + 1])) {
          i = start + 1;
          continue;
        }
        i++;
        i = readDigits(line, i, "decimal");
      } else if (isDigit(line[i])) {
        i = readDigits(line, i, "decimal");
        if (line[i] === "." && isDigit(line[i + 1])) {
          i++;
          i = readDigits(line, i, "decimal");
        }
      } else {
        i = start + 1;
        continue;
      }
      if (/[eE]/.test(line[i] ?? "")) {
        const expStart = i;
        let j = i + 1;
        if (line[j] === "+" || line[j] === "-") j++;
        const digitsStart = j;
        j = readDigits(line, j, "decimal");
        if (j > digitsStart) i = j;
        else i = expStart;
      }
    }

    if (/[nN]/.test(line[i] ?? "")) i++;
    const next = line[i] ?? null;
    if (isIdentifierChar(next)) continue;
    const raw = `${sign}${line.slice(numberStart, i)}`;
    tokens.push({ value: raw, start, end: i });
  }
  return tokens;
}

function numericMagnitude(value: string): number | null {
  const unsigned = value.replace(NUMERIC_SEPARATOR_RE, "").replace(/^[+-]/, "").replace(/n$/i, "");
  if (/^0[xX][0-9A-Fa-f]+$/.test(unsigned)) return Number.parseInt(unsigned.slice(2), 16);
  if (/^0[bB][01]+$/.test(unsigned)) return Number.parseInt(unsigned.slice(2), 2);
  if (/^0[oO][0-7]+$/.test(unsigned)) return Number.parseInt(unsigned.slice(2), 8);
  const parsed = Number(unsigned);
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

function isPowerOfTen(value: number): boolean {
  if (!Number.isInteger(value) || value < 10) return false;
  while (value > 1 && value % 10 === 0) value /= 10;
  return value === 1;
}

/** Allowlist trivial/sentinel/scaling values that are more noise than signal for this analyzer. */
export function isAllowedMagicNumberValue(value: string): boolean {
  const magnitude = numericMagnitude(value);
  if (magnitude === null) return true;
  if (magnitude === 0 || magnitude === 1 || magnitude === 2) return true;
  if (magnitude === 100 || magnitude === 1000) return true;
  if (isPowerOfTen(magnitude)) return true;
  return false;
}

function isArrayIndex(line: string, token: NumericToken): boolean {
  return previousCodeChar(line, token.start) === "[" && nextCodeChar(line, token.end) === "]";
}

function isLikelyEnumInitializer(line: string, token: NumericToken): boolean {
  const before = line.slice(0, token.start);
  return ENUM_MEMBER_RE.test(line) || /^[\s,]*[A-Z][A-Za-z0-9_]*\s*=\s*$/.test(before);
}

function isNamedConstantDeclaration(line: string): boolean {
  return NAMED_CONST_RE.test(line);
}

function isNumericObjectKey(line: string, token: NumericToken): boolean {
  return nextCodeChar(line, token.end) === ":" && ["{", ","].includes(previousCodeChar(line, token.start) ?? "");
}

function reportValue(value: string): string {
  return value.length > REPORT_CHARS ? value.slice(0, REPORT_CHARS) : value;
}

function stripInlineComments(line: string): string {
  const slash = line.indexOf("//");
  const block = line.indexOf("/*");
  const hash = /(^|\s)#/.exec(line);
  const cuts = [slash, block, hash?.index].filter((value): value is number => value !== undefined && value >= 0);
  return cuts.length ? line.slice(0, Math.min(...cuts)) : line;
}

/** Detect reportable numeric literals on one added source line after stripping strings/comments. */
export function detectMagicNumbers(line: string): Array<{ value: string }> {
  if (line.length > MAX_LINE_CHARS) return [];
  const code = stripInlineComments(codeOnly(line));
  if (isNamedConstantDeclaration(code)) return [];
  const findings: Array<{ value: string }> = [];
  for (const token of extractNumericTokens(code)) {
    if (isAllowedMagicNumberValue(token.value)) continue;
    if (isArrayIndex(code, token)) continue;
    if (isLikelyEnumInitializer(code, token)) continue;
    if (isNumericObjectKey(code, token)) continue;
    findings.push({ value: reportValue(token.value) });
  }
  return findings;
}

/** Scan one file patch's added lines for unexplained numeric literals, line-cited via hunk headers. Pure. */
export function scanPatchForMagicNumbers(
  path: string,
  patch?: string,
  limits: ScanLimits = {},
): MagicNumberFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !patch || !isMagicNumberSourcePath(path)) return [];
  const findings: MagicNumberFinding[] = [];
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
      for (const hit of detectMagicNumbers(line.slice(1))) {
        findings.push({ file: path, line: newLine, value: hit.value });
        if (findings.length >= maxFindings) return findings;
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // A `\ No newline at end of file` marker is not a new-file line -- do not advance the cursor.
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed non-test source file's added lines for reportable magic numbers. */
export async function scanMagicNumbers(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<MagicNumberFinding[]> {
  const findings: MagicNumberFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForMagicNumbers(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
