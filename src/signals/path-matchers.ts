// Pure path matchers for slop classification (#561), extracted to `@jsonbored/gittensory-engine` (#4252)
// so the published gittensory-mcp/gittensory-miner CLIs can depend on the same source instead of
// hand-porting it. This file is now a thin re-export shim; the implementation lives at
// packages/gittensory-engine/src/signals/path-matchers.ts (imported via relative source path, not the
// published package, to match this repo's existing engine-consumption convention — see
// src/signals/test-evidence.ts / src/scoring/preview.ts — and to avoid depending on the engine package's
// built `dist/` output, which is not guaranteed to exist when `typecheck`/`test:coverage` run in CI).
//
// The moved implementation keeps the same portability discipline (MUST NOT import from local-branch.ts —
// reachable from apps/gittensory-ui via focus-manifest.ts); its only dependency is `./test-evidence`,
// itself already extracted to the engine.
export * from "../../packages/gittensory-engine/src/signals/path-matchers";
