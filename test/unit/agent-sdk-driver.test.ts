import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSdkCodingAgentDriver,
  parseGitStatusPorcelain,
  type AgentSdkQueryFn,
  type CodingAgentDriverTask,
} from "../../packages/gittensory-engine/src/index";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const task: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/tmp/attempt-1",
  acceptanceCriteriaPath: "/tmp/attempt-1/acceptance-criteria.json",
  instructions: "fix the flaky test",
  maxTurns: 8,
};

function successResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "result" as const,
    subtype: "success" as const,
    is_error: false,
    num_turns: 3,
    result: "fixed the flaky test",
    ...overrides,
  };
}

function assistantMessage(text: string) {
  return {
    type: "assistant" as const,
    message: { content: [{ type: "text", text }] },
  };
}

function fakeQuery(messages: unknown[]): AgentSdkQueryFn {
  return (() =>
    (async function* () {
      for (const message of messages) yield message;
    })()) as unknown as AgentSdkQueryFn;
}

describe("parseGitStatusPorcelain (#4267)", () => {
  it("parses modified/added/untracked lines", () => {
    expect(parseGitStatusPorcelain(" M src/foo.ts\nA  src/bar.ts\n?? src/baz.ts\n")).toEqual([
      "src/foo.ts",
      "src/bar.ts",
      "src/baz.ts",
    ]);
  });

  it("keeps only the new path for a rename/copy line", () => {
    expect(parseGitStatusPorcelain("R  src/old.ts -> src/new.ts\n")).toEqual(["src/new.ts"]);
  });

  it("returns an empty array for empty or whitespace-only output", () => {
    expect(parseGitStatusPorcelain("")).toEqual([]);
    expect(parseGitStatusPorcelain("\n\n")).toEqual([]);
  });

  it("strips trailing carriage returns", () => {
    expect(parseGitStatusPorcelain(" M src/foo.ts\r\n")).toEqual(["src/foo.ts"]);
  });
});

