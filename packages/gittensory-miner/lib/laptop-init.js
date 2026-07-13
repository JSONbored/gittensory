import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchemaMigrations } from "./schema-version.js";
import { describeCliError, reportCliFailure } from "./cli-error.js";

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const classicRepoScopes = new Set(["repo", "public_repo"]);
const defaultDbFileName = "laptop-state.sqlite3";

/** Menu order for `init --interactive`'s provider prompt (#5176). Kept as a local literal — mirrors
 *  `CODING_AGENT_DRIVER_NAMES` in packages/gittensory-engine/src/miner/driver-factory.ts — rather than an
 *  import, since this package never depends on gittensory-engine at runtime (see checkClaudeCliPresent /
 *  checkCodexCliPresent above, which hardcode "claude-cli" / "codex-cli" the same way). */
const CODING_AGENT_PROVIDERS = Object.freeze(["claude-cli", "codex-cli", "agent-sdk", "noop"]);

/** Local state directory (mirrors `resolveMinerStateDir` in status.js — kept local to avoid import cycles). */
function resolveMinerStateDir(env = process.env) {
  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return explicitConfigDir;

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner");
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
      detail: `${dbPath}: not found (run gittensory-miner init)`,
    };
  }
  try {
    const db = new DatabaseSync(dbPath, { readonly: true });
    db.prepare("SELECT 1").get();
    db.close();
    return { name: "laptop-state-sqlite", ok: true, detail: dbPath };
  } catch (error) {
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
    if (!pathEntry) continue;
    const candidate = join(pathEntry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
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

function githubHeaders(githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": githubApiVersion,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function parseScopesHeader(scopesHeader) {
  return typeof scopesHeader === "string" && scopesHeader.trim()
    ? scopesHeader.split(",").map((scope) => scope.trim()).filter(Boolean)
    : [];
}

function formatScopes(scopes) {
  return scopes.length > 0 ? scopes.join(", ") : "none reported";
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
  const apiBaseUrl =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
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
  } catch (error) {
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
  } finally {
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
    detail:
      scopes.length > 0
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
  } catch {
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

/**
 * Reads one line of input a byte/keystroke at a time, echoing either the real character (`mask: false`, e.g. the
 * provider menu) or `*` (`mask: true`, GITHUB_TOKEN) to `output` -- never the raw character in the masked case
 * (#5176). One shared reader for both prompt kinds, rather than layering a manual raw-mode reader for the masked
 * prompt on top of `node:readline` for the unmasked ones: two independent input-consumption mechanisms on the
 * same stream in one process is a real footgun (readline's own internal buffering vs. this file's), and a single
 * mechanism is far simpler to reason about and to test against an injected stream.
 *
 * On a real TTY, raw mode is required to suppress the terminal's own cooked-mode echo of what's typed (and to
 * receive Ctrl+C as data rather than a SIGINT); on an injected/piped stream (no `setRawMode`, e.g. in tests) that
 * branch is simply skipped -- cooked-mode line editing already happened upstream in that case.
 *
 * `reader.leftover` carries any bytes consumed past the terminator from ONE prompt into the NEXT: a piped/non-TTY
 * stdin can (and in practice does) deliver several answers -- e.g. a token line AND the next menu selection -- in
 * a single "data" chunk, since pipes have no notion of "one keystroke per event" the way a real TTY in raw mode
 * does. Discarding everything after the first newline in that chunk would silently drop the next prompt's answer
 * and hang the wizard forever waiting for input that already arrived. `reader` is created once per wizard run
 * (see runInteractiveInitWizard) and threaded through every prompt in that run so the carry-over is preserved
 * across calls; the same input stream reused by a LATER, unrelated call gets a fresh reader with empty leftover.
 *
 * Resolves with the typed value (untrimmed; callers trim), or rejects on Ctrl+C.
 */
function promptRaw(io, question, mask) {
  const { input, output, reader } = io;
  output.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    // Raw mode is only needed to suppress the terminal's own cooked-mode echo, so only the masked (GITHUB_TOKEN)
    // prompt engages it -- the unmasked provider/model/timeout prompts stay in cooked mode, where the OS's own
    // line editing (and its own echo of `char`, mirrored by this file's write below) already does the right thing.
    const canSetRawMode = mask && typeof input.setRawMode === "function";
    if (canSetRawMode) input.setRawMode(true);
    if (typeof input.setEncoding === "function") input.setEncoding("utf8");
    input.resume();

    const finish = (remainder) => {
      input.removeListener("data", onData);
      if (canSetRawMode) input.setRawMode(false);
      input.pause();
      reader.leftover = remainder;
    };

    // Returns true once this prompt has resolved or rejected from `text` alone (a fully-answered chunk with
    // input still pending after it) -- the caller must stop feeding this reader more text in that case.
    const consume = (text) => {
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === "\r" || char === "\n") {
          finish(text.slice(i + 1));
          output.write("\n");
          resolve(value);
          return true;
        }
        if (char === "\u0003") {
          finish("");
          reject(new Error("aborted by operator (Ctrl+C)"));
          return true;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (mask) output.write("\b \b");
          }
          continue;
        }
        value += char;
        output.write(mask ? "*" : char);
      }
      return false;
    };

    const onData = (chunk) => {
      consume(String(chunk));
    };

    if (reader.leftover) {
      const pending = reader.leftover;
      reader.leftover = "";
      if (consume(pending)) return;
    }
    input.on("data", onData);
  });
}

