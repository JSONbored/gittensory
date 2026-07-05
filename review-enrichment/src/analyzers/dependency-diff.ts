// Dependency-diff inventory analyzer (#2020). Emits a neutral summary of direct dependency manifest
// changes — added, removed, or version-changed packages across package.json, requirements.txt, and go.mod.
// Distinct from the CVE-scanning dependency analyzer: no registry calls, pure compute over manifest patches.
import type { DependencyDiffFinding, EnrichRequest } from "../types.js";
import {
  extractDependencyInventoryChanges,
  type ScanLimits,
} from "./dependency-scan.js";

const MAX_FINDINGS = 25;
const LIMITS: ScanLimits = {
  maxManifestFiles: 20,
  maxPatchLinesPerFile: 500,
};

/** Scan changed manifest patches for direct dependency inventory deltas. Pure. */
export function scanDependencyDiff(req: EnrichRequest): DependencyDiffFinding[] {
  return extractDependencyInventoryChanges(req.files ?? [], LIMITS, MAX_FINDINGS);
}

/** Analyzer entrypoint: summarize direct dependency add/remove/change deltas from manifest patches. */
export async function scanDependencyDiffInventory(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<DependencyDiffFinding[]> {
  if (signal?.aborted) throw new Error("analyzer_aborted");
  return scanDependencyDiff(req);
}
