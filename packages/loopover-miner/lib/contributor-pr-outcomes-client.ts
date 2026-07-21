/** Read-only client for the hosted `GET /v1/contributors/:login/pr-outcomes` endpoint (#7658) -- the first
 * AMS-side consumer of src/signals/contributor-pr-outcomes.ts. Unlike discovery-index-client.js's fail-OPEN
 * opportunistic supplement, this FAILS LOUD (like tenant-client.js): a contributor runs `loopover-miner
 * pr-outcomes` deliberately to see their own post-merge history, so a missing session, an unreachable host, a
 * non-2xx status, or a malformed body must surface as a clear error rather than a silent empty result. Auth and
 * base URL come from the same authenticated loopover-mcp session resolveGitHubToken already uses
 * (resolveLoopoverBackendSession -> Bearer session token + apiUrl); no new env surface is invented here. A GET is
 * idempotent, so the request is wrapped in http-retry.js's bounded transient-5xx/rate-limit retry -- matching
 * contribution-profile.js's getJson posture, not tenant-client.js's no-retry (its POSTs are non-idempotent). */
import { fetchWithRetry } from "./http-retry.js";
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";

/** One post-merge outcome row, mirroring the endpoint's `ContributorPrOutcome` (public-safe attribution only;
 *  no reward/wallet fields). Re-declared here because src/signals is the Worker app, not an importable package. */
export type ContributorPrOutcome = {
  repoFullName: string;
  pullNumber: number | null;
  outcome: "merged";
  attribution: string;
  deeplink: string;
  recordedAt: string;
};

/** The endpoint's `ContributorPrOutcomes` payload shape. */
export type ContributorPrOutcomes = {
  login: string;
  count: number;
  summary: string;
  outcomes: ContributorPrOutcome[];
};

export type ContributorPrOutcomesClientOptions = {
  env?: NodeJS.ProcessEnv;
  /** Always called as `fetchImpl(url, init)` with a plain string URL -- narrower than `typeof fetch` on
   *  purpose, since that's the only shape this module ever actually calls it with. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Forwarded as the endpoint's `?limit=` (an integer 1..100 per the route); omitted when undefined. */
  limit?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fetch a contributor's hosted post-merge PR outcomes. Throws a clear Error on any failure: no logged-in session
 * (run `loopover-mcp login`), unreachable host, non-2xx status, or a non-JSON/non-object body.
 */
export async function fetchContributorPrOutcomes(
  login: string,
  options: ContributorPrOutcomesClientOptions = {},
): Promise<ContributorPrOutcomes> {
  const env = options.env ?? process.env;
  const session = resolveLoopoverBackendSession(env);
  if (!session) {
    throw new Error("not logged in: run `loopover-mcp login` (or set LOOPOVER_API_URL and a session token) to query hosted PR outcomes");
  }

  const query = options.limit === undefined ? "" : `?limit=${options.limit}`;
  const url = `${session.apiUrl}/v1/contributors/${encodeURIComponent(login)}/pr-outcomes${query}`;

  // fetchWithRetry's signature is deliberately untyped-permissive (`(url: unknown, init?: unknown) =>
  // Promise<Response>`) so it can wrap any fetch-shaped function; the narrower, more useful public
  // ContributorPrOutcomesClientOptions#fetchImpl type is cast at this one boundary rather than widened repo-wide.
  const fetchImpl = (options.fetchImpl ?? fetch) as (url: unknown, init?: unknown) => Promise<Response>;
  const response = await fetchWithRetry(
    fetchImpl,
    url,
    { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${session.sessionToken}` } },
    { timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
  );
  if (!response.ok) {
    throw new Error(`hosted pr-outcomes request failed: http_${response.status}`);
  }
  const payload = (await response.json().catch(() => null)) as ContributorPrOutcomes | null;
  if (payload === null || typeof payload !== "object") {
    throw new Error("hosted pr-outcomes returned a malformed response");
  }
  return payload;
}
