// Idea-intake bridge (#4798) — thin re-export shim. The canonical implementation lives in
// `@loopover/engine` (packages/loopover-engine/src/idea-intake.ts, product spec #4779), imported via the
// relative source path (matching src/signals/slop.ts) so the published loopover-mcp / loopover-miner CLIs
// share one bridge, and so this never depends on the engine's built dist/ during typecheck/test:coverage.
export * from "../packages/loopover-engine/src/idea-intake";
