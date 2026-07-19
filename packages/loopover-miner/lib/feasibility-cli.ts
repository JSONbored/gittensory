/** `feasibility` CLI command (#4270): a thin parse -> execute -> render wrapper around the engine's pure
 * `buildFeasibilityVerdict` composer. Purely local — no network, no filesystem — so it never needs the
 * npm-registry update check other subcommands opt into. */
import { buildFeasibilityVerdict } from "@loopover/engine";
import type {
  FeasibilityClaimStatus,
  FeasibilityDuplicateClusterRisk,
  FeasibilityGateInput,
  FeasibilityGateResult,
  FeasibilityIssueStatus,
} from "@loopover/engine";
import { argsWantJson, reportCliFailure } from "./cli-error.js";

const CLAIM_STATUSES = ["unclaimed", "claimed", "solved", "unknown"] as const satisfies readonly FeasibilityClaimStatus[];
const DUPLICATE_CLUSTER_RISKS = ["none", "low", "medium", "high"] as const satisfies readonly FeasibilityDuplicateClusterRisk[];
const ISSUE_STATUSES = [
  "ready",
  "needs_proof",
  "hold",
  "do_not_use",
  "duplicate",
  "invalid",
  "missing",
] as const satisfies readonly FeasibilityIssueStatus[];

/** Plain `Array.includes` doesn't narrow a `string` argument down to the array's literal element type, so this
 *  small type-guard wrapper does it explicitly wherever a parsed CLI token needs to become one of these enums. */
function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

const FEASIBILITY_USAGE =
  "Usage: loopover-miner feasibility <claimStatus> <duplicateClusterRisk> <issueStatus> [--not-found] [--json]\n" +
  `  claimStatus: ${CLAIM_STATUSES.join("|")}\n` +
  `  duplicateClusterRisk: ${DUPLICATE_CLUSTER_RISKS.join("|")}\n` +
  `  issueStatus: ${ISSUE_STATUSES.join("|")}`;

export type ParsedFeasibilityArgs =
  | {
      claimStatus: FeasibilityClaimStatus;
      duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
      issueStatus: FeasibilityIssueStatus;
      found: boolean;
      json: boolean;
    }
  | { error: string };

export function parseFeasibilityArgs(args: string[]): ParsedFeasibilityArgs {
  const options = { json: false, found: true };
  const positional: string[] = [];

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--not-found") {
      options.found = false;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length !== 3) {
    return { error: FEASIBILITY_USAGE };
  }

  // positional.length === 3 was just verified above, so this tuple cast is safe.
  const [claimStatus, duplicateClusterRisk, issueStatus] = positional as [string, string, string];
  if (!isOneOf(claimStatus, CLAIM_STATUSES)) {
    return { error: `claimStatus must be one of: ${CLAIM_STATUSES.join(", ")}.` };
  }
  if (!isOneOf(duplicateClusterRisk, DUPLICATE_CLUSTER_RISKS)) {
    return { error: `duplicateClusterRisk must be one of: ${DUPLICATE_CLUSTER_RISKS.join(", ")}.` };
  }
  if (!isOneOf(issueStatus, ISSUE_STATUSES)) {
    return { error: `issueStatus must be one of: ${ISSUE_STATUSES.join(", ")}.` };
  }

  return {
    claimStatus,
    duplicateClusterRisk,
    issueStatus,
    found: options.found,
    json: options.json,
  };
}

export type RunFeasibilityCliOptions = {
  buildFeasibilityVerdict?: (input: FeasibilityGateInput) => FeasibilityGateResult;
};

export function runFeasibilityCli(args: string[], options: RunFeasibilityCliOptions = {}): number {
  const parsed = parseFeasibilityArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const buildVerdict = options.buildFeasibilityVerdict ?? buildFeasibilityVerdict;
  const verdict = buildVerdict({
    found: parsed.found,
    claimStatus: parsed.claimStatus,
    duplicateClusterRisk: parsed.duplicateClusterRisk,
    issueStatus: parsed.issueStatus,
  });

  if (parsed.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(`${verdict.verdict}: ${verdict.summary}`);
  }
  return 0;
}
