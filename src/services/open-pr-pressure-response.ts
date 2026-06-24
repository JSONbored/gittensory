import { getRepository, listIssues, listPullRequests } from "../db/repositories";
import type { ContributorProfile } from "../signals/engine";
import { buildCollisionReport, buildQueueHealth, buildRoleContext } from "../signals/engine";
import { nowIso } from "../utils/json";
import { simulateOpenPrPressure, type OpenPrPressureSimulation } from "./open-pr-pressure-scenarios";

export type ContributorOpenPrPressureResponse = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  contributorOpenPrCount: number;
  simulation: OpenPrPressureSimulation;
};

/**
 * Build a contributor-scoped open-PR pressure strategy simulation for one repo.
 * Mirrors the simulation wired into local-branch analysis (#348) but exposes it as a
 * dedicated read-only surface for extension clients and MCP agents.
 */
export async function buildContributorOpenPrPressureResponse(
  env: Env,
  login: string,
  repoFullName: string,
  profile: ContributorProfile | null = null,
): Promise<ContributorOpenPrPressureResponse | null> {
  const repo = await getRepository(env, repoFullName);
  if (!repo) return null;

  const [issues, pullRequests] = await Promise.all([listIssues(env, repoFullName), listPullRequests(env, repoFullName)]);
  const roleContext = buildRoleContext({
    login,
    repo,
    repoFullName,
    pullRequests,
    issues,
    profile,
  });
  const collisions = buildCollisionReport(repoFullName, issues, pullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
  const normalizedLogin = login.toLowerCase();
  const contributorOpenPrCount = pullRequests.filter(
    (pr) => pr.state === "open" && (pr.authorLogin ?? "").toLowerCase() === normalizedLogin,
  ).length;
  const generatedAt = nowIso();
  const simulation = simulateOpenPrPressure({
    repoFullName,
    generatedAt,
    queueHealth,
    roleContext,
    contributorOpenPrCount,
  });

  return {
    login,
    repoFullName,
    generatedAt,
    contributorOpenPrCount,
    simulation,
  };
}