describe("createAgentSdkCodingAgentDriver (#4267)", () => {
  it("maps a successful result message into an ok CodingAgentDriverResult, joining assistant text into the transcript", async () => {
    const driver = createAgentSdkCodingAgentDriver({
      query: fakeQuery([assistantMessage("reading the code"), assistantMessage("applied the fix"), successResult()]),
      listChangedFiles: async (cwd) => (cwd === task.workingDirectory ? [] : []),
    });
    const result = await driver.run(task);
    expect(result).toMatchObject({
      ok: true,
      summary: "fixed the flaky test",
      turnsUsed: 3,
      changedFiles: [],
    });
    expect(result.transcript).toBe("reading the code\n\napplied the fix");
  });

  it("diffs changedFiles as (after - before), so a pre-existing dirty file is excluded but a new edit is kept", async () => {
    let call = 0;
    const driver = createAgentSdkCodingAgentDriver({
      query: fakeQuery([successResult()]),
      listChangedFiles: async () => {
        call += 1;
        return call === 1 ? ["acceptance-criteria.json"] : ["acceptance-criteria.json", "src/foo.ts"];
      },
    });
    const result = await driver.run(task);
    expect(result.changedFiles).toEqual(["src/foo.ts"]);
  });

  it("reports ok:false when the result message itself carries is_error:true despite subtype 'success'", async () => {
    const driver = createAgentSdkCodingAgentDriver({
      query: fakeQuery([successResult({ is_error: true })]),
      listChangedFiles: async () => [],
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
  });

  it("maps a non-success result subtype into ok:false with a joined error message", async () => {
    const driver = createAgentSdkCodingAgentDriver({
      query: fakeQuery([
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          num_turns: 8,
          errors: ["exceeded max turns"],
        },
      ]),
      listChangedFiles: async () => [],
    });
    const result = await driver.run(task);
    expect(result).toMatchObject({
      ok: false,
      summary: "agent-sdk driver error_max_turns",
      turnsUsed: 8,
      error: "exceeded max turns",
    });
  });

  it("falls back to the subtype string when the error result has no errors entries", async () => {
    const driver = createAgentSdkCodingAgentDriver({
      query: fakeQuery([
        { type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 2, errors: [] },
      ]),
      listChangedFiles: async () => [],
    });
    const result = await driver.run(task);
    expect(result.error).toBe("error_max_budget_usd");
  });

  it("reports ok:false with missing_result_message when the stream ends without a result message", async () => {
    const driver = createAgentSdkCodingAgentDriver({
      query: fakeQuery([assistantMessage("still working")]),
      listChangedFiles: async () => [],
    });
    const result = await driver.run(task);
    expect(result).toMatchObject({ ok: false, error: "missing_result_message" });
    expect(result.transcript).toBe("still working");
  });

  it("returns ok:false with the caught error message when the query stream throws", async () => {
    const throwingQuery: AgentSdkQueryFn = (() =>
      (async function* () {
        yield assistantMessage("about to fail");
        throw new Error("session crashed");
      })()) as unknown as AgentSdkQueryFn;
    const driver = createAgentSdkCodingAgentDriver({ query: throwingQuery, listChangedFiles: async () => [] });
    const result = await driver.run(task);
    expect(result).toMatchObject({ ok: false, changedFiles: [], error: "session crashed" });
  });

  it("redacts a known secret shape out of both the transcript accumulated so far and a thrown error message", async () => {
    const secretToken = "sk-ant-abcdefghijklmnopqrstuvwxyz";
    const throwingQuery: AgentSdkQueryFn = (() =>
      (async function* () {
        yield assistantMessage(`leaked token ${secretToken}`);
        throw new Error(`auth failed with ${secretToken}`);
      })()) as unknown as AgentSdkQueryFn;
    const driver = createAgentSdkCodingAgentDriver({ query: throwingQuery, listChangedFiles: async () => [] });
    const result = await driver.run(task);
    expect(result.error).not.toContain(secretToken);
    expect(result.error).toContain("[redacted]");
    expect(result.transcript).not.toContain(secretToken);
    expect(result.transcript).toContain("[redacted]");
  });

  it("forwards options.hooks verbatim into the query() call's options.hooks", async () => {
    const hooks = { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] } as never;
    let capturedOptions: Record<string, unknown> | undefined;
    const capturingQuery: AgentSdkQueryFn = ((params: { options?: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return (async function* () {
        yield successResult();
      })();
    }) as unknown as AgentSdkQueryFn;
    const driver = createAgentSdkCodingAgentDriver({ query: capturingQuery, hooks, listChangedFiles: async () => [] });
    await driver.run(task);
    expect(capturedOptions?.hooks).toBe(hooks);
  });

  it("omits the hooks key entirely from query() options when no hooks were configured", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const capturingQuery: AgentSdkQueryFn = ((params: { options?: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return (async function* () {
        yield successResult();
      })();
    }) as unknown as AgentSdkQueryFn;
    const driver = createAgentSdkCodingAgentDriver({ query: capturingQuery, listChangedFiles: async () => [] });
    await driver.run(task);
    expect(capturedOptions).not.toHaveProperty("hooks");
  });

  it("passes cwd/maxTurns from the task through to query() options, and allowlists the env (dropping non-allowlisted vars, keeping ANTHROPIC_API_KEY)", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const capturingQuery: AgentSdkQueryFn = ((params: { options?: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return (async function* () {
        yield successResult();
      })();
    }) as unknown as AgentSdkQueryFn;
    const driver = createAgentSdkCodingAgentDriver({
      query: capturingQuery,
      listChangedFiles: async () => [],
      env: { HOME: "/home/miner", ANTHROPIC_API_KEY: "sk-ant-test-key-000000000000", SECRET_OTHER: "nope" },
    });
    await driver.run(task);
    expect(capturedOptions).toMatchObject({ cwd: task.workingDirectory, maxTurns: task.maxTurns });
    expect((capturedOptions?.env as Record<string, string>).HOME).toBe("/home/miner");
    expect((capturedOptions?.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-ant-test-key-000000000000");
    expect(capturedOptions?.env).not.toHaveProperty("SECRET_OTHER");
  });

  it("with no listChangedFiles injected, the default implementation diffs a real git-status snapshot in the working directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sdk-driver-"));
    roots.push(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "pre-existing.txt"), "already dirty before the attempt\n");

    const editDuringAttempt: AgentSdkQueryFn = (() =>
      (async function* () {
        // Simulate the coding agent editing a file mid-attempt, the same way a real Edit/Write tool call would --
        // this must happen DURING iteration (after the "before" snapshot, before the "after" one), not eagerly.
        writeFileSync(join(root, "fixed.ts"), "// fix applied\n");
        yield successResult();
      })()) as unknown as AgentSdkQueryFn;
    const driver = createAgentSdkCodingAgentDriver({ query: editDuringAttempt });
    const result = await driver.run({ ...task, workingDirectory: root });

    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(["fixed.ts"]); // pre-existing.txt was already dirty -> excluded by the diff
  });

  it("the default listChangedFiles implementation rejects when the working directory is not a git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sdk-driver-not-git-"));
    roots.push(root);

    const driver = createAgentSdkCodingAgentDriver({ query: fakeQuery([successResult()]) });
    await expect(driver.run({ ...task, workingDirectory: root })).rejects.toThrow();
  });

  it("ignores non-text assistant content blocks (e.g. tool_use) when building the transcript", async () => {
    const driver = createAgentSdkCodingAgentDriver({
      query: fakeQuery([
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Edit", input: {} }, { type: "text", text: "done" }] },
        },
        successResult(),
      ]),
      listChangedFiles: async () => [],
    });
    const result = await driver.run(task);
    expect(result.transcript).toBe("done");
  });

  it("falls back to 'unknown error' when the query stream throws a non-Error value", async () => {
    const throwingQuery: AgentSdkQueryFn = (() =>
      (async function* () {
        throw "not an Error instance";
      })()) as unknown as AgentSdkQueryFn;
    const driver = createAgentSdkCodingAgentDriver({ query: throwingQuery, listChangedFiles: async () => [] });
    const result = await driver.run(task);
    expect(result.error).toBe("unknown error");
  });

  it("constructing the driver with no injected query falls back to the real Agent SDK query() reference without invoking it", () => {
    const driver = createAgentSdkCodingAgentDriver({});
    expect(typeof driver.run).toBe("function");
  });
});
