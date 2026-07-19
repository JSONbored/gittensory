import { closeSync, constants as fsConstants, openSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ACCEPTANCE_CRITERIA_FILENAME, buildAcceptanceCriteria, buildCollisionReport, buildFeasibilityVerdict, buildPromptPacket, feasibilityInputFromPreStartCheck, serializeAcceptanceCriteria, shouldWriteAcceptanceCriteria, } from "@loopover/engine";
import { neutralizePromptInjection } from "./prompt-injection-defense.js";
import { detectRepoStack, renderStackSummary } from "./stack-detection.js";
function buildTaskBrief(issue) {
    const title = neutralizePromptInjection(issue.title).text;
    const body = neutralizePromptInjection((issue.body ?? "").trim()).text;
    return body ? `${title}\n\n${body}` : title;
}
function buildConstraints(issue) {
    if (!Array.isArray(issue.labels) || issue.labels.length === 0)
        return "";
    return `Labels on this issue: ${issue.labels.join(", ")}.`;
}
function buildFeasibilityNotes(feasibility) {
    return [feasibility.summary, ...feasibility.avoidReasons, ...feasibility.raiseReasons].join("\n");
}
// Only ever resolves to "claimed"/"unclaimed": the claim ledger's own ClaimStatus vocabulary
// ("active"|"released"|"expired") has no "solved" concept for FeasibilityClaimStatus's "solved" value to
// map from -- that would need real evidence a PR already resolved the issue (e.g. a merged, linked PR),
// which this function doesn't have access to. Not fabricated; genuinely undetectable from claim data alone.
function resolveClaimStatus(claimLedger, repoFullName, issueNumber) {
    const claims = claimLedger.listClaims({ repoFullName, status: "active" });
    return claims.some((claim) => claim.issueNumber === issueNumber) ? "claimed" : "unclaimed";
}
// The target issue's own raw cluster risk from buildCollisionReport (newly exported from
// @loopover/engine's public barrel) -- "none" when the issue isn't part of any cluster at all.
// DELIBERATELY does NOT apply #5145's ">= 2 pull_request items" threshold: that gate exists specifically to
// stop inDuplicateCluster (self-review, "does MY OWN just-created submission look redundant") from firing on
// the ordinary case of one existing PR already legitimately closing the issue. Feasibility asks a different
// question -- "should I even START working on this issue" -- where an issue already having ANY open PR
// against it (buildCollisionReport's pairwise "shared linked issue" rule, which fires at "high" for exactly
// one PR) is a meaningful, real caution signal, not a false positive to filter out.
function resolveDuplicateClusterRisk(repoFullName, issues, pullRequests, issueNumber) {
    const report = buildCollisionReport(repoFullName, issues, pullRequests);
    const cluster = report.clusters.find((entry) => entry.items.some((item) => item.type === "issue" && item.number === issueNumber));
    return cluster ? cluster.risk : "none";
}
/**
 * Compute the feasibility verdict for one target issue, from real signals: whether the issue is present in
 * the fetched context, its real claim status (the claim ledger), and its real duplicate-cluster risk
 * (buildCollisionReport over the fetched issues/pullRequests). issueStatus is left to its documented
 * "ready" default -- see this file's header for why that's honest, not fabricated.
 */
export function buildCodingTaskFeasibility(repoFullName, issue, context, claimLedger) {
    const found = context.issues.some((candidate) => candidate.number === issue.number);
    const claimStatus = resolveClaimStatus(claimLedger, repoFullName, issue.number);
    const duplicateClusterRisk = resolveDuplicateClusterRisk(repoFullName, context.issues, context.pullRequests, issue.number);
    const feasibilityInput = feasibilityInputFromPreStartCheck({ found, claimStatus, duplicateClusterRisk });
    return buildFeasibilityVerdict(feasibilityInput);
}
/**
 * Compose the immutable AcceptanceCriteria document for one target issue + its feasibility verdict.
 */