function promptLine(io, question) {
  return promptRaw(io, question, false).then((value) => value.trim());
}

function promptMasked(io, question) {
  return promptRaw(io, question, true);
}

/** A blank answer means "skip this optional var" (#5176) -- returns `null` rather than an empty string so
 *  callers can `if (value)` without also excluding a deliberately-cleared-then-retyped value. */
async function promptOptionalLine(io, question) {
  const answer = await promptLine(io, question);
  return answer.length > 0 ? answer : null;
}

async function promptGithubToken(io) {
  for (;;) {
    const token = await promptMasked(io, "GitHub token (repo-scoped PAT, input hidden): ");
    if (token.trim().length > 0) return token.trim();
    io.output.write("A non-empty GITHUB_TOKEN is required.\n");
  }
}

async function promptProvider(io) {
  io.output.write("\nSelect a coding-agent provider (\"noop\" configures none for now):\n");
  CODING_AGENT_PROVIDERS.forEach((name, index) => {
    io.output.write(`  ${index + 1}) ${name}\n`);
  });
  for (;;) {
    const answer = await promptLine(io, `Provider [1-${CODING_AGENT_PROVIDERS.length}]: `);
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= CODING_AGENT_PROVIDERS.length) {
      return CODING_AGENT_PROVIDERS[index - 1];
    }
    io.output.write(`Please enter a number between 1 and ${CODING_AGENT_PROVIDERS.length}.\n`);
  }
}

/** Provider-specific companion prompts (#5176) -- mirrors CODING_AGENT_DRIVER_CONFIG_ENV in
 *  packages/gittensory-engine/src/miner/driver-factory.ts: `claude-cli` and `codex-cli` each take an optional
 *  model override plus the shared timeout var; `agent-sdk` and `noop` take neither. */
async function promptProviderCompanions(io, provider) {
  const values = {};
  if (provider !== "claude-cli" && provider !== "codex-cli") return values;

  const modelEnvVar = provider === "claude-cli" ? "MINER_CODING_AGENT_CLAUDE_MODEL" : "MINER_CODING_AGENT_CODEX_MODEL";
  const cliName = provider === "claude-cli" ? "claude" : "codex";
  const model = await promptOptionalLine(io, `Model override for ${cliName} (leave blank for its own default): `);
  if (model) values[modelEnvVar] = model;

  const timeoutMs = await promptOptionalLine(
    io,
    "Attempt timeout in ms (leave blank for the driver default, 120000): ",
  );
  if (timeoutMs) values.MINER_CODING_AGENT_TIMEOUT_MS = timeoutMs;

  return values;
}

