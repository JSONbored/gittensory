// The governor pause/resume control surface (#4851): a real, persisted pause flag an operator (or, in a future
// wave, the governor itself) can toggle via this CLI, that loop-cli.js's iteration loop actually checks before
// each cycle. Distinct from governor-kill-switch.js (a read-only resolver over pre-existing env/YAML inputs this
// package never itself writes) and governor-run-halt.js (a one-way, run-scoped terminal breaker with no resume
// path) -- this is the first genuinely operator/governor-writable stop/go control. Persisted on governor-state.js's
// existing single-row scalar-state table, not a new store: a pause flag has no relational key of its own, the
// same reasoning that table's other scalar fields (rate-limit buckets, cap usage) already rely on.
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { openGovernorState } from "./governor-state.js";
import { buildAmsGovernorPausedPayload, publishAmsNotificationEvents, } from "./ams-notifications.js";
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";
const GOVERNOR_PAUSE_USAGE = "Usage: loopover-miner governor pause [--reason <text>] [--dry-run] [--json]";
const GOVERNOR_RESUME_USAGE = "Usage: loopover-miner governor resume [--dry-run] [--json]";
const GOVERNOR_STATUS_USAGE = "Usage: loopover-miner governor status [--json]";
export function parseGovernorPauseArgs(args) {
    const options = {
        json: false,
        dryRun: false,
        reason: null,
    };
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: reports what pausing would do and returns before writing to governor-state.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--reason") {
            const value = args[index + 1];
            if (!value || value.startsWith("-"))
                return { error: GOVERNOR_PAUSE_USAGE };
            options.reason = value;
            index += 1;
            continue;
        }
        return { error: `Unknown option: ${token}` };
    }
    return options;
}
export function parseGovernorResumeArgs(args) {
    const options = { json: false, dryRun: false };
    for (const token of args) {
        if (token === "--json") {
            options.json = true;
            continue;
        }
        // #4847: reports what resuming would do and returns before writing to governor-state.
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        return { error: GOVERNOR_RESUME_USAGE };
    }
    return options;
}
function parseNoArgsSubcommand(args, usage) {
    if (args.length === 0)
        return { json: false };
    if (args.length === 1 && args[0] === "--json")
        return { json: true };
    return { error: usage };
}
async function withGovernorState(options, run) {
    const ownsGovernorState = options.openGovernorState === undefined;
    const governorState = (options.openGovernorState ?? openGovernorState)();
    try {
        return await run(governorState);
    }
    finally {
        if (ownsGovernorState)
            governorState.close();
    }
}
function renderPauseState(pauseState) {
    if (!pauseState.paused)
        return "governor is not paused";
    const reason = pauseState.reason ? ` (${pauseState.reason})` : "";
    return `governor is PAUSED since ${pauseState.pausedAt}${reason}`;
}
async function resolveSessionLogin(env) {
    const session = resolveLoopoverBackendSession(env);
    if (!session)
        return null;
    try {
        const response = await fetch(`${session.apiUrl}/v1/auth/session`, {
            headers: { authorization: `Bearer ${session.sessionToken}`, accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            return null;
        const payload = (await response.json().catch(() => null));
        return typeof payload?.login === "string" && payload.login.trim() ? payload.login.trim() : null;
    }
    catch {
        return null;
    }
}
async function notifyGovernorPaused(pauseState, options) {
    const env = options.env ?? process.env;
    // Injected fetchSessionLogin (tests) may resolve a login without a disk session; only require a real
    // session when falling back to GET /v1/auth/session.
    const processEnv = env;
    const login = options.fetchSessionLogin
        ? await options.fetchSessionLogin(resolveLoopoverBackendSession(processEnv) ?? { apiUrl: "https://api.loopover.ai", sessionToken: "" })
        : await resolveSessionLogin(processEnv);
    if (!login)
        return;
    const publish = options.publishAmsNotifications ?? publishAmsNotificationEvents;
    const publishOptions = { env };
    await publish([
        buildAmsGovernorPausedPayload({
            recipientLogin: login,
            reason: pauseState.reason,
            ...(pauseState.pausedAt ? { pausedAt: pauseState.pausedAt } : {}),
        }),
    ], publishOptions);
}
export async function runGovernorPause(args, options = {}) {
    const parsed = parseGovernorPauseArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", paused: true, reason: parsed.reason };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult));
        }
        else {
            const reason = parsed.reason ? ` (${parsed.reason})` : "";
            console.log(`DRY RUN: would pause the governor${reason}. No governor-state write was made.`);
        }
        return 0;
    }
    try {
        const pauseState = await withGovernorState(options, (governorState) => governorState.savePauseState({ paused: true, reason: parsed.reason }));
        // AMS badge notify (#7657): best-effort; a notify miss must not fail the pause itself.
        await notifyGovernorPaused(pauseState, options).catch(() => undefined);
        if (parsed.json) {
            console.log(JSON.stringify(pauseState));
        }
        else {
            console.log(renderPauseState(pauseState));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runGovernorResume(args, options = {}) {
    const parsed = parseGovernorResumeArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        const dryRunResult = { outcome: "dry_run", paused: false };
        if (parsed.json) {
            console.log(JSON.stringify(dryRunResult));
        }
        else {
            console.log("DRY RUN: would resume the governor. No governor-state write was made.");
        }
        return 0;
    }
    try {
        return await withGovernorState(options, (governorState) => {
            const pauseState = governorState.savePauseState({ paused: false });
            if (parsed.json) {
                console.log(JSON.stringify(pauseState));
            }
            else {
                console.log(renderPauseState(pauseState));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export async function runGovernorStatus(args, options = {}) {
    const parsed = parseNoArgsSubcommand(args, GOVERNOR_STATUS_USAGE);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return await withGovernorState(options, (governorState) => {
            const pauseState = governorState.loadPauseState();
            if (parsed.json) {
                console.log(JSON.stringify(pauseState));
            }
            else {
                console.log(renderPauseState(pauseState));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItcGF1c2UtY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZ292ZXJub3ItcGF1c2UtY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtHQUErRztBQUMvRywrR0FBK0c7QUFDL0csaUhBQWlIO0FBQ2pILCtHQUErRztBQUMvRyxvSEFBb0g7QUFDcEgsOEdBQThHO0FBQzlHLG1HQUFtRztBQUVuRyxPQUFPLEVBQUUsWUFBWSxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEYsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFFeEQsT0FBTyxFQUNMLDZCQUE2QixFQUM3Qiw0QkFBNEIsR0FFN0IsTUFBTSx3QkFBd0IsQ0FBQztBQUNoQyxPQUFPLEVBQUUsNkJBQTZCLEVBQUUsTUFBTSw4QkFBOEIsQ0FBQztBQUU3RSxNQUFNLG9CQUFvQixHQUFHLDZFQUE2RSxDQUFDO0FBQzNHLE1BQU0scUJBQXFCLEdBQUcsNERBQTRELENBQUM7QUFDM0YsTUFBTSxxQkFBcUIsR0FBRyxnREFBZ0QsQ0FBQztBQWtCL0UsTUFBTSxVQUFVLHNCQUFzQixDQUFDLElBQWM7SUFDbkQsTUFBTSxPQUFPLEdBQThEO1FBQ3pFLElBQUksRUFBRSxLQUFLO1FBQ1gsTUFBTSxFQUFFLEtBQUs7UUFDYixNQUFNLEVBQUUsSUFBSTtLQUNiLENBQUM7SUFFRixLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDcEQsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1lBQ3BCLFNBQVM7UUFDWCxDQUFDO1FBQ0QscUZBQXFGO1FB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