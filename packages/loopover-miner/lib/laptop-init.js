import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchemaMigrations } from "./schema-version.js";
import { reportCliFailure } from "./cli-error.js";
import { resolveGitHubToken } from "./github-token-resolution.js";
const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const classicRepoScopes = new Set(["repo", "public_repo"]);
const defaultDbFileName = "laptop-state.sqlite3";
/** Local state directory (mirrors `resolveMinerStateDir` in status.js — kept local to avoid import cycles). */
function resolveMinerStateDir(env = process.env) {
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return explicitConfigDir;
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner");
}
/** Path to the laptop-mode SQLite bootstrap file inside the miner state directory. */
export function resolveLaptopStateDbPath(env = process.env) {
    return join(resolveMinerStateDir(env), defaultDbFileName);
}
/** Create the state dir and SQLite file. Re-running is idempotent and never clobbers existing rows. */
export function initLaptopState(env = process.env) {
    const stateDir = resolveMinerStateDir(env);
    const dbPath = resolveLaptopStateDbPath(env);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const created = !existsSync(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS laptop_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
    // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
    applySchemaMigrations(db, []);
    if (created) {
        db.prepare("INSERT INTO laptop_meta (key, value) VALUES ('initialized_at', ?)")
            .run(new Date().toISOString());
    }
    chmodSync(dbPath, 0o600);
    db.close();
    return { stateDir, dbPath, created };
}
export function checkLaptopStateSqlite(env = process.env) {
    const dbPath = resolveLaptopStateDbPath(env);
    if (!existsSync(dbPath)) {
        return {
            name: "laptop-state-sqlite",
            ok: false,
            detail: `${dbPath}: not found (run loopover-miner init)`,
        };
    }
    try {
        // `readOnly` (camelCase) -- node:sqlite silently IGNORES `readonly` (lowercase) as an unrecognized option
        // and opens read-write anyway, which would break doctor's own "no writes, no network" contract. Same
        // footgun already documented in claim-ledger.js's openClaimLedgerReadOnly and purge-cli.js.
        const db = new DatabaseSync(dbPath, { readOnly: true });
        db.prepare("SELECT 1").get();
        db.close();
        return { name: "laptop-state-sqlite", ok: true, detail: dbPath };
    }
    catch (error) {
        return {
            name: "laptop-state-sqlite",
            ok: false,
            detail: `${dbPath}: ${error instanceof Error ? error.message : "not readable"}`,
        };
    }
}
/** Exported so callers that only need a presence boolean (e.g. status.js's `driver` section, #5164) can reuse
 *  this PATH scan directly instead of duplicating it or parsing a DoctorCheck's detail string. */
export function findExecutableOnPath(name, env = process.env) {
    const pathValue = typeof env.PATH === "string" ? env.PATH : "";
    for (const pathEntry of pathValue.split(delimiter)) {
        if (!pathEntry)
            continue;
        const candidate = join(pathEntry, name);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            // Keep scanning: PATH often contains missing or unreadable entries.
        }
    }
    return null;
}
/** Informational only — Docker is never required for laptop mode. */
export function checkDockerPresent(options = {}) {
    const resolveDockerPath = options.resolveDockerPath
        ?? (() => findExecutableOnPath("docker", options.env));
    const dockerPath = resolveDockerPath();
    return {
        name: "docker-present",
        ok: true,
        detail: dockerPath ? `found at ${dockerPath}` : "not installed (optional for laptop mode)",
    };
}
// Codex stores credentials at `$CODEX_HOME/auth.json`, else `$HOME/.codex/auth.json` — mirrors
// resolveCodexAuthPath in src/selfhost/ai.ts, kept local so the offline miner package never imports the
// Worker AI module. Exported so `doctor`'s provider-credential check (status.js, #5170) resolves the SAME
// path this file's own codex auth probe uses, instead of duplicating the location logic.
export function resolveCodexAuthPath(env = process.env) {
    const base = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
    return join(base, "auth.json");
}
// `githubToken` is always a string (never undefined) here -- verifyGithubToken's own
// `typeof options.githubToken === "string"` guard already normalizes it before this is called.
function githubHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "loopover-miner",
        "x-github-api-version": githubApiVersion,
    };
    const token = githubToken.trim();
    if (token)
        headers.authorization = `Bearer ${token}`;
    return headers;
}
function parseScopesHeader(scopesHeader) {
    return typeof scopesHeader === "string" && scopesHeader.trim()
        ? scopesHeader.split(",").map((scope) => scope.trim()).filter(Boolean)
        : [];
}
// Both call sites below already guard `scopes.length > 0` before calling this, so scopes is always
// non-empty here -- no "none reported" fallback needed (that phrasing lives inline at each call site instead).
function formatScopes(scopes) {
    return scopes.join(", ");
}
function hasRepoAccessScope(scopes) {
    return scopes.some((scope) => classicRepoScopes.has(scope));
}
function readGithubErrorMessage(payload, status) {
    if (payload && typeof payload === "object" && typeof payload.message === "string" && payload.message.trim()) {
        return payload.message.trim();
    }
    return `GitHub returned HTTP ${status}`;
}
/**
 * Validate a GitHub token with one authenticated API call.
 *
 * The classic OAuth scope header is advisory when GitHub reports it: if GitHub returns `repo` or
 * `public_repo`, we treat the token as sufficiently scoped for miner setup. If GitHub omits the classic
 * scope header altogether, the token is still considered valid and the response is reported as "scopes not
 * reported" — that keeps fine-grained tokens usable while still surfacing the scopes GitHub did return.
 */
