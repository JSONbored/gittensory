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
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Fetch a contributor's hosted post-merge PR outcomes. Throws a clear Error on any failure: no logged-in session
 * (run `loopover-mcp login`), unreachable host, non-2xx status, or a non-JSON/non-object body.
 */
export async function fetchContributorPrOutcomes(login, options = {}) {
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
    const fetchImpl = (options.fetchImpl ?? fetch);
    const response = await fetchWithRetry(fetchImpl, url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${session.sessionToken}` } }, { timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS });
    if (!response.ok) {
        throw new Error(`hosted pr-outcomes request failed: http_${response.status}`);
    }
    const payload = (await response.json().catch(() => null));
    if (payload === null || typeof payload !== "object") {
        throw new Error("hosted pr-outcomes returned a malformed response");
    }
    return payload;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udHJpYnV0b3ItcHItb3V0Y29tZXMtY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY29udHJpYnV0b3ItcHItb3V0Y29tZXMtY2xpZW50LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OztnSEFRZ0g7QUFDaEgsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ2pELE9BQU8sRUFBRSw2QkFBNkIsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBK0I3RSxNQUFNLDBCQUEwQixHQUFHLE1BQU0sQ0FBQztBQUUxQzs7O0dBR0c7QUFDSCxNQUFNLENBQUMsS0FBSyxVQUFVLDBCQUEwQixDQUM5QyxLQUFhLEVBQ2IsVUFBOEMsRUFBRTtJQUVoRCxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUM7SUFDdkMsTUFBTSxPQUFPLEdBQUcsNkJBQTZCLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDbkQsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyxtSEFBbUgsQ0FBQyxDQUFDO0lBQ3ZJLENBQUM7SUFFRCxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxVQUFVLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUMzRSxNQUFNLEdBQUcsR0FBRyxHQUFHLE9BQU8sQ0FBQyxNQUFNLG9CQUFvQixrQkFBa0IsQ0FBQyxLQUFLLENBQUMsZUFBZSxLQUFLLEVBQUUsQ0FBQztJQUVqRyxvR0FBb0c7SUFDcEcsaUdBQWlHO0lBQ2pHLGdIQUFnSDtJQUNoSCxNQUFNLFNBQVMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxTQUFTLElBQUksS0FBSyxDQUF3RCxDQUFDO0lBQ3RHLE1BQU0sUUFBUSxHQUFHLE1BQU0sY0FBYyxDQUNuQyxTQUFTLEVBQ1QsR0FBRyxFQUNILEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxPQUFPLEVBQUUsRUFBRSxNQUFNLEVBQUUsa0JBQWtCLEVBQUUsYUFBYSxFQUFFLFVBQVUsT0FBTyxDQUFDLFlBQVksRUFBRSxFQUFFLEVBQUUsRUFDM0csRUFBRSxTQUFTLEVBQUUsT0FBTyxDQUFDLGdCQUFnQixJQUFJLDBCQUEwQixFQUFFLENBQ3RFLENBQUM7SUFDRixJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQ2pCLE1BQU0sSUFBSSxLQUFLLENBQUMsMkNBQTJDLFFBQVEsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQ2hGLENBQUM7SUFDRCxNQUFNLE9BQU8sR0FBRyxDQUFDLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBaUMsQ0FBQztJQUMxRixJQUFJLE9BQU8sS0FBSyxJQUFJLElBQUksT0FBTyxPQUFPLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDcEQsTUFBTSxJQUFJLEtBQUssQ0FBQyxrREFBa0QsQ0FBQyxDQUFDO0lBQ3RFLENBQUM7SUFDRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDIn0=