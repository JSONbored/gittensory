/**
 * Focus-manifest validation shim (#6269). The result builder now lives engine-side in
 * `packages/loopover-engine/src/focus-manifest-validation.ts` so the local `loopover_validate_config` MCP
 * tool can compute it in-process (fully offline). This file re-exports the engine surface for the existing
 * app callers (`src/api/routes.ts`, `src/mcp/server.ts`), which keep importing from here unchanged.
 */
export {
  buildFocusManifestValidation,
  type FocusManifestValidationResult,
  type FocusManifestValidationStatus,
} from "../../packages/loopover-engine/src/focus-manifest-validation.js";
