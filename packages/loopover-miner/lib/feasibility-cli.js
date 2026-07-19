/** `feasibility` CLI command (#4270): a thin parse -> execute -> render wrapper around the engine's pure
 * `buildFeasibilityVerdict` composer. Purely local — no network, no filesystem — so it never needs the
 * npm-registry update check other subcommands opt into. */
import { buildFeasibilityVerdict } from "@loopover/engine";
import { argsWantJson, reportCliFailure } from "./cli-error.js";
const CLAIM_STATUSES = ["unclaimed", "claimed", "solved", "unknown"];
const DUPLICATE_CLUSTER_RISKS = ["none", "low", "medium", "high"];
const ISSUE_STATUSES = [
    "ready",
    "needs_proof",
    "hold",
    "do_not_use",
    "duplicate",
    "invalid",
    "missing",
];
/** Plain `Array.includes` doesn't narrow a `string` argument down to the array's literal element type, so this
 *  small type-guard wrapper does it explicitly wherever a parsed CLI token needs to become one of these enums. */
function isOneOf(value, allowed) {
    return allowed.includes(value);
}
const FEASIBILITY_USAGE = "Usage: loopover-miner feasibility <claimStatus> <duplicateClusterRisk> <issueStatus> [--not-found] [--json]\n" +
    `  claimStatus: ${CLAIM_STATUSES.join("|")}\n` +
    `  duplicateClusterRisk: ${DUPLICATE_CLUSTER_RISKS.join("|")}\n` +
    `  issueStatus: ${ISSUE_STATUSES.join("|")}`;
export function parseFeasibilityArgs(args) {
    const options = { json: false, found: true };
    const positional = [];
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
    const [claimStatus, duplicateClusterRisk, issueStatus] = positional;
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
export function runFeasibilityCli(args, options = {}) {
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
    }
    else {
        console.log(`${verdict.verdict}: ${verdict.summary}`);
    }
    return 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZmVhc2liaWxpdHktY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZmVhc2liaWxpdHktY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzsyREFFMkQ7QUFDM0QsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFRM0QsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBRWhFLE1BQU0sY0FBYyxHQUFHLENBQUMsV0FBVyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsU0FBUyxDQUFzRCxDQUFDO0FBQzFILE1BQU0sdUJBQXVCLEdBQUcsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQStELENBQUM7QUFDaEksTUFBTSxjQUFjLEdBQUc7SUFDckIsT0FBTztJQUNQLGFBQWE7SUFDYixNQUFNO0lBQ04sWUFBWTtJQUNaLFdBQVc7SUFDWCxTQUFTO0lBQ1QsU0FBUztDQUMyQyxDQUFDO0FBRXZEO2tIQUNrSDtBQUNsSCxTQUFTLE9BQU8sQ0FBbUIsS0FBYSxFQUFFLE9BQXFCO0lBQ3JFLE9BQVEsT0FBNkIsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELE1BQU0saUJBQWlCLEdBQ3JCLCtHQUErRztJQUMvRyxrQkFBa0IsY0FBYyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSTtJQUM5QywyQkFBMkIsdUJBQXVCLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJO0lBQ2hFLGtCQUFrQixjQUFjLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFZL0MsTUFBTSxVQUFVLG9CQUFvQixDQUFDLElBQWM7SUFDakQsTUFBTSxPQUFPLEdBQUcsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUM3QyxNQUFNLFVBQVUsR0FBYSxFQUFFLENBQUM7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