export function buildCodingTaskAcceptanceCriteria(issue, feasibility) {
    const promptPacket = buildPromptPacket({
        taskBrief: buildTaskBrief(issue),
        constraints: buildConstraints(issue),
        feasibilityNotes: buildFeasibilityNotes(feasibility),
        retrievalContext: "",
    });
    return buildAcceptanceCriteria({ promptPacket, feasibility });
}
/**
 * Write the acceptance-criteria document into the prepared worktree -- only when its own verdict authorizes
 * it (shouldWriteAcceptanceCriteria: verdict === "go"). A raise/avoid verdict writes nothing; the caller is
 * expected to abandon the attempt rather than start it, per acceptance-criteria.ts's own documented design.
 */
function assertContainedPath(root, path) {
    const relativePath = relative(root, path);
    // Defense-in-depth: writeAcceptanceCriteriaFile always joins the fixed ACCEPTANCE_CRITERIA_FILENAME under the
    // realpath'd root, so `relativePath` is always the contained filename -- the escaping branch (and its throw)
    // has no reachable caller and no test seam.
    /* v8 ignore start -- unreachable: the path is always the fixed filename joined under the realpath'd root */
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath)))
        return;
    throw new Error(`Refusing to write acceptance criteria outside the worktree: ${path}`);
    /* v8 ignore stop */
}
export function writeAcceptanceCriteriaFile(workingDirectory, acceptanceCriteria) {
    if (!shouldWriteAcceptanceCriteria(acceptanceCriteria.verdict))
        return { written: false, path: null };
    const root = realpathSync(workingDirectory);
    const path = join(root, ACCEPTANCE_CRITERIA_FILENAME);
    assertContainedPath(root, path);
    let fd;
    try {
        fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, serializeAcceptanceCriteria(acceptanceCriteria), "utf8");
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
    return { written: true, path };
}
/**
 * Prompt guidance derived from a real `detectRepoStack` result (#4786). Lists only commands the detector
 * confidently inferred -- a `null` command stays omitted rather than guessed -- and always tells the agent
 * not to assume LoopOver/loopover's own CI/coverage conventions.
 */
function buildValidationGuidance(stack) {
    const lines = [
        `Detected target-repo stack: ${renderStackSummary(stack)}`,
        "",
        "Validate your change with THIS repository's own build/test/lint tooling from the stack summary above.",
        "Do not assume LoopOver/loopover CI conventions, Codecov patch coverage, or `npm run test:ci` unless those commands appear in the detected stack.",
    ];
    if (stack?.detected === true) {
        const commands = [
            stack.testCommand ? `- test: \`${stack.testCommand}\`` : null,
            stack.lintCommand ? `- lint: \`${stack.lintCommand}\`` : null,
            stack.buildCommand ? `- build: \`${stack.buildCommand}\`` : null,
            stack.formatCommand ? `- format: \`${stack.formatCommand}\`` : null,
        ].filter((entry) => entry !== null);
        if (commands.length > 0) {
            lines.push("", "Run these commands before finishing:", ...commands);
        }
        else {
            lines.push("", "No build/test/lint/format commands were confidently inferred — discover and use this repo's own tooling rather than guessing.");
        }
    }
    return lines.join("\n");
}
/**
 * The coding-agent driver's own prompt text (agent-sdk-driver.ts's header: "forwarded verbatim as the
 * prompt -- the acceptance-criteria document already lives inside the worktree", so this points to it
 * rather than repeating its content). Also carries the target repo's detected stack + validation commands
 * (#4786) so the agent does not default to loopover-specific CI assumptions.
 *
 * The issue's title/body are neutralized against prompt-injection (#4795) before embedding -- this is the
 * literal `prompt:` handoff to the coding agent (agent-sdk-driver.ts), so it's the primary place untrusted
 * repo content could otherwise redirect agent behavior.
 */
