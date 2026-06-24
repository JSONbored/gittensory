import { describe, expect, it } from "vitest";
import { buildExtensionOpenPrPressure, extensionOpenPrPressureHeadline } from "../../src/signals/extension-open-pr-pressure";
import type { ContributorOpenPrPressureResponse } from "../../src/services/open-pr-pressure-response";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward estimate|raw trust|trust score|scoreability|private reviewability|estimated score|score estimate|farming/i;

function sampleResponse(overrides: Partial<ContributorOpenPrPressureResponse> = {}): ContributorOpenPrPressureResponse {
  return {
    login: "miner-a",
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    contributorOpenPrCount: 2,
    simulation: {
      repoFullName: "octo/demo",
      generatedAt: "2026-06-03T00:00:00.000Z",
      lane: "contributor",
      queuePressure: "high",
      recommendedOption: "cleanup_first",
      summary: "Clean up existing work before opening another PR.",
      scenarios: [
        {
          option: "cleanup_first",
          label: "Clean up existing work first",
          rank: 1,
          recommended: true,
          facts: ["Repo queue pressure is high.", "You have 2 open PR(s) on this repo."],
          assumptions: ["Maintainers review oldest work first."],
          tradeoffs: ["Delays starting new work."],
          blockers: ["Multiple open PRs increase review friction."],
        },
        {
          option: "wait",
          label: "Wait before opening more",
          rank: 2,
          recommended: false,
          facts: ["Repo queue pressure is high."],
          assumptions: ["Queue may clear soon."],
          tradeoffs: ["May miss a timely issue."],
          blockers: [],
        },
        {
          option: "open_new_work",
          label: "Open another PR now",
          rank: 3,
          recommended: false,
          facts: ["Repo queue pressure is high."],
          assumptions: ["New work is small and reviewable."],
          tradeoffs: ["Adds more queue pressure."],
          blockers: ["Review backlog is already elevated."],
        },
      ],
    },
    ...overrides,
  };
}

describe("extension open-PR pressure shaping", () => {
  it("redacts forbidden private terms from scenario text", () => {
    const shaped = buildExtensionOpenPrPressure(
      sampleResponse({
        simulation: {
          ...sampleResponse().simulation,
          summary: "Avoid wallet language and raw trust score claims.",
          scenarios: [
            {
              option: "wait",
              label: "Wait before opening more",
              rank: 1,
              recommended: true,
              facts: ["Do not mention payout estimates."],
              assumptions: ["No hotkey material in public comments."],
              tradeoffs: ["scoreability stays private"],
              blockers: ["reward estimate language"],
            },
          ],
        },
      }),
    );
    expect(JSON.stringify(shaped)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(shaped.summary).toContain("[redacted]");
  });

  it("preserves strategy structure and recommended option", () => {
    const shaped = buildExtensionOpenPrPressure(sampleResponse());
    expect(shaped.recommendedOption).toBe("cleanup_first");
    expect(shaped.contributorOpenPrCount).toBe(2);
    expect(shaped.scenarios).toHaveLength(3);
    expect(shaped.scenarios.find((entry) => entry.recommended)?.option).toBe("cleanup_first");
  });

  it("builds a public-safe headline from the recommended scenario label", () => {
    const shaped = buildExtensionOpenPrPressure(sampleResponse());
    const headline = extensionOpenPrPressureHeadline(shaped);
    expect(headline).toContain("octo/demo");
    expect(headline).toContain("Clean up existing work first");
    expect(headline).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });
});
