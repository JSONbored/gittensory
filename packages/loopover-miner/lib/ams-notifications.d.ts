export type AmsNotificationEventPayload = {
    eventType: "ams_attempt_started" | "ams_attempt_failed" | "ams_governor_paused" | "ams_pr_outcome";
    recipientLogin: string;
    repoFullName: string;
    pullNumber: number;
    dedupKey: string;
    deeplink: string;
    actorLogin: string;
    detectedAt: string;
};
export type AmsNotificationPublishResult = {
    sent: number;
    error?: string;
};
export type AmsNotificationFetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<Response>;
export type PublishAmsNotificationEventsOptions = {
    env?: Record<string, string | undefined>;
    fetchFn?: AmsNotificationFetch;
    timeoutMs?: number;
    /** Test/self-host inject: mirrors job-dispatch evaluate → notify-deliver without HTTP. */
    dispatch?: (events: AmsNotificationEventPayload[]) => Promise<void>;
};
export declare const DEFAULT_AMS_NOTIFICATION_TIMEOUT_MS = 10000;
export declare function buildAmsAttemptStartedPayload(input: {
    recipientLogin: string;
    repoFullName: string;
    issueNumber: number;
    attemptId: string;
    detectedAt?: string;
}): AmsNotificationEventPayload;
export declare function buildAmsAttemptFailedPayload(input: {
    recipientLogin: string;
    repoFullName: string;
    issueNumber: number;
    attemptId: string;
    reason?: string | null;
    detectedAt?: string;
}): AmsNotificationEventPayload;
export declare function buildAmsGovernorPausedPayload(input: {
    recipientLogin: string;
    reason?: string | null;
    pausedAt?: string;
    detectedAt?: string;
}): AmsNotificationEventPayload;
export declare function buildAmsPrOutcomePayload(input: {
    recipientLogin: string;
    repoFullName: string;
    pullNumber: number;
    decision: "merged" | "closed";
    closedAt?: string | null;
    detectedAt?: string;
}): AmsNotificationEventPayload;
/**
 * Publish AMS notification events through the hosted evaluate → notify-deliver path. Prefer an injected
 * `dispatch` (tests / in-process self-host). Otherwise POST to `/v1/contributors/:login/ams-notifications`
 * when a loopover-mcp session is on disk. Never throws.
 */
export declare function publishAmsNotificationEvents(events: AmsNotificationEventPayload[], options?: PublishAmsNotificationEventsOptions): Promise<AmsNotificationPublishResult>;
/** Fire-and-forget wrapper for sync call sites (never awaits into the caller's critical path). */
export declare function scheduleAmsNotificationEvents(events: AmsNotificationEventPayload[], options?: PublishAmsNotificationEventsOptions): void;
