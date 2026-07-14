import type { AuthIdentity } from "../auth/security";
import type { ControlPanelRoleName } from "../types";
import type { PublicSurfaceSkipReason } from "../signals/settings-preview";
import { loadControlPanelAccessScope } from "./control-panel-roles";

export const PR_VISIBILITY_SKIP_REASONS = [
  "surface_off",
  "missing_author",
  "bot_author",
  "ignored_author",
  "maintainer_author",
  "miner_detection_unavailable",
  "not_official_gittensor_miner",
] as const satisfies readonly PublicSurfaceSkipReason[];

export type SkippedPrAuditRepoScope = { ok: true; repoFullNames: string[] | undefined } | { ok: false };

/** Repo-scope resolution for the skipped-PR audit trail, shared by GET /v1/app/skipped-pr-audit and the
 *  loopover_get_skipped_pr_audit MCP tool so the two surfaces cannot drift on who gets to see which repos'
 *  skip events (#5825). An operator (or any non-session identity, which the caller must have already
 *  authorized separately) sees every repo unless a specific one is requested; a maintainer/owner session is
 *  scoped to the repos their control-panel access already covers. */
export async function resolveSkippedPrAuditRepoScope(
  env: Env,
  identity: AuthIdentity,
  roles: ControlPanelRoleName[],
  requestedRepo: string | undefined,
): Promise<SkippedPrAuditRepoScope> {
  if (identity.kind !== "session" || roles.includes("operator")) return { ok: true, repoFullNames: requestedRepo ? [requestedRepo] : undefined };
  const scope = await loadControlPanelAccessScope(env, identity.actor);
  const scopedRepoNames = new Set(scope.repositoryFullNames.map((name) => name.toLowerCase()));
  if (requestedRepo) {
    return scopedRepoNames.has(requestedRepo.toLowerCase()) ? { ok: true, repoFullNames: [requestedRepo] } : { ok: false };
  }
  return { ok: true, repoFullNames: scope.repositoryFullNames };
}

export function skippedPrAuditRemediation(reason: string): string {
  switch (reason) {
    case "surface_off":
      return "Enable a PR public surface or check runs in repository settings if maintainers want LoopOver to post.";
    case "missing_author":
      return "Retry after GitHub provides a resolvable pull request author.";
    case "bot_author":
      return "No action needed; bot-authored pull requests are intentionally kept quiet.";
    case "ignored_author":
      return "No action needed; the repository manifest explicitly skips review output for this author.";
    case "maintainer_author":
      return "Enable maintainer-authored PRs in repository settings only if those PRs should receive public GitHub App output.";
    case "miner_detection_unavailable":
      return "Retry after official Gittensor miner detection recovers; LoopOver skips instead of guessing.";
    case "not_official_gittensor_miner":
      return "No public action is needed unless the author should be recognized as an official Gittensor miner.";
    default:
      return "Review repository settings and installation health before reprocessing the pull request.";
  }
}

export function toIsoQueryDate(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
