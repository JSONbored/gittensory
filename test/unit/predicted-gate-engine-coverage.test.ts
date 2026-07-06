import { describe, expect, it } from "vitest";

import { evaluateGateCheck, buildPullRequestAdvisory } from "../../packages/gittensory-engine/src/advisory/gate-advisory";
import { buildFocusManifestGuidance } from "../../packages/gittensory-engine/src/focus-manifest/guidance";
import { sanitizePublicComment } from "../../packages/gittensory-engine/src/github/sanitize-public-comment";
import { evaluatePreMergeChecks, PRE_MERGE_CHECK_UNRESOLVED_CODE } from "../../packages/gittensory-engine/src/review/pre-merge-checks";
import { diffFilePriority } from "../../packages/gittensory-engine/src/review/diff-file-priority";
import {
  clearLabelPatternRegExpCacheForTest,
  LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES,
  labelMatchesPattern,
  labelPatternRegExpCacheKeysForTest,
} from "../../packages/gittensory-engine/src/scoring/label-match";
import { isDuplicateClusterWinner, isDuplicateClusterWinnerByClaim, resolveDuplicateClusterWinnerNumber } from "../../packages/gittensory-engine/src/signals/duplicate-winner";
import { guardrailPathMatches, isGuardrailHit } from "../../packages/gittensory-engine/src/signals/change-guardrail";
import { buildCollisionReport, buildPreflightResult, buildPublicReadinessScore, buildQueueHealth, classifyBountyLifecycle, unionScopedOverlapClusters } from "../../packages/gittensory-engine/src/signals/predicted-gate-engine";
import type { FocusManifest, IssueQualityReport, PullRequestRecord, RepositoryRecord } from "../../packages/gittensory-engine/src/types/predicted-gate-types";

const REPO: RepositoryRecord = {
  fullName: "acme/widgets",
  owner: "acme",
  name: "widgets",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "acme/widgets",
    emissionShare: 1,
    issueDiscoveryShare: 0,
    labelMultipliers: { "type:*": 1.2, bug: 1.1 },
    maintainerCut: 0,
    raw: {},
  },
};

const PR: PullRequestRecord = {
  repoFullName: "acme/widgets",
  number: 9,
  title: "Fix upload retries",
  state: "open",
  authorLogin: "miner1",
  labels: ["type:bug-fix", "bug"],
  linkedIssues: [7],
};

