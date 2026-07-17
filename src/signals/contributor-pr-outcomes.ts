import { listNotificationDeliveriesForRecipient } from "../db/repositories";

// A contributor's own post-merge outcome history (#6747): for each merged PR, the public-safe attribution that
// was delivered to them describing what it did for their standing on the repo. Sourced from the same
// `pull_request_merged` notification deliveries the `loopover_pr_outcome` MCP tool reads, so the MCP tool, the
// REST route (`GET /v1/contributors/:login/pr-outcomes`), and the CLI mirror all return identical data — this
// builder is the single source of truth, mirroring how `buildContributorOpenPrMonitor` backs its own trio.

/** Default number of most-recent merged-PR outcomes returned when the caller doesn't specify a limit. */
export const CONTRIBUTOR_PR_OUTCOMES_DEFAULT_LIMIT = 50;

export type ContributorPrOutcome = {
  repoFullName: string;
  /** The merged PR's number; null only for a legacy delivery recorded without one. */
  pullNumber: number | null;
  outcome: "merged";
  /** Public-safe attribution text — the delivered notification body, never raw internal scoring. */
  attribution: string;
  deeplink: string;
  recordedAt: string;
};

export type ContributorPrOutcomes = {
  login: string;
  count: number;
  outcomes: ContributorPrOutcome[];
};

/**
 * Build a contributor's merged-PR outcome history from their `pull_request_merged` notification deliveries,
 * newest first. Self-scoped by `login` — the caller (MCP tool / REST route) owns the access check. `login` is
 * lowercased in the result so every surface reports a canonical form.
 */
export async function buildContributorPrOutcomes(env: Env, login: string, limit?: number): Promise<ContributorPrOutcomes> {
  const deliveries = await listNotificationDeliveriesForRecipient(env, login, {
    eventType: "pull_request_merged",
    limit: limit ?? CONTRIBUTOR_PR_OUTCOMES_DEFAULT_LIMIT,
  });
  const outcomes: ContributorPrOutcome[] = deliveries.map((delivery) => ({
    repoFullName: delivery.repoFullName,
    pullNumber: delivery.pullNumber,
    outcome: "merged",
    attribution: delivery.body,
    deeplink: delivery.deeplink,
    recordedAt: delivery.createdAt,
  }));
  return { login: login.toLowerCase(), count: outcomes.length, outcomes };
}
