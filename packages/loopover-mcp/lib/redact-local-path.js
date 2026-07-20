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
export function redactLocalPath(value) {
    const text = String(value ?? "");
    if (!text)
        return text;
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
        .replace(rootedPath, (_, prefix) => `${prefix}<local-path>`)
        // Home/Windows roots that appear mid-token with no leading delimiter (so the anchored pass skips
        // them); run second so it only mops up what the anchored, space-aware pass could not claim.
        .replace(/(?:~\/|[A-Za-z]:\\)[^\s"'`,;)]+/g, "<local-path>");
}
/**
 * Redact KNOWN sensitive strings from free text by exact substring substitution: every entry of
 * `tokens` becomes `[redacted]` and every entry of `paths` becomes `[local-path]`. Non-string /
 * empty entries are ignored; a token must be non-empty and a path longer than one character (a bare
 * `/` is not a "known path"). Paths are applied longest-first so a nested path (e.g. cwd under home)
 * is redacted before a shorter prefix would swallow its tail. `undefined`/`null` pass through
 * untouched so callers can hand diagnostics straight in.
 */
export function redactKnownLocalPaths(value, { tokens = [], paths = [] } = {}) {
    if (value === undefined || value === null)
        return value;
    let text = String(value);
    for (const token of tokens) {
        if (typeof token === "string" && token.length > 0)
            text = text.split(token).join("[redacted]");
    }
    const knownPaths = paths.filter((candidate) => typeof candidate === "string" && candidate.length > 1);
    for (const localPath of knownPaths.sort((left, right) => right.length - left.length)) {
        text = text.split(localPath).join("[local-path]");
    }
    return text;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVkYWN0LWxvY2FsLXBhdGguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZWRhY3QtbG9jYWwtcGF0aC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxpR0FBaUc7QUFDakcsK0ZBQStGO0FBQy9GLG1HQUFtRztBQUNuRyx1RkFBdUY7QUFDdkYsRUFBRTtBQUNGLGtHQUFrRztBQUNsRyw4QkFBOEI7QUFDOUIsc0dBQXNHO0FBQ3RHLHVHQUF1RztBQUN2RyxzR0FBc0c7QUFDdEcsc0dBQXNHO0FBQ3RHLHNHQUFzRztBQUN0RyxxR0FBcUc7QUFFckc7Ozs7R0FJRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQUMsS0FBYztJQUM1QyxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2pDLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdkIsK0ZBQStGO0lBQy9GLCtGQUErRjtJQUMvRixzR0FBc0c7SUFDdEcsTUFBTSxXQUFXLEdBQUcsa0VBQWtFLENBQUM7SUFDdkYsTUFBTSxRQUFRLEdBQUcsd0JBQXdCLENBQUM7SUFDMUMscUdBQXFHO0lBQ3JHLHdHQUF3RztJQUN4RyxtR0FBbUc7SUFDbkcsTUFBTSxVQUFVLEdBQUcsSUFBSSxNQUFNLENBQUMsMkRBQTJELFdBQVcsWUFBWSxRQUFRLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQztJQUNsSSxPQUFPLElBQUk7U0FDUixPQUFPLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxFQUFFLE1BQWMsRUFBRSxFQUFFLENBQUMsR0FBRyxNQUFNLGNBQWMsQ0FBQztRQUNwRSxpR0FBaUc7UUFDakcsNEZBQTRGO1NBQzNGLE9BQU8sQ0FBQyxrQ0FBa0MsRUFBRSxjQUFjLENBQUMsQ0FBQztBQUNqRSxDQUFDO0FBSUQ7Ozs7Ozs7R0FPRztBQUNILE1BQU0sVUFBVSxxQkFBcUIsQ0FDbkMsS0FBYyxFQUNkLEVBQUUsTUFBTSxHQUFHLEVBQUUsRUFBRSxLQUFLLEdBQUcsRUFBRSxLQUFtQyxFQUFFO0lBRTlELElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUssSUFBSTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ3hELElBQUksSUFBSSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN6QixLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQzNCLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQztZQUFFLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUNqRyxDQUFDO0lBQ0QsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsRUFBdUIsRUFBRSxDQUFDLE9BQU8sU0FBUyxLQUFLLFFBQVEsSUFBSSxTQUFTLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQzNILEtBQUssTUFBTSxTQUFTLElBQUksVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDckYsSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUMsSUFBSSxDQUFDLGNBQWMsQ0FBQyxDQUFDO0lBQ3BELENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNkLENBQUMifQ==