import { describe, expect, it } from "vitest";
import { upsertIssueFromGitHub, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { buildContributorOpenPrPressureResponse } from "../../src/services/open-pr-pressure-response";
import { createTestEnv } from "../helpers/d1";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward estimate|raw trust|trust score|scoreability|private reviewability|estimated score|score estimate|farming/i;

describe("buildContributorOpenPrPressureResponse", () => {
  it("returns strategy simulation with contributor open PR count for a registered repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    await upsertIssueFromGitHub(env, "octo/demo", { number: 1, title: "Queue issue", state: "open", user: { login: "octo" }, labels: [{ name: "feature" }] });
    await upsertPullRequestFromGitHub(env, "octo/demo", {
      number: 10,
      title: "Contributor work",
      state: "open",
      user: { login: "miner-a" },
      labels: [],
      head: { sha: "abc", ref: "feat" },
      base: { ref: "main" },
    });
    await upsertPullRequestFromGitHub(env, "octo/demo", {
      number: 11,
      title: "More contributor work",
      state: "open",
      user: { login: "miner-a" },
      labels: [],
      head: { sha: "def", ref: "feat2" },
      base: { ref: "main" },
    });

    const response = await buildContributorOpenPrPressureResponse(env, "miner-a", "octo/demo");
    expect(response).toMatchObject({
      login: "miner-a",
      repoFullName: "octo/demo",
      contributorOpenPrCount: 2,
      simulation: {
        repoFullName: "octo/demo",
        lane: "contributor",
        recommendedOption: expect.stringMatching(/^(open_new_work|wait|cleanup_first)$/),
        scenarios: expect.arrayContaining([
          expect.objectContaining({
            option: expect.any(String),
            recommended: expect.any(Boolean),
            facts: expect.any(Array),
          }),
        ]),
      },
    });
    expect(JSON.stringify(response)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("returns null when the repo is unknown", async () => {
    const env = createTestEnv();
    await expect(buildContributorOpenPrPressureResponse(env, "miner-a", "missing/repo")).resolves.toBeNull();
  });

  it("recommends cleanup_first when the contributor has multiple open PRs on a busy queue", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "busy", full_name: "octo/busy", private: false, owner: { login: "octo" }, default_branch: "main" });
    for (let issue = 1; issue <= 6; issue += 1) {
      await upsertIssueFromGitHub(env, "octo/busy", { number: issue, title: `Issue ${issue}`, state: "open", user: { login: "octo" }, labels: [{ name: "feature" }] });
    }
    for (let pr = 1; pr <= 14; pr += 1) {
      await upsertPullRequestFromGitHub(env, "octo/busy", {
        number: pr,
        title: `PR ${pr}`,
        state: "open",
        user: { login: pr <= 3 ? "miner-a" : "other" },
        labels: [],
        head: { sha: `sha${pr}`, ref: `branch-${pr}` },
        base: { ref: "main" },
        ...(pr > 10 ? { updated_at: "2020-01-01T00:00:00.000Z" } : {}),
      });
    }

    const response = await buildContributorOpenPrPressureResponse(env, "miner-a", "octo/busy");
    expect(response?.contributorOpenPrCount).toBe(3);
    expect(response?.simulation.recommendedOption).toBe("cleanup_first");
    expect(response?.simulation.scenarios.find((entry) => entry.recommended)?.option).toBe("cleanup_first");
  });
});
