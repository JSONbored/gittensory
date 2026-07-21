// AMS → hosted badge notifications (#7657). Builds DetectedNotificationEvent-shaped AMS kinds and POSTs them
// to the contributor ams-notifications ingest, which evaluates through evaluateNotificationEvent →
// notify-deliver (same handoff as src/queue/job-dispatch.ts). Fail-soft: a missing session or network blip
// never breaks the miner's real work. No parallel local notification store.
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";
export const DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS = 10_000;
function normalizeLogin(login) {
    return login.trim().toLowerCase();
}
function nowIso() {
    return new Date().toISOString();
}
function githubIssueDeeplink(repoFullName, issueNumber) {
    return `https://github.com/${repoFullName}/issues/${issueNumber}`;
}
function githubPullDeeplink(repoFullName, pullNumber) {
    return `https://github.com/${repoFullName}/pull/${pullNumber}`;
}
export function buildAmsAttemptStartedPayload(input) {
    const recipientLogin = normalizeLogin(input.recipientLogin);
    const detectedAt = input.detectedAt ?? nowIso();
    return {
        eventType: "ams_attempt_started",
        recipientLogin,
        repoFullName: input.repoFullName,
        pullNumber: input.issueNumber,
        dedupKey: `ams_attempt_started:${input.repoFullName}#${input.issueNumber}:${input.attemptId}`,
        deeplink: githubIssueDeeplink(input.repoFullName, input.issueNumber),
        actorLogin: recipientLogin,
        detectedAt,
    };
}
export function buildAmsAttemptFailedPayload(input) {
    const recipientLogin = normalizeLogin(input.recipientLogin);
    const detectedAt = input.detectedAt ?? nowIso();
    const reasonKey = input.reason?.trim() ? `:${input.reason.trim().slice(0, 80)}` : "";
    return {
        eventType: "ams_attempt_failed",
        recipientLogin,
        repoFullName: input.repoFullName,
        pullNumber: input.issueNumber,
        dedupKey: `ams_attempt_failed:${input.repoFullName}#${input.issueNumber}:${input.attemptId}${reasonKey}`,
        deeplink: githubIssueDeeplink(input.repoFullName, input.issueNumber),
        actorLogin: recipientLogin,
        detectedAt,
    };
}
export function buildAmsGovernorPausedPayload(input) {
    const recipientLogin = normalizeLogin(input.recipientLogin);
    const detectedAt = input.detectedAt ?? nowIso();
    const pausedAt = input.pausedAt ?? detectedAt;
    const reasonKey = input.reason?.trim() ? `:${input.reason.trim().slice(0, 80)}` : "";
    return {
        eventType: "ams_governor_paused",
        recipientLogin,
        repoFullName: "ams/governor",
        pullNumber: 0,
        dedupKey: `ams_governor_paused:${recipientLogin}:${pausedAt}${reasonKey}`,
        deeplink: "https://github.com/JSONbored/loopover",
        actorLogin: recipientLogin,
        detectedAt,
    };
}
export function buildAmsPrOutcomePayload(input) {
    const recipientLogin = normalizeLogin(input.recipientLogin);
    const detectedAt = input.detectedAt ?? nowIso();
    const closedAt = input.closedAt?.trim() || detectedAt;
    return {
        eventType: "ams_pr_outcome",
        recipientLogin,
        repoFullName: input.repoFullName,
        pullNumber: input.pullNumber,
        dedupKey: `ams_pr_outcome:${input.repoFullName}#${input.pullNumber}:${input.decision}:${closedAt}`,
        deeplink: githubPullDeeplink(input.repoFullName, input.pullNumber),
        actorLogin: recipientLogin,
        detectedAt,
    };
}
/**
 * Publish AMS notification events through the hosted evaluate → notify-deliver path. Prefer an injected
 * `dispatch` (tests / in-process self-host). Otherwise POST to `/v1/contributors/:login/ams-notifications`
 * when a loopover-mcp session is on disk. Never throws.
 */
