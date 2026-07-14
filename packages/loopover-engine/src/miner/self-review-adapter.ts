// Self-review adapter (#2334): turns an attempt's live worktree diff state into the SAME inputs
// `buildPredictedGateVerdict` (predicted-gate.ts) and the slop-signal pass (src/signals/slop.ts) expect, so
// the iterate-loop's self-review call (#2333) is genuinely byte-identical to what the live maintainer gate
// would compute post-submission -- not an approximation.
//
// SLOP INJECTION: `src/signals/slop.ts` has not been extracted into this package (it depends on several
// sibling `src/signals/*` modules that are also unextracted) -- mirrors the established `RewardRiskEngineDeps`
// injection pattern (`reward-risk.ts`, #2281) for the identical reason: this module takes the slop assessment
// as an INJECTED function rather than importing slop.ts directly, so the engine package keeps zero import
// dependency on the private `src/` tree. `SelfReviewSlopInput`/`SelfReviewSlopAssessment` below are a
// hand-kept structural mirror of slop.ts's `SlopAssessmentInput`/`SlopAssessment` -- same discipline as
// `types/predicted-gate-types.ts`'s own header comment ("Local mirrors from src/... Keep in sync by hand").
// The real binding (`buildSlopAssessment`) lives in whichever `src`-side shim wires a live iterate-loop.

import { buildPredictedGateVerdict, type PredictedGateInput, type PredictedGateVerdict, type GateCheckConclusion } from "../predicted-gate.js";
import type { FocusManifest } from "../focus-manifest/guidance.js";
import type { AdvisoryFinding, BountyRecord, IssueRecord, PullRequestRecord, RepositoryRecord } from "../types/predicted-gate-types.js";
import type { IssueQualityReport } from "../signals/predicted-gate-engine.js";

/** One changed file in the attempt's live worktree diff. Mirrors `SlopChangedFile` (`src/signals/slop.ts`). */
export type SelfReviewChangedFile = {
  path: string;
  additions?: number | undefined;
  deletions?: number | undefined;
};

/** Structural mirror of `SlopBand` (`src/signals/slop.ts`). */
export type SelfReviewSlopBand = "clean" | "low" | "elevated" | "high";

/** Structural mirror of `SlopAssessmentInput` (`src/signals/slop.ts`) -- see the module doc comment on why
 *  this is a hand-kept mirror rather than an import. */
export type SelfReviewSlopInput = {
  changedFiles?: SelfReviewChangedFile[] | undefined;
  tests?: string[] | undefined;
  testFiles?: string[] | undefined;
  description?: string | null | undefined;
  commitMessages?: string[] | undefined;
  inDuplicateCluster?: boolean | undefined;
  hasLinkedIssue?: boolean | undefined;
  issueDiscoveryLane?: boolean | undefined;
};

/** Structural mirror of `SlopAssessment` (`src/signals/slop.ts`). Reuses the engine's own native
 *  `AdvisoryFinding` for `findings` (predicted-gate-types.ts's own comment already documents it as the mirror
 *  of `src/signals/engine.ts`'s `SignalFinding`, which slop.ts's findings are typed as). */
export type SelfReviewSlopAssessment = {
  slopRisk: number;
  band: SelfReviewSlopBand;
  findings: AdvisoryFinding[];
};

/** Injected dependency binding the real `src/signals/slop.ts#buildSlopAssessment` -- mirrors the
 *  `RewardRiskEngineDeps` injection pattern for the identical not-yet-extracted-into-the-engine reason. */
export type SelfReviewAdapterDeps = {
  runSlopAssessment: (input: SelfReviewSlopInput) => SelfReviewSlopAssessment;
};

/**
 * The attempt-side state an iterate-loop iteration (#2333) has available each round: the live worktree diff,
 * plus the acceptance-criteria-derived identity fields a synthetic PR needs. Nothing here requires network
 * access -- everything is either local diff state or already resolved by an earlier phase (prompt packet /
 * acceptance criteria).
 */
export type AttemptDiffState = {
  repoFullName: string;
  contributorLogin: string;
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  linkedIssues?: number[] | undefined;
  authorAssociation?: string | undefined;
  changedFiles: SelfReviewChangedFile[];
  testFiles?: string[] | undefined;
  commitMessages?: string[] | undefined;
  issueDiscoveryLane?: boolean | undefined;
};

/** Repo-level context the caller supplies once per attempt (this adapter does not fetch it itself -- see the
 *  module doc comment). Mirrors `buildPredictedGateVerdict`'s own non-diff-state parameters exactly. */
export type SelfReviewContext = {
  manifest: FocusManifest;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  bounties?: BountyRecord[] | undefined;
  issueQuality?: IssueQualityReport | null | undefined;
  confirmedContributor?: boolean | undefined;
  /** Whether this attempt's synthetic PR is itself in a duplicate cluster -- the caller computes this from
   *  `pullRequests`/`issues` the same way the live gate's collision report would. Threaded separately from
   *  `diffState` since it depends on repo-level context, not the diff itself. */
  inDuplicateCluster?: boolean | undefined;
};

