import type { Advisory, AdvisoryFinding, GateRuleMode } from "../types";
import type { SlopAssessment } from "../signals/slop";
import type { GateCheckEvaluation, GateCheckPolicy } from "./advisory";
import { buildQualityGateFinding, gateMode, isEvaluationBlockerFinding } from "./advisory";

export function slopFindingsToAdvisoryFindings(assessment: SlopAssessment): AdvisoryFinding[] {
  return assessment.findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail,
    ...(finding.action ? { action: finding.action } : {}),
    ...(finding.publicText ? { publicText: finding.publicText } : {}),
  }));
}

export function isMergeReadinessCompositeEnabled(policy: GateCheckPolicy): boolean {
  return policy.mergeReadinessGateMode === "block" || policy.mergeReadinessGateMode === "advisory";
}

export function collectMergeReadinessUnmetConditions(advisory: Advisory, policy: GateCheckPolicy): AdvisoryFinding[] {
  const unmet: AdvisoryFinding[] = [];

  if (subGateEnabled(policy.linkedIssueGateMode)) {
    const finding = advisory.findings.find((entry) => entry.code === "missing_linked_issue");
    if (finding) unmet.push(finding);
  }
  if (subGateEnabled(policy.duplicatePrGateMode)) {
    const finding = advisory.findings.find((entry) => entry.code === "duplicate_pr_risk");
    if (finding) unmet.push(finding);
  }
  if (subGateEnabled(policy.qualityGateMode)) {
    const qualityFinding = buildQualityGateFinding({ ...policy, qualityGateMode: "block" });
    if (qualityFinding) unmet.push(qualityFinding);
  }
  if ((policy.slopFindings ?? []).length > 0) {
    unmet.push(...(policy.slopFindings ?? []));
  }

  return unmet;
}

export function evaluateMergeReadinessGateCheck(advisory: Advisory, policy: GateCheckPolicy): GateCheckEvaluation {
  const evaluationBlockers = advisory.findings.filter((finding) => isEvaluationBlockerFinding(finding.code));
  const unmet = collectMergeReadinessUnmetConditions(advisory, policy);
  const advisoryWarnings = advisory.findings.filter((finding) => finding.severity === "warning");

  if (evaluationBlockers.length > 0) {
    return {
      enabled: true,
      conclusion: "action_required",
      title: "Gittensory Gate needs app attention",
      summary: "Gittensory cannot evaluate this PR until app or repo state is repaired.",
      blockers: evaluationBlockers,
      warnings: advisoryWarnings.filter((finding) => !evaluationBlockers.includes(finding)),
    };
  }

  if (unmet.length === 0) {
    return {
      enabled: true,
      conclusion: "success",
      title: "Gittensory Gate passed",
      summary: "All enabled merge-readiness conditions passed.",
      blockers: [],
      warnings: advisoryWarnings,
    };
  }

  if (gateMode(policy.mergeReadinessGateMode) === "advisory") {
    return {
      enabled: true,
      conclusion: "success",
      title: "Gittensory Gate passed",
      summary: `${unmet.length} merge-readiness condition${unmet.length === 1 ? "" : "s"} remain advisory.`,
      blockers: [],
      warnings: [...advisoryWarnings, ...unmet],
    };
  }

  return {
    enabled: true,
    conclusion: "failure",
    title: "Gittensory Gate is blocking merge",
    summary: buildMergeReadinessBlockingSummary(unmet),
    blockers: unmet,
    warnings: advisoryWarnings.filter((finding) => !unmet.includes(finding)),
  };
}

function subGateEnabled(mode: GateRuleMode | undefined): boolean {
  return mode !== "off";
}

function buildMergeReadinessBlockingSummary(unmet: AdvisoryFinding[]): string {
  const labels = unmet.map((finding) => finding.title).join("; ");
  return `${unmet.length} merge-readiness condition${unmet.length === 1 ? "" : "s"} still blocking: ${labels}.`;
}