function buildInstructions(issue, acceptanceCriteriaPath, stack) {
    const title = neutralizePromptInjection(issue.title);
    const body = neutralizePromptInjection((issue.body ?? "").trim());
    if (title.injected || body.injected) {
        console.log(JSON.stringify({
            event: "prompt_injection_neutralized",
            issueNumber: issue.number,
            fields: [title.injected ? "title" : null, body.injected ? "body" : null].filter(Boolean),
        }));
    }
    return [
        `Resolve the following GitHub issue in this repository: #${issue.number} -- ${title.text}`,
        "",
        body.text,
        "",
        `A structured acceptance-criteria document describing what "done" means for this attempt is at ${acceptanceCriteriaPath} -- read it and ensure your change satisfies every criterion before finishing.`,
        "",
        buildValidationGuidance(stack),
    ].join("\n");
}
/**
 * Full composition: feasibility -> acceptance criteria -> (if authorized) write the file -> detect the
 * target-repo stack (#4786) -> instructions. Returns `ready: false` (with the computed feasibility verdict,
 * for the caller to report) when the verdict is `raise`/`avoid` -- the caller should abandon the attempt
 * rather than proceed with no real acceptance-criteria file on disk.
 *
 * `detectRepoStack` is injectable so tests can assert both the detected and fail-closed undiscovered stack
 * branches without depending on real filesystem probes; omitted falls back to stack-detection.js's real
 * `detectRepoStack` (the production default).
 */
export function buildCodingTaskSpec(input) {
    const feasibility = buildCodingTaskFeasibility(input.repoFullName, input.issue, input.context, input.claimLedger);
    const acceptanceCriteria = buildCodingTaskAcceptanceCriteria(input.issue, feasibility);
    const writeResult = writeAcceptanceCriteriaFile(input.workingDirectory, acceptanceCriteria);
    if (!writeResult.written) {
        return { ready: false, verdict: feasibility.verdict, feasibility };
    }
    // Real target-repo stack (#4786): detected from the prepared worktree's own manifests, not guessed from
    // loopover conventions. Fail-closed `{ detected: false }` results still reach the prompt (via
    // renderStackSummary) so the agent is told detection failed rather than silently defaulting to npm/Codecov.
    const detect = input.detectRepoStack ?? detectRepoStack;
    const stack = detect(input.workingDirectory);
    return {
        ready: true,
        verdict: feasibility.verdict,
        feasibility,
        acceptanceCriteriaPath: writeResult.path,
        instructions: buildInstructions(input.issue, writeResult.path, stack),
        title: input.issue.title,
        body: input.issue.body ?? undefined,
        labels: input.issue.labels,
        linkedIssues: [input.issue.number],
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29kaW5nLXRhc2stc3BlYy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvZGluZy10YXNrLXNwZWMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLElBQUksV0FBVyxFQUFFLFFBQVEsRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3JHLE9BQU8sRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUN2RCxPQUFPLEVBQ0wsNEJBQTRCLEVBTTVCLHVCQUF1QixFQUN2QixvQkFBb0IsRUFDcEIsdUJBQXVCLEVBQ3ZCLGlCQUFpQixFQUNqQixpQ0FBaUMsRUFDakMsMkJBQTJCLEVBQzNCLDZCQUE2QixHQUM5QixNQUFNLGtCQUFrQixDQUFDO0FBQzFCLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLCtCQUErQixDQUFDO0FBQzFFLE9BQU8sRUFBd0IsZUFBZSxFQUFFLGtCQUFrQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUErRGpHLFNBQVMsY0FBYyxDQUFDLEtBQXNCO0lBQzVDLE1BQU0sS0FBSyxHQUFHLHlCQUF5QixDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDMUQsTUFBTSxJQUFJLEdBQUcseUJBQXlCLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQ3ZFLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLEtBQUssT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQzlDLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLEtBQXNCO0lBQzlDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxD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