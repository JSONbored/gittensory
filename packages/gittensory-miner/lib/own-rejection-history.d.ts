/** Minimal fetch shape this resolver actually uses (a GET returning a JSON PR payload). `typeof fetch` is
 *  assignable to it, so a real `fetch` or a test stub both satisfy it. */
export type PrStatusFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

export interface OwnRejectionHistoryOptions {
  fetchImpl?: PrStatusFetch;
  githubToken?: string;
  apiBaseUrl?: string;
  maxFetches?: number;
  listSubmissions?: (filter: { repoFullName: string }) => Array<{ pullRequestNumber?: number | undefined } | null>;
}

/**
 * Resolve whether any of this miner's own recent prior submissions on `repoFullName` was closed without merge
 * (the second `rejectionSignaled` trigger). Bounded fetch count; fails open to `false` on any list/fetch error.
 */
export function resolveOwnRejectionHistory(
  repoFullName: string,
  options?: OwnRejectionHistoryOptions,
): Promise<boolean>;
