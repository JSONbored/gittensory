import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEngineVersionSkewCheck,
  collectStatus,
  compareInstalledEngineVersion,
  readExpectedEnginePackageVersion,
  readExpectedEnginePackageVersionFromPaths,
  readInstalledEnginePackageVersion,
  readInstalledEnginePackageVersionFromPaths,
  resolveMinerStateDir,
  runDoctor,
  runDoctorChecks,
  runStatus,
} from "../../packages/gittensory-miner/lib/status.js";
import { initLaptopState } from "../../packages/gittensory-miner/lib/laptop-init.js";

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-status-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates an executable file `name` in a fresh bin dir and returns that dir (usable directly as PATH). */
function fakeBinDir(name: string): string {
  const dir = tempRoot();
  writeFileSync(join(dir, name), "#!/bin/sh\n");
  chmodSync(join(dir, name), 0o755);
  return dir;
}

describe("gittensory-miner status/doctor (#2288)", () => {
  it("resolves the state dir from the config-dir override, XDG, then the home default", () => {
    expect(resolveMinerStateDir({ GITTENSORY_MINER_CONFIG_DIR: "/custom/state" })).toBe("/custom/state");
    expect(resolveMinerStateDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gittensory-miner");
    expect(resolveMinerStateDir({})).toMatch(/\/\.config\/gittensory-miner$/);
  });

  it("collectStatus reports the installed versions, state dir, and config-file discovery", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-miner.yml"), "minerEnabled: true\n");
    const status = collectStatus({ GITTENSORY_MINER_CONFIG_DIR: join(root, "state") }, root);
    expect(status.package.name).toBe("@jsonbored/gittensory-miner");
    expect(typeof status.package.version).toBe("string");
    expect(status.engine.name).toBe("@jsonbored/gittensory-engine");
    expect(status.stateDir).toBe(join(root, "state"));
    expect(status.configFile).toBe(join(root, ".gittensory-miner.yml")); // discovered
  });

  it("collectStatus prefers GITTENSORY_MINER_VERSION over package.json (#4310)", () => {
    const status = collectStatus(
      {
        GITTENSORY_MINER_CONFIG_DIR: "/s",
        GITTENSORY_MINER_VERSION: "gittensory-miner-fleet@deadbeef",
      },
      tempRoot(),
    );
    expect(status.package.version).toBe("gittensory-miner-fleet@deadbeef");
  });

  it("runStatus prints human-readable text (0) and machine JSON with --json", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus([], { GITTENSORY_MINER_CONFIG_DIR: "/s" }, tempRoot())).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("@jsonbored/gittensory-miner");
    log.mockClear();
    expect(runStatus(["--json"], { GITTENSORY_MINER_CONFIG_DIR: "/s" }, tempRoot())).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).stateDir).toBe("/s");
  });

  it("doctor passes on a healthy setup (writable state dir, initialized sqlite, optional Docker, GITHUB_TOKEN set)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state"), GITHUB_TOKEN: "ghp_faketoken" };
    initLaptopState(env);
    const checks = runDoctorChecks(env);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.map((check) => check.name)).toEqual([
      "node-version",
      "engine-resolves",
      "engine-version-skew",
      "state-dir-writable",
      "laptop-state-sqlite",
      "docker-present",
      "claude-cli-present",
      "codex-cli-present",
      "github-token-present",
      "coding-agent-credential-present",
    ]);
    expect(runDoctor([], env)).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("engine version skew helpers compare installed vs expected semver", () => {
    expect(compareInstalledEngineVersion("0.2.0", "0.2.0")).toBe(0);
    expect(compareInstalledEngineVersion("0.1.0", "0.2.0")).toBe(-1);
    expect(compareInstalledEngineVersion("0.3.0", "0.2.0")).toBe(1);
    expect(typeof readInstalledEnginePackageVersion()).toBe("string");
    expect(readExpectedEnginePackageVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("buildEngineVersionSkewCheck skips when expected version is unavailable", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => "0.2.0",
      () => null,
    );
    expect(skewCheck.ok).toBe(true);
    expect(skewCheck.detail).toContain("skipped");
  });

  it("buildEngineVersionSkewCheck fails when installed engine is missing", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => null,
      () => "0.2.0",
    );
    expect(skewCheck.ok).toBe(false);
    expect(skewCheck.detail).toContain("not installed");
  });

  it("readExpectedEnginePackageVersionFromPaths prefers monorepo package.json then the pin file", () => {
    const root = tempRoot();
    const monorepoPkg = join(root, "engine-package.json");
    const pinFile = join(root, "expected-engine.version");
    writeFileSync(monorepoPkg, JSON.stringify({ version: "0.2.0" }));
    writeFileSync(pinFile, "0.1.0\n");
    expect(readExpectedEnginePackageVersionFromPaths(monorepoPkg, pinFile)).toBe("0.2.0");

    expect(readExpectedEnginePackageVersionFromPaths(join(root, "missing.json"), pinFile)).toBe("0.1.0");
    expect(readExpectedEnginePackageVersionFromPaths(join(root, "missing.json"), join(root, "missing-pin"))).toBeNull();
    writeFileSync(join(root, "broken.json"), "not-json");
    expect(readExpectedEnginePackageVersionFromPaths(join(root, "broken.json"), pinFile)).toBeNull();
  });

  it("readInstalledEnginePackageVersionFromPaths falls back to the workspace engine package", () => {
    const root = tempRoot();
    const workspacePkg = join(root, "gittensory-engine-package.json");
    writeFileSync(workspacePkg, JSON.stringify({ version: "0.2.0" }));
    expect(readInstalledEnginePackageVersionFromPaths("/missing/entry", workspacePkg)).toBe("0.2.0");
    writeFileSync(workspacePkg, "not-json");
    expect(readInstalledEnginePackageVersionFromPaths("/missing/entry", workspacePkg)).toBeNull();
    expect(readInstalledEnginePackageVersionFromPaths("/missing/entry", join(root, "missing.json"))).toBeNull();

    const installedPkg = join(root, "installed", "package.json");
    mkdirSync(join(root, "installed"), { recursive: true });
    writeFileSync(installedPkg, JSON.stringify({ version: "0.2.1" }));
    expect(readInstalledEnginePackageVersionFromPaths(join(root, "installed", "index.js"), workspacePkg)).toBe("0.2.1");
  });

  it("runDoctor supports --json output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state"), GITHUB_TOKEN: "ghp_faketoken" };
    initLaptopState(env);
    expect(runDoctor(["--json"], env)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).checks).toBeDefined();
  });

  it("buildEngineVersionSkewCheck reports behind when installed engine lags expected", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => "0.1.0",
      () => "0.2.0",
    );
    expect(skewCheck.ok).toBe(false);
    expect(skewCheck.detail).toContain("behind");
  });

  it("buildEngineVersionSkewCheck reports ahead when installed engine exceeds expected", () => {
    const skewCheck = buildEngineVersionSkewCheck(
      () => "0.3.0",
      () => "0.2.0",
    );
    expect(skewCheck.ok).toBe(true);
    expect(skewCheck.detail).toContain("ahead");
  });

  it("doctor fails (exit 1) when the state directory cannot be created", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    // Point the state dir UNDER a regular file → mkdir throws ENOTDIR.
    const root = tempRoot();
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "");
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(filePath, "state") };
    expect(runDoctorChecks(env).find((check) => check.name === "state-dir-writable")?.ok).toBe(false);
    expect(runDoctor([], env)).toBe(1);
    expect(errorLog).toHaveBeenCalled();
  });

  it("makes no network calls", () => {
    const fetchStub = vi.fn(() => {
      throw new Error("network calls are forbidden");
    });
    vi.stubGlobal("fetch", fetchStub);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(tempRoot(), "state") };
    initLaptopState(env);
    runStatus(["--json"], env, tempRoot());
    runDoctor([], env);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  describe("driver section of status/status --json (#5164)", () => {
    it("reports provider: null, modelEnvVar: null, cliPresent: null when no provider is configured", () => {
      const status = collectStatus({ GITTENSORY_MINER_CONFIG_DIR: "/s", PATH: "" }, tempRoot());
      expect(status.driver).toEqual({ provider: null, modelEnvVar: null, cliPresent: null });
    });

    it("reports the noop provider with no model env var and no CLI to check (cliPresent: null)", () => {
      const status = collectStatus(
        { GITTENSORY_MINER_CONFIG_DIR: "/s", PATH: "", MINER_CODING_AGENT_PROVIDER: "noop" },
        tempRoot(),
      );
      expect(status.driver).toEqual({ provider: "noop", modelEnvVar: null, cliPresent: null });
    });

    it("reports the agent-sdk provider with no model env var and no CLI to check (cliPresent: null)", () => {
      const status = collectStatus(
        { GITTENSORY_MINER_CONFIG_DIR: "/s", PATH: "", MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
        tempRoot(),
      );
      expect(status.driver).toEqual({ provider: "agent-sdk", modelEnvVar: null, cliPresent: null });
    });

    it("claude-cli configured + CLI present on PATH: reports the model env-var name and cliPresent: true", () => {
      const status = collectStatus(
        {
          GITTENSORY_MINER_CONFIG_DIR: "/s",
          MINER_CODING_AGENT_PROVIDER: "claude-cli",
          PATH: fakeBinDir("claude"),
        },
        tempRoot(),
      );
      expect(status.driver).toEqual({
        provider: "claude-cli",
        modelEnvVar: "MINER_CODING_AGENT_CLAUDE_MODEL",
        cliPresent: true,
      });
    });

    it("claude-cli configured + CLI absent from PATH: cliPresent: false", () => {
      const status = collectStatus(
        { GITTENSORY_MINER_CONFIG_DIR: "/s", MINER_CODING_AGENT_PROVIDER: "claude-cli", PATH: tempRoot() },
        tempRoot(),
      );
      expect(status.driver.cliPresent).toBe(false);
    });

    it("codex-cli configured + CLI present on PATH: reports the model env-var name and cliPresent: true", () => {
      const status = collectStatus(
        {
          GITTENSORY_MINER_CONFIG_DIR: "/s",
          MINER_CODING_AGENT_PROVIDER: "codex-cli",
          PATH: fakeBinDir("codex"),
        },
        tempRoot(),
      );
      expect(status.driver).toEqual({
        provider: "codex-cli",
        modelEnvVar: "MINER_CODING_AGENT_CODEX_MODEL",
        cliPresent: true,
      });
    });

    it("codex-cli configured + CLI absent from PATH: cliPresent: false", () => {
      const status = collectStatus(
        { GITTENSORY_MINER_CONFIG_DIR: "/s", MINER_CODING_AGENT_PROVIDER: "codex-cli", PATH: tempRoot() },
        tempRoot(),
      );
      expect(status.driver.cliPresent).toBe(false);
    });

    it("human-readable status text renders the driver line for both configured and unconfigured cases", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      runStatus([], { GITTENSORY_MINER_CONFIG_DIR: "/s", PATH: "" }, tempRoot());
      expect(String(log.mock.calls[0]?.[0])).toContain("driver: none configured");
      log.mockClear();
      runStatus(
        [],
        { GITTENSORY_MINER_CONFIG_DIR: "/s", MINER_CODING_AGENT_PROVIDER: "codex-cli", PATH: fakeBinDir("codex") },
        tempRoot(),
      );
      expect(String(log.mock.calls[0]?.[0])).toContain(
        "driver: codex-cli (CLI present: yes, model env: MINER_CODING_AGENT_CODEX_MODEL)",
      );
    });

    it("invariant: no env-var VALUE or secret-shaped string ever appears in status --json output across provider permutations", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const secretModelValue = "sk-ant-should-never-appear-in-output";
      const providers = [undefined, "noop", "claude-cli", "codex-cli", "agent-sdk"];
      for (const provider of providers) {
        log.mockClear();
        runStatus(
          ["--json"],
          {
            GITTENSORY_MINER_CONFIG_DIR: "/s",
            ...(provider ? { MINER_CODING_AGENT_PROVIDER: provider } : {}),
            MINER_CODING_AGENT_CLAUDE_MODEL: secretModelValue,
            MINER_CODING_AGENT_CODEX_MODEL: secretModelValue,
            PATH: fakeBinDir("claude"),
          },
          tempRoot(),
        );
        const output = String(log.mock.calls[0]?.[0]);
        expect(output).not.toContain(secretModelValue);
        const parsed = JSON.parse(output);
        expect(typeof parsed.driver.cliPresent === "boolean" || parsed.driver.cliPresent === null).toBe(true);
      }
    });
  });

  describe("doctor credential-presence checks (#5170)", () => {
    it("github-token-present: ok true when GITHUB_TOKEN is a non-empty string", () => {
      const check = runDoctorChecks({ GITHUB_TOKEN: "ghp_faketoken" }).find(
        (c) => c.name === "github-token-present",
      );
      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe("GITHUB_TOKEN is set");
    });

    it("github-token-present: ok false (regression guard) when GITHUB_TOKEN is unset or blank", () => {
      const unset = runDoctorChecks({}).find((c) => c.name === "github-token-present");
      expect(unset?.ok).toBe(false);
      const blank = runDoctorChecks({ GITHUB_TOKEN: "   " }).find((c) => c.name === "github-token-present");
      expect(blank?.ok).toBe(false);
    });

    it("coding-agent-credential-present: no provider configured is advisory (ok true)", () => {
      const check = runDoctorChecks({}).find((c) => c.name === "coding-agent-credential-present");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe("no coding-agent provider configured");
    });

    it("coding-agent-credential-present: noop/agent-sdk require no separate credential (ok true, no secret in message)", () => {
      const noop = runDoctorChecks({ MINER_CODING_AGENT_PROVIDER: "noop" }).find(
        (c) => c.name === "coding-agent-credential-present",
      );
      expect(noop?.ok).toBe(true);
      expect(noop?.detail).toBe("noop requires no separate credential file/env var");

      const agentSdk = runDoctorChecks({ MINER_CODING_AGENT_PROVIDER: "agent-sdk" }).find(
        (c) => c.name === "coding-agent-credential-present",
      );
      expect(agentSdk?.ok).toBe(true);
      expect(agentSdk?.detail).toBe("agent-sdk requires no separate credential file/env var");
    });

    it("coding-agent-credential-present: claude-cli configured + token set is ok true", () => {
      const check = runDoctorChecks({
        MINER_CODING_AGENT_PROVIDER: "claude-cli",
        CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token",
      }).find((c) => c.name === "coding-agent-credential-present");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe("CLAUDE_CODE_OAUTH_TOKEN is set");
    });

    it("coding-agent-credential-present: claude-cli configured + token missing fails with an actionable message", () => {
      const check = runDoctorChecks({ MINER_CODING_AGENT_PROVIDER: "claude-cli" }).find(
        (c) => c.name === "coding-agent-credential-present",
      );
      expect(check?.ok).toBe(false);
      expect(check?.detail).toBe(
        "CLAUDE_CODE_OAUTH_TOKEN is not set -- every claude-cli attempt will fail without it",
      );
    });

    it("coding-agent-credential-present: codex-cli configured + auth.json readable is ok true", () => {
      const root = tempRoot();
      const authFile = join(root, "auth.json");
      writeFileSync(authFile, "{}");
      const check = runDoctorChecks({ MINER_CODING_AGENT_PROVIDER: "codex-cli", CODEX_HOME: root }).find(
        (c) => c.name === "coding-agent-credential-present",
      );
      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe(`${authFile} is readable`);
    });

    it("coding-agent-credential-present: codex-cli configured + auth.json missing fails with an actionable message", () => {
      const root = tempRoot();
      const check = runDoctorChecks({ MINER_CODING_AGENT_PROVIDER: "codex-cli", CODEX_HOME: root }).find(
        (c) => c.name === "coding-agent-credential-present",
      );
      expect(check?.ok).toBe(false);
      expect(check?.detail).toBe(
        `${join(root, "auth.json")} is missing or unreadable -- run \`codex auth\`; every codex-cli attempt will fail without it`,
      );
    });

    it("makes zero network calls (preserves doctor's documented invariant)", () => {
      const fetchStub = vi.fn(() => {
        throw new Error("network calls are forbidden");
      });
      vi.stubGlobal("fetch", fetchStub);
      runDoctorChecks({ GITHUB_TOKEN: "ghp_faketoken", MINER_CODING_AGENT_PROVIDER: "codex-cli" });
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("invariant: doctor's output never contains an actual credential value, only presence booleans/names/paths", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const secretToken = "ghp_should-never-appear-in-doctor-output";
      const secretOauth = "oauth-should-never-appear-in-doctor-output";
      runDoctor(["--json"], {
        GITTENSORY_MINER_CONFIG_DIR: tempRoot(),
        GITHUB_TOKEN: secretToken,
        MINER_CODING_AGENT_PROVIDER: "claude-cli",
        CLAUDE_CODE_OAUTH_TOKEN: secretOauth,
      });
      const output = String(log.mock.calls[0]?.[0]);
      expect(output).not.toContain(secretToken);
      expect(output).not.toContain(secretOauth);
    });
  });
});
