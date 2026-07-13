import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit, runInteractiveInitWizard } from "../../packages/gittensory-miner/lib/laptop-init.js";

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-init-interactive-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A fake stdin: each queued "line" is the entire raw byte sequence a prompt should receive (may embed
 * backspace/Ctrl+C control characters to exercise those paths). Overriding `on` to auto-emit the next queued
 * line, on a fresh microtask, the instant a "data" listener is (re-)registered makes this robust against the
 * wizard's own await-driven prompt sequencing -- no fixed sleeps or manual tick-flushing needed, since a new
 * listener is only ever registered exactly when the wizard is ready for the next answer.
 */
class ScriptedInput extends EventEmitter {
  queue: string[];
  rawModeCalls: boolean[] = [];

  constructor(
    answers: string[],
    { hasSetRawMode = false, hasSetEncoding = true }: { hasSetRawMode?: boolean; hasSetEncoding?: boolean } = {},
  ) {
    super();
    this.queue = [...answers];
    if (hasSetRawMode) {
      (this as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (mode: boolean) => {
        this.rawModeCalls.push(mode);
      };
    }
    if (hasSetEncoding) {
      (this as unknown as { setEncoding: () => void }).setEncoding = () => {};
    }
  }

  override on(event: string, listener: (chunk: string) => void) {
    super.on(event, listener);
    if (event === "data") {
      const next = this.queue.shift();
      if (next !== undefined) queueMicrotask(() => this.emit("data", next));
    }
    return this;
  }

  resume() {
    return this;
  }

  pause() {
    return this;
  }
}

function fakeOutput() {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => (chunks.push(chunk), true) };
}