export async function publishAmsNotificationEvents(events, options = {}) {
    if (!Array.isArray(events) || events.length === 0)
        return { sent: 0 };
    if (options.dispatch) {
        try {
            await options.dispatch(events);
            return { sent: events.length };
        }
        catch (error) {
            return { sent: 0, error: error instanceof Error ? error.message.slice(0, 160) : "dispatch_failed" };
        }
    }
    const env = options.env ?? process.env;
    const session = resolveLoopoverBackendSession(env);
    if (!session)
        return { sent: 0, error: "no_session" };
    const recipientLogin = normalizeLogin(events[0].recipientLogin);
    if (!recipientLogin)
        return { sent: 0, error: "missing_recipient" };
    if (events.some((event) => normalizeLogin(event.recipientLogin) !== recipientLogin)) {
        return { sent: 0, error: "mixed_recipients" };
    }
    const fetchFn = options.fetchFn ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS;
    const url = `${session.apiUrl}/v1/contributors/${encodeURIComponent(recipientLogin)}/ams-notifications`;
    const body = JSON.stringify({
        events: events.map(({ eventType, repoFullName, pullNumber, dedupKey, deeplink, actorLogin, detectedAt }) => ({
            eventType,
            repoFullName,
            pullNumber,
            dedupKey,
            deeplink,
            actorLogin,
            detectedAt,
        })),
    });
    try {
        const response = await fetchFn(url, {
            method: "POST",
            headers: {
                authorization: `Bearer ${session.sessionToken}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            return { sent: 0, error: `http_${response.status}` };
        }
        return { sent: events.length };
    }
    catch (error) {
        return { sent: 0, error: error instanceof Error ? error.message.slice(0, 160) : "network_failed" };
    }
}
/** Fire-and-forget wrapper for sync call sites (never awaits into the caller's critical path). */
export function scheduleAmsNotificationEvents(events, options = {}) {
    void publishAmsNotificationEvents(events, options).catch(() => {
        // publishAmsNotificationEvents is already fail-soft; this only guards a rejected promise from an inject.
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW1zLW5vdGlmaWNhdGlvbnMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhbXMtbm90aWZpY2F0aW9ucy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw2R0FBNkc7QUFDN0csbUdBQW1HO0FBQ25HLDJHQUEyRztBQUMzRyw0RUFBNEU7QUFFNUUsT0FBTyxFQUFFLDZCQUE2QixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUE0QjdFLE1BQU0sQ0FBQyxNQUFNLG1DQUFtQyxHQUFHLE1BQU0sQ0FBQztBQUUxRCxTQUFTLGNBQWMsQ0FBQyxLQUFhO0lBQ25DLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0FBQ3BDLENBQUM7QUFFRCxTQUFTLE1BQU07SUFDYixPQUFPLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7QUFDbEMsQ0FBQztBQUVELFNBQVMsbUJBQW1CLENBQUMsWUFBb0IsRUFBRSxXQUFtQjtJQUNwRSxPQUFPLHNCQUFzQixZQUFZLFdBQVcsV0FBVyxFQUFFLENBQUM7QUFDcEUsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsWUFBb0IsRUFBRSxVQUFrQjtJQUNsRSxPQUFPLHNCQUFzQixZQUFZLFNBQVMsVUFBVSxFQUFFLENBQUM7QUFDakUsQ0FBQztBQUVELE1BQU0sVUFBVSw2QkFBNkIsQ0FBQyxLQU03QztJQUNDLE1BQU0sY0FBYyxHQUFHLGNBQWMsQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDNUQsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLFVBQVUsSUFBSSxNQUFNLEVBQUUsQ0FBQztJQUNoRCxPQUFPO1FBQ0wsU0FBUyxFQUFFLHFCQUFxQjtRQUNoQyxjQUFjO1FBQ2QsWUFBWSxFQUFFLEtBQUssQ0FBQyxZQUFZO1FBQ2hDLFVBQVUsRUFBRSxLQUFLLENBQUMsV0FBVztRQUM3QixRQUFRLEVBQUUsdUJBQXVCLEtBQUssQ0FBQyxZQUFZLElBQUksS0FBSyxD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