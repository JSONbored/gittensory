// Browser Sentry (issue #1737): the operator UI's own client-side error tracking -- a separate integration
// from the self-host backend's Node Sentry (src/selfhost/sentry.ts) and the review-enrichment service's
// (review-enrichment/src/sentry.ts). Three independent deploy surfaces, three independent DSN-gated
// integrations. Opt-in: a complete no-op when VITE_SENTRY_DSN is unset -- no SDK init, no event traffic.
// `@sentry/react` is dynamically imported inside the DSN gate so a DSN-less build never fetches its chunk at
// all (Vite code-splits a dynamic import into its own lazily-loaded chunk), the browser-bundle equivalent of
// sentry.ts's "never enters a bundle that doesn't need it." NO Session Replay in this pass: only `init`'s
// default error-capture integrations are used -- `replayIntegration`/`@sentry/replay` are never imported or
// referenced anywhere in this module.
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../../../../src/signals/redaction";
import type { Event as SentryEvent } from "@sentry/react";

type SentryReactNs = typeof import("@sentry/react");

let Sentry: SentryReactNs | undefined;
let active = false;

const SECRET_KEY =
  /(token|secret|key|password|passwd|authorization|auth|dsn|cookie|bearer|credential|private|session)/i;
const SECRET_VALUE = new RegExp(
  [
    String.raw`gh[opsru]_[A-Za-z0-9_]{20,}`,
    String.raw`sk-[A-Za-z0-9_-]{20,}`,
    String.raw`(?:gts|orbenr|orbsec)_[A-Za-z0-9_]{20,}`,
    String.raw`Bearer\s+[A-Za-z0-9._~+/=-]{12,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`,
  ].join("|"),
  "gi",
);
const REDACTED = "[redacted]";
const MAX_SCRUB_DEPTH = 6;

function scrubString(value: string): string {
  return value
    .replace(SECRET_VALUE, REDACTED)
    .replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "[local-path]");
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_SCRUB_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : scrubValue(nested, depth + 1),
    ]),
  );
}

/** Strip everything the issue explicitly calls out (headers, cookies, auth/session, request bodies), then
 *  recursively redact secret-shaped keys/values everywhere else, and unconditionally drop `user` -- no PII
 *  ever leaves the browser. Returns `null` (drops the whole event) on any scrubbing failure, matching
 *  sentry.ts's fail-closed discipline: better to lose one event than risk shipping unscrubbed data. */
export function scrubBrowserEvent<T extends SentryEvent>(event: T): T | null {
  try {
    const safe = { ...event } as Record<string, unknown>;
    delete safe.user;
    if (safe.request && typeof safe.request === "object") {
      const request = { ...(safe.request as Record<string, unknown>) };
      delete request.cookies;
      delete request.headers;
      delete request.data;
      safe.request = request;
    }
    for (const key of ["contexts", "extra", "tags"] as const) {
      if (safe[key]) safe[key] = scrubValue(safe[key], 0);
    }
    if (Array.isArray(safe.breadcrumbs)) {
      safe.breadcrumbs = safe.breadcrumbs.map((crumb) => scrubValue(crumb, 0));
    }
    if (safe.message && typeof safe.message === "string") safe.message = scrubString(safe.message);
    if (safe.exception && typeof safe.exception === "object")
      safe.exception = scrubValue(safe.exception, 0);
    return safe as T;
  } catch {
    return null;
  }
}

/** Low-cardinality tag allowlist (#1737's "safe tags... avoid high-cardinality or sensitive tags"): route
 *  (pathname only, never query/fragment), release, environment, and a fixed app-surface identifier. Mutates
 *  `event.tags` directly (an event-processor's job), not scope -- Sentry already applies `release`/
 *  `environment` from `init()`'s own options, but setting them as explicit tags too keeps them queryable
 *  alongside the others without relying on Sentry's separate release/environment filter UI. */
function applyBrowserTags<T extends SentryEvent>(
  event: T,
  release: string | undefined,
  environment: string,
): T {
  const tags: Record<string, string> = { ...event.tags, app_surface: "operator_ui", environment };
  if (release) tags.release = release;
  if (typeof window !== "undefined") tags.route = window.location.pathname;
  return { ...event, tags };
}

/** True when VITE_SENTRY_DSN is configured -- the same gate {@link initBrowserSentry} uses, exposed so
 *  callers (e.g. a settings/about page) can show whether browser error tracking is active without importing
 *  the SDK. */
export function isBrowserSentryConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SENTRY_DSN?.trim());
}

/** Initialize browser Sentry. No-op (never imports `@sentry/react`) when VITE_SENTRY_DSN is unset. Call once,
 *  before hydration, from the client entry point. */
export function initBrowserSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return;
  const release = import.meta.env.VITE_SENTRY_RELEASE?.trim() || undefined;
  const environment =
    import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() ||
    (import.meta.env.PROD ? "production" : "development");
  void import("@sentry/react").then((mod) => {
    Sentry = mod;
    Sentry.init({
      dsn,
      release,
      environment,
      // Session Replay is explicitly out of scope for this pass (#1737) -- default integrations only, no
      // replayIntegration, no performance tracing (tracesSampleRate omitted -- this is error tracking only).
      // Inline (not a shared named function) so each hook's event parameter infers its own type
      // (ErrorEvent vs. the internal TransactionEvent) from Sentry.init's own call signature.
      beforeSend: (event) => {
        const scrubbed = scrubBrowserEvent(event);
        return scrubbed ? applyBrowserTags(scrubbed, release, environment) : null;
      },
      beforeSendTransaction: (event) => {
        const scrubbed = scrubBrowserEvent(event);
        return scrubbed ? applyBrowserTags(scrubbed, release, environment) : null;
      },
    });
    active = true;
  });
}

/** Capture a route/render error. No-op when Sentry is off or not yet initialized (the dynamic import in
 *  {@link initBrowserSentry} may still be in flight for the very first paint's error, which is an acceptable
 *  gap -- see this file's tests). `boundary` becomes a low-cardinality tag identifying which error boundary
 *  caught it, mirroring sentry.ts's `eventName`-as-fingerprint discipline for grouping. */
export function captureBrowserError(error: unknown, context: { boundary: string }): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    scope.setTag("boundary", context.boundary);
    Sentry!.captureException(error);
  });
}

/** Reset module-level init state between tests -- `active`/`Sentry` otherwise persist across every test in a
 *  file, since {@link initBrowserSentry} is designed to run exactly once per real page load. */
export function resetBrowserSentryForTest(): void {
  Sentry = undefined;
  active = false;
}
