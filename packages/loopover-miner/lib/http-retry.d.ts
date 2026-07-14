export function defaultRetryBackoffMs(attempt: number): number;

export function fetchWithRetry<Response extends { status: number }>(
  fetchFn: (url: unknown, init?: unknown) => Promise<Response>,
  url: unknown,
  init?: unknown,
  options?: {
    maxAttempts?: number;
    sleepFn?: (ms: number) => Promise<unknown>;
    backoffMs?: (attempt: number) => number;
  },
): Promise<Response>;
