// Self-plagiarism throttle (#2345): pure classifier over a prospective PR's diff fingerprint vs the miner's own
// recent submission history. Gates nothing on its own — the Governor open_pr chokepoint (#2340) composes this
// verdict with rate-limit, budget caps, and non-convergence before recording to the governor ledger.
//
// ELECTION: reuses {@link isDuplicateClusterWinnerByClaim}'s claim-time / earliest-wins ordering so a
// near-duplicate cluster has exactly one survivor — sparse or ambiguous timing fails closed (deny), mirroring
// duplicate-cluster adjudication in src/signals/duplicate-winner.ts.
//
// DETECTOR ONLY — no IO, no Date.now(), no randomness. Identical inputs always yield the identical verdict.

import type { GovernorLedgerEventType } from "../governor-ledger.js";

/** Conservative default — only very similar diff fingerprints throttle (not hard-coded at call sites). */
export const DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD = 0.85;

export type SelfPlagiarismConfig = {
  /** Jaccard similarity in [0, 1] at/above which two fingerprints read as near-duplicates. */
  similarityThreshold: number;
};

export const DEFAULT_SELF_PLAGIARISM_CONFIG: Readonly<SelfPlagiarismConfig> =
  Object.freeze({
    similarityThreshold: DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
  });

/** One prior submission from the miner's own history (same actor only — never cross-miner). */
export type OwnSubmissionRecord = {
  repoFullName: string;
  /** Stable diff fingerprint for similarity comparison (caller-normalized token set or hash). */
  fingerprint: string;
  /** When the submission was recorded — election ordering signal (ISO-8601). */
  submittedAt?: string | null | undefined;
  pullRequestNumber?: number | null | undefined;
  issueNumber?: number | null | undefined;
};

export type SelfPlagiarismCandidate = OwnSubmissionRecord;

export type SelfPlagiarismVerdict = {
  allowed: boolean;
  /** Aligns with governor-ledger vocabulary: `allowed`, `throttled`, or `denied`. */
  eventType: GovernorLedgerEventType;
  reason: string;
  /** Highest-similarity prior that triggered the throttle, when present. */
  matchedSubmission?: OwnSubmissionRecord;
  similarity?: number;
};

function normalizeThreshold(value: number): number {
  if (!Number.isFinite(value))
    return DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD;
  return Math.min(1, Math.max(0, value));
}

