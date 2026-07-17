import { describe, expect, it } from "vitest";
import {
  evaluateCandidateEligibility,
  fetchRepoLabelDescriptions,
  filterEligibleCandidates,
  profileNeedsLabelDescriptions,
} from "../../packages/loopover-miner/lib/contribution-profile-eligibility.js";
import { emptyContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile.js";
import type { ContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile.js";
import type { RawCandidateIssue } from "../../packages/loopover-miner/lib/opportunity-fanout.js";

const GENERATED_AT = "2026-07-01T00:00:00.000Z";

function candidate(overrides: Partial<RawCandidateIssue> = {}): RawCandidateIssue {
  return {
    owner: "acme",
    repo: "widgets",
    repoFullName: "acme/widgets",
    issueNumber: 42,
    title: "Fix the thing",
    labels: [],
    assignees: [],
    commentsCount: 0,
    createdAt: null,
    updatedAt: null,
    htmlUrl: null,
    aiPolicyAllowed: true,
    aiPolicySource: "none",
    ...overrides,
  };
}

function profileWith(overrides: Partial<ContributionProfile> = {}): ContributionProfile {
  return { ...emptyContributionProfile("acme/widgets", GENERATED_AT), ...overrides };
}

const eligibilityByName = (contains: string) =>
  profileWith({
    eligibilityLabels: { value: [{ field: "name" as const, contains }], confidence: "explicit", provenance: [] },
  });

const exclusionByName = (contains: string) =>
  profileWith({
    exclusionLabels: { value: [{ field: "name" as const, contains }], confidence: "inferred", provenance: [] },
  });

describe("evaluateCandidateEligibility (#6798)", () => {
  it("excludes nothing via label rules when there is no profile at all (fully-absent degrade)", () => {
    expect(evaluateCandidateEligibility(candidate(), null)).toEqual({ excluded: false, reasons: [] });
    expect(evaluateCandidateEligibility(candidate(), undefined)).toEqual({ excluded: false, reasons: [] });
  });

  it("excludes nothing via label rules when the profile's own label signals are absent (value: null)", () => {
    expect(evaluateCandidateEligibility(candidate(), emptyContributionProfile("acme/widgets", GENERATED_AT))).toEqual(
      { excluded: false, reasons: [] },
    );
  });

  it("excludes a candidate missing the profile's required eligibility label", () => {
    const result = evaluateCandidateEligibility(candidate({ labels: ["bug"] }), eligibilityByName("help wanted"));
    expect(result).toEqual({ excluded: true, reasons: ["missing eligibility label"] });
  });

  it("does not exclude a candidate that carries a matching eligibility label (case-insensitive substring)", () => {
    const result = evaluateCandidateEligibility(
      candidate({ labels: ["Help Wanted"] }),
      eligibilityByName("help wanted"),
    );
    expect(result).toEqual({ excluded: false, reasons: [] });
  });

  it("matches an eligibility rule by label DESCRIPTION when the name itself does not match", () => {
    const profile = profileWith({
      eligibilityLabels: {
        value: [{ field: "description", contains: "good first issue" }],
        confidence: "explicit",
        provenance: [],
      },
    });
    const labelDescriptionsByName = new Map([["e-easy", "good first issue material"]]);
    const result = evaluateCandidateEligibility(candidate({ labels: ["E-easy"] }), profile, {
      labelDescriptionsByName,
    });
    expect(result).toEqual({ excluded: false, reasons: [] });
  });

  it("treats an unresolved description matcher (no labelDescriptionsByName supplied) as unmatched", () => {
    const profile = profileWith({
      eligibilityLabels: {
        value: [{ field: "description", contains: "good first issue" }],
        confidence: "explicit",
        provenance: [],
      },
    });
    const result = evaluateCandidateEligibility(candidate({ labels: ["E-easy"] }), profile);
    expect(result).toEqual({ excluded: true, reasons: ["missing eligibility label"] });
  });

  it("excludes a candidate carrying the profile's exclusion label", () => {
    const result = evaluateCandidateEligibility(candidate({ labels: ["blocked"] }), exclusionByName("blocked"));
    expect(result).toEqual({ excluded: true, reasons: ["exclusion label present"] });
  });

  it("does not exclude a candidate with no exclusion-matching label", () => {
    const result = evaluateCandidateEligibility(candidate({ labels: ["bug"] }), exclusionByName("blocked"));
    expect(result).toEqual({ excluded: false, reasons: [] });
  });

  it("CONFLICTING SIGNALS: a candidate matching both eligibility and exclusion resolves conservatively (exclusion wins, one reason)", () => {
    const profile = profileWith({
      eligibilityLabels: { value: [{ field: "name", contains: "help wanted" }], confidence: "explicit", provenance: [] },
      exclusionLabels: { value: [{ field: "name", contains: "blocked" }], confidence: "inferred", provenance: [] },
    });
    const result = evaluateCandidateEligibility(candidate({ labels: ["help wanted", "blocked"] }), profile);
    expect(result).toEqual({ excluded: true, reasons: ["exclusion label present"] });
  });

  it("excludes a candidate assigned to the repo's own owner login by default", () => {
    const result = evaluateCandidateEligibility(candidate({ owner: "acme", assignees: ["ACME"] }), null);
    expect(result).toEqual({ excluded: true, reasons: ["excluded assignee"] });
  });

  it("does not exclude a candidate assigned to someone other than the repo owner", () => {
    const result = evaluateCandidateEligibility(candidate({ owner: "acme", assignees: ["someone-else"] }), null);
    expect(result).toEqual({ excluded: false, reasons: [] });
  });

  it("honors a caller-supplied excludeAssignedLogins list instead of the default owner-only rule", () => {
    const result = evaluateCandidateEligibility(candidate({ owner: "acme", assignees: ["core-maintainer"] }), null, {
      excludeAssignedLogins: ["core-maintainer"],
    });
    expect(result).toEqual({ excluded: true, reasons: ["excluded assignee"] });
  });

  it("collects multiple independent reasons at once", () => {
    const result = evaluateCandidateEligibility(
      candidate({ owner: "acme", labels: ["bug"], assignees: ["acme"] }),
      eligibilityByName("help wanted"),
    );
    expect(result).toEqual({ excluded: true, reasons: ["missing eligibility label", "excluded assignee"] });
  });
});

describe("filterEligibleCandidates (#6798)", () => {
  it("splits candidates into eligible and excluded per their own repo's profile", () => {
    const issues = [
      candidate({ issueNumber: 1, repoFullName: "acme/widgets", owner: "acme", labels: ["help wanted"] }),
      candidate({ issueNumber: 2, repoFullName: "acme/widgets", owner: "acme", labels: ["bug"] }),
    ];
    const profilesByRepo = new Map([["acme/widgets", eligibilityByName("help wanted")]]);
    const result = filterEligibleCandidates(issues, profilesByRepo);
    expect(result.eligible.map((issue) => issue.issueNumber)).toEqual([1]);
    expect(result.excluded).toEqual([{ issue: issues[1], reasons: ["missing eligibility label"] }]);
  });

  it("falls back to a fully-absent profile for a repo with no entry in profilesByRepo", () => {
    const issues = [candidate({ repoFullName: "unknown/repo", owner: "unknown", labels: [] })];
    const result = filterEligibleCandidates(issues, new Map());
    expect(result.eligible).toEqual(issues);
    expect(result.excluded).toEqual([]);
  });

  it("resolves label descriptions per repo from labelDescriptionsByRepo", () => {
    const profile = profileWith({
      exclusionLabels: {
        value: [{ field: "description", contains: "not ready" }],
        confidence: "inferred",
        provenance: [],
      },
    });
    const issue = candidate({ repoFullName: "acme/widgets", labels: ["status: hold"] });
    const result = filterEligibleCandidates(
      [issue],
      new Map([["acme/widgets", profile]]),
      { labelDescriptionsByRepo: new Map([["acme/widgets", new Map([["status: hold", "not ready for contributors"]])]]) },
    );
    expect(result.excluded).toEqual([{ issue, reasons: ["exclusion label present"] }]);
  });
});

describe("profileNeedsLabelDescriptions (#6798)", () => {
  it("is false for a fully-absent profile", () => {
    expect(profileNeedsLabelDescriptions(emptyContributionProfile("acme/widgets", GENERATED_AT))).toBe(false);
  });

  it("is false when every matcher is name-based", () => {
    expect(profileNeedsLabelDescriptions(eligibilityByName("help wanted"))).toBe(false);
  });

  it("is true when the eligibility matchers include a description-field matcher", () => {
    const profile = profileWith({
      eligibilityLabels: { value: [{ field: "description", contains: "good first issue" }], confidence: "explicit", provenance: [] },
    });
    expect(profileNeedsLabelDescriptions(profile)).toBe(true);
  });

  it("is true when the exclusion matchers include a description-field matcher", () => {
    const profile = profileWith({
      exclusionLabels: { value: [{ field: "description", contains: "not ready" }], confidence: "inferred", provenance: [] },
    });
    expect(profileNeedsLabelDescriptions(profile)).toBe(true);
  });

  it("is false for a missing/undefined profile", () => {
    expect(profileNeedsLabelDescriptions(null)).toBe(false);
    expect(profileNeedsLabelDescriptions(undefined)).toBe(false);
  });
});

describe("fetchRepoLabelDescriptions (#6798)", () => {
  it("returns a lowercased name -> description map for a successful fetch", async () => {
    const fetchImpl = async () =>
      Response.json([
        { name: "E-easy", description: "Good first issue material" },
        { name: "bug", description: null },
      ]);
    const result = await fetchRepoLabelDescriptions("acme/widgets", { fetchImpl });
    expect(result).toEqual(
      new Map([
        ["e-easy", "Good first issue material"],
        ["bug", null],
      ]),
    );
  });

  it("sends the github token and a custom api base url when supplied", async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      return Response.json([]);
    };
    await fetchRepoLabelDescriptions("acme/widgets", {
      fetchImpl,
      githubToken: "tok",
      apiBaseUrl: "https://api.example.test/",
    });
    expect(calls).toEqual([
      { url: "https://api.example.test/repos/acme/widgets/labels?per_page=100", authorization: "Bearer tok" },
    ]);
  });

  it("returns an empty map for a malformed or non-string repo full name, without fetching", async () => {
    const fetchImpl = async () => {
      throw new Error("must not be called");
    };
    expect(await fetchRepoLabelDescriptions("not-a-repo", { fetchImpl })).toEqual(new Map());
    expect(await fetchRepoLabelDescriptions("a/b/c", { fetchImpl })).toEqual(new Map());
    // @ts-expect-error deliberately passing a non-string to exercise the guard.
    expect(await fetchRepoLabelDescriptions(42, { fetchImpl })).toEqual(new Map());
  });

  it("returns an empty map when the fetch throws", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    expect(await fetchRepoLabelDescriptions("acme/widgets", { fetchImpl })).toEqual(new Map());
  });

  it("returns an empty map for a non-ok response", async () => {
    const fetchImpl = async () => new Response("nope", { status: 404 });
    expect(await fetchRepoLabelDescriptions("acme/widgets", { fetchImpl })).toEqual(new Map());
  });

  it("returns an empty map when the response body is not an array", async () => {
    const fetchImpl = async () => Response.json({ not: "an array" });
    expect(await fetchRepoLabelDescriptions("acme/widgets", { fetchImpl })).toEqual(new Map());
  });

  it("returns an empty map when the response body fails to parse as JSON", async () => {
    const fetchImpl = async () => new Response("not json", { status: 200 });
    expect(await fetchRepoLabelDescriptions("acme/widgets", { fetchImpl })).toEqual(new Map());
  });

  it("skips a label entry whose name is not a string", async () => {
    const fetchImpl = async () => Response.json([{ name: 42, description: "x" }, { name: "ok", description: "y" }]);
    expect(await fetchRepoLabelDescriptions("acme/widgets", { fetchImpl })).toEqual(new Map([["ok", "y"]]));
  });
});
