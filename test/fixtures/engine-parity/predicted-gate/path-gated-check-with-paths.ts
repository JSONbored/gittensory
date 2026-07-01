import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// changedPaths supplied: a path-gated pre-merge check becomes enforceable and fails.
export default definePredictedGateFixture({
  id: "path-gated-check-with-paths",
  title: "Path-gated pre-merge check fails once changedPaths are known",
  branch: "pre_merge_check_required when an enforced whenPaths rule matches the supplied changedPaths",
  input: BASE_INPUT,
  manifest: parseManifest({
    review: { pre_merge_checks: [{ name: "Tests for src", title_contains: "ZZZ-never", when_paths: ["src/**"], enforce: true }] },
  }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  changedPaths: ["src/upload/client.ts"],
  expected: {
    conclusion: "failure",
    pack: "gittensor",
    blockerCodes: ["pre_merge_check_required"],
    warningCodes: [],
    funnelPresent: false,
    noteExcludes: ["Provide the PR's changed paths"],
  },
});
