import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// changedPaths absent: the same path-gated check cannot be predicted yet and must stay silent.
export default definePredictedGateFixture({
  id: "path-gated-check-without-paths",
  title: "Path-gated pre-merge check stays unresolved without changedPaths",
  branch: "same review.pre_merge_checks rule as the changedPaths case, but skipped pre-submission without file paths",
  input: BASE_INPUT,
  manifest: parseManifest({
    review: { pre_merge_checks: [{ name: "Tests for src", title_contains: "ZZZ-never", when_paths: ["src/**"], enforce: true }] },
  }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  expected: {
    conclusion: "success",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: [],
    funnelPresent: false,
    noteIncludes: ["Provide the PR's changed paths"],
  },
});
