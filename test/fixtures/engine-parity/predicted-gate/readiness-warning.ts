import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, parseManifest } from "./_shared";

// Readiness branch: the public readiness score falls below the manifest threshold, but stays advisory.
export default definePredictedGateFixture({
  id: "readiness-warning",
  title: "Low readiness stays advisory",
  branch: "readiness_score_below_threshold from gate.readiness.mode=advisory and a high threshold",
  input: { ...BASE_INPUT, body: "", linkedIssues: [] },
  manifest: parseManifest({ gate: { readiness: { mode: "advisory", minScore: 90 } } }),
  repo: BASE_REPO,
  issues: [],
  pullRequests: [],
  expected: {
    conclusion: "success",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: ["readiness_score_below_threshold"],
    funnelPresent: false,
  },
});
