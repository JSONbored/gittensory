import type { ErrorEvent, EventHint } from "@sentry/node";

type SentryNs = typeof import("@sentry/node");

let Sentry: SentryNs | undefined;
let active = false;

const SECRET_FIELD = /(?:authorization|cookie|token|secret|password|private[_-]?key|shared[_-]?secret)/i;
const SECRET_VALUE = /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[a-f0-9]{64}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function resolveReesSentryRelease(env: NodeJS.ProcessEnv): string | undefined {
  return (
    nonBlank(env.SENTRY_RELEASE) ??
    (nonBlank(env.RAILWAY_GIT_COMMIT_SHA)
      ? `gittensory-rees@${nonBlank(env.RAILWAY_GIT_COMMIT_SHA)}`
      : undefined)
  );
}

export function resolveSentryEnvironment(env: NodeJS.ProcessEnv): string {
  return nonBlank(env.SENTRY_ENVIRONMENT) ?? nonBlank(env.RAILWAY_ENVIRONMENT_NAME) ?? "production";
}

export function resolveTracesSampleRate(env: NodeJS.ProcessEnv): number {
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0");
  if (!Number.isFinite(rate)) return 0;
  return Math.max(0, Math.min(1, rate));
}

function warn(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "warn", event, ...fields }));
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_FIELD.test(key) ? "[Filtered]" : scrubValue(entry),
      ]),
    );
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[Filtered]");
  return value;
}

function scrubEvent(event: ErrorEvent): ErrorEvent {
  return scrubValue(event) as ErrorEvent;
}

export async function initSentry(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!nonBlank(env.SENTRY_DSN)) return false;
  try {
    Sentry = await import("@sentry/node");
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: resolveSentryEnvironment(env),
      release: resolveReesSentryRelease(env),
      tracesSampleRate: resolveTracesSampleRate(env),
      beforeSend: (event: ErrorEvent, _hint: EventHint) => scrubEvent(event),
    });
    active = true;
    return true;
  } catch (error) {
    active = false;
    Sentry = undefined;
    warn("rees_sentry_init_failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!active || !Sentry) return;
  Sentry.withScope((scope) => {
    if (context) scope.setContext("rees", scrubValue(context) as Record<string, unknown>);
    Sentry!.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!active || !Sentry) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}
