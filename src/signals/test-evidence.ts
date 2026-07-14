// Test/code-path classifiers, extracted to `@loopover/engine` so the published
// gittensory-mcp/gittensory-miner CLIs can depend on the same source instead of hand-porting it
// (previously drifted three times independently — see commit history titled "re-sync isTestFile
// with the server"). This file is a thin re-export shim; the implementation lives at
// packages/loopover-engine/src/signals/test-evidence.ts (imported via relative source path, not
// the published package, to match this repo's existing engine-consumption convention — see e.g.
// src/scoring/preview.ts — and to avoid depending on the engine package's built `dist/` output,
// which is not guaranteed to exist yet when `typecheck`/`test:coverage` run in CI).
export * from "../../packages/loopover-engine/src/signals/test-evidence";
