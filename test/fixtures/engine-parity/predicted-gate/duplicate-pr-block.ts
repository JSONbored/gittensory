import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, openPr, parseManifest } from "./_shared";

// Duplicate cluster branch: another OPEN PR already claims the same linked issue.
export default definePredictedGateFixture({
  id: "duplicate-pr-block",
  title: "Duplicate open PR blocks the predicted gate",
  branch: "duplicate_pr_risk via another open sibling sharing the linked issue",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { duplicates: "block" } }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [openPr(42, "Retry uploads on 5xx responses", [7])],
  expected: {
    conclusion: "failure",
    pack: "gittensor",
    blockerCodes: ["duplicate_pr_risk"],
    warningCodes: [],
    funnelPresent: false,
  },
});
