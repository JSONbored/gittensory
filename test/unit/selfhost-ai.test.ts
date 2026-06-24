import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeErrorStatus, createClaudeCodeAi, createOpenAiCompatibleAi, createSelfHostAi, extractCliText } from "../../src/selfhost/ai";

afterEach(() => vi.unstubAllGlobals());

type SpawnResult = { stdout: string; code: number | null };
type StubSpawn = (cmd: string, args: string[], opts: { env: Record<string, string | undefined>; input?: string; timeoutMs: number }) => Promise<SpawnResult>;

describe("createOpenAiCompatibleAi (#979)", () => {
  it("POSTs to /chat/completions and returns { response }", async () => {
    const calls: Array<{ url: string; body: { model: string } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), { status: 200 });
    }));
    const ai = createOpenAiCompatibleAi({ baseUrl: "http://ollama:11434/v1/", apiKey: "k" });
    const out = await ai.run("llama3.1", { messages: [{ role: "user", content: "x" }], max_tokens: 100 });
    expect(out.response).toBe("hi there");
    const first = calls[0];
    expect(first?.url).toBe("http://ollama:11434/v1/chat/completions"); // trailing slash trimmed
    expect(first?.body.model).toBe("llama3.1");
  });

  it("throws on a non-OK response so the caller degrades", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    await expect(createOpenAiCompatibleAi({ baseUrl: "http://x/v1" }).run("m", { prompt: "p" })).rejects.toThrow(/ai_http_500/);
  });
});

describe("createSelfHostAi — provider selection", () => {
  it("is undefined when AI_PROVIDER is unset", () => {
    expect(createSelfHostAi({})).toBeUndefined();
  });
  it("maps ollama/openai-compatible/claude-code/codex to adapters", () => {
    expect(typeof createSelfHostAi({ AI_PROVIDER: "ollama", AI_BASE_URL: "http://o/v1" })?.run).toBe("function");
    expect(typeof createSelfHostAi({ AI_PROVIDER: "claude-code" })?.run).toBe("function");
    expect(typeof createSelfHostAi({ AI_PROVIDER: "codex" })?.run).toBe("function");
    expect(createSelfHostAi({ AI_PROVIDER: "nonsense" })).toBeUndefined();
  });
});

describe("subscription CLI helpers + fail-safe", () => {
  it("extractCliText pulls the result/text field", () => {
    expect(extractCliText(JSON.stringify({ type: "result", result: "ok" }))).toBe("ok");
    expect(extractCliText("")).toBe("");
  });
  it("claudeErrorStatus catches the is_error envelope", () => {
    expect(claudeErrorStatus(JSON.stringify({ is_error: true, api_error_status: 401 }))).toBe("401");
    expect(claudeErrorStatus(JSON.stringify({ is_error: false, result: "ok" }))).toBeNull();
  });
  it("Claude Code fails SAFE on an is_error envelope (exits 0) instead of surfacing the error text", async () => {
    const stub: StubSpawn = async () => ({ stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: "Failed to authenticate" }), code: 0 });
    await expect(createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, stub).run("m", { prompt: "x" })).rejects.toThrow(/claude_code_error_401/);
  });
  it("Claude Code returns the model text on success and scrubs billable keys", async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    const stub: StubSpawn = async (_c, _a, o) => {
      capturedEnv = o.env;
      return { stdout: JSON.stringify({ type: "result", result: "review text" }), code: 0 };
    };
    const out = await createClaudeCodeAi({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "sk-bill" }, stub).run("sonnet", { prompt: "x" });
    expect(out.response).toBe("review text");
    expect(capturedEnv.ANTHROPIC_API_KEY).toBeUndefined(); // scrubbed
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
  });
});
