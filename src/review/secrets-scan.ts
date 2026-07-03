// Reusable secret-pattern scanner (the `secretsScan` capability). Deterministic, no deps.
// Callers run scanForSecrets() on submitted diff/text; a hit typically forces a close/manual verdict.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): every type + pattern this module needs is
// defined HERE. No imports from reviewbot. The logic is byte-faithful to the reviewbot source
// (src/core/secrets-scan.ts); there are no stricter-tsconfig deltas — the module is already total.
//
// #2553: widened to match review-enrichment/src/analyzers/secret-scan.ts's richer, higher-recall rule set
// (google_api_key, jwt, generic_secret_assignment) so the deterministic hard blocker (safety.ts's
// HARD_SECRET_KINDS) catches the same patterns REES's advisory-only enrichment brief already does. Kept as a
// second, independent copy here rather than a cross-package import: review-enrichment deploys standalone on
// Railway with its own tsconfig/build/test pipeline (see review-enrichment/package.json), so importing across
// that boundary would break its independence — the same reasoning this file's own header already documents
// for staying self-contained relative to reviewbot.

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "private_key_block", re: /-----BEGIN(?: RSA| EC| OPENSSH| PGP| DSA)? PRIVATE KEY-----/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "gitlab_token", re: /\bglpat-[0-9A-Za-z_-]{20}\b/ },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "seed_or_mnemonic", re: /\b(?:seed phrase|mnemonic)\b/i },
  { name: "bittensor_key", re: /\b(?:hot|cold)key\b\s*[:=]/i },
];

// Deliberately NOT in SECRET_PATTERNS above: unlike the format-specific patterns (a real GitHub token/AWS key
// ALWAYS matches its exact character format, so a bare .test() is precise enough), a keyword-plus-quoted-value
// SHAPE also matches plenty of non-secrets -- a Zod schema field (`password: z.string()`), a TypeScript type
// declaration, or a placeholder value ("xxx", "your-api-key-here", "<REDACTED>"). Captured so each match's
// VALUE can be checked against isPlaceholderSecretValue before counting as a hit; the value itself is never
// returned from this module (only the kind name), preserving the existing never-echo-the-secret guarantee.
const GENERIC_SECRET_ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{16,})["']/gi;

const PLACEHOLDER_VALUE_PATTERN = /placeholder|change[_-]?me|your[_-]|<[^>]*>|\bexample\b|redacted|dummy|\bsample\b|\btodo\b|\bfixme\b|\binsert\b|replace[_-]?me|\bfake\b/i;

// #2553 gate review finding: a string with NO repeated characters (e.g. "abcdefghijklmnop123") has HIGH
// Shannon entropy by raw character-frequency counting, but is obviously not a real secret -- entropy alone
// only measures frequency, not ORDER, so a keyboard-sequential/alphabetical run slips past a pure distinct-
// character-count check. Detect the longest run of consecutive ascending or descending character codes (e.g.
// "abcdefg" or "9876543") and treat a long one as a human-constructed test value, not a randomly generated
// credential -- real API keys/tokens essentially never contain a 6+ character monotonic run.
const MIN_SEQUENTIAL_RUN_LENGTH = 6;
function hasLongSequentialRun(value: string): boolean {
  let ascendingRun = 1;
  let descendingRun = 1;
  for (let i = 1; i < value.length; i += 1) {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    ascendingRun = diff === 1 ? ascendingRun + 1 : 1;
    descendingRun = diff === -1 ? descendingRun + 1 : 1;
    if (ascendingRun >= MIN_SEQUENTIAL_RUN_LENGTH || descendingRun >= MIN_SEQUENTIAL_RUN_LENGTH) return true;
  }
  return false;
}

/** True for an obvious non-secret filler value: a known placeholder phrase, a string built from at most 2
 *  distinct characters (e.g. "xxxxxxxxxxxxxxxx", "----------------"), or a long monotonic character-code run
 *  (e.g. "abcdefghijklmnop123") — real high-entropy secrets never look like any of these. */
function isPlaceholderSecretValue(value: string): boolean {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true;
  if (new Set(value.toLowerCase()).size <= 2) return true;
  return hasLongSequentialRun(value);
}

function hasGenericSecretAssignment(text: string): boolean {
  // No zero-length-match / lastIndex-stall guard needed: the pattern's captured value alone requires 16+
  // characters, so every match is well over 16 characters long and lastIndex always advances past match.index.
  GENERIC_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERIC_SECRET_ASSIGNMENT_PATTERN.exec(text)) !== null) {
    // The pattern's sole capturing group is mandatory (not `?`/`*`-wrapped), so it is always present
    // whenever the overall match succeeds -- non-null by construction, not a runtime branch.
    if (!isPlaceholderSecretValue(match[1]!)) return true;
  }
  return false;
}

