export type GitHubTokenResolutionFetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
}) => Promise<Response>;
/**
 * Same loopover-mcp session + API URL posture `resolveGitHubToken` uses for backend calls (#6487).
 * Returns null when there is no session token on disk (fully-standalone AMS / no `loopover-mcp login`).
 */
export declare function resolveLoopoverBackendSession(env?: NodeJS.ProcessEnv): {
    apiUrl: string;
    sessionToken: string;
} | null;
/**
 * The GitHub login recorded in the active loopover-mcp session on disk (written by `loopover-mcp login`), or
 * null when no session names one. Lets a miner command default `:login` to the operator's own configured
 * identity without retyping it, mirroring loopover-mcp's own `activeProfile.session?.login` resolution -- the
 * login-side companion to resolveLoopoverBackendSession's token/apiUrl.
 */
export declare function resolveLoopoverSessionLogin(env?: NodeJS.ProcessEnv): string | null;
/**
 * Resolve a GitHub token for AMS's git operations (#6116). Returns null when nothing is available: no
 * GITHUB_TOKEN override, no loopover-mcp session on disk, or the session-token fetch fails for any reason --
 * callers already treat a missing token as "git operations requiring auth will fail," the same failure mode
 * as before this feature existed.
 */
export declare function resolveGitHubToken(env?: NodeJS.ProcessEnv, options?: {
    fetchImpl?: GitHubTokenResolutionFetch;
}): Promise<string | null>;
/** Test-only: clear the process-lifetime cache so one test's resolution can't leak into the next. */
export declare function resetGitHubTokenResolutionForTesting(): void;
/**
 * Offline-only check: does resolveGitHubToken have ANYTHING to try (a GITHUB_TOKEN override, or a
 * loopover-mcp session recorded on disk), without making the network call resolveGitHubToken itself would
 * make to actually verify it still works. For `doctor`/`status`-style diagnostics (status.js's
 * checkGitHubTokenPresent), which are deliberately offline-only -- a genuinely expired or revoked session
 * still reports "present" here; only an actual attempt (or resolveGitHubToken itself) discovers that.
 */
export declare function hasGitHubTokenSource(env?: NodeJS.ProcessEnv): boolean;
