import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Resolve the engine from source (not its built dist), matching the convention in the other miner unit suites.
vi.mock("@loopover/engine", async () => import("../../packages/gittensory-engine/src/index"));

import {
  buildProviderMenu,
  companionPromptsFor,
  DEFAULT_TIMEOUT_MS,
  formatEnvValue,
  MASKED_SECRET,
  normalizeTimeoutMs,
  parseProviderChoice,
  renderEnvFile,
  runInitWizard,
  summarizeCollectedEnv,
  WIZARD_ENV_FILENAME,
} from "../../packages/gittensory-miner/lib/init-wizard.js";

const NOW = "2026-07-13T00:00:00.000Z";
const TOKEN = "ghp_supersecrettoken";

/** A scripted, TTY-free IO: answers are dequeued in order; everything printed is captured for assertions. */
function fakeIo(answers: string[], masked: string[] = []) {
  const printed: string[] = [];
  return {
    printed,
    print: (line: string) => printed.push(line),
    prompt: async () => answers.shift() ?? "",
    promptMasked: async () => masked.shift() ?? "",
    close: () => {},
    output: () => printed.join("\n"),
  };
}

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "gt-wizard-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("init wizard pure helpers (#5176)", () => {
  it("builds the provider menu from the engine's canonical driver list", () => {
    expect(buildProviderMenu()).toEqual([
      "  1) noop",
      "  2) claude-cli",
      "  3) codex-cli",
      "  4) agent-sdk",
    ]);
  });

  it("parses a provider by menu number or by name, case/space-insensitively", () => {
    expect(parseProviderChoice("2")).toBe("claude-cli");
    expect(parseProviderChoice(" Claude-CLI ")).toBe("claude-cli");
    expect(parseProviderChoice("4")).toBe("agent-sdk");
  });

  it("rejects unknown, out-of-range, and empty provider answers (deny by default)", () => {
    for (const bad of ["", "   ", "0", "5", "99", "gpt-cli", undefined, 3 as unknown as string]) {
      expect(parseProviderChoice(bad as string)).toBeNull();
    }
  });

  it("derives companion prompts per provider from CODING_AGENT_DRIVER_CONFIG_ENV", () => {
    expect(companionPromptsFor("claude-cli").map((p) => p.envKey)).toEqual([
      "MINER_CODING_AGENT_CLAUDE_MODEL",
      "MINER_CODING_AGENT_TIMEOUT_MS",
    ]);
    expect(companionPromptsFor("codex-cli").map((p) => p.envKey)).toEqual([
      "MINER_CODING_AGENT_CODEX_MODEL",
      "MINER_CODING_AGENT_TIMEOUT_MS",
    ]);
    // noop / agent-sdk declare no model or timeout key, so they must prompt for nothing at all.
    expect(companionPromptsFor("noop")).toEqual([]);
    expect(companionPromptsFor("agent-sdk")).toEqual([]);
  });

  it("normalizes the timeout: blank keeps the default, non-positive-integers are rejected", () => {
    expect(normalizeTimeoutMs("")).toBe(DEFAULT_TIMEOUT_MS);
    expect(normalizeTimeoutMs("  ")).toBe(DEFAULT_TIMEOUT_MS);
    expect(normalizeTimeoutMs("1500")).toBe(1500);
    expect(normalizeTimeoutMs("", 900)).toBe(900);
    for (const bad of ["0", "-5", "1.5", "abc", "10s"]) {
      expect(normalizeTimeoutMs(bad)).toBeNull();
    }
  });

  it("quotes env values only when ambiguous", () => {
    expect(formatEnvValue("ghp_abc123")).toBe("ghp_abc123");
    expect(formatEnvValue("claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(formatEnvValue("has space")).toBe('"has space"');
    expect(formatEnvValue("with#hash")).toBe('"with#hash"');
    expect(formatEnvValue("")).toBe('""');
  });

  it("renders a deterministic env file and omits empty values", () => {
    const text = renderEnvFile({ GITHUB_TOKEN: TOKEN, MINER_CODING_AGENT_PROVIDER: "noop", EMPTY: "" }, NOW);
    expect(text).toContain(`# Generated: ${NOW}`);
    expect(text).toContain(`GITHUB_TOKEN=${TOKEN}`);
    expect(text).toContain("MINER_CODING_AGENT_PROVIDER=noop");
    expect(text).not.toContain("EMPTY=");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("NEVER echoes the secret back in the summary", () => {
    const lines = summarizeCollectedEnv({ GITHUB_TOKEN: TOKEN, MINER_CODING_AGENT_PROVIDER: "noop" });
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines).toContain(`  GITHUB_TOKEN=${MASKED_SECRET}`);
    expect(lines).toContain("  MINER_CODING_AGENT_PROVIDER=noop");
  });
});

describe("runInitWizard flow (#5176)", () => {
  it("collects token + provider, writes a 0600 .env, and never prints the token", async () => {
    const io = fakeIo(["2", "claude-sonnet-4", "1500"], [TOKEN]);
    const result = await runInitWizard({ stateDir, io, env: {}, now: NOW });

    expect(result.cancelled).toBe(false);
    const envPath = join(stateDir, WIZARD_ENV_FILENAME);
    const written = readFileSync(envPath, "utf8");
    expect(written).toContain(`GITHUB_TOKEN=${TOKEN}`);
    expect(written).toContain("MINER_CODING_AGENT_PROVIDER=claude-cli");
    expect(written).toContain("MINER_CODING_AGENT_CLAUDE_MODEL=claude-sonnet-4");
    expect(written).toContain("MINER_CODING_AGENT_TIMEOUT_MS=1500");
    // The token must never reach the terminal — not while typing, not in the summary.
    expect(io.output()).not.toContain(TOKEN);
    expect(io.output()).toContain(MASKED_SECRET);
    // The file holds a credential, so it must be owner-only. Windows has no POSIX mode bits (chmod is a no-op
    // there), so this invariant is only assertable on POSIX — matching how the other miner store suites treat it.
    if (process.platform !== "win32") {
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    }
  });

  it("offers the default timeout when the answer is blank, and skips a blank model", async () => {
    const io = fakeIo(["2", "", ""], [TOKEN]);
    await runInitWizard({ stateDir, io, env: {}, now: NOW });
    const written = readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8");
    expect(written).toContain(`MINER_CODING_AGENT_TIMEOUT_MS=${DEFAULT_TIMEOUT_MS}`);
    expect(written).not.toContain("MINER_CODING_AGENT_CLAUDE_MODEL");
  });

  it("leaves the timeout unset (driver default) when the answer is not a positive integer", async () => {
    const io = fakeIo(["2", "", "soon"], [TOKEN]);
    await runInitWizard({ stateDir, io, env: {}, now: NOW });
    const written = readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8");
    expect(written).not.toContain("MINER_CODING_AGENT_TIMEOUT_MS");
    expect(io.output()).toContain("not a positive whole number");
  });

  it("prompts for no companion vars when the provider declares none", async () => {
    const io = fakeIo(["1"], [TOKEN]); // noop
    await runInitWizard({ stateDir, io, env: {}, now: NOW });
    const written = readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8");
    expect(written).toContain("MINER_CODING_AGENT_PROVIDER=noop");
    expect(written).not.toContain("MINER_CODING_AGENT_TIMEOUT_MS");
  });

  it("cancels without writing when no token is supplied", async () => {
    const io = fakeIo(["2"], [""]);
    const result = await runInitWizard({ stateDir, io, env: {}, now: NOW });
    expect(result).toMatchObject({ cancelled: true, reason: "missing_token" });
    expect(() => readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8")).toThrow();
  });

  it("cancels without writing when the provider choice is invalid", async () => {
    const io = fakeIo(["nope"], [TOKEN]);
    const result = await runInitWizard({ stateDir, io, env: {}, now: NOW });
    expect(result).toMatchObject({ cancelled: true, reason: "invalid_provider" });
    expect(() => readFileSync(join(stateDir, WIZARD_ENV_FILENAME), "utf8")).toThrow();
  });

  it("refuses to clobber an existing .env unless the operator explicitly confirms", async () => {
    const envPath = join(stateDir, WIZARD_ENV_FILENAME);
    writeFileSync(envPath, "PRE_EXISTING=1\n");

    const declined = await runInitWizard({ stateDir, io: fakeIo(["n"]), env: {}, now: NOW });
    expect(declined).toMatchObject({ cancelled: true, reason: "declined_overwrite" });
    expect(readFileSync(envPath, "utf8")).toBe("PRE_EXISTING=1\n"); // untouched

    const accepted = await runInitWizard({ stateDir, io: fakeIo(["y", "1"], [TOKEN]), env: {}, now: NOW });
    expect(accepted.cancelled).toBe(false);
    expect(readFileSync(envPath, "utf8")).toContain("MINER_CODING_AGENT_PROVIDER=noop");
  });
});