export interface SecretScanResult {
  found: boolean;
  kinds: string[];
}

export function scanForSecrets(text: string): SecretScanResult {
  if (!text) return { found: false, kinds: [] };
  const kinds = SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
  if (hasGenericSecretAssignment(text)) kinds.push("generic_secret_assignment");
  return { found: kinds.length > 0, kinds };
}

/** Extract quoted string-literal inner text from one source line (for cross-line join below). */
function extractStringLiteralContents(line: string): string[] {
  const literals: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) literals.push(match[0].slice(1, -1));
  return literals;
}

function formatSecretKindsFromText(text: string): string[] {
  const kinds = SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
  if (hasGenericSecretAssignment(text)) kinds.push("generic_secret_assignment");
  return kinds;
}

/** True for unified-diff file headers (`+++ b/path`, `--- a/path`), not added content like `+++const`. */
function isUnifiedDiffFileHeaderLine(line: string): boolean {
  return /^(?:\+\+\+|---) (?:[ab]\/|\/dev\/null)/.test(line);
}

/** Scan a PR diff for secret kinds introduced on added lines (and added/renamed file headers). Per-line regex
 *  first; then a bounded cross-line join of consecutive added lines' adjacent string literals (#2454) so a
 *  credential split across `const a = "AKIA…"; const b = "REST";` still trips the unconditional gate. Context,
 *  removed, and hunk boundaries reset the join window — same semantics as review-enrichment's scanPatch. */
export function scanPrDiffForSecretKinds(diff: string): string[] {
  const found = new Set<string>();
  const addedLines: string[] = [];
  let inFileSection = false;
  let inHunk = false;
  let previousLiterals: string[] = [];

  for (const line of diff.split("\n")) {
    if (line === "") {
      inFileSection = false;
      inHunk = false;
      previousLiterals = [];
      continue;
    }
    if (/^### .+ \(.+\) /.test(line)) {
      inFileSection = true;
      inHunk = false;
      previousLiterals = [];
      if (/^### .+ \((?:added|renamed)\) /.test(line)) {
        for (const kind of formatSecretKindsFromText(line)) found.add(kind);
      }
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      previousLiterals = [];
      continue;
    }
    if (line.startsWith("+")) {
      if (!inFileSection) continue;
      // Skip pre-hunk file headers only; inside a hunk `+++…` is added content, not a header.
      if (!inHunk && isUnifiedDiffFileHeaderLine(line)) continue;
      const content = line.slice(1);
      addedLines.push(content);
      let matched = false;
      for (const kind of formatSecretKindsFromText(content)) {
        found.add(kind);
        matched = true;
      }
      const currentLiterals = extractStringLiteralContents(content);
      const lastPrevious = previousLiterals.at(-1);
      const firstCurrent = currentLiterals[0];
      if (!matched && lastPrevious !== undefined && firstCurrent !== undefined) {
        const joined = lastPrevious + firstCurrent;
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.re.test(joined)) {
            found.add(pattern.name);
            break;
          }
        }
      }
      previousLiterals = currentLiterals;
      continue;
    }
    if (line.startsWith("-")) {
      previousLiterals = [];
      continue;
    }
    if (inHunk && line.startsWith(" ")) {
      previousLiterals = [];
    }
  }

  if (!found.has("generic_secret_assignment") && hasGenericSecretAssignment(addedLines.join("\n"))) {
    found.add("generic_secret_assignment");
  }
  return [...found];
}
