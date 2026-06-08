import { listRepositories } from "../db/repositories";
import { compositeQueuePressureScore, type BurdenForecast } from "../signals/engine";
import { loadOrComputeBurdenForecastResponse, type BurdenForecastResponse } from "./burden-forecast";
import { buildUnavailableQueueTrendReport, type QueueTrendReport } from "./queue-trends";
import { getRepoQueueTrendSnapshot } from "../db/repositories";
import { nowIso } from "../utils/json";

export const FEDERATED_QUEUE_INDEX_DEFAULT_LIMIT = 10;
export const FEDERATED_QUEUE_INDEX_MAX_LIMIT = 25;

const LEVEL_RANK: Record<BurdenForecast["level"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export type FederatedRepoEntry = {
  repoFullName: string;
  burdenScore: number;
  level: BurdenForecast["level"];
  compositeScore: number;
  stalePullRequestRate: number | null;
  pullRequestGrowth7d: number | null;
  freshness: "fresh" | "stale";
  summary: string;
};

export type FederatedQueueIndex = {
  generatedAt: string;
  repoCount: number;
  limitApplied: number;
  entries: FederatedRepoEntry[];
};

export async function buildFederatedQueueIndex(
  env: Env,
  limit: number = FEDERATED_QUEUE_INDEX_DEFAULT_LIMIT,
): Promise<FederatedQueueIndex> {
  const safeLimit = Math.min(Math.max(1, limit), FEDERATED_QUEUE_INDEX_MAX_LIMIT);
  const repos = (await listRepositories(env)).filter((repo) => repo.isRegistered && repo.isInstalled);

  const [forecasts, trendSnapshots] = await Promise.all([
    Promise.all(repos.map((repo) => loadOrComputeBurdenForecastResponse(env, repo.fullName))),
    Promise.all(repos.map((repo) => getRepoQueueTrendSnapshot(env, repo.fullName))),
  ]);

  const entries: FederatedRepoEntry[] = [];
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]!;
    const forecast = forecasts[i];
    /* v8 ignore next -- loadOrComputeBurdenForecastResponse only returns null for unknown repos; registered+installed repos are always known */
    if (!forecast) continue;
    const trendSnapshot = trendSnapshots[i];
    const trendReport: QueueTrendReport = trendSnapshot
      ? (trendSnapshot.payload as unknown as QueueTrendReport)
      : buildUnavailableQueueTrendReport(repo.fullName);
    /* v8 ignore next -- find returns undefined only when a trend report has no 7d window at all; unavailable trend reports always include all three window stubs */
    const window7d = trendReport.windows.find((w) => w.windowDays === 7) ?? null;
    const stalePullRequestRate = window7d?.stalePullRequestRate ?? null;
    const pullRequestGrowth7d = window7d?.pullRequestGrowth ?? null;
    const burdenScore = forecast.report.forecast?.projectedReviewLoad ?? 0;
    const composite = compositeQueuePressureScore(
      burdenScore,
      stalePullRequestRate,
      pullRequestGrowth7d,
    );
    entries.push({
      repoFullName: repo.fullName,
      burdenScore,
      level: forecast.report.level,
      compositeScore: Math.round(composite * 100) / 100,
      stalePullRequestRate,
      pullRequestGrowth7d,
      freshness: forecast.freshness,
      summary: forecast.report.summary,
    });
  }

  entries.sort((a, b) => {
    const scoreDiff = b.compositeScore - a.compositeScore;
    if (scoreDiff !== 0) return scoreDiff;
    return LEVEL_RANK[b.level] - LEVEL_RANK[a.level];
  });

  return {
    generatedAt: nowIso(),
    repoCount: entries.length,
    limitApplied: safeLimit,
    entries: entries.slice(0, safeLimit),
  };
}
