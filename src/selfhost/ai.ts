// Self-host AI provider (#979). gittensory calls `env.AI.run(model, { messages, max_tokens, temperature })`
// and reads `{ response }`. On self-host we provide an Ai-shaped adapter selected by AI_PROVIDER:
//   • ollama / openai-compatible / openai  — any OpenAI-compatible /chat/completions endpoint (BYO key)
//   • claude-code / codex                  — a locally-authenticated CLI SUBSCRIPTION, run as a subprocess
// Absent (no AI_PROVIDER) → env.AI is undefined → gittensory's AI summary degrades to "unavailable" and the
// review proceeds deterministically. Every path returns `{ response: string }` (or throws → the caller
// records an error and degrades — never a silent wrong answer).

interface AiRunOptions {
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  max_tokens?: number;
  temperature?: number;
}
export interface SelfHostAi {
  run(model: string, options: AiRunOptions): Promise<{ response: string }>;
}

function toMessages(options: AiRunOptions): Array<{ role: string; content: string }> {
  if (Array.isArray(options.messages)) return options.messages;
  return [{ role: "user", content: String(options.prompt ?? "") }];
}

/** OpenAI-compatible chat endpoint (Ollama's /v1, OpenAI, vLLM, LM Studio, …). */
export function createOpenAiCompatibleAi(opts: { baseUrl: string; apiKey?: string | undefined; defaultModel?: string | undefined }): SelfHostAi {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async run(model, options) {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: model || opts.defaultModel || "llama3.1", messages: toMessages(options), max_tokens: options.max_tokens, temperature: options.temperature }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`ai_http_${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return { response: data.choices?.[0]?.message?.content ?? "" };
    },
  };
}

// ── Subscription CLI providers (#979) — locally-authenticated `claude` / `codex` as a subprocess ──────────
// SECURITY: the child env DELETES the billable API keys so a misconfigured CLI cannot silently bill the
// metered API instead of using the subscription OAuth token. The CLI runs read-only / no extra tools. Any
// non-zero exit / empty output / error-envelope THROWS so the caller degrades — never a silent answer.
const BILLABLE_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"] as const;

function scrubBillableKeys(parent: Record<string, string | undefined>): Record<string, string | undefined> {
  const child = { ...parent };
  for (const k of BILLABLE_KEY_VARS) delete child[k];
  return child;
}

/** Pull the assistant's final text out of a CLI's JSON output (Claude Code `{result}` or Codex JSONL). */
export function extractCliText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  const tryParse = (s: string): string => {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const text = o.result ?? o.text ?? o.content ?? o.response;
      return typeof text === "string" ? text : "";
    } catch {
      return "";
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    const t = tryParse(line);
    if (t) return t;
  }
  return "";
}

/** Claude Code's `--output-format json` exits 0 even on an API/auth error, returning {is_error:true,result:"<msg>"}.
 *  Detect it so the error string is never surfaced as the model's answer. */
export function claudeErrorStatus(stdout: string): string | null {
  try {
    const o = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (o.is_error === true) return String(o.api_error_status ?? o.subtype ?? "unknown");
  } catch {
    /* not a single JSON object — handled by the empty-output guard */
  }
  return null;
}

type SpawnFn = (cmd: string, args: string[], opts: { env: Record<string, string | undefined>; input?: string; timeoutMs: number }) => Promise<{ stdout: string; code: number | null }>;

async function defaultSpawn(): Promise<SpawnFn> {
  const cp = await import("node:child_process");
  return (cmd, args, o) =>
    new Promise((resolve, reject) => {
      const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
      const child = cp.spawn(cmd, args, { env: o.env as NodeJS.ProcessEnv, stdio });
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("subscription_cli_timeout"));
      }, o.timeoutMs);
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, code });
      });
      if (o.input != null) {
        child.stdin?.write(o.input);
        child.stdin?.end();
      }
    });
}

/** Claude Code subscription (CLAUDE_CODE_OAUTH_TOKEN via `claude setup-token`). Headless, read-only, JSON. */
export function createClaudeCodeAi(parentEnv: Record<string, string | undefined>, spawnImpl?: SpawnFn): SelfHostAi {
  return {
    async run(model, options) {
      const token = parentEnv.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error("claude_code_no_oauth_token");
      const env = scrubBillableKeys(parentEnv);
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      const prompt = toMessages(options).map((m) => m.content).join("\n\n");
      const spawn = spawnImpl ?? (await defaultSpawn());
      const { stdout, code } = await spawn("claude", ["--print", "--output-format", "json", "--model", model || "sonnet", "--permission-mode", "plan", "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch"], { env, input: prompt, timeoutMs: 120_000 });
      if (code !== 0) throw new Error(`claude_code_exit_${code ?? "null"}`);
      const errStatus = claudeErrorStatus(stdout);
      if (errStatus) throw new Error(`claude_code_error_${errStatus}`);
      const text = extractCliText(stdout);
      if (!text) throw new Error("claude_code_empty_output");
      return { response: text };
    },
  };
}

/** Codex subscription (`codex exec`, auth from ~/.codex/auth.json). Gated/unverified — fail-safe. */
export function createCodexAi(parentEnv: Record<string, string | undefined>, spawnImpl?: SpawnFn): SelfHostAi {
  return {
    async run(model, options) {
      const env = scrubBillableKeys(parentEnv);
      const prompt = toMessages(options).map((m) => m.content).join("\n\n");
      const spawn = spawnImpl ?? (await defaultSpawn());
      const { stdout, code } = await spawn("codex", ["exec", "--json", "--sandbox", "read-only", "--ask-for-approval", "never", "--model", model || "gpt-5", prompt], { env, timeoutMs: 120_000 });
      if (code !== 0) throw new Error(`codex_exit_${code ?? "null"}`);
      const text = extractCliText(stdout);
      if (!text) throw new Error("codex_empty_output");
      return { response: text };
    },
  };
}

/** Pick the self-host AI provider from env (AI_PROVIDER). Returns undefined when unconfigured. */
export function createSelfHostAi(env: Record<string, string | undefined>): SelfHostAi | undefined {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) return undefined;
  if (provider === "ollama" || provider === "openai-compatible" || provider === "openai") {
    return createOpenAiCompatibleAi({ baseUrl: env.AI_BASE_URL ?? "http://localhost:11434/v1", apiKey: env.AI_API_KEY, defaultModel: env.WORKERS_AI_SUMMARY_MODEL });
  }
  if (provider === "claude-code") return createClaudeCodeAi(env);
  if (provider === "codex") return createCodexAi(env);
  return undefined;
}