export async function verifyGithubToken(options = {}) {
    const githubToken = typeof options.githubToken === "string" ? options.githubToken.trim() : "";
    const fetchImpl = options.fetchImpl ?? fetch;
    const apiBaseUrl = typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
        ? options.apiBaseUrl.trim().replace(/\/+$/, "") || githubApiBaseUrl
        : githubApiBaseUrl;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetchImpl(`${apiBaseUrl}/user`, {
            method: "GET",
            headers: githubHeaders(githubToken),
            signal: controller.signal,
        });
    }
    catch (error) {
        const detail = controller.signal.aborted
            ? `timed out after ${timeoutMs}ms`
            : error instanceof Error
                ? error.message
                : "request failed";
        return {
            ok: false,
            login: null,
            scopes: [],
            detail: `GITHUB_TOKEN verification failed: ${detail}`,
        };
    }
    finally {
        clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => null);
    const scopesHeader = response.headers.get("x-oauth-scopes");
    const scopesHeaderPresent = response.headers.has("x-oauth-scopes");
    const scopes = parseScopesHeader(scopesHeader);
    const login = payload && typeof payload === "object" && typeof payload.login === "string" ? payload.login.trim() : "";
    if (!response.ok) {
        return {
            ok: false,
            login: null,
            scopes,
            detail: `GITHUB_TOKEN verification failed: ${readGithubErrorMessage(payload, response.status)}`,
        };
    }
    if (scopesHeaderPresent && scopes.length === 0) {
        return {
            ok: false,
            login: login || null,
            scopes,
            detail: "GITHUB_TOKEN is valid, but GitHub returned an empty x-oauth-scopes header; reissue it with repo access for miner setup.",
        };
    }
    if (scopes.length > 0 && !hasRepoAccessScope(scopes)) {
        return {
            ok: false,
            login: login || null,
            scopes,
            detail: `GITHUB_TOKEN is valid, but GitHub reported only ${formatScopes(scopes)}; reissue it with repo access for miner setup.`,
        };
    }
    return {
        ok: true,
        login: login || null,
        scopes,
        detail: scopes.length > 0
            ? `validated GitHub token for ${login || "unknown user"}; scopes: ${formatScopes(scopes)}`
            : `validated GitHub token for ${login || "unknown user"}; GitHub did not report classic OAuth scopes`,
    };
}
/** A coding-agent CLI is only needed once a driver provider is configured (#4289) — gated by
 *  `MINER_CODING_AGENT_PROVIDER` (#5165). When that provider is NOT the CLI being checked, absence is
 *  advisory (`ok: true`), mirroring checkDockerPresent's optional tone. When it IS configured and the CLI is
 *  missing, `ok: false` — every attempt will fail without it. The auth probe (once found) stays advisory
 *  either way, since an unauthenticated-but-installed CLI is a separate, already-visible warning. */
function codingAgentProviderConfiguredFor(env, providerName) {
    return env.MINER_CODING_AGENT_PROVIDER === providerName;
}
/** Informational unless `MINER_CODING_AGENT_PROVIDER=claude-cli` (#5165), in which case a missing CLI fails
 *  doctor. The auth probe is read-only and never spawns the CLI: it surfaces, proactively, the SAME condition
 *  claude checks at call time — `CLAUDE_CODE_OAUTH_TOKEN` present (see createClaudeCodeAi, src/selfhost/ai.ts). */
