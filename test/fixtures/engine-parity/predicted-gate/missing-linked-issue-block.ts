import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, parseManifest } from "./_shared";

// Linked-issue branch: the repo's public config requires an issue, but none is linked or inferred from the body.
export default definePredictedGateFixture({
  id: "missing-linked-issue-block",
  title: "Missing linked issue blocks the predicted gate",
  branch: "missing_linked_issue when linkedIssue:block and the body carries no issue reference",
  input: { ...BASE_INPUT, body: "No linked issue yet", linkedIssues: [] },
  manifest: parseManifest({ gate: { linkedIssue: "block" } }),
  repo: BASE_REPO,
  issues: [],
  pullRequests: [],
  expected: {
    conclusion: "failure",
    pack: "gittensor",
    blockerCodes: ["missing_linked_issue"],
    warningCodes: [],
    funnelPresent: false,
  },
});
