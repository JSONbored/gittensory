import { z } from "zod";
import { loadControlPanelAccessScope } from "./control-panel-roles";
import type { AuthIdentity } from "../auth/security";
import type { ControlPanelRoleName, PublicSurfaceSkipReason } from "../types";

export const PR_VISIBILITY_SKIP_REASONS = [
  "surface_off",
  "missing_author",
  "bot_author",
  "ignored_author",
  "maintainer_author",
  "miner_detection_unavailable",
  "not_official_gittensor_miner",
] as const satisfies readonly PublicSurfaceSkipReason[];

export const skippedPrAuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().optional(),
    repoFullName: z.string().trim().min(3).max(200).optional(),
    reason: z.enum(PR_VISIBILITY_SKIP_REASONS).optional(),
    since: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type SkippedPrAuditScopeResult =
  | { ok: true; repoFullNames: string[] | undefined }
  | { ok: false; code: "forbidden_repo" };

export async function skippedPrAuditRepoScope(
  env: Env,
  identity: AuthIdentity,
  roles: ControlPanelRoleName[],
  requestedRepo: string | undefined,
): Promise<SkippedPrAuditScopeResult> {
  if (identity.kind !== "session" || roles.includes("operator")) {
    return { ok: true, repoFullNames: requestedRepo ? [requestedRepo] : undefined };
  }
  const scope = await loadControlPanelAccessScope(env, identity.actor);
  const scopedRepoNames = new Set(scope.repositoryFullNames.map((name) => name.toLowerCase()));
  if (requestedRepo) {
    return scopedRepoNames.has(requestedRepo.toLowerCase())
      ? { ok: true, repoFullNames: [requestedRepo] }
      : { ok: false, code: "forbidden_repo" };
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
