// Feasibility-gate composer (pure).
//
// Metadata-only verdict over the three discriminants the analyze-phase feasibility gate actually branches on:
// claim status, duplicate-cluster risk, and issue quality/lifecycle status. Composes the same go/raise/avoid
// decision as the pre-start check's core recommendation logic without pulling in repo records or GitHub caches.

export type FeasibilityClaimStatus = "unclaimed" | "claimed" | "solved" | "unknown";
export type FeasibilityDuplicateClusterRisk = "none" | "low" | "medium" | "high";
export type FeasibilityIssueStatus = "ready" | "needs_proof" | "hold" | "do_not_use" | "duplicate" | "invalid" | "missing";

export type FeasibilityGateInput = {
  /** Whether cached metadata resolved a target issue. Defaults to true when omitted. */
  found?: boolean | undefined;
  claimStatus: FeasibilityClaimStatus;
  duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
  issueStatus: FeasibilityIssueStatus;
};

export type FeasibilityVerdict = "go" | "raise" | "avoid";

export type FeasibilityGateResult = {
  verdict: FeasibilityVerdict;
  avoidReasons: readonly string[];
  raiseReasons: readonly string[];
  summary: string;
};

function collectAvoidReasons(input: FeasibilityGateInput): string[] {
  // Collect every avoid trigger independently — never fold with ??/|| so two simultaneous avoid signals both surface.
  const reasons: string[] = [];
  if (input.claimStatus === "solved") reasons.push("claim_status_solved");
  if (input.issueStatus === "do_not_use") reasons.push("issue_quality_do_not_use");
  if (input.issueStatus === "duplicate") reasons.push("issue_lifecycle_duplicate");
  if (input.issueStatus === "invalid") reasons.push("issue_lifecycle_invalid");
  if (input.duplicateClusterRisk === "high") reasons.push("duplicate_cluster_high");
  return reasons;
}

function collectRaiseReasons(input: FeasibilityGateInput, found: boolean): string[] {
  const reasons: string[] = [];
  if (!found) reasons.push("target_not_found");
  if (input.duplicateClusterRisk === "medium") reasons.push("duplicate_cluster_medium");
  if (input.claimStatus === "claimed") reasons.push("claim_status_claimed");
  if (input.issueStatus === "needs_proof" || input.issueStatus === "hold") reasons.push("issue_quality_uncertain");
  if (input.issueStatus === "missing") reasons.push("issue_missing");
  return reasons;
}

/** Pure feasibility verdict from claim, duplicate-cluster, and issue-status signals. */
export function buildFeasibilityVerdict(input: FeasibilityGateInput): FeasibilityGateResult {
  const found = input.found ?? true;
  const avoidReasons = collectAvoidReasons(input);
  if (avoidReasons.length > 0) {
    return {
      verdict: "avoid",
      avoidReasons,
      raiseReasons: [],
      summary: `Avoid: ${avoidReasons.join(", ")}.`,
    };
  }

  const raiseReasons = collectRaiseReasons(input, found);
  if (raiseReasons.length > 0) {
    return {
      verdict: "raise",
      avoidReasons: [],
      raiseReasons,
      summary: `Raise: ${raiseReasons.join(", ")}.`,
    };
  }

  return {
    verdict: "go",
    avoidReasons: [],
    raiseReasons: [],
    summary: "Go: no blocking feasibility signal detected.",
  };
}

/** Map a pre-start check report into the feasibility composer's input shape (parity helper for tests/callers). */
export function feasibilityInputFromPreStartCheck(report: {
  found: boolean;
  claimStatus: FeasibilityClaimStatus;
  duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
  issueQualityStatus?: "ready" | "needs_proof" | "hold" | "do_not_use" | undefined;
  lifecycle?: string | undefined;
}): FeasibilityGateInput {
  let issueStatus: FeasibilityIssueStatus;
  if (!report.found) issueStatus = "missing";
  else if (report.lifecycle === "duplicate") issueStatus = "duplicate";
  else if (report.lifecycle === "invalid") issueStatus = "invalid";
  else if (report.issueQualityStatus === "do_not_use") issueStatus = "do_not_use";
  else if (report.issueQualityStatus === "needs_proof") issueStatus = "needs_proof";
  else if (report.issueQualityStatus === "hold") issueStatus = "hold";
  else issueStatus = "ready";

  return {
    found: report.found,
    claimStatus: report.claimStatus,
    duplicateClusterRisk: report.duplicateClusterRisk,
    issueStatus,
  };
}
