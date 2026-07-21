// GitHub-token resolution for AMS's git operations (#6116). Precedence: an explicit GITHUB_TOKEN env
// override always wins (a self-host operator's existing PAT setup keeps working, unchanged) -- otherwise,
// fetch a live token from the authenticated loopover-mcp session (POST /v1/auth/github/token, #6114/#6115),
// so `loopover-mcp login` alone becomes sufficient to run AMS against a repo the user has access to.
//
// Deliberately reimplements loopover-mcp's own config-file read here rather than depending on @loopover/mcp
// as a package: @loopover/miner and @loopover/mcp are separately-installable CLIs (the whole point of this
// milestone is that installing the GitHub App doesn't require BOTH), and a hard runtime dependency between
// them would mean installing one always pulls in the other just to read a config file format neither
// package publishes as a stable API. This mirrors loopover-mcp/bin/loopover-mcp.js's own configPath/
// selectProfileName/apiUrl resolution logic (kept in sync by hand -- there is no shared module to import).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const DEFAULT_API_URL = "https://api.loopover.ai";
const LEGACY_DEFAULT_API_URLS = new Set([
    "https://gittensory-api.zeronode.workers.dev",
    "https://gittensory-api.aethereal.dev",
]);
const DEFAULT_PROFILE_NAME = "default";
const GITHUB_TOKEN_FETCH_TIMEOUT_MS = 10_000;
function loopoverConfigPath(env) {
    if (env.LOOPOVER_CONFIG_PATH)
        return env.LOOPOVER_CONFIG_PATH;
    if (env.LOOPOVER_CONFIG_DIR)
        return join(env.LOOPOVER_CONFIG_DIR, "config.json");
    return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "loopover", "config.json");
}
function loadLoopoverConfig(env) {
    const configPath = loopoverConfigPath(env);
    if (!existsSync(configPath))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(configPath, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
// Only ever called with an already-truthy candidate name (see selectProfileName below) -- no nullish
// fallback needed here, since a nullish/empty `value` never reaches this function in the first place.
function normalizeProfileName(value) {
    const name = String(value).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : DEFAULT_PROFILE_NAME;
}
// Mirrors loopover-mcp's own selectProfileName: an explicit request wins, else the config's own
// activeProfile (only if it names a real profile entry), else "default".
function selectProfileName(config, requestedName) {
    if (requestedName)
        return normalizeProfileName(requestedName);
    const configured = config.activeProfile ? normalizeProfileName(config.activeProfile) : DEFAULT_PROFILE_NAME;
    return config.profiles?.[configured] ? configured : DEFAULT_PROFILE_NAME;
}
function activeLoopoverProfile(env) {
    const config = loadLoopoverConfig(env);
    const profileName = selectProfileName(config, env.LOOPOVER_PROFILE);
    return config.profiles?.[profileName] ?? {};
}
function loopoverSessionToken(env) {
    const token = activeLoopoverProfile(env).session?.token;
    return typeof token === "string" && token ? token : null;
}
function loopoverApiUrl(env) {
    if (env.LOOPOVER_API_URL)
        return env.LOOPOVER_API_URL.replace(/\/+$/, "");
    const profileApiUrl = activeLoopoverProfile(env).apiUrl;
    if (typeof profileApiUrl === "string" && profileApiUrl.trim()) {
        const normalized = profileApiUrl.replace(/\/+$/, "");
        if (!LEGACY_DEFAULT_API_URLS.has(normalized))
            return normalized;
    }
    return DEFAULT_API_URL;
}
/**
 * Same loopover-mcp session + API URL posture `resolveGitHubToken` uses for backend calls (#6487).
 * Returns null when there is no session token on disk (fully-standalone AMS / no `loopover-mcp login`).
 */
export function resolveLoopoverBackendSession(env = process.env) {
    const sessionToken = loopoverSessionToken(env);
    if (!sessionToken)
        return null;
    return { apiUrl: loopoverApiUrl(env), sessionToken };
}
/**
 * The GitHub login recorded in the active loopover-mcp session on disk (written by `loopover-mcp login`), or
 * null when no session names one. Lets a miner command default `:login` to the operator's own configured
 * identity without retyping it, mirroring loopover-mcp's own `activeProfile.session?.login` resolution -- the
 * login-side companion to resolveLoopoverBackendSession's token/apiUrl.
 */
export function resolveLoopoverSessionLogin(env = process.env) {
    const login = activeLoopoverProfile(env).session?.login;
    return typeof login === "string" && login.trim() ? login.trim() : null;
}
async function fetchLiveGitHubTokenFromSession(sessionToken, apiUrl, fetchImpl) {
    try {
        const response = await fetchImpl(`${apiUrl}/v1/auth/github/token`, {
            method: "POST",
            headers: { authorization: `Bearer ${sessionToken}`, accept: "application/json" },
            signal: AbortSignal.timeout(GITHUB_TOKEN_FETCH_TIMEOUT_MS),
        });
        if (!response.ok)
            return null;
        const payload = (await response.json().catch(() => null));
        return typeof payload?.token === "string" && payload.token ? payload.token : null;
    }
    catch {
        return null;
    }
}
// Process-lifetime cache of a SUCCESSFUL resolution only. A failure (no session, expired session, transient
// network error) is deliberately NOT cached -- it's retried on the next call instead, so a long-running AMS
// process can self-heal from a transient blip rather than being stuck treating the token as permanently
// unavailable for its entire remaining lifetime.
let cachedToken;
/**
 * Resolve a GitHub token for AMS's git operations (#6116). Returns null when nothing is available: no
 * GITHUB_TOKEN override, no loopover-mcp session on disk, or the session-token fetch fails for any reason --
 * callers already treat a missing token as "git operations requiring auth will fail," the same failure mode
 * as before this feature existed.
 */
export async function resolveGitHubToken(env = process.env, options = {}) {
    if (env.GITHUB_TOKEN)
        return env.GITHUB_TOKEN;
    if (cachedToken)
        return cachedToken;
    const sessionToken = loopoverSessionToken(env);
    if (!sessionToken)
        return null;
    const fetchImpl = options.fetchImpl ?? fetch;
    const fetched = await fetchLiveGitHubTokenFromSession(sessionToken, loopoverApiUrl(env), fetchImpl);
    if (fetched)
        cachedToken = fetched;
    return fetched;
}
/** Test-only: clear the process-lifetime cache so one test's resolution can't leak into the next. */
export function resetGitHubTokenResolutionForTesting() {
    cachedToken = undefined;
}
/**
 * Offline-only check: does resolveGitHubToken have ANYTHING to try (a GITHUB_TOKEN override, or a
 * loopover-mcp session recorded on disk), without making the network call resolveGitHubToken itself would
 * make to actually verify it still works. For `doctor`/`status`-style diagnostics (status.js's
 * checkGitHubTokenPresent), which are deliberately offline-only -- a genuinely expired or revoked session
 * still reports "present" here; only an actual attempt (or resolveGitHubToken itself) discovers that.
 */
export function hasGitHubTokenSource(env = process.env) {
    return Boolean(env.GITHUB_TOKEN) || Boolean(loopoverSessionToken(env));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2l0aHViLXRva2VuLXJlc29sdXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnaXRodWItdG9rZW4tcmVzb2x1dGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxR0FBcUc7QUFDckcsMEdBQTBHO0FBQzFHLDRHQUE0RztBQUM1RyxxR0FBcUc7QUFDckcsRUFBRTtBQUNGLDRHQUE0RztBQUM1RywyR0FBMkc7QUFDM0csMkdBQTJHO0FBQzNHLHFHQUFxRztBQUNyRyxxR0FBcUc7QUFDckcsMkdBQTJHO0FBQzNHLE9BQU8sRUFBRSxVQUFVLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ25ELE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDbEMsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQXFCakMsTUFBTSxlQUFlLEdBQUcseUJBQXlCLENBQUM7QUFDbEQsTUFBTSx1QkFBdUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUN0Qyw2Q0FBNkM7SUFDN0Msc0NBQXNDO0NBQ3ZDLENBQUMsQ0FBQztBQUNILE1BQU0sb0JBQW9CLEdBQUcsU0FBUyxDQUFDO0FBQ3ZDLE1BQU0sNkJBQTZCLEdBQUcsTUFBTSxDQUFDO0FBRTdDLFNBQVMsa0JBQWtCLENBQUMsR0FBc0I7SUFDaEQsSUFBSSxHQUFHLENBQUMsb0JBQW9CO1FBQUUsT0FBTyxHQUFHLENBQUMsb0JBQW9CLENBQUM7SUFDOUQsSUFBSSxHQUFHLENBQUMsbUJBQW1CO1FBQUUsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLG1CQUFtQixFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBQ2pGLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxlQUFlLElBQUksSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFLFNBQVMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxhQUFhLENBQUMsQ0FBQztBQUM1RixDQUFDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxHQUFzQjtJ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