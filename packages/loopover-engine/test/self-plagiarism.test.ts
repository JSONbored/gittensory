import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSelfPlagiarismGovernorLedgerEvent,
  DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
  fingerprintFromChangedFiles,
  fingerprintSimilarity,
  resolveSelfPlagiarismConfig,
  selfPlagiarismCheck,
  type OwnSubmissionRecord,
} from "../dist/index.js";

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

test("barrel: the public entrypoint re-exports the self-plagiarism governor API (#2345)", () => {
  assert.equal(typeof selfPlagiarismCheck, "function");
  assert.equal(typeof fingerprintSimilarity, "function");
  assert.equal(typeof fingerprintFromChangedFiles, "function");
  assert.equal(typeof buildSelfPlagiarismGovernorLedgerEvent, "function");
  assert.equal(typeof resolveSelfPlagiarismConfig, "function");
  assert.equal(DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD, 0.85);
});

test("selfPlagiarismCheck: allows a genuinely distinct PR against recent own submissions", () => {
  const verdict = selfPlagiarismCheck(candidate(), [prior()]);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.eventType, "allowed");
  assert.equal(verdict.reason, "distinct_from_recent_own_submissions");
});

test("selfPlagiarismCheck: throttles a near-duplicate diff across repos when the prior claimed first", () => {
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
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.eventType, "throttled");
  assert.equal(verdict.reason, "near_duplicate_self_plagiarism");
  assert.equal(verdict.matchedSubmission?.repoFullName, "acme/repo-a");
});

test("selfPlagiarismCheck: fails closed on missing or ambiguous fingerprint data", () => {
  assert.deepEqual(selfPlagiarismCheck(candidate({ fingerprint: "  " }), [prior()]), {
    allowed: false,
    eventType: "denied",
    reason: "missing_candidate_fingerprint",
  });
  assert.deepEqual(selfPlagiarismCheck(candidate({ submittedAt: null }), [prior()]), {
    allowed: false,
    eventType: "denied",
    reason: "missing_candidate_submitted_at",
  });
  assert.deepEqual(
    selfPlagiarismCheck(candidate({ fingerprint: "shared diff fingerprint tokens" }), [
      prior({ fingerprint: "shared diff fingerprint tokens", submittedAt: null }),
    ]),
    { allowed: false, eventType: "denied", reason: "missing_prior_submitted_at" },
  );
});

test("selfPlagiarismCheck: allows the earliest near-duplicate claimant", () => {
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
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, "earliest_near_duplicate_claimant");
});

test("resolveSelfPlagiarismConfig: normalizes bare numbers and invalid shapes", () => {
  assert.equal(resolveSelfPlagiarismConfig(0.9).similarityThreshold, 0.9);
  assert.equal(resolveSelfPlagiarismConfig(Number.NaN).similarityThreshold, 0.85);
  assert.equal(resolveSelfPlagiarismConfig(["not", "object"]).similarityThreshold, 0.85);
});

test("buildSelfPlagiarismGovernorLedgerEvent: records throttled open_pr with the flagged prior referenced", () => {
  const verdict = selfPlagiarismCheck(
    candidate({ fingerprint: "same patch tokens" }),
    [prior({ fingerprint: "same patch tokens", pullRequestNumber: 42, repoFullName: "acme/first" })],
  );
  const event = buildSelfPlagiarismGovernorLedgerEvent("acme/second", verdict);
  assert.equal(event.eventType, "throttled");
  assert.equal(event.repoFullName, "acme/second");
  assert.equal(event.actionClass, "open_pr");
  assert.equal(event.decision, "throttle");
  assert.equal(event.reason, "near_duplicate_self_plagiarism");
  assert.equal(event.payload.matchedRepoFullName, "acme/first");
  assert.equal(event.payload.matchedPullRequestNumber, 42);
});

test("fingerprintSimilarity: returns Jaccard overlap for token sets", () => {
  assert.equal(fingerprintSimilarity("abc def", "ABC DEF"), 1);
  assert.equal(fingerprintSimilarity("aa bb", "bb cc"), 1 / 3);
});

test("fingerprintFromChangedFiles: sorts and comma-joins a real changed-file set", () => {
  assert.equal(fingerprintFromChangedFiles(["src/b.ts", "src/a.ts"]), "src/a.ts,src/b.ts");
});

test("fingerprintFromChangedFiles: dedupes repeated paths", () => {
  assert.equal(fingerprintFromChangedFiles(["src/a.ts", "src/a.ts"]), "src/a.ts");
});

test("fingerprintFromChangedFiles: is order-independent -- the same real change set always fingerprints identically", () => {
  const first = fingerprintFromChangedFiles(["src/b.ts", "src/a.ts", "docs/c.md"]);
  const second = fingerprintFromChangedFiles(["docs/c.md", "src/a.ts", "src/b.ts"]);
  assert.equal(first, second);
});

test("fingerprintFromChangedFiles: an empty change set produces an honest empty string, never a fabricated token", () => {
  assert.equal(fingerprintFromChangedFiles([]), "");
});

test("fingerprintFromChangedFiles: blank/whitespace-only entries are dropped, not turned into empty tokens", () => {
  assert.equal(fingerprintFromChangedFiles(["src/a.ts", "  ", ""]), "src/a.ts");
});

test("fingerprintFromChangedFiles: feeds fingerprintSimilarity as a real Jaccard token set (comma-delimited paths)", () => {
  const a = fingerprintFromChangedFiles(["src/a.ts", "src/b.ts"]);
  const b = fingerprintFromChangedFiles(["src/a.ts", "src/c.ts"]);
  assert.equal(fingerprintSimilarity(a, b), 1 / 3); // {a,b} vs {a,c}: intersection 1, union 3
});
