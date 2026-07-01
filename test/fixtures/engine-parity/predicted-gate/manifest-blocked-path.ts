import { BASE_INPUT, BASE_REPO, definePredictedGateFixture, openIssue, parseManifest } from "./_shared";

// Focus-manifest policy branch: a changed path hits a blocked glob and manifestPolicy:block downgrades to HOLD.
export default definePredictedGateFixture({
  id: "manifest-blocked-path",
  title: "Blocked manifest path yields a neutral hold",
  branch: "manifest_blocked_path with changedPaths supplied and manifestPolicy:block",
  input: BASE_INPUT,
  manifest: parseManifest({ gate: { manifestPolicy: "block" }, blockedPaths: ["dist/**"] }),
  repo: BASE_REPO,
  issues: [openIssue(7, "Uploads should retry on 5xx")],
  pullRequests: [],
  changedPaths: ["dist/bundle.js"],
  expected: {
    conclusion: "neutral",
    pack: "gittensor",
    blockerCodes: [],
    warningCodes: ["manifest_blocked_path"],
    funnelPresent: false,
    noteExcludes: ["Provide the PR's changed paths"],
  },
});
