/** `idea-feasibility` CLI command: the freeform-idea counterpart to the metadata `feasibility` CLI
 * (feasibility-cli.js, #4270). It runs a freeform Rent-a-Loop idea submission (#4779) through the
 * pre-compute feasibility gate (idea-feasibility.js, #5671) so a renter can no longer burn compute on an
 * idea that was never going to succeed — the same parse -> execute -> render wrapper the metadata gate uses,
 * only the idea's `issueStatus` is DERIVED from its own structure rather than supplied. Purely local — no
 * network, no filesystem — so it never needs the npm-registry update check other subcommands opt into. */
import { assessIdeaFeasibility } from "./idea-feasibility.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";
const CLAIM_STATUSES = ["unclaimed", "claimed", "solved", "unknown"];
const DUPLICATE_CLUSTER_RISKS = ["none", "low", "medium", "high"];
/** Plain `Array.includes` doesn't narrow a `string` argument down to the array's literal element type, so this
 *  small type-guard wrapper does it explicitly wherever a parsed CLI token needs to become one of these enums. */
function isOneOf(value, allowed) {
    return allowed.includes(value);
}
const IDEA_FEASIBILITY_USAGE = "Usage: loopover-miner idea-feasibility <claimStatus> <duplicateClusterRisk> [--not-resolvable] [--hint <text>]... [--json]\n" +
    `  claimStatus: ${CLAIM_STATUSES.join("|")}\n` +
    `  duplicateClusterRisk: ${DUPLICATE_CLUSTER_RISKS.join("|")}\n` +
    "  --not-resolvable: the idea's target repo does not resolve to a repo the loop can act on (issueStatus=missing)\n" +
    "  --hint <text>: an objective acceptance signal (repeatable); an idea declaring none is invalid (issueStatus=invalid)";
export function parseIdeaFeasibilityArgs(args) {
    const options = { json: false, targetResolvable: true, acceptanceHints: [] };
    const positional = [];
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--not-resolvable") {
            options.targetResolvable = false;
            continue;
        }
        if (token === "--hint") {
            const value = args[i + 1];
            // A whitespace-only hint is as empty as a missing one (#6766): it declares no testable success signal, so
            // it gets the same rejection rather than sailing through as a real objective signal.
            if (value === undefined || value.startsWith("-") || value.trim() === "") {
                return { error: "--hint requires a value." };
            }
            options.acceptanceHints.push(value);
            i += 1;
            continue;
        }
        if (token.startsWith("-")) {
            return { error: `Unknown option: ${token}` };
        }
        positional.push(token);
    }
    if (positional.length !== 2) {
        return { error: IDEA_FEASIBILITY_USAGE };
    }
    // positional.length === 2 was just verified above, so this tuple cast is safe.
    const [claimStatus, duplicateClusterRisk] = positional;
    if (!isOneOf(claimStatus, CLAIM_STATUSES)) {
        return { error: `claimStatus must be one of: ${CLAIM_STATUSES.join(", ")}.` };
    }
    if (!isOneOf(duplicateClusterRisk, DUPLICATE_CLUSTER_RISKS)) {
        return { error: `duplicateClusterRisk must be one of: ${DUPLICATE_CLUSTER_RISKS.join(", ")}.` };
    }
    return {
        claimStatus,
        duplicateClusterRisk,
        targetResolvable: options.targetResolvable,
        acceptanceHints: options.acceptanceHints,
        json: options.json,
    };
}
export function runIdeaFeasibilityCli(args, options = {}) {
    const parsed = parseIdeaFeasibilityArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    const assessment = assessIdeaFeasibility({ acceptanceHints: parsed.acceptanceHints }, {
        targetResolvable: parsed.targetResolvable,
        claimStatus: parsed.claimStatus,
        duplicateClusterRisk: parsed.duplicateClusterRisk,
    }, options);
    if (parsed.json) {
        console.log(JSON.stringify(assessment, null, 2));
    }
    else {
        console.log(`${assessment.disposition}: ${assessment.summary}`);
    }
    return 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWRlYS1mZWFzaWJpbGl0eS1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpZGVhLWZlYXNpYmlsaXR5LWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7MEdBSzBHO0FBQzFHLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBRTlELE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUdoRSxNQUFNLGNBQWMsR0FBRyxDQUFDLFdBQVcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLFNBQVMsQ0FBc0QsQ0FBQztBQUMxSCxNQUFNLHVCQUF1QixHQUFHLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsTUFBTSxDQUErRCxDQUFDO0FBRWhJO2tIQUNrSDtBQUNsSCxTQUFTLE9BQU8sQ0FBbUIsS0FBYSxFQUFFLE9BQXFCO0lBQ3JFLE9BQVEsT0FBNkIsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELE1BQU0sc0JBQXNCLEdBQzFCLDhIQUE4SDtJQUM5SCxrQkFBa0IsY0FBYyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSTtJQUM5QywyQkFBMkIsdUJBQXVCLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJO0lBQ2hFLG1IQUFtSDtJQUNuSCx1SEFBdUgsQ0FBQztBQVkxSCxNQUFNLFVBQVUsd0JBQXdCLENBQUMsSUFBYztJQUNyRCxNQUFNLE9BQU8sR0FBRyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLEVBQUUsSUFBSSxFQUFFLGVBQWUsRUFBRSxFQUFjLEVBQUUsQ0FBQztJQUN6RixNQUFNLFVBQVUsR0FBYSxFQUFFLENBQUM7SUFFaEMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFD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