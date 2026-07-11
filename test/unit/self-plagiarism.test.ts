import { describe, expect, it } from "vitest";
import {
  buildSelfPlagiarismGovernorLedgerEvent,
  DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
  fingerprintSimilarity,
  selfPlagiarismCheck,
  type OwnSubmissionRecord,
} from "../../packages/gittensory-engine/src/governor/self-plagiarism";

const CANDIDATE_AT = "2026-07-10T12:00:00.000Z";

function candidate(overrides: Partial<OwnSubmissionRecord> = {}): OwnSubmissionRecord {
  return {
    repoFullName: "acme/widgets",
    fingerprint: "alpha beta gamma",
    submittedAt: CANDIDATE_AT,
    pullRequestNumber: 200,
    ...overrides,
  };
}

function prior(overrides: Partial<OwnSubmissionRecord> = {}): OwnSubmissionRecord {
  return {
    repoFullName: "acme/other",
    fingerprint: "totally different tokens",
    submittedAt: "2026-07-09T12:00:00.000Z",
    pullRequestNumber: 100,
    ...overrides,
  };
}

describe("fingerprintSimilarity", () => {
  it("returns 1 for identical normalized fingerprints", () => {
    expect(fingerprintSimilarity("abc def", "ABC DEF")).toBe(1);
  });

  it("returns 0 when either fingerprint token set is empty", () => {
    expect(fingerprintSimilarity("", "abc")).toBe(0);
    expect(fingerprintSimilarity("abc", "   ")).toBe(0);
  });
});

describe("selfPlagiarismCheck (#2345)", () => {
  it("allows a genuinely distinct PR against recent own submissions", () => {
    const verdict = selfPlagiarismCheck(candidate(), [prior()]);
    expect(verdict.allowed).toBe(true);
    expect(verdict.eventType).toBe("allowed");
    expect(verdict.reason).toBe("distinct_from_recent_own_submissions");
  });

  it("throttles a near-duplicate diff across two different target repos when the prior claimed first", () => {
    const shared = "fix null pointer in handler cleanup path shared";
    const verdict = selfPlagiarismCheck(
      candidate({ repoFullName: "acme/repo-b", fingerprint: shared, pullRequestNumber: 201 }),
      [
        prior({
          repoFullName: "acme/repo-a",
          fingerprint: `${shared} extra`,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: 55,
        }),
      ],
      { similarityThreshold: 0.85 },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.eventType).toBe("throttled");
    expect(verdict.reason).toBe("near_duplicate_self_plagiarism");
    expect(verdict.matchedSubmission?.repoFullName).toBe("acme/repo-a");
    expect(verdict.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("denies when the candidate fingerprint is missing (fail closed — does not assume uniqueness)", () => {
    const verdict = selfPlagiarismCheck(candidate({ fingerprint: "  " }), [prior()]);
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_candidate_fingerprint" });
  });

  it("denies when the candidate submittedAt is missing even if fingerprints differ", () => {
    const verdict = selfPlagiarismCheck(candidate({ submittedAt: null }), [prior()]);
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_candidate_submitted_at" });
  });

  it("denies when a near-duplicate prior lacks submittedAt (ambiguous election timing)", () => {
    const shared = "shared diff fingerprint tokens";
    const verdict = selfPlagiarismCheck(candidate({ fingerprint: shared }), [
      prior({ fingerprint: shared, submittedAt: null }),
    ]);
    expect(verdict).toMatchObject({ allowed: false, eventType: "denied", reason: "missing_prior_submitted_at" });
  });

  it("allows the earliest claimant when it precedes near-duplicate priors in claim-time order", () => {
    const shared = "shared implementation patch body";
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: shared, submittedAt: "2026-07-10T10:00:00.000Z", pullRequestNumber: 10 }),
      [
        prior({
          fingerprint: shared,
          submittedAt: "2026-07-10T11:00:00.000Z",
          pullRequestNumber: 20,
        }),
      ],
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe("earliest_near_duplicate_claimant");
  });

  it("uses the conservative built-in default threshold when config is omitted", () => {
    expect(DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD).toBe(0.85);
    const almost = "aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp qq rr ss tt uu vv ww xx yy zz";
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: almost }),
      [prior({ fingerprint: `${almost} zz` })],
    );
    expect(verdict.eventType).toBe("throttled");
  });
});

describe("buildSelfPlagiarismGovernorLedgerEvent", () => {
  it("records a throttled open_pr denial with the flagged prior submission referenced", () => {
    const verdict = selfPlagiarismCheck(
      candidate({ fingerprint: "same patch tokens" }),
      [prior({ fingerprint: "same patch tokens", pullRequestNumber: 42, repoFullName: "acme/first" })],
    );
    const event = buildSelfPlagiarismGovernorLedgerEvent("acme/second", verdict);
    expect(event).toMatchObject({
      eventType: "throttled",
      repoFullName: "acme/second",
      actionClass: "open_pr",
      decision: "throttle",
      reason: "near_duplicate_self_plagiarism",
      payload: {
        matchedRepoFullName: "acme/first",
        matchedPullRequestNumber: 42,
      },
    });
  });
});
