import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Forward every real execFileSync (git metadata + the packaged/fixture scorer subprocesses the other
// tests spawn for real) untouched, and only hijack a NON-git sentinel command when a test opts in via
// execHooks.scorerOverride. This lets the branch-coverage tests below drive classifyScorerExecFailure's
// error-shape branches (SIGTERM-without-ETIMEDOUT, "...JSON..." messages, signal kills with stderr) and
// normalizeScorerOutput's camel/snake/nested shapes deterministically, without disturbing the existing
// real-subprocess tests or the real git calls inside buildBranchAnalysisPayload.
const execHooks = vi.hoisted(() => ({
  scorerOverride: null as null | ((command: string, args: readonly string[], options: Record<string, unknown>) => string),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped = ((command: unknown, args?: unknown, options?: unknown) => {
    if (command === "git" || execHooks.scorerOverride === null) {
      return (actual.execFileSync as (...callArgs: unknown[]) => unknown)(command, args, options);
    }
    return execHooks.scorerOverride(command as string, (args ?? []) as readonly string[], (options ?? {}) as Record<string, unknown>);
  }) as typeof actual.execFileSync;
  return { ...actual, execFileSync: wrapped };
});

function fixtureCommand(name: string) {
  return `node ${join(process.cwd(), "test/fixtures/local-scorer", name)}`;
}

// Points at the real bundled scorer script the package ships, so this test exercises it end to end.
// Lives here (not exported from lib/local-branch.js) since this test is its only real caller (#6259) --
// production guidance text always uses the intentionally generic, path-redacted referenceScorePreviewExample.
function packagedScorerCommand(kind: "metadata" | "gittensor" = "metadata") {
  const script = kind === "gittensor" ? "gittensor-score-preview.py" : "gittensor-score-preview.mjs";
  const interpreter = kind === "gittensor" ? "python3" : "node";
  return `${interpreter} ${join(process.cwd(), "packages/loopover-mcp/scripts", script)}`;
}

describe("local scorer adapter", () => {
  const metadata = {
    repoFullName: "entrius/allways-ui",
    branchName: "fix-cache",
    repoRoot: process.cwd(),
    changedFiles: [
      { path: "src/cache.ts", additions: 12, deletions: 2, status: "modified" },
      { path: "test/cache.test.ts", additions: 8, deletions: 0, status: "added" },
    ],
  };

  let previousCommand: string | undefined;
  let previousTimeout: string | undefined;
  let previousGittensorRoot: string | undefined;

  afterEach(() => {
    if (previousCommand === undefined) delete process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    else process.env.GITTENSOR_SCORE_PREVIEW_CMD = previousCommand;
    if (previousTimeout === undefined) delete process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    else process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = previousTimeout;
    if (previousGittensorRoot === undefined) delete process.env.GITTENSOR_ROOT;
    else process.env.GITTENSOR_ROOT = previousGittensorRoot;
  });

  it("returns structured success output from a working scorer command", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-success.mjs"));
    expect(result).toMatchObject({
      ok: true,
      code: "success",
      fallbackMode: "external_command",
      payload: { sourceTokenScore: 42, totalTokenScore: 50 },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports missing scorer command with setup guidance", async () => {
    const { runExternalScorePreview, setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, undefined);
    expect(result).toMatchObject({ ok: false, code: "missing_scorer_command", fallbackMode: "metadata_only" });
    const guidance = setupGuidanceForLocalScorer(result).join(" ");
    expect(guidance).toMatch(/GITTENSOR_SCORE_PREVIEW_CMD/);
    expect(guidance).not.toMatch(process.cwd());
  });

  it("handles scorer timeouts without crashing analysis", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    previousTimeout = process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "200";
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-timeout.mjs"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("timeout");
    expect(result.fallbackMode).toBe("metadata_only");
  });

  it("handles malformed scorer JSON and non-zero exits", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const malformed = runExternalScorePreview(metadata, fixtureCommand("scorer-malformed.mjs"));
    expect(malformed).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });

    const failing = runExternalScorePreview(metadata, fixtureCommand("scorer-nonzero.mjs"));
    expect(failing).toMatchObject({ ok: false, code: "non_zero_exit", fallbackMode: "metadata_only" });
    expect(failing.exitCode).toBe(7);
  });

  it("falls back to metadata-only scorer output and keeps source upload disabled", async () => {
    const { buildBranchAnalysisPayload, collectLocalBranchMetadata } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const payload = buildBranchAnalysisPayload({
      cwd: process.cwd(),
      repoFullName: "JSONbored/loopover",
      baseRef: "HEAD",
      login: "local",
      scorePreviewCommand: fixtureCommand("scorer-nonzero.mjs"),
    });
    expect(payload.localScorer).toMatchObject({ mode: "metadata_only" });
    expect(payload.localScorerStatus.ok).toBe(false);
    expect(payload).not.toHaveProperty("repoRoot");
    expect(JSON.stringify(payload)).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);

    process.env.LOOPOVER_UPLOAD_SOURCE = "true";
    expect(() => collectLocalBranchMetadata({ cwd: process.cwd(), repoFullName: "JSONbored/loopover", login: "local" })).toThrow(/not supported/);
    delete process.env.LOOPOVER_UPLOAD_SOURCE;
  });

  it("runs the packaged reference scorer against metadata only", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, packagedScorerCommand("metadata"));
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      sourceTokenScore: expect.any(Number),
      totalTokenScore: expect.any(Number),
    });
  });

  it("redacts local paths from scorer diagnostics and setup guidance", async () => {
    const { probeLocalScorer, redactLocalPath, redactScorerCommand, sanitizeLocalScorerStatus, setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");

    previousGittensorRoot = process.env.GITTENSOR_ROOT;
    previousCommand = process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    process.env.GITTENSOR_ROOT = "/secret/home/user/gittensor";
    process.env.GITTENSOR_SCORE_PREVIEW_CMD = `/secret/opt/tools/node /secret/home/user/loopover-mcp/scripts/gittensor-score-preview.mjs`;

    expect(redactLocalPath("/secret/home/user/gittensor")).not.toContain("/secret/home/user");
    expect(redactScorerCommand(process.env.GITTENSOR_SCORE_PREVIEW_CMD)).toBe("node <scorer-script>/gittensor-score-preview.mjs");

    const status = sanitizeLocalScorerStatus({
      ok: false,
      code: "scorer_failed",
      reason: "failed under /secret/home/user/gittensor",
      stderr: "/secret/home/user/output.txt",
      scorerCommand: process.env.GITTENSOR_SCORE_PREVIEW_CMD,
    });
    expect(JSON.stringify(status)).not.toMatch(/\/secret\/home\/user/);

    const guidance = setupGuidanceForLocalScorer({ ok: false, code: "missing_scorer_command" }).join("\n");
    expect(guidance).not.toMatch(/\/secret\/home\/user/);
    expect(guidance).toMatch(/node_modules\/@loopover\/mcp\/scripts\//);

    const probe = probeLocalScorer(process.env.GITTENSOR_SCORE_PREVIEW_CMD);
    expect(JSON.stringify(probe)).not.toMatch(/\/secret\/home\/user/);
  });
});

