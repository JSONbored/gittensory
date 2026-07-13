import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// Pack branch: oss-anti-slop keeps the same deterministic pass path but surfaces the public funnel.
export default definePredictedGateFixture({
  id: "clean-pass-oss-anti-slop",
  title: "Clean pass under the oss-anti-slop pack",
  branch: "pack selection branch with a public funnel and no duplicate, linked-issue, or path-policy findings",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { pack: "oss-anti-slop", duplicates: "block", linkedIssue: "advisory" } }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  expected: {
    conclusion: "success",
    pack: "oss-anti-slop",
    blockerCodes: [],
    warningCodes: [],
    funnelPresent: true,
    noteIncludes: ["public .loopover.yml", "slop score is NOT evaluated pre-submission"],
  },
});
