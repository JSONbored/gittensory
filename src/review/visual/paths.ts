// Visual-path classifier (reviewbot→gittensory convergence — visual capture port).
//
// PORTED VERBATIM from reviewbot's src/agents/gittensory/capabilities.ts `isVisualPath` (the three
// VISUAL_PATTERNS), keeping capture scoped to file types and public assets that are directly web-visible.
// Route inference is still generalized in capture.ts's DEFAULT_ROUTE_FILE, but this cost gate must not treat
// every apps/* file as visual: screenshot-enabled repos often keep backend/config/docs files there too. This is
// the EMPHATIC gate: screenshots fire ONLY for WEB-VISIBLE changes — a public asset (public/**, e.g. an OG
// image), or a front-of-house source extension
// (.tsx/.jsx/.css/.scss/.sass/.less/.html/.svg/.astro/.vue/.svelte/.mdx). A backend change
// (.ts/.md/.json/.py/...) matches NONE of these, so capture never triggers for it.
//
// PURE — no imports, no I/O. Callers MUST filter changed files through this before any capture.

const VISUAL_PATTERNS: RegExp[] = [
  /(^|\/)public\//i,
  /\.(tsx|jsx|css|scss|sass|less|html|svg|astro|vue|svelte|mdx)$/i,
];

/** True when `path` is a web-visible change worth screenshotting (frontend page / public OG asset / front-end
 *  source file). Backend .ts/.md/.json/.py paths return false → capture must NOT trigger for them. */
export function isVisualPath(path: string): boolean {
  return VISUAL_PATTERNS.some((pattern) => pattern.test(path));
}
