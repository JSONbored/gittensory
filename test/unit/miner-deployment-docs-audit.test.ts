import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertDeploymentDocsInSync,
  auditDeploymentDocs,
  extractEnvVarClaims,
  extractFilePathClaims,
  extractSubcommandClaims,
  isRepoRelativePath,
  scanEnvVarTokens,
  scanRegisteredCommands,
} from "../../packages/gittensory-miner/lib/deployment-docs-audit.js";
import type { DeploymentDocsReality } from "../../packages/gittensory-miner/lib/deployment-docs-audit.d.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MINER_DIR = resolve(REPO_ROOT, "packages/gittensory-miner");
const DEPLOYMENT_MD = resolve(MINER_DIR, "DEPLOYMENT.md");
const BIN_DIR = resolve(MINER_DIR, "bin");
const BIN_ENTRY = resolve(BIN_DIR, "gittensory-miner.js");
const LIB_DIR = resolve(MINER_DIR, "lib");

function readJsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

function buildLiveReality(): DeploymentDocsReality {
  const envReads = scanEnvVarTokens([...readJsFiles(LIB_DIR), ...readJsFiles(BIN_DIR)].join("\n"));
  const registered = scanRegisteredCommands(readFileSync(BIN_ENTRY, "utf8"));
  return {
    hasEnvRead: (name) => envReads.has(name),
    pathExists: (relativePath) => existsSync(resolve(MINER_DIR, relativePath)),
    isRegisteredCommand: (name) => registered.has(name),
  };
}

const ALWAYS_IN_SYNC: DeploymentDocsReality = {
  hasEnvRead: () => true,
  pathExists: () => true,
  isRegisteredCommand: () => true,
};

describe("gittensory-miner DEPLOYMENT.md docs-accuracy audit (#5180)", () => {
  const markdown = readFileSync(DEPLOYMENT_MD, "utf8");
  const claims = {
    envVars: extractEnvVarClaims(markdown),
    filePaths: extractFilePathClaims(markdown),
    subcommands: extractSubcommandClaims(markdown),
  };

  it("passes cleanly against DEPLOYMENT.md's current, accurate state", () => {
    const result = assertDeploymentDocsInSync(claims, buildLiveReality());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("extracts every documented GITTENSORY_MINER_* / MINER_* env var", () => {
    expect(claims.envVars).toContain("GITTENSORY_MINER_CONFIG_DIR");
    expect(claims.envVars.every((name) => /^(?:GITTENSORY_MINER|MINER)_/.test(name))).toBe(true);
  });

  it("extracts repo-relative file paths and drops external issue links", () => {
    expect(claims.filePaths).toContain("Dockerfile");
    expect(claims.filePaths).toContain("../../docker-compose.yml");
    expect(claims.filePaths).toContain("../../k8s/");
    expect(claims.filePaths.some((path) => path.startsWith("http"))).toBe(false);
  });

  it("extracts documented CLI subcommands, not the npm package spelling", () => {
    expect(claims.subcommands).toEqual(expect.arrayContaining(["status", "doctor", "init", "loop"]));
    // `@jsonbored/gittensory-miner run build` must not be mistaken for a `run` subcommand.
    expect(claims.subcommands).not.toContain("run");
  });

  it("scanEnvVarTokens keeps the namespaced token whole and finds bare MINER_* aliases", () => {
    expect(
      [...scanEnvVarTokens("read GITTENSORY_MINER_CONFIG_DIR and MINER_PING_STATUS here")].sort(),
    ).toEqual(["GITTENSORY_MINER_CONFIG_DIR", "MINER_PING_STATUS"]);
    expect(scanEnvVarTokens("no env vars here").size).toBe(0);
  });

  it("extractSubcommandClaims returns nothing when the CLI is never invoked", () => {
    expect(extractSubcommandClaims("plain prose without any commands")).toEqual([]);
  });

  it("extractFilePathClaims returns nothing when there are no markdown links", () => {
    expect(extractFilePathClaims("plain prose without links")).toEqual([]);
  });

  it("isRepoRelativePath accepts repo paths and rejects URLs, anchors, and runtime paths", () => {
    expect(isRepoRelativePath("Dockerfile")).toBe(true);
    expect(isRepoRelativePath("../../k8s/")).toBe(true);
    expect(isRepoRelativePath("https://example.com")).toBe(false);
    expect(isRepoRelativePath("http://example.com")).toBe(false);
    expect(isRepoRelativePath("#anchor")).toBe(false);
    expect(isRepoRelativePath("mailto:ops@example.com")).toBe(false);
    expect(isRepoRelativePath("~/.config/gittensory-miner")).toBe(false);
    expect(isRepoRelativePath("/data/miner")).toBe(false);
  });

  it("scanRegisteredCommands reads the CLI dispatch table from the bin entry", () => {
    const registered = scanRegisteredCommands(readFileSync(BIN_ENTRY, "utf8"));
    for (const command of ["status", "doctor", "init", "loop"]) {
      expect(registered.has(command)).toBe(true);
    }
  });

  it("auditDeploymentDocs reports ok when every claim is backed by reality", () => {
    const result = auditDeploymentDocs(
      { envVars: ["GITTENSORY_MINER_CONFIG_DIR"], filePaths: ["Dockerfile"], subcommands: ["loop"] },
      ALWAYS_IN_SYNC,
    );
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("flags a documented env var with no corresponding read (renamed-var regression)", () => {
    // Regression: an operator renames GITTENSORY_MINER_CONFIG_DIR in code but leaves the doc untouched.
    const result = auditDeploymentDocs(
      { envVars: ["GITTENSORY_MINER_CONFIG_DIR"], filePaths: [], subcommands: [] },
      { ...ALWAYS_IN_SYNC, hasEnvRead: (name) => name !== "GITTENSORY_MINER_CONFIG_DIR" },
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("GITTENSORY_MINER_CONFIG_DIR");
    expect(result.failures[0]).toContain("no read");
  });

  it("flags a documented file path that no longer exists on disk", () => {
    const result = auditDeploymentDocs(
      { envVars: [], filePaths: ["docker-compose.moved.yml"], subcommands: [] },
      { ...ALWAYS_IN_SYNC, pathExists: () => false },
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("docker-compose.moved.yml");
    expect(result.failures[0]).toContain("no longer exists");
  });

  it("flags a documented subcommand that is not registered in the CLI", () => {
    const result = auditDeploymentDocs(
      { envVars: [], filePaths: [], subcommands: ["teleport"] },
      { ...ALWAYS_IN_SYNC, isRegisteredCommand: () => false },
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("gittensory-miner teleport");
    expect(result.failures[0]).toContain("not registered");
  });

  it("assertDeploymentDocsInSync throws and names every stale claim at once", () => {
    expect(() =>
      assertDeploymentDocsInSync(
        { envVars: ["GITTENSORY_MINER_GONE"], filePaths: ["gone.yml"], subcommands: ["gone"] },
        { hasEnvRead: () => false, pathExists: () => false, isRegisteredCommand: () => false },
      ),
    ).toThrow(/GITTENSORY_MINER_GONE[\s\S]*gone\.yml[\s\S]*gittensory-miner gone/);
  });

  it("assertDeploymentDocsInSync returns the ok result without throwing when in sync", () => {
    const result = assertDeploymentDocsInSync(
      { envVars: [], filePaths: [], subcommands: [] },
      ALWAYS_IN_SYNC,
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
