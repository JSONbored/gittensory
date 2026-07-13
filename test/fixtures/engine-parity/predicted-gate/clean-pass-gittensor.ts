import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// Clean pass: linked issue present, no open duplicate cluster, and no path-gated or manifest blockers.
export default definePredictedGateFixture({
  id: "clean-pass-gittensor",
  title: "Clean pass under the default gittensor pack",
  branch: "success path with no duplicate_pr_risk, no missing_linked_issue, and no path-dependent findings",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { duplicates: "block", linkedIssue: "advisory" } }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  expected: {
    conclusion: "success",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: [],
    funnelPresent: false,
    noteIncludes: ["public .loopover.yml", "slop score is NOT evaluated pre-submission"],
  },
});
