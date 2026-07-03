// Units for the CI check-run signals analyzer. Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCheckRuns,
  scanCiCheckSignals,
} from "../dist/analyzers/ci-check-signals.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

const req = (extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 7,
  githubToken: "test-token",
  headSha: "headsha0000000000000000000000000000000000",
  ...extra,
});

const checkRunsFetch = (checkRuns) => async () => jsonResponse({ total_count: checkRuns.length, check_runs: checkRuns });

const run = (name, conclusion, startedAt, completedAt, status = "completed", app = { id: 15368, slug: "github-actions" }) => ({
  name,
  status,
  conclusion,
  started_at: startedAt,
  completed_at: completedAt,
  app,
});

test("analyzeCheckRuns: flags a check whose latest run succeeded after an earlier failure", () => {
  const findings = analyzeCheckRuns([
    run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    run("CI", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z"),
  ]);
  assert.deepEqual(findings, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 }]);
});

test("analyzeCheckRuns: counts every non-success attempt before the eventual success", () => {
  const findings = analyzeCheckRuns([
    run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    run("CI", "timed_out", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z"),
    run("CI", "cancelled", "2026-01-01T00:20:00Z", "2026-01-01T00:25:00Z"),
    run("CI", "success", "2026-01-01T00:30:00Z", "2026-01-01T00:35:00Z"),
  ]);
  assert.deepEqual(findings, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 3 }]);
});

