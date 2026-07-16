// Visual-path classifier (reviewbot→loopover convergence — visual capture port).
//
// PORTED VERBATIM from reviewbot's src/agents/loopover/capabilities.ts `isVisualPath` (the three
// VISUAL_PATTERNS), with the first pattern's app-folder segment widened to a wildcard (#3611 follow-up) so it
// isn't loopover-ui-only — see capture.ts's DEFAULT_ROUTE_FILE for the same generalization. This is the
// EMPHATIC gate: screenshots fire ONLY for WEB-VISIBLE changes — any frontend app folder (apps/*/**, e.g.
// apps/loopover-ui/** or apps/ui/**), a public asset (public/**, e.g. an OG image), or a front-of-house
// source extension (.tsx/.jsx/.css/.scss/.sass/.less/.html/.svg/.astro/.vue/.svelte/.mdx). A backend change
// OUTSIDE an app folder (.ts/.md/.json/.py/... under e.g. src/**) matches NONE of these, so capture never
// triggers for it.
//
// #6322: pattern 1's app-folder prefix alone is extension-agnostic, so a bare .ts file living INSIDE an app's
// own src/ tree (a data/logic/hooks/test file — TanStack Router's file-based routes are always .tsx/.jsx, so a
// bare .ts can never itself be a route) also matched, even though it renders nothing (confirmed live:
// JSONbored/metagraphed#6036 touched only apps/ui/src/lib/metagraphed/queries.ts + its .test.ts sibling, a
// non-visual data-layer fix the bot's own screenshot-table-gate correctly called out of scope, yet capture
// still ran and burned Browser Rendering on a meaningless "before/after of the unchanged homepage"). Excluding
// apps/*/src/**/*.ts specifically (not .tsx) fixes exactly that case while leaving every existing scope
// untouched: an app-ROOT .ts config file (tailwind.config.ts, vite.config.ts — genuinely can affect rendered
// output) still matches pattern 1 since it isn't under src/; README.md/components.json/any non-.ts file
// anywhere in the app tree still matches (not .ts); every .tsx/.jsx route or component is unaffected (this
// exclusion only strips bare .ts, never .tsx).
const NON_VISUAL_APP_SOURCE = /^apps\/[^/]+\/src\/.*\.ts$/i;

const VISUAL_PATTERNS: RegExp[] = [
  /^apps\/[^/]+\//i,
  /(^|\/)public\//i,
  /\.(tsx|jsx|css|scss|sass|less|html|svg|astro|vue|svelte|mdx)$/i,
];

/** True when `path` is a web-visible change worth screenshotting (frontend page / public OG asset / front-end
 *  source file). Backend .ts/.md/.json/.py paths return false → capture must NOT trigger for them, and (#6322)
 *  so does a bare .ts file under an app's own src/ tree even though it starts with an app-folder prefix — see
 *  NON_VISUAL_APP_SOURCE's doc comment above for why that specific case is safe to exclude. */
export function isVisualPath(path: string): boolean {
  if (NON_VISUAL_APP_SOURCE.test(path)) return false;
  return VISUAL_PATTERNS.some((pattern) => pattern.test(path));
}
