// i18n regression analyzer (#2029). When added lines in a UI file show a translation convention
// (t('…'), useTranslation, FormattedMessage, etc.), flags newly-added user-facing string literals that
// bypass it — JSX text nodes and common label/title props. Inactive when the diff shows no i18n usage.
// Pure compute over added lines, no network. Never returns string content in findings.
import type { EnrichRequest, I18nFinding } from "../types.js";
import { isTestPath } from "./test-ratio.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

const UI_PATH_RE = /\.(?:tsx|jsx|vue)$/i;

const I18N_CONVENTION_RES = [
  /\bt\s*\(\s*['"`]/,
  /\buseTranslation\s*\(/,
  /<FormattedMessage\b/,
  /\bformatMessage\s*\(/,
  /\bi18n\.t\s*\(/,
  /\bi18next\.t\s*\(/,
  /\$t\s*\(/,
];

const USER_FACING_PROP_RE =
  /\b(?:title|label|placeholder|aria-label|helperText|message|description|heading|tooltip|hint|alt|caption|subtitle|confirmText|cancelText|buttonText|emptyText)\s*=\s*["']([^"']+)["']/gi;

/** True when a line shows the repo uses an i18n/translation call convention. Pure. */
export function detectI18nConvention(line: string): boolean {
  return I18N_CONVENTION_RES.some((re) => {
    re.lastIndex = 0;
    return re.test(line);
  });
}

/** True when a string literal looks like user-facing copy rather than a key/id. Pure. */
export function looksLikeUserFacingLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) return false;
  if (/\s/.test(trimmed)) return true;
  if (/^[a-z0-9_.-]+$/.test(trimmed) && trimmed.includes(".")) return false;
  if (trimmed.length <= 3 && /^[a-z]+$/.test(trimmed)) return false;
  if (/[A-Z]/.test(trimmed)) return true;
  return trimmed.length >= 8;
}

function isCommentOrImportLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^(?:\/\/|\/\*|\*|<!--|import\b|from\b)/.test(trimmed);
}

function hasUserFacingJsxText(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char !== ">") continue;

    const textStart = i + 1;
    const next = line[textStart];
    if (next === undefined || next === "<" || next === "{") continue;

    const close = line.indexOf("<", textStart);
    if (close === -1) return false;
    if (looksLikeUserFacingLiteral(line.slice(textStart, close))) return true;
    i = close - 1;
  }

  return false;
}

/** True when one added UI line adds a hardcoded user-facing string, or null. Pure. */
export function detectHardcodedUiString(line: string): boolean {
  if (isCommentOrImportLine(line)) return false;

  USER_FACING_PROP_RE.lastIndex = 0;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = USER_FACING_PROP_RE.exec(line))) {
    if (looksLikeUserFacingLiteral(propMatch[1] ?? "")) return true;
  }

  if (hasUserFacingJsxText(line)) return true;

  return false;
}

function isUiPath(path: string): boolean {
  return UI_PATH_RE.test(path) && !isTestPath(path);
}

function patchShowsI18nConvention(patch: string): boolean {
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+")) continue;
    const body = line.slice(1);
    if (body.length > MAX_LINE_CHARS) continue;
    if (detectI18nConvention(body)) return true;
  }
  return false;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

/** Scan one file patch for i18n regressions, line-cited via hunk headers. Pure. */
export function scanPatchForI18nRegression(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): I18nFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0 || !isUiPath(path) || !patchShowsI18nConvention(patch)) return [];

  const findings: I18nFinding[] = [];
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
      if (body.length <= MAX_LINE_CHARS && detectHardcodedUiString(body)) {
        findings.push({ file: path, line: newLine });
        if (findings.length >= maxFindings) return findings;
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }

  return findings;
}

/** Analyzer entrypoint: scan UI files whose diff shows an i18n convention. */
export async function scanI18nRegression(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<I18nFinding[]> {
  const findings: I18nFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch) continue;
    for (const finding of scanPatchForI18nRegression(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