test("analyzeCheckRuns: a single stable-green run is not a retry", () => {
  const findings = analyzeCheckRuns([run("CI", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z")]);
  assert.deepEqual(findings, []);
});

test("analyzeCheckRuns: a check that is STILL failing (latest run not success) is not reported as a retry", () => {
  const findings = analyzeCheckRuns([
    run("CI", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    run("CI", "failure", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z"),
  ]);
  assert.deepEqual(findings, []);
});

test("analyzeCheckRuns: neutral/skipped earlier runs do not count as failed attempts", () => {
  const findings = analyzeCheckRuns([
    run("CI", "neutral", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    run("CI", "skipped", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z"),
    run("CI", "success", "2026-01-01T00:20:00Z", "2026-01-01T00:25:00Z"),
  ]);
  assert.deepEqual(findings, []);
});

test("analyzeCheckRuns: an in-progress/queued run (no conclusion) is excluded from grouping", () => {
  const findings = analyzeCheckRuns([
    run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    { name: "CI", status: "in_progress", conclusion: null, started_at: "2026-01-01T00:10:00Z", completed_at: null },
  ]);
  // The in-progress run is excluded, so the last COMPLETED run is still the failure — not a retry-to-success yet.
  assert.deepEqual(findings, []);
});

test("analyzeCheckRuns: orders attempts by started_at, not by list order", () => {
  const findings = analyzeCheckRuns([
    run("CI", "success", "2026-01-01T00:30:00Z", "2026-01-01T00:35:00Z"), // listed first, but started LAST
    run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"), // listed second, but started FIRST
  ]);
  assert.deepEqual(findings, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 }]);
});

test("analyzeCheckRuns: tracks independent check names separately", () => {
  const findings = analyzeCheckRuns([
    run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    run("CI", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z"),
    run("Lint", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
  ]);
  assert.deepEqual(findings, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 }]);
});

test("analyzeCheckRuns: two DIFFERENT apps sharing the same check name are NOT merged into a false retry", () => {
  const findings = analyzeCheckRuns([
    run("build", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", "completed", { id: 111, slug: "app-one" }),
    run("build", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z", "completed", { id: 222, slug: "app-two" }),
  ]);
  // Same display name, different apps — these are two unrelated checks, not one check retried.
  assert.deepEqual(findings, []);
});

test("analyzeCheckRuns: groups by app slug when id is absent, falls back to a sentinel when both are absent", () => {
  const bySlug = analyzeCheckRuns([
    run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", "completed", { slug: "custom-app" }),
    run("CI", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z", "completed", { slug: "custom-app" }),
  ]);
  assert.deepEqual(bySlug, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 }]);

  const noAppInfo = analyzeCheckRuns([
    run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", "completed", null),
    run("CI", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z", "completed", null),
  ]);
  assert.deepEqual(noAppInfo, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 }]);
});

test("analyzeCheckRuns: flags a completed run at/over the long-running threshold", () => {
  const findings = analyzeCheckRuns([run("Deploy", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:15:00Z")]);
  assert.deepEqual(findings, [{ checkName: "Deploy", kind: "long-running-check", durationMinutes: 15 }]);
  const brief = renderBrief({ ciCheckSignals: findings }).promptSection;
  assert.match(brief, /ran for 15 minutes/);
});

test("renderBrief: pluralizes a single failed attempt / single minute correctly", () => {
  const findings = [
    { checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 },
    { checkName: "Deploy", kind: "long-running-check", durationMinutes: 1 },
  ];
  const brief = renderBrief({ ciCheckSignals: findings }).promptSection;
  assert.match(brief, /1 earlier non-success attempt at this commit/);
  assert.match(brief, /ran for 1 minute\b/);
  assert.doesNotMatch(brief, /1 attempts\b/);
  assert.doesNotMatch(brief, /1 minutes\b/);
});

test("analyzeCheckRuns: a run under the long-running threshold is not flagged", () => {
  const findings = analyzeCheckRuns([run("Deploy", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:14:59Z")]);
  assert.deepEqual(findings, []);
});

test("analyzeCheckRuns: a run can be both a retry-resolving success AND long-running", () => {
  const findings = analyzeCheckRuns([
    run("Deploy", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
    run("Deploy", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:30:00Z"), // 20-minute successful retry
  ]);
  assert.deepEqual(findings, [
    { checkName: "Deploy", kind: "retried-after-failure", failedAttempts: 1 },
    { checkName: "Deploy", kind: "long-running-check", durationMinutes: 20 },
  ]);
});

test("analyzeCheckRuns: no findings for an empty check-run list", () => {
  assert.deepEqual(analyzeCheckRuns([]), []);
});

test("scanCiCheckSignals: resolves findings from the check-runs API response envelope", async () => {
  const findings = await scanCiCheckSignals(
    req(),
    checkRunsFetch([
      run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
      run("CI", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z"),
    ]),
  );
  assert.deepEqual(findings, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 }]);
});

test("scanCiCheckSignals: an integration-shaped mock that emulates the real API's filter=latest default would hide the retry, proving the scanner must ask for filter=all", async () => {
  // GitHub's check-runs list defaults to filter=latest (one run per name); only filter=all returns superseded
  // attempts. This mock behaves like the real API: it drops the earlier failure unless filter=all is requested.
  const findings = await scanCiCheckSignals(req(), async (url) => {
    const all = new URL(url).searchParams.get("filter") === "all";
    const runs = all
      ? [
          run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z"),
          run("CI", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z"),
        ]
      : [run("CI", "success", "2026-01-01T00:10:00Z", "2026-01-01T00:15:00Z")]; // filter=latest: only the newest run
    return jsonResponse({ total_count: runs.length, check_runs: runs });
  });
  assert.deepEqual(findings, [{ checkName: "CI", kind: "retried-after-failure", failedAttempts: 1 }]);
});

test("scanCiCheckSignals: requests filter=all so earlier (non-latest) attempts are visible, not just the newest run", async () => {
  let requestedUrl;
  await scanCiCheckSignals(req(), async (url) => {
    requestedUrl = url;
    return jsonResponse({ total_count: 0, check_runs: [] });
  });
  assert.match(
    requestedUrl,
    /^https:\/\/api\.github\.com\/repos\/octo\/repo\/commits\/headsha0+\/check-runs\?per_page=100&filter=all$/,
  );
});

test("scanCiCheckSignals: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanCiCheckSignals(
    req({ githubToken: undefined }),
    checkRunsFetch([run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanCiCheckSignals: no head SHA → skipped (no finding, no throw)", async () => {
  const findings = await scanCiCheckSignals(
    req({ headSha: undefined }),
    checkRunsFetch([run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanCiCheckSignals: a malformed repoFullName is skipped, not thrown", async () => {
  const findings = await scanCiCheckSignals(
    req({ repoFullName: "not-a-valid-slug" }),
    checkRunsFetch([run("CI", "failure", "2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanCiCheckSignals: a fetch failure yields no finding", async () => {
  const findings = await scanCiCheckSignals(req(), async () => jsonResponse({ message: "bad" }, 500));
  assert.deepEqual(findings, []);
});

test("scanCiCheckSignals: a malformed response body (check_runs not an array) yields no finding", async () => {
  const findings = await scanCiCheckSignals(req(), async () => jsonResponse({ total_count: 0 }));
  assert.deepEqual(findings, []);
});

test("scanCiCheckSignals: no check-runs yields no finding", async () => {
  const findings = await scanCiCheckSignals(req(), checkRunsFetch([]));
  assert.deepEqual(findings, []);
});
