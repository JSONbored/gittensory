// Unlinked-issue candidate pre-filter, extracted to `@loopover/engine` (#4883) so the published
// gittensory-mcp/gittensory-miner CLIs can run the SAME deterministic recall pass the maintainer gate uses to
// surface a PR's likely-but-unlinked issue, instead of reaching into this backend's src/ tree. This file is a
// thin re-export shim; the implementation lives at packages/loopover-engine/src/signals/unlinked-issue-candidates.ts
// (imported via relative source path, not the published package, to match this repo's existing
// engine-consumption convention — see e.g. src/signals/slop.ts — and to avoid depending on the engine
// package's built dist/ output, which is not guaranteed to exist yet when typecheck/test:coverage run in CI).
export * from "../../packages/loopover-engine/src/signals/unlinked-issue-candidates";
