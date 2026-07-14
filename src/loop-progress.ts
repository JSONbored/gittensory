// Loop progress model (#4800) — thin re-export shim. The canonical implementation lives in
// `@loopover/engine` (packages/loopover-engine/src/loop-progress.ts), imported via the relative source
// path (matching src/results-payload.ts / src/idea-intake.ts) so the published loopover-mcp / loopover-miner
// CLIs share one model, and so this never depends on the engine's built dist/ during typecheck/test.
export * from "../packages/loopover-engine/src/loop-progress";