function normalizeFingerprint(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function tokenSet(fingerprint: string): Set<string> {
  return new Set(
    fingerprint
      .split(/[\s:,]+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

/** Token-set Jaccard similarity — deterministic and dependency-free for diff fingerprint comparison. */
export function fingerprintSimilarity(left: string, right: string): number {
  const setLeft = tokenSet(normalizeFingerprint(left) ?? "");
  const setRight = tokenSet(normalizeFingerprint(right) ?? "");
  if (setLeft.size === 0 && setRight.size === 0) return 1;
  if (setLeft.size === 0 || setRight.size === 0) return 0;
  let intersection = 0;
  for (const token of setLeft) {
    if (setRight.has(token)) intersection += 1;
  }
  const union = setLeft.size + setRight.size - intersection;
  return intersection / union;
}

/**
 * Build a real `OwnSubmissionRecord.fingerprint` from the real set of file paths a submission actually
 * changed (`CodingAgentDriverResult.changedFiles`/`HandoffPacket.changedFiles`, never a fabricated or
 * partial list). Comma-joined so `fingerprintSimilarity`'s own `tokenSet` splitter treats each path as one
 * token -- two submissions touching mostly the same files read as near-duplicates. Deduped and sorted so the
 * same real change set always produces the identical fingerprint regardless of the order paths were reported
 * in. Empty input (no changed files) is an honest empty string, never a fabricated placeholder token.
 */
export function fingerprintFromChangedFiles(paths: readonly string[]): string {
  const unique = new Set(
    paths
      .filter((path): path is string => typeof path === "string")
      .map((path) => path.trim())
      .filter((path) => path.length > 0),
  );
  return [...unique].sort().join(",");
}

function submissionTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function submissionNumber(record: OwnSubmissionRecord): number {
  return (
    (typeof record.pullRequestNumber === "number" &&
    Number.isFinite(record.pullRequestNumber)
      ? record.pullRequestNumber
      : null) ??
    (typeof record.issueNumber === "number" &&
    Number.isFinite(record.issueNumber)
      ? record.issueNumber
      : null) ??
    0
  );
}

function repoTieBreaker(record: OwnSubmissionRecord): string {
  return record.repoFullName.trim().toLowerCase();
}

function submissionPrecedesSibling(
  candidate: OwnSubmissionRecord,
  sibling: OwnSubmissionRecord,
): boolean {
  const candidateTime = submissionTimeMs(candidate.submittedAt)!;
  const siblingTime = submissionTimeMs(sibling.submittedAt)!;
  if (siblingTime < candidateTime) return false;
  if (siblingTime > candidateTime) return true;

  const candidateNumber = submissionNumber(candidate);
  const siblingNumber = submissionNumber(sibling);
  if (siblingNumber < candidateNumber) return false;
  if (siblingNumber > candidateNumber) return true;

  const candidateRepo = repoTieBreaker(candidate);
  const siblingRepo = repoTieBreaker(sibling);
  if (siblingRepo.length === 0 || candidateRepo.length === 0) return false;
  return candidateRepo < siblingRepo;
}

function isSelfPlagiarismClusterWinner(
  candidate: OwnSubmissionRecord,
  nearDuplicates: readonly OwnSubmissionRecord[],
): boolean {
  return nearDuplicates.every((sibling) =>
    submissionPrecedesSibling(candidate, sibling),
  );
}

// Precondition: the caller (selfPlagiarismCheck) already confirmed `candidate` is NOT the outright
// winner (isSelfPlagiarismClusterWinner returned false) before calling this -- so this only needs to
// search nearDuplicates for a sibling that wins instead.
function resolveSelfPlagiarismWinner(
  candidate: OwnSubmissionRecord,
  nearDuplicates: readonly OwnSubmissionRecord[],
): OwnSubmissionRecord | null {
  for (const sibling of nearDuplicates) {
    const rest = nearDuplicates.filter((other) => other !== sibling);
    if (isSelfPlagiarismClusterWinner(sibling, [candidate, ...rest]))
      return sibling;
  }
  return null;
}

function buildVerdict(
  allowed: boolean,
  eventType: GovernorLedgerEventType,
  reason: string,
  matchedSubmission?: OwnSubmissionRecord,
  similarity?: number,
): SelfPlagiarismVerdict {
  return {
    allowed,
    eventType,
    reason,
    ...(matchedSubmission ? { matchedSubmission } : {}),
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

/**
 * Compare a prospective PR fingerprint against the miner's own recent submissions. Fail closed when the
 * candidate fingerprint or election timing is missing/ambiguous. When near-duplicates exist, only the
 * earliest claimant wins — later submissions are throttled.
 */
export function selfPlagiarismCheck(
  candidateFingerprint: SelfPlagiarismCandidate,
  recentOwnSubmissions: readonly OwnSubmissionRecord[],
  config: SelfPlagiarismConfig = DEFAULT_SELF_PLAGIARISM_CONFIG,
): SelfPlagiarismVerdict {
  const threshold = normalizeThreshold(config.similarityThreshold);
  const candidatePrint = normalizeFingerprint(candidateFingerprint.fingerprint);
  if (candidatePrint === null) {
    return buildVerdict(false, "denied", "missing_candidate_fingerprint");
  }
  if (submissionTimeMs(candidateFingerprint.submittedAt) === null) {
    return buildVerdict(false, "denied", "missing_candidate_submitted_at");
  }

  let bestMatch: OwnSubmissionRecord | undefined;
  let bestSimilarity = 0;
  const nearDuplicates: OwnSubmissionRecord[] = [];

  for (const prior of recentOwnSubmissions) {
    const priorPrint = normalizeFingerprint(prior.fingerprint);
    if (priorPrint === null) continue;
    const similarity = fingerprintSimilarity(candidatePrint, priorPrint);
    if (similarity >= threshold) {
      nearDuplicates.push(prior);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = prior;
      }
    }
  }

  if (nearDuplicates.length === 0) {
    return buildVerdict(
      true,
      "allowed",
      "distinct_from_recent_own_submissions",
    );
  }

  for (const prior of nearDuplicates) {
    if (submissionTimeMs(prior.submittedAt) === null) {
      return buildVerdict(false, "denied", "missing_prior_submitted_at");
    }
  }

  if (isSelfPlagiarismClusterWinner(candidateFingerprint, nearDuplicates)) {
    return buildVerdict(true, "allowed", "earliest_near_duplicate_claimant");
  }

  const winner = resolveSelfPlagiarismWinner(
    candidateFingerprint,
    nearDuplicates,
  );
  const matched =
    winner && winner !== candidateFingerprint
      ? winner
      : (bestMatch ?? nearDuplicates[0]!);

  const matchedPrint = normalizeFingerprint(matched.fingerprint)!;
  return buildVerdict(
    false,
    "throttled",
    "near_duplicate_self_plagiarism",
    matched,
    bestSimilarity > 0
      ? bestSimilarity
      : fingerprintSimilarity(candidatePrint, matchedPrint),
  );
}

/** Governor-ledger row shape for an open_pr self-plagiarism decision (#2345 deliverable). */
export function buildSelfPlagiarismGovernorLedgerEvent(
  repoFullName: string,
  verdict: SelfPlagiarismVerdict,
): {
  eventType: GovernorLedgerEventType;
  repoFullName: string;
  actionClass: string;
  decision: string;
  reason: string;
  payload: Record<string, unknown>;
} {
  const matched = verdict.matchedSubmission;
  return {
    eventType: verdict.eventType,
    repoFullName,
    actionClass: "open_pr",
    decision: verdict.allowed
      ? "allow"
      : verdict.eventType === "throttled"
        ? "throttle"
        : "deny",
    reason: verdict.reason,
    payload: matched
      ? {
          matchedRepoFullName: matched.repoFullName,
          matchedPullRequestNumber: matched.pullRequestNumber ?? null,
          matchedIssueNumber: matched.issueNumber ?? null,
          matchedSubmittedAt: matched.submittedAt ?? null,
          similarity: verdict.similarity ?? null,
        }
      : {},
  };
}

/** Normalize a miner-goal-spec selfPlagiarism block (or bare threshold number) into engine config. */
export function resolveSelfPlagiarismConfig(
  raw: unknown,
): SelfPlagiarismConfig {
  if (raw === undefined || raw === null)
    return { ...DEFAULT_SELF_PLAGIARISM_CONFIG };
  if (typeof raw === "number") {
    return { similarityThreshold: normalizeThreshold(raw) };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    return {
      similarityThreshold: normalizeThreshold(
        typeof record.similarityThreshold === "number"
          ? record.similarityThreshold
          : DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
      ),
    };
  }
  return { ...DEFAULT_SELF_PLAGIARISM_CONFIG };
}