export type SelfReviewVerdict = {
  predictedGateVerdict: PredictedGateVerdict;
  slopAssessment: SelfReviewSlopAssessment;
  changedPaths: string[];
  /** The hard requirement this issue's deliverables call for: true ONLY when `predictedGateVerdict.conclusion`
   *  is a clear pass ({@link SELF_REVIEW_PASSING_CONCLUSION}). Any other conclusion -- `"failure"`,
   *  `"action_required"`, `"neutral"`, or `"skipped"` -- means false. Callers (this adapter's own consumers,
   *  and independently the iterate-loop orchestrator, #2333, as defense in depth) must never hand off to
   *  submission when this is false. */
  passesPredictedGate: boolean;
};

/** The one literal conclusion value that counts as a clear pass. Exported so callers enforcing the same hard
 *  requirement (defense in depth, per this issue's own deliverable) check against the identical literal rather
 *  than each re-deriving their own notion of "passing". */
export const SELF_REVIEW_PASSING_CONCLUSION: GateCheckConclusion = "success";

function isClearPass(conclusion: GateCheckConclusion): boolean {
  return conclusion === SELF_REVIEW_PASSING_CONCLUSION;
}

/** Build the `PredictedGateInput` (repo, contributor login, title, body, labels, linked issues) from the
 *  attempt's diff state -- the compact synthetic-PR-identity fields `buildPredictedGateVerdict` needs, as
 *  distinct from the repo-level {@link SelfReviewContext}. */
export function buildSelfReviewPredictedGateInput(diffState: AttemptDiffState): PredictedGateInput {
  return {
    repoFullName: diffState.repoFullName,
    contributorLogin: diffState.contributorLogin,
    title: diffState.title,
    ...(diffState.body !== undefined ? { body: diffState.body } : {}),
    ...(diffState.labels !== undefined ? { labels: diffState.labels } : {}),
    ...(diffState.linkedIssues !== undefined ? { linkedIssues: diffState.linkedIssues } : {}),
    ...(diffState.authorAssociation !== undefined ? { authorAssociation: diffState.authorAssociation } : {}),
  };
}

/** The real changed file paths from the diff, for the `changedPaths` argument `buildPredictedGateVerdict`
 *  needs to evaluate path-dependent checks (focus-manifest path policy, path-gated pre-merge checks, the
 *  file-count size/guardrail hold). Omitting them silently under-predicts per predicted-gate.ts's own
 *  `PREDICTED_GATE_NOTE_NO_PATHS` disclaimer -- a dangerous false-confidence bug if the miner's own loop
 *  relied on an omitted-paths call. `runSelfReview` below always threads this through; it is exported
 *  separately so a caller assembling `SelfReviewContext` can also see the exact same path list if needed. */
export function buildSelfReviewChangedPaths(diffState: AttemptDiffState): string[] {
  return diffState.changedFiles.map((file) => file.path);
}

/** Build the slop-assessment input from the diff state + context, mirroring `SlopAssessmentInput` exactly. */
export function buildSelfReviewSlopInput(diffState: AttemptDiffState, context: SelfReviewContext): SelfReviewSlopInput {
  return {
    changedFiles: diffState.changedFiles,
    testFiles: diffState.testFiles,
    description: diffState.body ?? null,
    commitMessages: diffState.commitMessages,
    inDuplicateCluster: context.inDuplicateCluster,
    hasLinkedIssue: (diffState.linkedIssues?.length ?? 0) > 0,
    issueDiscoveryLane: diffState.issueDiscoveryLane,
  };
}

/**
 * Run the full self-review pass for one iteration: build the predicted-gate + slop inputs from the attempt's
 * diff state, call `buildPredictedGateVerdict` with the caller-supplied repo-level context (`changedPaths`
 * ALWAYS threaded through explicitly, never omitted), run the injected slop assessment, and combine into one
 * verdict.
 */
export function runSelfReview(diffState: AttemptDiffState, context: SelfReviewContext, deps: SelfReviewAdapterDeps): SelfReviewVerdict {
  const changedPaths = buildSelfReviewChangedPaths(diffState);
  const predictedGateVerdict = buildPredictedGateVerdict({
    input: buildSelfReviewPredictedGateInput(diffState),
    manifest: context.manifest,
    repo: context.repo,
    issues: context.issues,
    pullRequests: context.pullRequests,
    ...(context.bounties !== undefined ? { bounties: context.bounties } : {}),
    ...(context.issueQuality !== undefined ? { issueQuality: context.issueQuality } : {}),
    ...(context.confirmedContributor !== undefined ? { confirmedContributor: context.confirmedContributor } : {}),
    changedPaths,
  });
  const slopAssessment = deps.runSlopAssessment(buildSelfReviewSlopInput(diffState, context));

  return {
    predictedGateVerdict,
    slopAssessment,
    changedPaths,
    passesPredictedGate: isClearPass(predictedGateVerdict.conclusion),
  };
}