describe("gittensory-miner init --interactive wizard (#5176)", () => {
  it("collects GITHUB_TOKEN + provider and skips companion prompts for noop", async () => {
    const input = new ScriptedInput(["ghp_mytoken\n", "4\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result).toEqual({ ok: true, values: { GITHUB_TOKEN: "ghp_mytoken", MINER_CODING_AGENT_PROVIDER: "noop" } });
    expect(output.chunks.join("")).not.toContain("Model override");
  });

  it("re-prompts on an empty GITHUB_TOKEN before accepting a non-empty one", async () => {
    const input = new ScriptedInput(["\n", "  \n", "ghp_real\n", "4\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.GITHUB_TOKEN).toBe("ghp_real");
    expect(output.chunks.join("")).toContain("A non-empty GITHUB_TOKEN is required.");
  });

  it("re-prompts on an invalid provider selection before accepting a valid one", async () => {
    // Final answer "4" (noop) deliberately avoids claude-cli/codex-cli so this test stays scoped to menu
    // validation alone -- picking either of those would pull in two more (companion-var) prompts this test
    // doesn't script answers for.
    const input = new ScriptedInput(["ghp_x\n", "0\n", "9\n", "not-a-number\n", "4\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.MINER_CODING_AGENT_PROVIDER).toBe("noop");
    const text = output.chunks.join("");
    expect(text.match(/Please enter a number between 1 and 4\./g)?.length).toBe(3);
  });

  it("lists providers in claude-cli/codex-cli/agent-sdk/noop order", async () => {
    const input = new ScriptedInput(["ghp_x\n", "4\n"]);
    const output = fakeOutput();
    await runInteractiveInitWizard({ input, output });
    const text = output.chunks.join("");
    expect(text).toContain("1) claude-cli");
    expect(text).toContain("2) codex-cli");
    expect(text).toContain("3) agent-sdk");
    expect(text).toContain("4) noop");
  });

  it("collects claude-cli's model + timeout companions when provided", async () => {
    const input = new ScriptedInput(["ghp_x\n", "1\n", "claude-opus\n", "600000\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.MINER_CODING_AGENT_CLAUDE_MODEL).toBe("claude-opus");
      expect(result.values.MINER_CODING_AGENT_TIMEOUT_MS).toBe("600000");
    }
  });

  it("codex-cli prompts for its own model env var, not claude's", async () => {
    const input = new ScriptedInput(["ghp_x\n", "2\n", "codex-mini\n", "\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.MINER_CODING_AGENT_CODEX_MODEL).toBe("codex-mini");
      expect(result.values).not.toHaveProperty("MINER_CODING_AGENT_CLAUDE_MODEL");
      expect(result.values).not.toHaveProperty("MINER_CODING_AGENT_TIMEOUT_MS");
    }
  });

  it("companion vars are skippable: a blank line leaves them unset rather than empty-stringed", async () => {
    const input = new ScriptedInput(["ghp_x\n", "1\n", "\n", "\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).not.toHaveProperty("MINER_CODING_AGENT_CLAUDE_MODEL");
      expect(result.values).not.toHaveProperty("MINER_CODING_AGENT_TIMEOUT_MS");
      expect(Object.keys(result.values).sort()).toEqual(["GITHUB_TOKEN", "MINER_CODING_AGENT_PROVIDER"]);
    }
  });

  it("agent-sdk skips companion prompts entirely, same as noop", async () => {
    const input = new ScriptedInput(["ghp_x\n", "3\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.values).sort()).toEqual(["GITHUB_TOKEN", "MINER_CODING_AGENT_PROVIDER"]);
    expect(output.chunks.join("")).not.toContain("Model override");
  });

  it("masked input honors backspace edits mid-entry", async () => {
    const input = new ScriptedInput(["ab\u007fc\n", "4\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.GITHUB_TOKEN).toBe("ac");
  });

  it("toggles raw mode on then off around the masked token prompt when the stream supports it", async () => {
    const input = new ScriptedInput(["ghp_x\n", "4\n"], { hasSetRawMode: true });
    const output = fakeOutput();
    await runInteractiveInitWizard({ input, output });
    expect(input.rawModeCalls).toEqual([true, false]);
  });

  it("never touches setRawMode when the stream doesn't expose it (piped/non-TTY input)", async () => {
    const input = new ScriptedInput(["ghp_x\n", "4\n"]);
    expect((input as unknown as { setRawMode?: unknown }).setRawMode).toBeUndefined();
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
  });

  it("tolerates an input stream with no setEncoding method", async () => {
    const input = new ScriptedInput(["ghp_x\n", "4\n"], { hasSetEncoding: false });
    expect((input as unknown as { setEncoding?: unknown }).setEncoding).toBeUndefined();
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
  });

  it("a leading backspace on an empty value is a harmless no-op", async () => {
    const input = new ScriptedInput(["\u007fabc\n", "4\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.GITHUB_TOKEN).toBe("abc");
  });

  it("backspace during an unmasked prompt edits the value without emitting the masked erase sequence", async () => {
    const input = new ScriptedInput(["ghp_x\n", "3\u007f4\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.MINER_CODING_AGENT_PROVIDER).toBe("noop");
    expect(output.chunks.join("")).not.toContain("\b \b");
  });

  it("falls back to process.stdin/process.stdout when no streams are injected", async () => {
    const fakeStdin = new ScriptedInput(["ghp_default\n", "4\n"]);
    const fakeStdoutChunks: string[] = [];
    const fakeStdout = { write: (chunk: string) => (fakeStdoutChunks.push(chunk), true) };
    const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true });
    try {
      const result = await runInteractiveInitWizard();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.values.GITHUB_TOKEN).toBe("ghp_default");
      expect(fakeStdoutChunks.join("")).toContain("gittensory-miner interactive setup");
    } finally {
      if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
      if (originalStdout) Object.defineProperty(process, "stdout", originalStdout);
    }
  });

  it("REGRESSION: multiple answers delivered in a single data chunk (piped/non-TTY stdin) are not dropped", async () => {
    // A real piped stdin (e.g. `printf 'token\\n4\\n' | gittensory-miner init --interactive`) has no notion of
    // "one keystroke per event" -- everything already written to the pipe can arrive as ONE "data" chunk. Discarding
    // everything after the first prompt's terminator (as an earlier version of this wizard did) drops the next
    // prompt's answer and hangs forever waiting for input that already arrived.
    const input = new EventEmitter() as EventEmitter & { resume: () => void; pause: () => void };
    input.resume = () => {};
    input.pause = () => {};
    const output = fakeOutput();

    const wizardPromise = runInteractiveInitWizard({ input, output });
    input.emit("data", "ghp_onechunk\n4\n");
    const result = await wizardPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.GITHUB_TOKEN).toBe("ghp_onechunk");
      expect(result.values.MINER_CODING_AGENT_PROVIDER).toBe("noop");
    }
  });

  it("accumulates a value across several separate data events (real TTY raw-mode keystroke delivery)", async () => {
    const input = new EventEmitter() as EventEmitter & { resume: () => void; pause: () => void };
    input.resume = () => {};
    input.pause = () => {};
    const output = fakeOutput();

    const wizardPromise = runInteractiveInitWizard({ input, output });
    for (const char of "ghp_keystroke") input.emit("data", char);
    input.emit("data", "\n");
    // Let every pending microtask (the token prompt resolving, its await chain unwinding up through
    // promptGithubToken/runInteractiveInitWizard, and promptProvider registering its own "data" listener) settle
    // before sending the next answer -- a real TTY delivers keystrokes on separate ticks too, never faster than
    // the process can react.
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", "4\n");
    const result = await wizardPromise;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.GITHUB_TOKEN).toBe("ghp_keystroke");
  });

  it("carries a PARTIAL leftover (no terminator yet) into a fresh data listener rather than resolving early", async () => {
    // The leftover from the token prompt ("4", no trailing newline) is a real but incomplete answer to the next
    // prompt -- it must be combined with whatever arrives in a LATER, separate chunk, not treated as already-done.
    const input = new EventEmitter() as EventEmitter & { resume: () => void; pause: () => void };
    input.resume = () => {};
    input.pause = () => {};
    const output = fakeOutput();

    const wizardPromise = runInteractiveInitWizard({ input, output });
    input.emit("data", "ghp_partial\n4");
    await new Promise((resolve) => setImmediate(resolve));
    input.emit("data", "\n");
    const result = await wizardPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.GITHUB_TOKEN).toBe("ghp_partial");
      expect(result.values.MINER_CODING_AGENT_PROVIDER).toBe("noop");
    }
  });

  it("REGRESSION/invariant: the raw GITHUB_TOKEN value never appears in any output write, including the summary", async () => {
    const secret = "ghp_super_secret_do_not_leak_1234567890";
    const input = new ScriptedInput([`${secret}\n`, "1\n", "\n", "\n"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result.ok).toBe(true);
    for (const chunk of output.chunks) expect(chunk).not.toContain(secret);
    const text = output.chunks.join("");
    expect(text).toContain("*".repeat(secret.length));
    expect(text).toContain("GITHUB_TOKEN: (provided, hidden)");
  });

  it("aborts cleanly (ok: false) on Ctrl+C during the token prompt, with no values leaked", async () => {
    const input = new ScriptedInput(["abc\u0003"]);
    const output = fakeOutput();
    const result = await runInteractiveInitWizard({ input, output });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Ctrl+C") });
  });
});

describe("gittensory-miner runInit --interactive (#5176)", () => {
  it("writes a starter .env (mode 0600) under the state dir and mutates env in place", async () => {
    const root = tempRoot();
    const env: Record<string, string> = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const input = new ScriptedInput(["ghp_written\n", "1\n", "opus\n", "\n"]);
    const output = fakeOutput();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await runInit(["--interactive"], env, { input, output });

    expect(exitCode).toBe(0);
    expect(env.GITHUB_TOKEN).toBe("ghp_written");
    expect(env.MINER_CODING_AGENT_PROVIDER).toBe("claude-cli");
    expect(env.MINER_CODING_AGENT_CLAUDE_MODEL).toBe("opus");

    const envPath = join(root, "state", ".env");
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const contents = readFileSync(envPath, "utf8");
    expect(contents).toContain("GITHUB_TOKEN=ghp_written");
    expect(contents).toContain("MINER_CODING_AGENT_PROVIDER=claude-cli");
    expect(contents).toContain("MINER_CODING_AGENT_CLAUDE_MODEL=opus");
    expect(contents).not.toContain("MINER_CODING_AGENT_TIMEOUT_MS");
  });

  it("prints the env file path in plain-text output", async () => {
    const root = tempRoot();
    const env: Record<string, string> = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const input = new ScriptedInput(["ghp_x\n", "4\n"]);
    const output = fakeOutput();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runInit(["--interactive"], env, { input, output });

    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.startsWith("env file: ") && line.includes(join(root, "state", ".env")))).toBe(true);
  });

  it("--json output includes the envFile path alongside the standard init payload", async () => {
    const root = tempRoot();
    const env: Record<string, string> = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const input = new ScriptedInput(["ghp_x\n", "4\n"]);
    const output = fakeOutput();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await runInit(["--interactive", "--json"], env, { input, output });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.envFile).toBe(join(root, "state", ".env"));
    expect(payload.created).toBe(true);
  });

  it("never prints the raw GITHUB_TOKEN to console.log, only to the .env file", async () => {
    const root = tempRoot();
    const secret = "ghp_console_leak_check_abcdef";
    const env: Record<string, string> = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const input = new ScriptedInput([`${secret}\n`, "4\n"]);
    const output = fakeOutput();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runInit(["--interactive"], env, { input, output });

    for (const call of log.mock.calls) expect(String(call[0])).not.toContain(secret);
    const contents = readFileSync(join(root, "state", ".env"), "utf8");
    expect(contents).toContain(secret);
  });

  it("aborts without creating the state dir or the .env file when the wizard is aborted", async () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    const env: Record<string, string> = { GITTENSORY_MINER_CONFIG_DIR: stateDir };
    const input = new ScriptedInput(["abc\u0003"]);
    const output = fakeOutput();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runInit(["--interactive"], env, { input, output });

    expect(exitCode).toBe(1);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("REGRESSION: non-interactive init is byte-for-byte unchanged and never reads the injected streams", async () => {
    const root = tempRoot();
    const env: Record<string, string> = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state") };
    const input = new ScriptedInput([]);
    const untouchedInput = {
      on: () => {
        throw new Error("non-interactive init must never read from input");
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await runInit([], env, { input: untouchedInput as never, output: fakeOutput() });

    expect(exitCode).toBe(0);
    expect(log.mock.calls).toHaveLength(2);
    expect(String(log.mock.calls[0]?.[0])).toBe(`initialized ${join(root, "state")}`);
    expect(String(log.mock.calls[1]?.[0])).toContain("sqlite: ");
    expect(String(log.mock.calls[1]?.[0])).not.toContain("already existed");
    expect(existsSync(join(root, "state", ".env"))).toBe(false);
    expect(input.queue).toHaveLength(0);
  });
});
