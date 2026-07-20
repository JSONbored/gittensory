/**
 * Redact any absolute or home-anchored local path found in free text, replacing it with the
 * `<local-path>` placeholder. Heuristic (matches an unknown path by shape), so it never needs the
 * concrete path in advance — the counterpart to the exact-match `redactKnownLocalPaths` below.
 */
export declare function redactLocalPath(value: unknown): string;
export type RedactKnownLocalPathsOptions = {
    tokens?: unknown[];
    paths?: unknown[];
};
/**
 * Redact KNOWN sensitive strings from free text by exact substring substitution: every entry of
 * `tokens` becomes `[redacted]` and every entry of `paths` becomes `[local-path]`. Non-string /
 * empty entries are ignored; a token must be non-empty and a path longer than one character (a bare
 * `/` is not a "known path"). Paths are applied longest-first so a nested path (e.g. cwd under home)
 * is redacted before a shorter prefix would swallow its tail. `undefined`/`null` pass through
 * untouched so callers can hand diagnostics straight in.
 */
export declare function redactKnownLocalPaths(value: unknown, { tokens, paths }?: RedactKnownLocalPathsOptions): unknown;