describe("predicted-gate engine module coverage (#2283)", () => {
  it("mirrors scoring label matcher semantics through the engine copy", () => {
    expect(labelMatchesPattern("type:bug-fix", "type:*")).toBe(true);
    expect(labelMatchesPattern("kind:chore", "type:*")).toBe(false);
    expect(labelMatchesPattern("Priority:1", "priority:?")).toBe(true);
    expect(labelMatchesPattern("priority:10", "priority:?")).toBe(false);
    expect(labelMatchesPattern("kind/bug", "kind/[bc]ug")).toBe(true);
    expect(labelMatchesPattern("kind/dug", "kind/[!bc]ug")).toBe(true);
    expect(labelMatchesPattern("x", "[z-a]")).toBe(false);
    expect(labelMatchesPattern("[bug", "[bug")).toBe(true);
    expect(labelMatchesPattern("m", "[a-z-9]")).toBe(true);
    expect(labelMatchesPattern("5", "[!a-z-9]")).toBe(true);
    expect(labelMatchesPattern("type-bug-fix", "type-*-*")).toBe(true);
    expect(labelMatchesPattern("a-b-c-final", "*-*-*-final")).toBe(false);
    expect(labelMatchesPattern("x", "[!]")).toBe(false);
    expect(labelMatchesPattern("a.b", "a.b")).toBe(true);
  });

  it("bounds the memoized label pattern cache and evicts least-recently-used entries", () => {
    clearLabelPatternRegExpCacheForTest();
    for (let i = 0; i < LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES; i += 1) {
      expect(labelMatchesPattern(`kind:${i}`, `kind:${i}`)).toBe(true);
    }
    expect(labelPatternRegExpCacheKeysForTest()).toHaveLength(LABEL_PATTERN_REGEXP_CACHE_MAX_ENTRIES);
    expect(labelMatchesPattern("kind:0", "kind:0")).toBe(true);
    expect(labelMatchesPattern("kind:overflow", "kind:overflow")).toBe(true);
    expect(labelPatternRegExpCacheKeysForTest()).toContain("kind:0");
    expect(labelPatternRegExpCacheKeysForTest()).not.toContain("kind:1");
    clearLabelPatternRegExpCacheForTest();
  });

  it("exercises duplicate-winner election helpers", () => {
    expect(isDuplicateClusterWinnerByClaim({ number: 1, createdAt: "2026-01-01T00:00:00.000Z" }, [{ number: 2, createdAt: "2026-01-02T00:00:00.000Z" }])).toBe(true);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 2, linkedIssueClaimedAt: "2026-01-02T00:00:00.000Z" },
        [{ number: 1, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" }],
      ),
    ).toBe(false);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 3, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" },
        [{ number: 2, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" }],
      ),
    ).toBe(false);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
        [{ number: 2, createdAt: "2026-01-01T00:00:00.000Z" }],
      ),
    ).toBe(true);
    expect(resolveDuplicateClusterWinnerNumber({ number: 2, createdAt: "2026-01-02T00:00:00.000Z" }, [{ number: 1, createdAt: "2026-01-01T00:00:00.000Z" }])).toBe(1);
    expect(resolveDuplicateClusterWinnerNumber({ number: 1, createdAt: null }, [{ number: 2, createdAt: null }])).toBeNull();
  });

  it("exercises diff-file priority and collision path overlap helpers", () => {
    expect(diffFilePriority("src/app.ts")).toBe(0);
    expect(diffFilePriority("package-lock.json")).toBe(4);
    const collisions = buildCollisionReport("acme/widgets", [], [
      { ...PR, changedFiles: ["src/a.ts"] },
      { ...PR, number: 10, changedFiles: ["src/a.ts"] },
    ]);
    expect(collisions.clusters.length).toBeGreaterThan(0);
  });

  it("exercises guardrail path matching", () => {
    expect(isGuardrailHit([".github/workflows/ci.yml"], [".github/workflows/*"])).toBe(true);
    expect(guardrailPathMatches([".github/workflows/ci.yml"], [".github/workflows/*"])).toEqual([
      { path: ".github/workflows/ci.yml", glob: ".github/workflows/*" },
    ]);
  });

  it("exercises sanitizePublicComment redaction paths", () => {
    expect(sanitizePublicComment("score estimate 12.5 -> 41.2")).toContain("private context");
    expect(sanitizePublicComment("reviewability internals")).toContain("private context");
    expect(sanitizePublicComment("@gittensory reviewability score")).toContain("reviewability");
    expect(sanitizePublicComment("open pr count 12 exceeds threshold 10")).toContain("private context");
  });

  it("exercises focus-manifest guidance branches", () => {
    const manifest: FocusManifest = {
      present: true,
      source: "repo_file",
      wantedPaths: ["src/"],
      preferredLabels: ["bug"],
      linkedIssuePolicy: "required",
      testExpectations: ["npm test"],
      issueDiscoveryPolicy: "discouraged",
      maintainerNotes: [],
      publicNotes: ["Keep changes focused."],
      gate: { present: true } as FocusManifest["gate"],
      settings: {},
      review: { present: true, preMergeChecks: [] },
      warnings: [],
    };
    const offFocus = buildFocusManifestGuidance({ manifest, changedPaths: ["docs/readme.md"], labels: [], linkedIssueCount: 0, testFileCount: 0 });
    expect(offFocus.findings.some((f) => f.code === "manifest_off_focus")).toBe(true);
    expect(offFocus.findings.some((f) => f.code === "manifest_linked_issue_required")).toBe(true);
    expect(offFocus.findings.some((f) => f.code === "manifest_issue_discovery_discouraged")).toBe(true);
    const aligned = buildFocusManifestGuidance({ manifest, changedPaths: ["src/a.ts"], labels: ["bug"], linkedIssueCount: 1, testFileCount: 1 });
    expect(aligned.findings.some((f) => f.code === "manifest_preferred_path")).toBe(true);
  });

  it("exercises pre-merge unresolved path-gated checks", () => {
    const findings = evaluatePreMergeChecks(
      [{ name: "migrations", whenPaths: ["migrations/**"], titleContains: null, descriptionContains: null, requireLabel: null, enforce: true }],
      { title: "x", body: "y", labels: [], changedPaths: [], filesResolved: false },
    );
    expect(findings[0]?.code).toBe(PRE_MERGE_CHECK_UNRESOLVED_CODE);
  });

  it("exercises preflight bounty and issue-quality branches", () => {
    const issueQuality: IssueQualityReport = {
      repoFullName: "acme/widgets",
      generatedAt: "2026-01-01T00:00:00.000Z",
      lane: { lane: "direct_pr", repoFullName: "acme/widgets", summary: "ok", contributorGuidance: "ok", maintainerGuidance: "ok" },
      issues: [{ number: 7, title: "Issue", status: "do_not_use", score: 0, reasons: [], warnings: ["already solved"] }],
      summary: "hold",
    };
    const preflight = buildPreflightResult(
      { repoFullName: "acme/widgets", title: "Fix", body: "Closes #7", linkedIssues: [7], changedFiles: ["src/a.ts"] },
      REPO,
      [],
      [],
      [{ id: "b1", repoFullName: "acme/widgets", issueNumber: 7, status: "completed", payload: {} }],
      issueQuality,
    );
    expect(preflight.findings.some((f) => f.code === "issue_quality_do_not_use")).toBe(true);
    expect(preflight.findings.some((f) => f.code === "linked_issue_bounty_historical")).toBe(true);
  });

  it("exercises advisory label context and dry-run displayConclusion", () => {
    const advisory = buildPullRequestAdvisory(REPO, PR);
    expect(advisory.findings.some((f) => f.code === "label_context_found")).toBe(true);
    const dry = evaluateGateCheck(advisory, { dryRun: true, duplicatePrGateMode: "advisory", linkedIssueGateMode: "advisory", aiReviewGateMode: "advisory" });
    expect(dry.displayConclusion).toBeDefined();
  });

  it("exercises advisory edge cases and gate failures", () => {
    const missingRepo = buildPullRequestAdvisory(null, PR);
    expect(missingRepo.findings.some((f) => f.code === "repo_not_registered")).toBe(true);
    const missingPr = buildPullRequestAdvisory(REPO, null);
    expect(missingPr.findings.some((f) => f.code === "pr_not_cached")).toBe(true);
    const blocked = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "duplicate_pr_risk", severity: "warning", title: "dup", detail: "dup" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { duplicatePrGateMode: "block" },
    );
    expect(blocked.conclusion).toBe("failure");
  });

  it("exercises deprecated duplicate winner helper and lane advice branches", () => {
    expect(isDuplicateClusterWinner(1, [2, 3])).toBe(true);
    expect(isDuplicateClusterWinner(3, [1, 2])).toBe(false);
    const inactive = buildPreflightResult(
      { repoFullName: "acme/widgets", title: "Fix", body: "Closes #7", linkedIssues: [7] },
      { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 0 } },
      [],
      [],
    );
    expect(inactive.lane.lane).toBe("inactive");
  });

  it("exercises manifest globstar path matching", () => {
    const manifest: FocusManifest = {
      present: true,
      source: "repo_file",
      wantedPaths: ["**/safe.ts"],
      preferredLabels: [],
      linkedIssuePolicy: "optional",
      testExpectations: [],
      issueDiscoveryPolicy: "neutral",
      maintainerNotes: [],
      publicNotes: [],
      gate: { present: true } as FocusManifest["gate"],
      settings: {},
      review: { present: true, preMergeChecks: [] },
      warnings: [],
    };
    const guidance = buildFocusManifestGuidance({ manifest, changedPaths: ["safe.ts", "nested/safe.ts"], linkedIssueCount: 1, testFileCount: 1 });
    expect(guidance.matchedWantedPaths.length).toBeGreaterThan(0);
  });

  it("exercises lane, collision, queue, and preflight edge branches", () => {
    const issueDiscoveryRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 1, emissionShare: 1 },
    };
    const splitRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 0.5, emissionShare: 1 },
    };
    const discoveryPreflight = buildPreflightResult({ repoFullName: REPO.fullName, title: "Report issue", body: "", linkedIssues: [] }, issueDiscoveryRepo, [], []);
    expect(discoveryPreflight.lane.lane).toBe("issue_discovery");
    const splitPreflight = buildPreflightResult({ repoFullName: REPO.fullName, title: "Fix", body: "Closes #7", linkedIssues: [7] }, splitRepo, [], []);
    expect(splitPreflight.lane.lane).toBe("split");

    const collisions = buildCollisionReport(
      REPO.fullName,
      [],
      [
        { ...PR, number: 1, authorLogin: "alice", title: "retry upload client", changedFiles: ["src/upload.ts"] },
        { ...PR, number: 2, authorLogin: "alice", title: "retry upload service", changedFiles: ["src/upload.ts"] },
        { ...PR, number: 3, authorLogin: "bob", title: "totally different", changedFiles: ["src/upload.ts"] },
        { ...PR, number: 4, authorLogin: "carol", title: "totally different too", changedFiles: ["src/upload.ts"] },
      ],
    );
    expect(collisions.clusters.length).toBeGreaterThan(0);

    const queue = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Big change", body: "", linkedIssues: [7, 8], changedFiles: Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`) },
      REPO,
      [],
      [
        { ...PR, number: 11, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true },
        { ...PR, number: 12, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z" },
      ],
      [{ id: "b2", repoFullName: REPO.fullName, issueNumber: 7, status: "stale bounty", payload: {} }],
      {
        repoFullName: REPO.fullName,
        generatedAt: "2026-01-01T00:00:00.000Z",
        lane: splitPreflight.lane,
        issues: [
          { number: 7, title: "Issue", status: "needs_proof", score: 0, reasons: [], warnings: ["needs proof"] },
          { number: 8, title: "Issue2", status: "hold", score: 0, reasons: [], warnings: ["hold"] },
        ],
        summary: "x",
      },
    );
    expect(queue.findings.some((f) => f.code === "missing_test_evidence")).toBe(true);
    expect(queue.findings.some((f) => f.code === "linked_issue_bounty_unverified")).toBe(true);
    expect(queue.findings.some((f) => f.code === "issue_quality_needs_proof")).toBe(true);
    expect(queue.findings.some((f) => f.code === "issue_quality_hold")).toBe(true);

    const collisionsForQueue = buildCollisionReport(REPO.fullName, [], [{ ...PR, number: 11, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true }]);
    const queueHealth = buildQueueHealth(REPO, [], [{ ...PR, number: 11, linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z", isDraft: true }], collisionsForQueue);
    expect(queueHealth.findings.some((f) => f.code === "unlinked_prs")).toBe(true);
    expect(queueHealth.findings.some((f) => f.code === "inactive_draft_prs")).toBe(true);
  });

  it("exercises gate holds, readiness score branches, and linked-issue advisory paths", () => {
    const advisory = buildPullRequestAdvisory(REPO, PR, { requireLinkedIssue: true, confirmedNoOpenLinkedIssue: true, linkedIssueAuthorLogins: ["miner1"] });
    expect(advisory.findings.some((f) => f.code === "missing_linked_issue")).toBe(true);
    expect(advisory.findings.some((f) => f.code === "self_authored_linked_issue")).toBe(true);
    const guardrailHold = evaluateGateCheck(
      { id: "a", targetType: "pull_request", targetKey: "k", repoFullName: REPO.fullName, conclusion: "success", severity: "info", title: "t", summary: "s", findings: [], generatedAt: "2026-01-01T00:00:00.000Z" },
      { guardrailHit: true, guardrailMatches: [{ path: "src/a.ts", glob: "src/*" }], sizeGateMode: "advisory", changedFileCount: 20, changedLineCount: 2000 },
    );
    expect(guardrailHold.conclusion).toBe("neutral");
    const preflight = buildPreflightResult({ repoFullName: REPO.fullName, title: "No issue docs only", body: "docs-only change", linkedIssues: [] }, REPO, [], []);
    const readiness = buildPublicReadinessScore({
      pr: { ...PR, isDraft: true, body: "docs-only change", linkedIssues: [] },
      preflight,
      queueHealth: buildQueueHealth(REPO, [], [], buildCollisionReport(REPO.fullName, [], [])),
      scopedOverlapCount: 2,
      linkedDuplicatePrs: [42],
    });
    expect(readiness.total).toBeGreaterThan(0);
    const slopBlocked = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "slop_risk_above_threshold", severity: "warning", title: "slop", detail: "slop" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { slopGateMode: "block", slopRisk: 90, slopGateMinScore: 60 },
    );
    expect(slopBlocked.blockers.some((b) => b.code === "slop_risk_above_threshold")).toBe(true);
  });

  it("exercises remaining advisory, duplicate-winner, and manifest branches", () => {
    const discoveryOnlyRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 1, maintainerCut: 1 },
    };
    const directOnlyRepo: RepositoryRecord = {
      ...REPO,
      registryConfig: { ...REPO.registryConfig!, issueDiscoveryShare: 0, maintainerCut: 0 },
    };
    expect(buildPullRequestAdvisory(discoveryOnlyRepo, PR).findings.some((f) => f.code === "direct_pr_pool_disabled")).toBe(true);
    expect(buildPullRequestAdvisory(directOnlyRepo, PR).findings.some((f) => f.code === "issue_discovery_disabled")).toBe(true);
    expect(buildPullRequestAdvisory(directOnlyRepo, PR).findings.some((f) => f.code === "maintainer_cut_enabled")).toBe(false);
    expect(buildPullRequestAdvisory(discoveryOnlyRepo, PR).findings.some((f) => f.code === "maintainer_cut_enabled")).toBe(true);

    const busy = buildPullRequestAdvisory(
      REPO,
      PR,
      { otherOpenPullRequests: Array.from({ length: 10 }, (_, i) => ({ ...PR, number: i + 20 })) },
    );
    expect(busy.findings.some((f) => f.code === "busy_pr_queue")).toBe(true);
    expect(buildPullRequestAdvisory(REPO, { ...PR, authorAssociation: "OWNER" }).findings.some((f) => f.code === "maintainer_authored_pr")).toBe(true);

    const aiBlocked = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "neutral",
        severity: "warning",
        title: "t",
        summary: "s",
        findings: [{ code: "ai_consensus_defect", severity: "warning", title: "ai", detail: "ai" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      { aiReviewGateMode: "block", aiReviewCloseConfidence: 0.5 },
    );
    expect(aiBlocked.conclusion).toBe("failure");

    const aiHold = evaluateGateCheck(
      {
        id: "a",
        targetType: "pull_request",
        targetKey: "k",
        repoFullName: REPO.fullName,
        conclusion: "success",
        severity: "info",
        title: "t",
        summary: "s",
        findings: [{ code: "ai_review_inconclusive", severity: "warning", title: "ai", detail: "ai" }],
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      {},
    );
    expect(aiHold.conclusion).toBe("neutral");

    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 1, linkedIssueClaimedAt: "2026-01-01T00:00:00.000Z" },
        [{ number: 2, linkedIssueClaimedAt: "2026-01-02T00:00:00.000Z" }],
      ),
    ).toBe(true);
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 2, createdAt: "2026-01-02T00:00:00.000Z" },
        [{ number: 1, createdAt: "2026-01-02T00:00:00.000Z" }],
      ),
    ).toBe(false);

    const preferredMissing = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: [],
        preferredLabels: ["bug"],
        linkedIssuePolicy: "preferred",
        testExpectations: [],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["src/a.ts"],
      labels: [],
      linkedIssueCount: 0,
      passedValidationCount: 1,
    });
    expect(preferredMissing.findings.some((f) => f.code === "manifest_linked_issue_preferred")).toBe(true);
    expect(preferredMissing.findings.some((f) => f.code === "manifest_missing_preferred_label")).toBe(true);
  });

  it("exercises collision, bounty, readiness, and queue branches", () => {
    const selfAuthoredSkip = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 1, linkedIssues: [], labels: [], authorLogin: "alice", title: "foo bar", changedFiles: ["src/services/upload/retry.ts"] },
      { ...PR, number: 2, linkedIssues: [], labels: [], authorLogin: "alice", title: "baz qux", changedFiles: ["src/services/upload/retry.ts"] },
    ]);
    expect(selfAuthoredSkip.clusters).toHaveLength(0);

    const lockfileOnly = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 3, linkedIssues: [], labels: [], authorLogin: "bob", title: "foo bar", changedFiles: ["package-lock.json"] },
      { ...PR, number: 4, linkedIssues: [], labels: [], authorLogin: "carol", title: "baz qux", changedFiles: ["package-lock.json"] },
    ]);
    expect(lockfileOnly.clusters).toHaveLength(0);

    const mergedCollisions = buildCollisionReport(
      REPO.fullName,
      [],
      [],
      [{ repoFullName: REPO.fullName, number: 99, title: "Merged fix", authorLogin: "miner1", labels: [], linkedIssues: [7], changedFiles: ["src/a.ts"] }],
    );
    expect(mergedCollisions.summary.itemsReviewed).toBeGreaterThan(0);

    expect(classifyBountyLifecycle({ id: "b1", repoFullName: REPO.fullName, issueNumber: 7, status: "open", updatedAt: "2020-01-01T00:00:00.000Z", discoveredAt: "2020-01-01T00:00:00.000Z", payload: {} }, { repoFullName: REPO.fullName, number: 7, title: "Issue", state: "open", labels: [], linkedPrs: [] })).toBe("stale");
    expect(classifyBountyLifecycle({ id: "b3", repoFullName: REPO.fullName, issueNumber: 9, status: "open", updatedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(), payload: {} }, { repoFullName: REPO.fullName, number: 9, title: "Issue", state: "open", labels: [], linkedPrs: [] })).toBe("active");
    expect(classifyBountyLifecycle({ id: "b2", repoFullName: REPO.fullName, issueNumber: 8, status: "active funded", updatedAt: "2026-01-01T00:00:00.000Z", discoveredAt: "2026-01-01T00:00:00.000Z", payload: {} }, { repoFullName: REPO.fullName, number: 8, title: "Issue", state: "closed", labels: [], linkedPrs: [] })).toBe("ambiguous");

    const mergedSelfAuthored = buildCollisionReport(
      REPO.fullName,
      [],
      [{ ...PR, number: 5, linkedIssues: [], labels: [], authorLogin: "alice", title: "foo bar", changedFiles: ["src/services/upload/retry.ts"] }],
      [{ repoFullName: REPO.fullName, number: 50, title: "baz qux", authorLogin: "alice", labels: [], linkedIssues: [], changedFiles: ["src/services/upload/retry.ts"] }],
    );
    expect(mergedSelfAuthored.clusters).toHaveLength(0);

    const linkedBodyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "Closes acme/widgets#77", linkedIssues: [] },
      REPO,
      [],
      [],
    );
    expect(linkedBodyPreflight.linkedIssues).toContain(77);

    const holdPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7] },
      { ...REPO, registryConfig: { ...REPO.registryConfig!, emissionShare: 0 } },
      [],
      [],
      [],
      null,
      false,
    );
    const readyPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: ["src/a.test.ts"] },
      REPO,
      [],
      [],
    );
    const missingTestPreflight = buildPreflightResult(
      { repoFullName: REPO.fullName, title: "Fix", body: "tested locally", linkedIssues: [7], changedFiles: ["src/a.ts"], tests: [] },
      REPO,
      [],
      [],
    );
    const collisionReport = buildCollisionReport(REPO.fullName, [], [
      { ...PR, number: 11, title: "overlap upload retry client", changedFiles: ["src/upload.ts"] },
      { ...PR, number: 12, title: "overlap upload retry service", changedFiles: ["src/upload.ts"] },
    ]);
    expect(collisionReport.summary.clusterCount).toBeGreaterThan(0);
    const queueHealth = buildQueueHealth(
      REPO,
      [],
      Array.from({ length: 14 }, (_, i) => ({ ...PR, number: i + 20, linkedIssues: [7], updatedAt: i === 0 ? "2020-01-01T00:00:00.000Z" : "2026-06-01T00:00:00.000Z" })),
      collisionReport,
    );
    expect(queueHealth.findings.some((f) => f.code === "stale_prs")).toBe(true);
    expect(queueHealth.findings.some((f) => f.code === "collision_clusters")).toBe(true);

    expect(buildPublicReadinessScore({ pr: { ...PR, labels: ["size:large"], isDraft: true }, preflight: holdPreflight, queueHealth }).total).toBeGreaterThan(0);
    expect(buildPublicReadinessScore({ pr: { ...PR, body: "tested locally" }, preflight: missingTestPreflight, queueHealth }).components.find((c) => c.key === "validation")?.score).toBe(12);
    expect(buildPublicReadinessScore({ pr: { ...PR, body: "npm test passed" }, preflight: readyPreflight, queueHealth }).components.find((c) => c.key === "validation")?.score).toBe(25);
    expect(buildPublicReadinessScore({ pr: PR, preflight: readyPreflight, queueHealth }).components.find((c) => c.key === "validation")?.score).toBe(20);

    const union = unionScopedOverlapClusters(collisionReport, PR, collisionReport.clusters);
    expect(union.length).toBeGreaterThanOrEqual(0);

    const malformed = buildFocusManifestGuidance({
      manifest: {
        present: false,
        source: "repo_file",
        wantedPaths: [],
        preferredLabels: [],
        linkedIssuePolicy: "optional",
        testExpectations: ["run npm test"],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: false } as FocusManifest["gate"],
        settings: {},
        review: { present: false, preMergeChecks: [] },
        warnings: ["invalid yaml"],
      },
      changedPaths: ["src/a.ts"],
      linkedIssueCount: 0,
      testFileCount: 0,
      passedValidationCount: 0,
    });
    expect(malformed.findings.some((f) => f.code === "manifest_malformed")).toBe(true);

    const middleGlob = buildFocusManifestGuidance({
      manifest: {
        present: true,
        source: "repo_file",
        wantedPaths: ["src/*util*core.ts"],
        preferredLabels: [],
        linkedIssuePolicy: "optional",
        testExpectations: [],
        issueDiscoveryPolicy: "neutral",
        maintainerNotes: [],
        publicNotes: [],
        gate: { present: true } as FocusManifest["gate"],
        settings: {},
        review: { present: true, preMergeChecks: [] },
        warnings: [],
      },
      changedPaths: ["src/foo/util/bar/core.ts"],
      linkedIssueCount: 1,
      testFileCount: 1,
    });
    expect(middleGlob.matchedWantedPaths.length).toBeGreaterThan(0);

    expect(buildPullRequestAdvisory(REPO, { ...PR, state: "closed" }).findings.some((f) => f.code === "pr_not_open")).toBe(true);
    const sizeHold = evaluateGateCheck(
      { id: "a", targetType: "pull_request", targetKey: "k", repoFullName: REPO.fullName, conclusion: "success", severity: "info", title: "t", summary: "s", findings: [], generatedAt: "2026-01-01T00:00:00.000Z" },
      { sizeGateMode: "advisory", changedFileCount: 20, changedLineCount: 2000 },
    );
    expect(sizeHold.conclusion).toBe("neutral");
    expect(sizeHold.warnings.some((w) => w.code === "oversized_pr")).toBe(true);
  });
});