export function checkClaudeCliPresent(options = {}) {
    const env = options.env ?? process.env;
    const claudePath = (options.resolveClaudePath ?? (() => findExecutableOnPath("claude", env)))();
    if (!claudePath) {
        const configured = codingAgentProviderConfiguredFor(env, "claude-cli");
        return {
            name: "claude-cli-present",
            ok: !configured,
            detail: configured
                ? "not installed — MINER_CODING_AGENT_PROVIDER is set to claude-cli, every attempt will fail without it"
                : "not installed (optional until a coding-agent driver is configured)",
        };
    }
    const authed = typeof env.CLAUDE_CODE_OAUTH_TOKEN === "string" && env.CLAUDE_CODE_OAUTH_TOKEN.length > 0;
    return {
        name: "claude-cli-present",
        ok: true,
        detail: authed ? `found at ${claudePath} (authenticated)` : `found at ${claudePath} (not authenticated: set CLAUDE_CODE_OAUTH_TOKEN)`,
    };
}
/** Informational unless `MINER_CODING_AGENT_PROVIDER=codex-cli` (#5165), in which case a missing CLI fails
 *  doctor — mirrors {@link checkClaudeCliPresent}. The auth probe checks the same read-only condition
 *  assertCodexAuthConfigured uses at call time: codex's `auth.json` is readable. */
export function checkCodexCliPresent(options = {}) {
    const env = options.env ?? process.env;
    const codexPath = (options.resolveCodexPath ?? (() => findExecutableOnPath("codex", env)))();
    if (!codexPath) {
        const configured = codingAgentProviderConfiguredFor(env, "codex-cli");
        return {
            name: "codex-cli-present",
            ok: !configured,
            detail: configured
                ? "not installed — MINER_CODING_AGENT_PROVIDER is set to codex-cli, every attempt will fail without it"
                : "not installed (optional until a coding-agent driver is configured)",
        };
    }
    const authPath = (options.resolveCodexAuthPath ?? (() => resolveCodexAuthPath(env)))();
    let authed = false;
    try {
        accessSync(authPath, constants.R_OK);
        authed = true;
    }
    catch {
        // auth.json missing or unreadable — codex would fail for lack of credentials at call time.
    }
    if (authed) {
        return { name: "codex-cli-present", ok: true, detail: `found at ${codexPath} (authenticated)` };
    }
    // codex-cli IS the configured driver but auth.json is missing/expired: a more specific, actionable remediation
    // than the generic advisory below, mirroring ORB's codexAuthReadinessProbe/assertCodexAuthConfigured wording
    // (#5166). `ok` stays true either way (unchanged by this issue, see #5165) since the CLI itself IS present --
    // only the CLI-absent case is a hard doctor failure.
    const detail = codingAgentProviderConfiguredFor(env, "codex-cli")
        ? `found at ${codexPath} but auth.json is missing or expired — run \`codex auth\` to authenticate before attempts run`
        : `found at ${codexPath} (not authenticated: run \`codex auth\`)`;
    return { name: "codex-cli-present", ok: true, detail };
}
export async function runInit(args = [], env = process.env) {
    const verifyToken = args.includes("--verify-token");
    const jsonOutput = args.includes("--json");
    let verification = null;
    if (verifyToken) {
        verification = await verifyGithubToken({ githubToken: (await resolveGitHubToken(env)) ?? "" });
        if (!verification.ok) {
            return reportCliFailure(jsonOutput, verification.detail, 1);
        }
    }
    const result = initLaptopState(env);
    if (jsonOutput) {
        console.log(JSON.stringify(verification ? { ...result, tokenVerification: verification } : result, null, 2));
    }
    else {
        console.log(`initialized ${result.stateDir}`);
        console.log(`sqlite: ${result.dbPath}${result.created ? "" : " (already existed)"}`);
        if (verification) {
            console.log(`token: ${verification.detail}`);
        }
    }
    return 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGFwdG9wLWluaXQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsYXB0b3AtaW5pdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNsRixPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQzVDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDM0MsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFFbEUsTUFBTSxnQkFBZ0IsR0FBRyx3QkFBd0IsQ0FBQztBQUNsRCxNQUFNLGdCQUFnQixHQUFHLFlBQVksQ0FBQztBQUN0QyxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLGFBQWEsQ0FBQyxDQUFDLENBQUM7QUFDM0QsTUFBTSxpQkFBaUIsR0FBRyxzQkFBc0IsQ0FBQztBQUlqRCwrR0FBK0c7QUFDL0csU0FBUyxvQkFBb0IsQ0FBQyxNQUFXLE9BQU8sQ0FBQyxHQUFHO0lBQ2xELE1BQU0saUJBQWlCLEdBQUcsT0FBTyxHQUFHLENBQUMseUJBQXlCLEtBQUssUUFBUTtRQUN6RSxDQUFDLENBQUMsR0FBRyxDQUFDLHlCQUF5QixDQUFDLElBQUksRUFBRTtRQUN0QyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1AsSUFBSSxpQkFBaUI7UUFBRSxPQUFPLGlCQUFpQixDQUFDO0lBRWhELE1BQU0sVUFBVSxHQUFHLE9BQU8sR0FBRyxDQUFDLGVBQWUsS0FBSyxR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