describe("local scorer adapter branch coverage", () => {
  const ENV_KEYS = ["GITTENSOR_SCORE_PREVIEW_CMD", "GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS", "GITTENSOR_ROOT"] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    delete process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    delete process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
  });

  afterEach(() => {
    execHooks.scorerOverride = null;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const meta = { repoFullName: "entrius/allways-ui" } as Record<string, unknown>;

  it("resolves the score-preview command from explicit input, env, or nothing", async () => {
    const { resolveScorePreviewCommand } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(resolveScorePreviewCommand({ scorePreviewCommand: "  node scorer.mjs  " })).toBe("node scorer.mjs");
    expect(resolveScorePreviewCommand({ scorePreviewCommand: "   " })).toBeUndefined();
    expect(resolveScorePreviewCommand({})).toBeUndefined();
    expect(resolveScorePreviewCommand()).toBeUndefined();
    process.env.GITTENSOR_SCORE_PREVIEW_CMD = "  node from-env.mjs  ";
    expect(resolveScorePreviewCommand({})).toBe("node from-env.mjs");
    expect(resolveScorePreviewCommand({ scorePreviewCommand: "node explicit.mjs" })).toBe("node explicit.mjs");
  });

  it("builds reference score-preview examples for metadata and gittensor kinds", async () => {
    const { referenceScorePreviewExample } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(referenceScorePreviewExample("gittensor")).toBe("python3 ./node_modules/@loopover/mcp/scripts/gittensor-score-preview.py");
    expect(referenceScorePreviewExample("metadata")).toBe("node ./node_modules/@loopover/mcp/scripts/gittensor-score-preview.mjs");
    expect(referenceScorePreviewExample()).toBe("node ./node_modules/@loopover/mcp/scripts/gittensor-score-preview.mjs");
  });

  it("redacts scorer commands to interpreter + script basename, with safe fallbacks", async () => {
    const { redactScorerCommand } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(redactScorerCommand("/usr/local/bin/python3 /home/me/tools/score.py")).toBe("python3 <scorer-script>/score.py");
    expect(redactScorerCommand('node "/quoted path/score.mjs"')).toBe("node <scorer-script>/score.mjs");
    expect(redactScorerCommand("some-binary --flag value")).toBe("<configured-scorer-command>");
    expect(redactScorerCommand("")).toBe("");
    expect(redactScorerCommand(null)).toBe("");
    expect(redactScorerCommand(undefined)).toBe("");
  });

  it("sanitizes scorer status objects and passes non-objects through unchanged", async () => {
    const { sanitizeLocalScorerStatus } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(sanitizeLocalScorerStatus(null as unknown as { ok?: boolean })).toBeNull();
    expect(sanitizeLocalScorerStatus("nope" as unknown as { ok?: boolean })).toBe("nope");
    const sanitized = sanitizeLocalScorerStatus({
      ok: false,
      code: "scorer_failed",
      reason: "failed under /home/user/project/scorer",
      stderr: "trace at /home/user/project/log.txt",
      scorerCommand: "node /home/user/scripts/score.mjs",
      exitCode: 2,
    });
    expect(String(sanitized.reason)).not.toContain("/home/user");
    expect(String(sanitized.stderr)).not.toContain("/home/user");
    expect(sanitized.scorerCommand).toBe("node <scorer-script>/score.mjs");
    expect(sanitized.exitCode).toBe(2);
    expect(sanitizeLocalScorerStatus({ ok: true })).toEqual({ ok: true });
  });

  it("returns no setup guidance when the scorer already succeeded", async () => {
    const { setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(setupGuidanceForLocalScorer({ ok: true })).toEqual([]);
  });

  it("tailors setup guidance to each explicit scorer failure code", async () => {
    const { setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(setupGuidanceForLocalScorer({ ok: false, code: "empty_scorer_command" }).join(" ")).toMatch(/set but empty/i);
    expect(setupGuidanceForLocalScorer({ ok: false, code: "timeout" }).join(" ")).toMatch(/exceeded \d+ms/i);

    const malformedWith = setupGuidanceForLocalScorer({ ok: false, code: "malformed_json", stderr: "partial output here" }).join("\n");
    expect(malformedWith).toMatch(/one JSON object/i);
    expect(malformedWith).toMatch(/Last scorer stdout snippet: partial output here/);
    expect(setupGuidanceForLocalScorer({ ok: false, code: "malformed_json" }).join("\n")).not.toMatch(/stdout snippet/i);

    const nonZeroWith = setupGuidanceForLocalScorer({ ok: false, code: "non_zero_exit", stderr: `boom-${"x".repeat(200)}`, exitCode: 5 }).join("\n");
    expect(nonZeroWith).toMatch(/non-zero status/i);
    expect(nonZeroWith).toMatch(/Scorer stderr: boom-x/);
    expect(nonZeroWith).toMatch(/\.\.\.$/m); // long stderr is truncated with an ellipsis
    expect(nonZeroWith).toMatch(/Exit code: 5/);
    const nonZeroWithout = setupGuidanceForLocalScorer({ ok: false, code: "non_zero_exit" }).join("\n");
    expect(nonZeroWithout).not.toMatch(/Scorer stderr/);
    expect(nonZeroWithout).not.toMatch(/Exit code/);

    const defaultWith = setupGuidanceForLocalScorer({ ok: false, code: "some_unknown_code", reason: "mystery failure" }).join("\n");
    expect(defaultWith).toMatch(/reads branch metadata JSON from stdin/i);
    expect(defaultWith).toMatch(/Last scorer error: mystery failure/);
    expect(setupGuidanceForLocalScorer({ ok: false, code: "some_unknown_code" }).join("\n")).not.toMatch(/Last scorer error/);
  });

  it("infers the scorer failure code from the reason when no code is present", async () => {
    const { setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "GITTENSOR_SCORE_PREVIEW_CMD missing_scorer_command detail" }).join("\n")).toMatch(/export GITTENSOR_SCORE_PREVIEW_CMD/);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "empty_scorer_command was set" }).join("\n")).toMatch(/set but empty/i);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "External scorer timed out after 15000ms." }).join("\n")).toMatch(/exceeded \d+ms/i);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "stdout was not valid JSON." }).join("\n")).toMatch(/one JSON object/i);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "External scorer exited with status 7." }).join("\n")).toMatch(/non-zero status/i);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "some random breakage" }).join("\n")).toMatch(/reads branch metadata JSON from stdin/i);
    // Neither code nor reason present: inferScorerCode coerces undefined -> "" -> scorer_failed default.
    expect(setupGuidanceForLocalScorer({ ok: false }).join("\n")).toMatch(/reads branch metadata JSON from stdin/i);
  });

  it("falls back to the default score-preview timeout for invalid env values", async () => {
    const { setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "not-a-number";
    expect(setupGuidanceForLocalScorer({ ok: false, code: "timeout" }).join("\n")).toMatch(/exceeded 15000ms/);
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "0";
    expect(setupGuidanceForLocalScorer({ ok: false, code: "timeout" }).join("\n")).toMatch(/exceeded 15000ms/);
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "500";
    expect(setupGuidanceForLocalScorer({ ok: false, code: "timeout" }).join("\n")).toMatch(/exceeded 500ms/);
  });

  it("flags a whitespace-only scorer command as empty", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(runExternalScorePreview(meta, "   ")).toMatchObject({ ok: false, code: "empty_scorer_command", fallbackMode: "metadata_only" });
  });

  it("accepts snake_case and nested scorer JSON shapes", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => JSON.stringify({ active_model: "m", source_token_score: 40, total_token_score: 60, source_lines: 38, test_token_score: 8, non_code_token_score: 2 });
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: true, code: "success", fallbackMode: "external_command" });
    execHooks.scorerOverride = () => JSON.stringify({ source: { tokenScore: 40, lines: 38 }, total: { tokenScore: 60 }, tests: { tokenScore: 8 }, nonCode: { tokenScore: 2 } });
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: true, code: "success" });
  });

  it("rejects non-object and score-less scorer JSON", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => JSON.stringify([1, 2, 3]);
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });
    execHooks.scorerOverride = () => JSON.stringify({ note: "no scores here" });
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });
  });

  it("classifies scorer stdout that is not JSON as malformed", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => {
      throw Object.assign(new Error("Command failed"), { stdout: "garbage-not-json", status: 3, stderr: "" });
    };
    const result = runExternalScorePreview(meta, "mock-scorer");
    expect(result).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });
    expect(result.stderr).toBe("garbage-not-json");
    expect(result.scorerCommand).toBe("<configured-scorer-command>");
  });

  it("classifies a SIGTERM-killed scorer as a timeout even without ETIMEDOUT", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => {
      throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    };
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: false, code: "timeout" });
  });

  it("classifies a JSON parse error message as malformed without captured stdout", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => {
      throw new Error("Unexpected token o in JSON at position 1");
    };
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: false, code: "malformed_json" });
  });

  it("classifies a signal kill whose stderr is not JSON as malformed", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => {
      throw Object.assign(new Error("Command failed"), { signal: "SIGKILL", stderr: "boom on stderr" });
    };
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: false, code: "malformed_json" });
  });

  it("classifies an unknown scorer failure (ENOENT) and redacts the message", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(meta, "definitely-not-a-real-binary-xyzq");
    expect(result).toMatchObject({ ok: false, code: "scorer_failed", fallbackMode: "metadata_only" });
  });

  it("classifies exec failures by inspecting the captured stdout JSON shape", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const withStdout = (stdout: string, status = 4) => {
      execHooks.scorerOverride = () => {
        throw Object.assign(new Error("Command failed"), { stdout, status });
      };
      return runExternalScorePreview(meta, "mock-scorer");
    };
    // Valid scorer JSON on stdout despite the non-zero exit -> NOT malformed; classified by exit code.
    expect(withStdout(JSON.stringify({ sourceTokenScore: 1 }))).toMatchObject({ ok: false, code: "non_zero_exit", exitCode: 4 });
    expect(withStdout(JSON.stringify({ totalTokenScore: 5 }))).toMatchObject({ ok: false, code: "non_zero_exit" });
    // Well-formed JSON that is not a usable scorer object -> malformed.
    for (const bad of [JSON.stringify({ foo: 1 }), "[1,2,3]", "42", "null"]) {
      expect(withStdout(bad)).toMatchObject({ ok: false, code: "malformed_json" });
    }
  });

  it("classifies a non-Error, non-object throw as a generic scorer failure", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => {
      throw "plain string failure";
    };
    expect(runExternalScorePreview(meta, "mock-scorer")).toMatchObject({ ok: false, code: "scorer_failed" });
  });

  it("normalizes a successful external scorer payload into localScorer fields", async () => {
    const { buildBranchAnalysisPayload } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => JSON.stringify({ activeModel: "density-v2", sourceTokenScore: 42, totalTokenScore: 70, sourceLines: 40, testTokenScore: 12, nonCodeTokenScore: 3, warnings: ["w1", 2], ignored: "field" });
    const payload = buildBranchAnalysisPayload({ cwd: process.cwd(), repoFullName: "JSONbored/loopover", baseRef: "HEAD", login: "local", scorePreviewCommand: "mock-scorer" });
    expect(payload.localScorer).toEqual({
      mode: "external_command",
      activeModel: "density-v2",
      sourceTokenScore: 42,
      totalTokenScore: 70,
      sourceLines: 40,
      testTokenScore: 12,
      nonCodeTokenScore: 3,
      warnings: ["w1", "2"],
    });
    expect(payload.localScorerStatus).toMatchObject({ ok: true, code: "success" });
  });

  it("drops blank activeModel, non-numeric scores, and non-array warnings during normalization", async () => {
    const { buildBranchAnalysisPayload } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    execHooks.scorerOverride = () => JSON.stringify({ activeModel: "   ", sourceTokenScore: 15, totalTokenScore: "not-a-number", warnings: "not-an-array" });
    const payload = buildBranchAnalysisPayload({ cwd: process.cwd(), repoFullName: "JSONbored/loopover", baseRef: "HEAD", login: "local", scorePreviewCommand: "mock-scorer" });
    expect(payload.localScorer).toEqual({ mode: "external_command", sourceTokenScore: 15 });
  });

  it("probes the local scorer using the resolved command by default", async () => {
    const { probeLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(probeLocalScorer()).toMatchObject({ ok: false, code: "missing_scorer_command" });
  });
});
