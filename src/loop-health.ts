// Loop health / anomaly evaluator (#4808) — thin re-export shim. The canonical implementation lives in
// `@loopover/engine` (packages/loopover-engine/src/loop-health.ts), imported via the relative source path
// (matching src/loop-progress.ts / src/results-payload.ts) so the published loopover-mcp / loopover-miner
// CLIs share one evaluator, and so this never depends on the engine's built dist/ during typecheck/test.
export * from "../packages/loopover-engine/src/loop-health";
