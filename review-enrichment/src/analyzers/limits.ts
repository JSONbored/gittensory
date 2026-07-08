// Shared default limits for REES analyzers (#1477 follow-up). Most analyzers cap their findings and
// skip pathologically long lines at the same two numbers -- centralizing them here means changing the
// platform-wide bound in ONE place instead of ~30 duplicated literals scattered across analyzer files
// and their registry.ts descriptors. An analyzer with a genuinely different bound (e.g. asset-weight's
// 50, heavy-dependency's 15) keeps its own local override -- only the REPEATED 25/2000 pair moves here.

/** Default cap on findings a single analyzer emits per request, keeping the brief bounded. */
export const DEFAULT_MAX_FINDINGS = 25;

/** Default per-line length ceiling analyzers skip past without inspecting -- defensive against a
 *  pathologically long generated/minified line, not a real code-quality signal. */
export const DEFAULT_MAX_LINE_CHARS = 2000;
