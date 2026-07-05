// Shared skip predicate for the history-class analyzers (blame-link #2034, churn-hotspot #1513). A file whose
// commit history carries no useful "who introduced this" / code-fragility signal — a lockfile, generated
// output, or a binary blob — should be skipped by both, so the rule lives in one place instead of a duplicated
// per-analyzer regex. Binary and lockfile recognition delegate to the unified inventories (binary-extensions,
// lockfile-path) so this stays in sync as those grow, rather than a hand-maintained list.
import { BINARY_EXT_RE } from "./binary-extensions.js";
import { isSupportedLockfile } from "../lockfile-path.js";

// Non-binary generated output (and the original narrow binary/lockfile set) — kept verbatim from the previous
// per-analyzer SKIP_RE. Broader binary and lockfile coverage is added by the two shared inventories below.
const SKIP_RE =
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum)$|\.(?:lock|min\.js|map|snap|png|jpe?g|gif|svg|ico|pdf|zip|gz|woff2?)$|(?:^|\/)(?:dist|build|vendor)\//i;

/** True when a file's commit history is not a useful fragility/attribution signal — a lockfile, generated
 *  output, or a binary blob. Additive over the original rule: it now also skips the full shared binary
 *  inventory (e.g. webp/avif/heic/mp4/wasm/safetensors) and the full lockfile set (e.g. Cargo.lock,
 *  composer.lock, bun.lockb), not just the original narrow list. Pure. */
export function isHistoryUninformativePath(path: string): boolean {
  return SKIP_RE.test(path) || BINARY_EXT_RE.test(path) || isSupportedLockfile(path);
}
