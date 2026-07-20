// The autonomous supervising loop (#5135, Wave 3.5): the missing daemon/watch layer over the one-shot
// `discover`/`attempt` subcommands. Every existing piece it composes -- runDiscover, runAttempt,
// evaluateRunLoopBoundaryGate, attemptLoopReentry, buildLoopClosureSummary, governor-state.js -- already
// existed; this is the first caller that actually chains them into a real repeat-until-halted run.
//
// STRUCTURE (one cycle): kill-switch check -> pause-flag check (#4851, governor-state.js's persisted
// paused/reason/pausedAt) -> real-per-repo-policy-aware run-loop boundary gate (before claiming) -> real
// runAttempt -> real CI-status poll (ci-poller.js, #5394) + real PR-disposition poll
// (pr-disposition-poller.js, on a submitted outcome) -> real loop-closure summary -> real attemptLoopReentry
// decision. `attemptLoopReentry`'s own dequeue is the
// AUTHORITATIVE claim for every cycle after the first (its own doc: "if allowed -- dequeues the next
// candidate") -- this loop does not ALSO call portfolioQueue.dequeueNext() on a successful reentry, which
// would silently double-claim (the reentry's own claim would then leak as a permanently 'in_progress', never-
// attempted row). A manual dequeueNext() is used only to prime the very first cycle (no prior outcome exists
// yet to reenter from) and to refill after an empty queue.
//
// REAL, NOT FABRICATED: this loop is the first production caller of governor-state.js's `saveCapUsage`
// (turnsTaken from runMinerAttempt's own real `loopResult.totalTurnsUsed`, elapsedMs from real wall-clock
// measurement). Its per-identifier convergence history (attempts/consecutiveFailures/reenqueues) is the real,
// SQLite-persisted portfolio-queue attempt-history (portfolio-queue.js's getAttemptHistory, #5654) that the
// dequeueNext claim + markDone/markFailed calls below already maintain -- the same source a one-shot `attempt`
// invocation reads (#5654), so both share one source of truth and the counters survive a loop-daemon restart
// (crash/deploy/systemd bounce) instead of resetting with the process (#5677).
import { checkMinerKillSwitch } from "./governor-kill-switch.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { evaluateRunLoopBoundaryGate } from "./governor-run-halt.js";
import { openGovernorState } from "./governor-state.js";
import { initGovernorLedger } from "./governor-ledger.js";
import { initEventLedger } from "./event-ledger.js";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initRunStateStore } from "./run-state.js";
import { runDiscover } from "./discover-cli.js";
import { runAttempt } from "./attempt-cli.js";
import { resolveAmsPolicy } from "./ams-policy.js";
import { pollPrDisposition, classifyPrDisposition } from "./pr-disposition-poller.js";
import { pollCheckRuns } from "./ci-poller.js";
import { recordPrOutcomeSnapshot } from "./pr-outcome.js";
import { isRejectedPr } from "./rejection-state-machine.js";
import { buildLoopClosureSummary } from "./loop-closure.js";
import { attemptLoopReentry } from "./loop-reentry.js";
import { parsePrNumberFromExecResult } from "./pr-number-parse.js";
import { resolveGitHubToken } from "./github-token-resolution.js";
import { DEFAULT_AMS_POLICY_SPEC } from "@loopover/engine";
const LOOP_USAGE = "Usage: loopover-miner loop <owner/repo> [<owner/repo>...] | --search <query> --miner-login <login> [--base <branch>] [--live] [--dry-run] [--max-cycles <n>] [--cycle-delay-ms <ms>] [--json]";
const DEFAULT_CYCLE_DELAY_MS = 60_000;
const ISSUE_IDENTIFIER_PATTERN = /^issue:(\d+)$/;
function parseRepoTarget(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return `${owner}/${repo}`;
}
function normalizeOptionalPositiveInt(value, label) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue < 0) {
        throw new Error(`${label} must be a non-negative integer: ${value}`);
    }
    return parsedValue;
}
export function parseLoopArgs(args) {
    const options = {
        json: false,
        minerLogin: null,
        base: "main",
        live: false,
        dryRun: false,
        search: null,
        maxCycles: undefined,
        cycleDelayMs: DEFAULT_CYCLE_DELAY_MS,
    };
    const targets = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--live") {
            options.live = true;
            continue;
        }
        // #4847: see attempt-cli.js's own --dry-run comment -- distinct from --live's absence, this short-circuits
        // BEFORE governor state or any other store is opened, guaranteeing zero discovery/queue/ledger writes.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--search") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.search = value;
            index += 1;
            continue;
        }
        if (token === "--miner-login") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.minerLogin = value;
            index += 1;
            continue;
        }
        if (token === "--base") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            options.base = value;
            index += 1;
            continue;
        }
        if (token === "--max-cycles") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            try {
                options.maxCycles = normalizeOptionalPositiveInt(value, "--max-cycles");
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
            index += 1;
            continue;
        }
        if (token === "--cycle-delay-ms") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: LOOP_USAGE };
            try {
                options.cycleDelayMs = normalizeOptionalPositiveInt(value, "--cycle-delay-ms");
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        const target = parseRepoTarget(token);
        if (!target)
            return { error: `Repository must be in owner/repo form: ${token}` };
        targets.push(target);
    }
    if (options.search === null && targets.length === 0)
        return { error: LOOP_USAGE };
    if (options.search !== null && targets.length > 0)
        return { error: "Pass either repository targets or --search, not both." };
    if (!options.minerLogin)
        return { error: `--miner-login is required. ${LOOP_USAGE}` };
    return {
        targets,
        search: options.search,
        minerLogin: options.minerLogin,
        base: options.base,
        live: options.live,
        dryRun: options.dryRun,
        maxCycles: options.maxCycles,
        cycleDelayMs: options.cycleDelayMs,
        json: options.json,
    };
}
function discoverArgv(parsed) {
    return parsed.search !== null ? ["--search", parsed.search] : [...parsed.targets];
}
function parseIssueNumberFromIdentifier(identifier) {
    const match = typeof identifier === "string" ? identifier.match(ISSUE_IDENTIFIER_PATTERN) : null;
    return match ? Number(match[1]) : null;
}
/**
 * Run one full discover -> claim -> attempt -> observe -> reenter cycle repeatedly until a kill-switch trips,
 * the run-loop boundary gate halts (non-convergence or a real budget/turn/elapsed cap), re-entry is declined,
 * or `--max-cycles` is reached. Fails closed: refuses to start at all if governor state cannot be loaded.
 *
 * @param {string[]} args
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   nowMs?: number,
 *   githubToken?: string,
 *   apiBaseUrl?: string,
 *   sleepFn?: (delayMs: number) => Promise<void>,
 *   openGovernorState?: typeof openGovernorState,
 *   initEventLedger?: typeof initEventLedger,
 *   initGovernorLedger?: typeof initGovernorLedger,
 *   initPortfolioQueue?: () => import("./portfolio-queue.js").PortfolioQueueStore,
 *   initRunStateStore?: typeof initRunStateStore,
 *   runDiscover?: typeof runDiscover,
 *   runAttempt?: typeof runAttempt,
 *   resolveAmsPolicy?: typeof resolveAmsPolicy,
 *   checkMinerKillSwitch?: typeof checkMinerKillSwitch,
 *   evaluateRunLoopBoundaryGate?: typeof evaluateRunLoopBoundaryGate,
 *   pollPrDisposition?: typeof pollPrDisposition,
 *   pollCheckRuns?: typeof pollCheckRuns,
 *   recordPrOutcomeSnapshot?: typeof recordPrOutcomeSnapshot,
 *   buildLoopClosureSummary?: typeof buildLoopClosureSummary,
 *   attemptLoopReentry?: typeof attemptLoopReentry,
 *   attemptOptions?: Record<string, unknown>,
 *   prDispositionOptions?: Record<string, unknown>,
 *   ciPollOptions?: Record<string, unknown>,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runLoop(args, options = {}) {
    const parsed = parseLoopArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    const env = options.env ?? process.env;
    const sleepFn = options.sleepFn ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    const nowMsFn = () => options.nowMs ?? Date.now();
    const sessionStartMs = nowMsFn();
    // #4847: reports what a real loop invocation would target and returns BEFORE governor state or any other
    // store (event/governor ledger, portfolio queue, run state) is opened -- a provable zero-write path, not just
    // "opened but didn't write." The loop's own discovery call enqueues newly-found candidates into the LOCAL
    // portfolio queue even before any attempt happens, so a faithful dry run cannot call it either.
    if (parsed.dryRun) {
        const dryRunResult = {
            outcome: "dry_run",
            targets: parsed.targets,
            search: parsed.search,
            minerLogin: parsed.minerLogin,
            base: parsed.base,
            live: parsed.live,
            maxCycles: parsed.maxCycles ?? null,
        };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult, null, 2));
        }
        else {
            const target = parsed.search !== null ? `--search ${parsed.search}` : parsed.targets.join(", ");
            console.log(`DRY RUN: would run an autonomous loop against ${target} for ${parsed.minerLogin} (base: ${parsed.base}, live: ${parsed.live}). No discovery, queue, or ledger writes were made.`);
        }
        return 0;
    }
    let governorState;
    try {
        governorState = (options.openGovernorState ?? openGovernorState)();
    }
    catch (error) {
        return reportCliFailure(parsed.json, `Loop refuses to start: governor state cannot be loaded: ${describeCliError(error)}`, 3);
    }
    const eventLedger = (options.initEventLedger ?? initEventLedger)();
    const governorLedger = (options.initGovernorLedger ?? initGovernorLedger)();
    const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
    const runState = (options.initRunStateStore ?? initRunStateStore)();
    const runDiscoverFn = (options.runDiscover ?? runDiscover);
    const runAttemptFn = (options.runAttempt ?? runAttempt);
    const resolveAmsPolicyFn = (options.resolveAmsPolicy ?? resolveAmsPolicy);
    const checkKillSwitchFn = (options.checkMinerKillSwitch ?? checkMinerKillSwitch);
    const evaluateBoundaryGateFn = (options.evaluateRunLoopBoundaryGate ?? evaluateRunLoopBoundaryGate);
    const pollPrDispositionFn = (options.pollPrDisposition ?? pollPrDisposition);
    const pollCheckRunsFn = (options.pollCheckRuns ?? pollCheckRuns);
    const recordPrOutcomeSnapshotFn = (options.recordPrOutcomeSnapshot ?? recordPrOutcomeSnapshot);
    const buildLoopClosureSummaryFn = (options.buildLoopClosureSummary ?? buildLoopClosureSummary);
    const attemptLoopReentryFn = (options.attemptLoopReentry ?? attemptLoopReentry);
    // Resolved ONCE, at the CLI-entrypoint layer, mirroring manage-poll.js's own runManagePoll (its
    // recordManagePollSnapshot callee has no env fallback of its own either -- the top-level CLI function is
    // where the GitHub token gets resolved, then threaded down explicitly to every real GitHub caller).
    // pollPrDisposition (unlike runDiscover, which falls back to process.env.GITHUB_TOKEN internally) has NO
    // such fallback -- an unresolved githubToken here would silently poll unauthenticated.
    // resolveGitHubToken (#6116): GITHUB_TOKEN env override wins outright, else a live token from the
    // authenticated `loopover-mcp login` session -- cached in memory for this process's lifetime.
    const githubToken = options.githubToken ?? (await resolveGitHubToken(env)) ?? "";
    async function runDiscoveryOnce() {
        await runDiscoverFn(discoverArgv(parsed), {
            initPortfolioQueue: () => portfolioQueue,
            githubToken,
            apiBaseUrl: options.apiBaseUrl,
            nowMs: nowMsFn(),
        });
    }
    let usage = governorState.loadCapUsage();
    const cycles = [];
    let sinceSeq = eventLedger.readEvents({}).at(-1)?.seq ?? 0;
    let haltReason = null;
    try {
        // Checked BEFORE any work at all -- including the very first discovery call -- so an already-active kill
        // switch OR an already-active pause (#4851) halts the loop without ever touching GitHub or the queue. The
        // pause flag is real, persisted, operator/governor-writable state on governorState (toggled via
        // `loopover-miner governor pause`/`resume`) -- unlike the kill switch, a paused run resumes simply by being
        // re-invoked: every piece of per-cycle state this loop reads (portfolioQueue, runState, governorState's own
        // cap usage) is already durable, so clearing the flag and restarting continues exactly where it left off.
        const initialKillSwitch = checkKillSwitchFn({ env });
        const initialPauseState = governorState.loadPauseState();
        let claimed = null;
        if (initialKillSwitch.active) {
            haltReason = `kill_switch_${initialKillSwitch.scope}`;
            cycles.push({ cycle: 1, outcome: "halted", reason: haltReason });
        }
        else if (initialPauseState.paused) {
            haltReason = "paused";
            cycles.push({ cycle: 1, outcome: "halted", reason: haltReason });
        }
        else {
            await runDiscoveryOnce();
            claimed = portfolioQueue.dequeueNext();
        }
        let cycleIndex = haltReason !== null ? 1 : 0;
        while (haltReason === null && (parsed.maxCycles === undefined || cycleIndex < parsed.maxCycles)) {
            cycleIndex += 1;
            const killSwitch = checkKillSwitchFn({ env });
            if (killSwitch.active) {
                haltReason = `kill_switch_${killSwitch.scope}`;
                // Release the in-flight claim so left state is defined (#5670 / mirrors run-halt's markFailed).
                if (claimed) {
                    portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                }
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    ...(claimed
                        ? { repoFullName: claimed.repoFullName, identifier: claimed.identifier }
                        : {}),
                });
                break;
            }
            const pauseState = governorState.loadPauseState();
            if (pauseState.paused) {
                haltReason = "paused";
                if (claimed) {
                    portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                }
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    ...(claimed
                        ? { repoFullName: claimed.repoFullName, identifier: claimed.identifier }
                        : {}),
                });
                break;
            }
            if (!claimed) {
                cycles.push({ cycle: cycleIndex, outcome: "idle_queue_empty" });
                await sleepFn(parsed.cycleDelayMs);
                await runDiscoveryOnce();
                claimed = portfolioQueue.dequeueNext();
                continue;
            }
            const issueNumber = parseIssueNumberFromIdentifier(claimed.identifier);
            if (issueNumber === null) {
                // Never produced by enqueueRankedDiscovery in practice (always "issue:N") -- fail soft rather than
                // crash the whole run: this exact item can never be attempted, so it will never resolve on retry.
                portfolioQueue.markDone(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
                cycles.push({ cycle: cycleIndex, outcome: "skipped_malformed_identifier", identifier: claimed.identifier });
                claimed = portfolioQueue.dequeueNext();
                continue;
            }
            const amsPolicy = await resolveAmsPolicyFn(claimed.repoFullName, { env });
            // Real, SQLite-persisted per-item convergence history (#5677): the dequeueNext claim above already recorded
            // this attempt and the markDone/markFailed calls below record the outcome, so reading it back here shares one
            // source of truth with attempt-cli.js (#5654) and survives a loop-daemon restart instead of resetting.
            const convergenceInput = portfolioQueue.getAttemptHistory(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            const boundary = evaluateBoundaryGateFn({
                runHalted: false,
                usage,
                limits: amsPolicy.spec.capLimits ?? DEFAULT_AMS_POLICY_SPEC.capLimits,
                convergence: convergenceInput,
                convergenceThresholds: amsPolicy.spec.convergenceThresholds ?? DEFAULT_AMS_POLICY_SPEC.convergenceThresholds,
                inFlightItem: { repoFullName: claimed.repoFullName, identifier: claimed.identifier },
                // Echoes claimed.apiBaseUrl (#5563), NOT the callback's own repoFullName/identifier alone -- two forge
                // hosts can share an in-flight item with the same repo name+identifier.
                markFailed: (repoFullName, identifier) => portfolioQueue.markFailed(repoFullName, identifier, claimed.apiBaseUrl),
            }, { append: (event) => governorLedger.appendGovernorEvent(event) });
            if (!boundary.canClaimNext) {
                haltReason = `boundary_${boundary.verdict.reason}`;
                cycles.push({ cycle: cycleIndex, outcome: "halted", reason: haltReason, repoFullName: claimed.repoFullName, identifier: claimed.identifier });
                break;
            }
            const cycleStartMs = nowMsFn();
            let lastResult = null;
            const attemptArgv = [
                claimed.repoFullName,
                String(issueNumber),
                "--miner-login",
                parsed.minerLogin,
                "--base",
                parsed.base,
                ...(parsed.live ? ["--live"] : []),
            ];
            await runAttemptFn(attemptArgv, {
                ...(options.attemptOptions ?? {}),
                env,
                onResult: (result) => {
                    lastResult = result;
                },
            });
            const cycleElapsedMs = nowMsFn() - cycleStartMs;
            usage = {
                // Real for the agent-sdk provider (its own SDK result message reports total_cost_usd, wired through
                // runMinerAttempt's real loopResult.totalCostUsd); the CLI-subprocess providers (claude-cli/codex-cli)
                // report no cost signal today, so this contributes 0 for those runs -- an honest absence, not a
                // fabricated number. A capLimits.budget dimension only ever meaningfully trips against agent-sdk spend.
                budgetSpent: usage.budgetSpent + (lastResult?.totalCostUsd ?? 0),
                turnsTaken: usage.turnsTaken + (lastResult?.totalTurnsUsed ?? 0),
                elapsedMs: usage.elapsedMs + cycleElapsedMs,
            };
            governorState.saveCapUsage(usage);
            const attemptOutcome = lastResult?.outcome ?? "attempt_error";
            const submitted = attemptOutcome === "attempt_submitted";
            // A repo-wide AI-usage-policy ban will never resolve on retry -- stop re-queuing it (matches
            // rejection-signal.js's own "this repo bans automated contributions" semantics). Every other blocked/
            // abandoned/stale/governed outcome MAY resolve on a later retry (transient infra, contention, a
            // different iteration budget) and is requeued -- a genuinely stuck item is caught by non-convergence
            // (reenqueues threshold) rather than silently retried forever.
            const permanentBlock = attemptOutcome === "blocked_rejection_signaled";
            // Mid-attempt kill-switch abandon (#5670): stop the outer loop immediately instead of waiting for the
            // next between-cycle probe, and treat the item like any other re-queued abandon via markFailed below.
            const killSwitchAbandon = lastResult?.abandonReason === "kill_switch_engaged";
            if (submitted || permanentBlock) {
                // Both terminal -- a submitted PR is done, and a repo-wide AI-usage-policy ban never resolves on retry --
                // so neither is re-queued. markDone also clears the persisted consecutive-failure streak.
                portfolioQueue.markDone(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            }
            else {
                // Any other blocked/abandoned/stale/governed outcome may resolve on a later retry, so requeue it; markFailed
                // records the re-enqueue + consecutive failure the non-convergence detector reads on the next cycle.
                portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            }
            if (killSwitchAbandon) {
                const liveKill = checkKillSwitchFn({ env });
                haltReason = liveKill.active ? `kill_switch_${liveKill.scope}` : "kill_switch_engaged";
                cycles.push({
                    cycle: cycleIndex,
                    outcome: "halted",
                    reason: haltReason,
                    repoFullName: claimed.repoFullName,
                    identifier: claimed.identifier,
                    attemptOutcome,
                });
                break;
            }
            let reentryOutcome = "other";
            let prNumber = null;
            let prDisposition = null;
            let ciConclusion = null;
            if (submitted) {
                prNumber = parsePrNumberFromExecResult(lastResult?.execResult, claimed.repoFullName);
                if (prNumber !== null) {
                    // Real CI-status observation (#5394): recorded BEFORE the disposition poll below, so a submitted
                    // PR's check-run state is captured even while it's still open, not just at its eventual merge/close.
                    // ci-poller.js's real GitHub check-run polling is a heuristic proxy for the gate verdict; the
                    // authoritative terminal merge/close outcome comes from pollPrDispositionFn below, sourced directly
                    // from GitHub's own PR state rather than a server-internal endpoint (#5450).
                    const ciStatus = await pollCheckRunsFn(claimed.repoFullName, prNumber, {
                        githubToken,
                        apiBaseUrl: options.apiBaseUrl,
                        ...(options.ciPollOptions ?? {}),
                    });
                    ciConclusion = ciStatus.conclusion;
                    eventLedger.appendEvent({
                        type: "ci_status_observed",
                        repoFullName: claimed.repoFullName,
                        payload: { prNumber, conclusion: ciStatus.conclusion, checkCount: ciStatus.checks.length, source: "ci-poller" },
                    });
                    prDisposition = await pollPrDispositionFn(claimed.repoFullName, prNumber, {
                        githubToken,
                        apiBaseUrl: options.apiBaseUrl,
                        ...(options.prDispositionOptions ?? {}),
                    });
                    if (prDisposition.state === "closed") {
                        recordPrOutcomeSnapshotFn({
                            repoFullName: claimed.repoFullName,
                            prNumber,
                            decision: prDisposition.merged ? "merged" : "closed",
                            closedAt: prDisposition.closedAt,
                        }, { eventLedger });
                        // Real per-repo reputation history (#5675): a resolved terminal outcome updates the decided/unfavorable
                        // counts the Governor's self-reputation throttle reads on this repo's next attempt. `decided` always;
                        // `unfavorable` only on a closed-without-merge (rejection-state-machine.js's isRejectedPr, matching
                        // #5655's own-rejection classification). Forge-scoped by claimed.apiBaseUrl (#5563), like every other
                        // governor-state write here.
                        const priorReputation = governorState.loadReputationHistory(claimed.repoFullName, claimed.apiBaseUrl);
                        governorState.saveReputationHistory(claimed.repoFullName, {
                            decided: priorReputation.decided + 1,
                            unfavorable: priorReputation.unfavorable + (isRejectedPr(prDisposition) ? 1 : 0),
                        }, claimed.apiBaseUrl);
                        reentryOutcome = classifyPrDisposition(prDisposition);
                    }
                }
            }
            const loopSummary = buildLoopClosureSummaryFn({ eventLedger, portfolioQueue, runState }, { sinceSeq, repoFullName: claimed.repoFullName });
            sinceSeq = loopSummary.lastSeq;
            const reentry = attemptLoopReentryFn({ killSwitchScope: killSwitch.scope, repoFullName: claimed.repoFullName, outcome: reentryOutcome }, { eventLedger, portfolioQueue, runState, nowMs: nowMsFn(), sessionStartMs, loopSummary });
            cycles.push({
                cycle: cycleIndex,
                outcome: "attempted",
                repoFullName: claimed.repoFullName,
                identifier: claimed.identifier,
                attemptOutcome,
                reentryOutcome,
                prNumber,
                ciConclusion,
                reentered: reentry.decision.reenter,
                reasons: reentry.decision.reasons,
            });
            if (!reentry.decision.reenter) {
                haltReason = `reentry_declined:${reentry.decision.reasons.join(",")}`;
                break;
            }
            if (reentry.dequeued) {
                claimed = reentry.dequeued;
                await sleepFn(parsed.cycleDelayMs);
            }
            else {
                await sleepFn(parsed.cycleDelayMs);
                await runDiscoveryOnce();
                claimed = portfolioQueue.dequeueNext();
            }
        }
        if (haltReason === null && parsed.maxCycles !== undefined) {
            haltReason = "max_cycles_reached";
            // The next cycle's item is primed (dequeued → 'in_progress') BEFORE the while-condition re-checks
            // maxCycles -- both at the initial priming above and at each cycle's tail -- so exhausting maxCycles
            // ends the run holding a claim no cycle ever processed. Release it, mirroring the kill-switch/pause
            // halts (#5670): dequeueNext() only pulls 'queued' rows, so an unreleased claim is invisible to every
            // future loop/attempt run until an out-of-band stale-lease sweep reclaims it.
            if (claimed) {
                portfolioQueue.markFailed(claimed.repoFullName, claimed.identifier, claimed.apiBaseUrl);
            }
        }
        const summary = { haltReason, cyclesRun: cycles.length, cycles };
        if (parsed.json) {
            console.log(JSON.stringify(summary, null, 2));
        }
        else {
            console.log(`Loop finished after ${cycles.length} cycle(s): ${haltReason ?? "unknown"}.`);
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
    finally {
        governorState.close();
        eventLedger.close();
        governorLedger.close();
        portfolioQueue.close();
        runState.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcC1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsb29wLWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxzR0FBc0c7QUFDdEcsaUdBQWlHO0FBQ2pHLHlHQUF5RztBQUN6RyxtR0FBbUc7QUFDbkcsRUFBRTtBQUNGLHFHQUFxRztBQUNyRyx5R0FBeUc7QUFDekcscUZBQXFGO0FBQ3JGLDZHQUE2RztBQUM3RyxzREFBc0Q7QUFDdEQscUdBQXFHO0FBQ3JHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNkdBQTZHO0FBQzdHLDJEQUEyRDtBQUMzRCxFQUFFO0FBQ0YsdUdBQXVHO0FBQ3ZHLDBHQUEwRztBQUMxRyw4R0FBOEc7QUFDOUcsNEdBQTRHO0FBQzVHLCtHQUErRztBQUMvRyw2R0FBNkc7QUFDN0csK0VBQStFO0FBRS9FLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQ2pFLE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUNyRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUN4RCxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUMxRCxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDcEQsT0FBTyxFQUFFLHVCQUF1QixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDL0QsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbkQsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQ2hELE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUM5QyxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxpQkFBaUIsQ0FB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