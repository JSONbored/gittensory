// Signals engine, extracted to `@loopover/engine` (#4884). This is the maintainer-side signal stack
// (collision detection, queue health, contributor/lane advice, preflight, bounty context, and the rest of
// the ~5,800-line subsystem). The canonical implementation lives at
// packages/loopover-engine/src/signals/engine.ts; this file is a thin re-export shim so every existing
// consumer and test keeps its `../signals/engine` import path unchanged (imported via relative source path,
// not the published package, to match this repo's existing engine-consumption convention — see
// src/signals/check-summary.ts).
export * from "../../packages/loopover-engine/src/signals/engine";
