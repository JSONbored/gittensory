// Findings-by-category/severity analytics card model (#2195). UI-side mirror of the findings breakdown surfaced
// on the operator-dashboard payload (from src/review/stats.ts StatsPayload) plus the pure folds the card renders.
// Types + helpers live here (not in the .tsx) so the component file exports only components
// (react-refresh/only-export-components).

/** AI-review finding severity tiers, high → low. */
export type FindingSeverity = "high" | "medium" | "low";

/** One category's finding counts broken out by severity, over the report window. */
export interface FindingsCategoryRow {
  category: string;
  high: number;
  medium: number;
  low: number;
}

/** The findings-breakdown slice delivered on the operator-dashboard payload. Public-safe counts only. */
export interface FindingsBreakdownReport {
  windowDays: number;
  categories: FindingsCategoryRow[];
}

/** Aggregate severity totals across every category, plus the grand total. */
export interface FindingsBreakdownTotals {
  high: number;
  medium: number;
  low: number;
  total: number;
}

/** Sum one category row across its severities. */
export function categoryTotal(row: FindingsCategoryRow): number {
  return row.high + row.medium + row.low;
}

/** Fold every category row into aggregate severity totals + a grand total. Pure; an empty report is all zeros. */
export function totalFindingsBreakdown(report: FindingsBreakdownReport): FindingsBreakdownTotals {
  const totals = report.categories.reduce(
    (acc, row) => ({
      high: acc.high + row.high,
      medium: acc.medium + row.medium,
      low: acc.low + row.low,
    }),
    { high: 0, medium: 0, low: 0 },
  );
  return { ...totals, total: totals.high + totals.medium + totals.low };
}
