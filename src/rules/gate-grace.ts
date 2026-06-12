import type { GateRuleMode } from "../types";
import type { ContributorOutcomeHistory, RoleContext } from "../signals/engine";
import type { GateCheckPolicy } from "./advisory";

export function isRepeatClosedUnmergedAuthor(
  repoOutcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined,
): boolean {
  if (!repoOutcome) return false;
  return repoOutcome.closedPullRequests > 0 && repoOutcome.mergedPullRequests === 0 && repoOutcome.pullRequests >= 2;
}

export function shouldGrantFirstTimeContributorGrace(args: {
  enabled: boolean;
  roleContext: RoleContext;
  repoOutcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
}): boolean {
  if (!args.enabled) return false;
  if (args.roleContext.maintainerLane) return false;
  if (isRepeatClosedUnmergedAuthor(args.repoOutcome)) return false;
  if (!args.repoOutcome) return true;
  if (args.repoOutcome.pullRequests <= 1) return true;
  return args.repoOutcome.mergedPullRequests === 0 && args.repoOutcome.closedPullRequests === 0;
}

export function applyFirstTimeContributorGrace(policy: GateCheckPolicy): GateCheckPolicy {
  return {
    ...policy,
    linkedIssueGateMode: downgradeBlockToAdvisory(policy.linkedIssueGateMode),
    duplicatePrGateMode: downgradeBlockToAdvisory(policy.duplicatePrGateMode),
    qualityGateMode: downgradeBlockToAdvisory(policy.qualityGateMode),
  };
}

export function resolveContributorGraceGatePolicy(
  base: GateCheckPolicy,
  settings: { firstTimeContributorGrace: boolean },
  context: {
    roleContext: RoleContext;
    repoOutcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  },
): GateCheckPolicy {
  if (!settings.firstTimeContributorGrace) return base;
  if (!shouldGrantFirstTimeContributorGrace({ enabled: true, roleContext: context.roleContext, repoOutcome: context.repoOutcome })) {
    return base;
  }
  return applyFirstTimeContributorGrace(base);
}

function downgradeBlockToAdvisory(mode: GateRuleMode | undefined): GateRuleMode | undefined {
  return mode === "block" ? "advisory" : mode;
}
