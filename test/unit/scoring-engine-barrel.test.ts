import { describe, expect, it } from "vitest";

import { DEFAULT_SCORING_CONSTANTS, parsePythonNumberConstants } from "../../packages/loopover-engine/src/scoring/model";
import { buildScorePreview } from "../../packages/loopover-engine/src/scoring/preview";
import { classifyOpenPullRequest } from "../../packages/loopover-engine/src/scoring/pending-pr-scenarios";

describe("gittensory-engine scoring barrel exports (#2282)", () => {
  it("re-exports scoring namespaces from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.scoringPreview.buildScorePreview).toBe("function");
    expect(typeof barrel.scoringModel.parsePythonNumberConstants).toBe("function");
    expect(typeof barrel.scoringPendingPrScenarios.classifyOpenPullRequest).toBe("function");
    expect(barrel.scoringModel.DEFAULT_SCORING_CONSTANTS).toEqual(DEFAULT_SCORING_CONSTANTS);
    expect(typeof barrel.scoringPreview.buildScorePreview).toBe(typeof buildScorePreview);
    expect(typeof barrel.scoringModel.parsePythonNumberConstants).toBe(typeof parsePythonNumberConstants);
    expect(typeof barrel.scoringPendingPrScenarios.classifyOpenPullRequest).toBe(typeof classifyOpenPullRequest);
  });
});
