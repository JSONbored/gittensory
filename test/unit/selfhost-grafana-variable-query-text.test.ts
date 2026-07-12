import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard (2026-07 fix): every "query"-type template variable across every dashboard silently
// returned ZERO options in the live Grafana instance -- confirmed empirically against a running
// frser-sqlite-datasource via POST /api/ds/query -- because the variable's `query` object only carried
// `rawQueryText` (a display/round-trip field), never the `queryText` field the plugin actually needs to
// execute the query. Panel targets were never affected: they already set BOTH fields at the top level (see
// the `rawQueryText === queryText` check on panel targets elsewhere in this suite), which is exactly why
// every table/timeseries panel rendered real data while every $variable dropdown showed a red error icon and
// resolved to nothing -- cascading into "No data"/zeroed panels wherever a panel's WHERE clause referenced
// one of those variables. This test scans every dashboard file, not just the ones fixed today, so a future
// dashboard can never reintroduce this by copying the variable shape without the fix.
const dashboardsDir = join(process.cwd(), "grafana/dashboards");

type TemplateVar = {
  name: string;
  type: string;
  datasource?: { type?: string };
  query?: { queryText?: string; rawQueryText?: string } | string;
};

function readDashboardFiles(): Array<{ file: string; vars: TemplateVar[] }> {
  return readdirSync(dashboardsDir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const dashboard = JSON.parse(readFileSync(join(dashboardsDir, file), "utf8")) as {
        templating?: { list?: TemplateVar[] };
      };
      return { file, vars: dashboard.templating?.list ?? [] };
    });
}

describe("Grafana dashboards: every query-type template variable actually executes (2026-07 fix)", () => {
  it("every SQL-datasource query variable's `query` object carries queryText, matching rawQueryText", () => {
    const dashboards = readDashboardFiles();
    expect(dashboards.length).toBeGreaterThan(3); // sanity: the scan found real dashboard files

    const violations: string[] = [];
    for (const { file, vars } of dashboards) {
      for (const v of vars) {
        if (v.type !== "query") continue;
        if (typeof v.query !== "object" || v.query === null) continue;
        // Only the frser-sqlite-datasource plugin exhibits this specific missing-queryText bug (confirmed
        // empirically); a Prometheus/other query variable's `query` field is a plain string, not this shape,
        // and is unaffected -- skip anything that isn't this plugin.
        if (v.datasource?.type !== "frser-sqlite-datasource") continue;
        const { queryText, rawQueryText } = v.query;
        if (!queryText) {
          violations.push(`${file}: $${v.name} is missing "queryText" in its query object (rawQueryText alone silently returns zero rows)`);
        } else if (queryText !== rawQueryText) {
          violations.push(`${file}: $${v.name}'s queryText and rawQueryText have diverged ("${queryText}" vs "${rawQueryText}")`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