/**
 * Interactive credential/provider wizard for `init --interactive` (#5176). Never makes a network call itself --
 * that stays scoped to the separate, explicitly opt-in `--verify-token` flag. Returns the collected values (never
 * echoing GITHUB_TOKEN back, including in the printed summary) or `{ ok: false }` if the operator aborts.
 */
export async function runInteractiveInitWizard(streams = {}) {
  const io = {
    input: streams.input ?? process.stdin,
    output: streams.output ?? process.stdout,
    reader: { leftover: "" },
  };
  try {
    io.output.write("gittensory-miner interactive setup\n");
    io.output.write("-----------------------------------\n");
    const githubToken = await promptGithubToken(io);
    const provider = await promptProvider(io);
    const companions = await promptProviderCompanions(io, provider);
    const values = { GITHUB_TOKEN: githubToken, MINER_CODING_AGENT_PROVIDER: provider, ...companions };

    io.output.write("\nCollected configuration:\n");
    io.output.write("  GITHUB_TOKEN: (provided, hidden)\n");
    for (const [key, value] of Object.entries(companions)) io.output.write(`  ${key}: ${value}\n`);
    io.output.write(`  MINER_CODING_AGENT_PROVIDER: ${provider}\n`);

    return { ok: true, values };
  } catch (error) {
    return { ok: false, error: describeCliError(error) };
  }
}

/** Writes the values collected by {@link runInteractiveInitWizard} to a starter `.env` file in the state dir
 *  (#5176). Not auto-loaded by this CLI (mirrors the existing `.gittensory-miner.env.example` / systemd
 *  `EnvironmentFile=` convention, README.md's "Bare-host (systemd, no Docker)" section) — an operator sources it
 *  into their shell or points a service's env-file setting at it. */
function writeStarterEnvFile(env, values) {
  const stateDir = resolveMinerStateDir(env);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, ".env");
  const lines = [
    `# gittensory-miner starter env, written by \`gittensory-miner init --interactive\` on ${new Date().toISOString()}.`,
    "# Not auto-loaded by this CLI -- source it into your shell, or point a service's env-file setting at it.",
    "# Keep this file out of version control and treat it like a secret.",
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path };
}

export async function runInit(args = [], env = process.env, streams = {}) {
  const verifyToken = args.includes("--verify-token");
  const jsonOutput = args.includes("--json");
  const interactive = args.includes("--interactive");

  let wizard = null;
  if (interactive) {
    wizard = await runInteractiveInitWizard(streams);
    if (!wizard.ok) {
      return reportCliFailure(jsonOutput, wizard.error, 1);
    }
    // Mutates the caller's env in place (defaults to process.env) so the just-collected values are visible to
    // the rest of THIS invocation -- the --verify-token/initLaptopState calls right below, and (for the real
    // CLI entry point) the doctor rerun that follows init --interactive, without threading a merged-env object
    // through every layer for a one-shot interactive command.
    Object.assign(env, wizard.values);
  }

  let verification = null;
  if (verifyToken) {
    verification = await verifyGithubToken({ githubToken: env.GITHUB_TOKEN ?? "" });
    if (!verification.ok) {
      return reportCliFailure(jsonOutput, verification.detail, 1);
    }
  }

  const result = initLaptopState(env);
  const envFile = interactive ? writeStarterEnvFile(env, wizard.values) : null;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ...result,
          ...(verification ? { tokenVerification: verification } : {}),
          ...(envFile ? { envFile: envFile.path } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`initialized ${result.stateDir}`);
    console.log(`sqlite: ${result.dbPath}${result.created ? "" : " (already existed)"}`);
    if (verification) {
      console.log(`token: ${verification.detail}`);
    }
    if (envFile) {
      console.log(`env file: ${envFile.path}`);
    }
  }
  return 0;
}
