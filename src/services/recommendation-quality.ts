import { listAgentRecommendationOutcomes } from "../db/repositories";
import type { RecommendationQualityReport } from "./recommendation-quality-report";
import { buildRecommendationQualityReportFromOutcomes } from "./recommendation-quality-report";
import { nowIso } from "../utils/json";

export type RepoRecommendationQualityReport = {
  repoFullName: string;
  generatedAt: string;
  windowDays: number;
  visibility: "maintainer_scoped";
  /** Narrowed view of the operator dashboard report, scoped to this repo. */
  totals: RecommendationQualityReport["totals"];
  trends: RecommendationQualityReport["trends"];
  failureCategories: RecommendationQualityReport["failureCategories"];
  rollups: RecommendationQualityReport["rollups"];
  warnings: RecommendationQualityReport["warnings"];
  summary: string;
};

export function recommendationQualitySummary(report: RepoRecommendationQualityReport): string {
  const resolved = report.totals.positive + report.totals.negative;
  const rate = resolved > 0 ? `${Math.round((report.totals.positive / resolved) * 100)}%` : "n/a";
  const window = `${report.windowDays}d`;
  return `${report.repoFullName}: recommendation outcomes ${report.totals.positive}/${report.totals.total} positive (${rate} resolved, ${window}).`;
}

/** Maintainer-scoped, repo-filtered recommendation quality report. Measurement only. */
export async function buildRepoRecommendationQuality(
  env: Env,
  repoFullName: string,
  windowDays?: number,
): Promise<RepoRecommendationQualityReport> {
  const generatedAt = nowIso();
  const effectiveWindowDays = windowDays ?? 90;
  const outcomes = await listAgentRecommendationOutcomes(env, { repoFullName, windowDays: effectiveWindowDays, now: generatedAt, limit: 5000 });
  const report = buildRecommendationQualityReportFromOutcomes(outcomes, { generatedAt, windowDays: effectiveWindowDays });
  const scoped: RepoRecommendationQualityReport = {
    repoFullName,
    generatedAt,
    windowDays: effectiveWindowDays,
    visibility: "maintainer_scoped",
    totals: report.totals,
    trends: report.trends,
    failureCategories: report.failureCategories,
    rollups: report.rollups,
    warnings: report.warnings,
    summary: "",
  };
  scoped.summary = recommendationQualitySummary(scoped);
  return scoped;
}

