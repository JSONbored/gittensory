// #6264: the one shared local-filesystem-path redactor for the MCP CLI. Three call sites used to
// carry their own copy of this logic (`redactLocalPath` here, `redactLocalValidationPaths` and
// `sanitizeDiagnosticText` in bin/loopover-mcp.js), so a single redaction fix had to be made — and
// kept in sync — three times. They are consolidated here so a future fix happens once.
//
// Two genuinely different mechanisms are needed, so both stay available as named functions rather
// than being forced into one:
//   - `redactLocalPath`      DETECTS an unknown absolute/home path in free text via a regex heuristic
//                            (stack traces, scorer stderr, pasted validation output) → `<local-path>`.
//   - `redactKnownLocalPaths` redacts KNOWN sensitive strings (session tokens, config dirs, cwd/home)
//                            supplied by the caller, by exact substring substitution → `[redacted]` /
//                            `[local-path]`. It cannot detect an arbitrary path; the heuristic cannot
//                            redact a token it was never told about. Each solves a distinct problem.

/**
 * Redact any absolute or home-anchored local path found in free text, replacing it with the
 * `<local-path>` placeholder. Heuristic (matches an unknown path by shape), so it never needs the
 * concrete path in advance — the counterpart to the exact-match `redactKnownLocalPaths` below.
 */
export function redactLocalPath(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return text;
  // Both `/g` patterns are rebuilt per call so no `lastIndex` state carries between invocations.
  // Delimiter-anchored roots (`~/`, `~\`, `C:\`, `C:/`, `/`) whose interior segments may contain
  // spaces, e.g. `/Users/Alice Smith/project` — the anchoring prefix is preserved, only the path swaps.
  const pathSegment = "[^\\\\/\\s\"'`,;)\\]]+(?:\\s+[^\\\\/\\s\"'`,;)\\]]+)*(?=[\\\\/])";
  const pathTail = "[^\\\\/\\s\"'`,;)\\]]+";
  // Prefix delimiters a real path can immediately follow in pasted stack-trace/validation-output text.
  // `(` is the Node.js stack-frame shape (`at fn (/abs/path:10:5)`); `[` and `:` cover the same "no space
  // before the path" shape in bracketed log lines and colon-joined messages (e.g. `path:/abs/path`).
  const rootedPath = new RegExp(`(^|[\\s"'\\\`=(\\[:])((?:~[\\\\/]|[A-Za-z]:[\\\\/]|/)(?:${pathSegment}[\\\\/])*${pathTail})`, "g");
  return text
    .replace(rootedPath, (_, prefix: string) => `${prefix}<local-path>`)
    // Home/Windows roots that appear mid-token with no leading delimiter (so the anchored pass skips
    // them); run second so it only mops up what the anchored, space-aware pass could not claim.
    .replace(/(?:~\/|[A-Za-z]:\\)[^\s"'`,;)]+/g, "<local-path>");
}

export type RedactKnownLocalPathsOptions = { tokens?: unknown[]; paths?: unknown[] };

/**
 * Redact KNOWN sensitive strings from free text by exact substring substitution: every entry of
 * `tokens` becomes `[redacted]` and every entry of `paths` becomes `[local-path]`. Non-string /
 * empty entries are ignored; a token must be non-empty and a path longer than one character (a bare
 * `/` is not a "known path"). Paths are applied longest-first so a nested path (e.g. cwd under home)
 * is redacted before a shorter prefix would swallow its tail. `undefined`/`null` pass through
 * untouched so callers can hand diagnostics straight in.
 */
export function redactKnownLocalPaths(
  value: unknown,
  { tokens = [], paths = [] }: RedactKnownLocalPathsOptions = {},
): string | null | undefined {
  if (value === undefined || value === null) return value;
  let text = String(value);
  for (const token of tokens) {
    if (typeof token === "string" && token.length > 0) text = text.split(token).join("[redacted]");
  }
  const knownPaths = paths.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 1);
  for (const localPath of knownPaths.sort((left, right) => right.length - left.length)) {
    text = text.split(localPath).join("[local-path]");
  }
  return text;
}
