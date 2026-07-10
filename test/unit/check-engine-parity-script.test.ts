import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkEngineParityDrift,
  checkEngineVersionSkew,
  checkGateLogicVersionBump,
  checkMinerEngineVersionPinSync,
  compareSemver,
  defaultDidEngineVersionChange,
  defaultGetChangedFiles,
  defaultReadExpectedEngineVersion,
  defaultResolveInstalledEngineVersion,
  describeEngineVersionSkew,
  discoverEngineParityPairs,
  type EngineParityPair,
  GATE_LOGIC_TWIN_FILES,
  isEngineStubPair,
  isThinEngineReExportShim,
  normalizeEngineParityText,
  normalizeImportSpec,
  runEngineParityChecks,
  runEngineParityMain,
  runGateLogicVersionBumpMain,
} from "../../scripts/check-engine-parity";

const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

describe("check-engine-parity script", () => {
  it("normalizes known-harmless import-path aliases", () => {
    expect(normalizeImportSpec("../types/predicted-gate-types.js")).toBe("../types");
    expect(normalizeImportSpec("../focus-manifest/guidance.js")).toBe("../signals/focus-manifest");
    const host = 'import type { X } from "../types/predicted-gate-types";\n';
    const engine = 'import type { X } from "../types/manifest-deps-types.js";\n';
    expect(normalizeEngineParityText(host)).toBe(normalizeEngineParityText(engine));
  });

  it("detects thin engine re-export shims and engine stub pairs", () => {
    const shim = `// comment\nexport * from "../../packages/gittensory-engine/src/signals/test-evidence";\n`;
    expect(isThinEngineReExportShim(shim)).toBe(true);
    expect(isThinEngineReExportShim("export const MODE = 'strict';\n")).toBe(false);
    expect(isEngineStubPair("export const A = 1;\n".repeat(30), "export {};\n")).toBe(true);
  });

  it("passes when normalized host and engine copies are identical", () => {
    const body = "export const VALUE = 1;\nimport type { T } from \"../types\";\n";
    const readFile = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings/sample.ts") return body;
      if (relativePath === "packages/gittensory-engine/src/settings/sample.ts") return body;
      throw new Error(`unexpected read: ${relativePath}`);
    };
    const listDir = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings") return ["sample.ts"];
      if (relativePath === "packages/gittensory-engine/src/settings") return ["sample.ts"];
      return [];
    };
    const result = checkEngineParityDrift({ root: "/fake", readFile, listDir });
    expect(result.failures).toEqual([]);
    expect(result.pairsChecked).toHaveLength(1);
  });

  it("fails with a clear message when a discovered pair diverges", () => {
    const readFile = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings/autonomy.ts") return "export const MODE = 'strict';\n";
      if (relativePath === "packages/gittensory-engine/src/settings/autonomy.ts") return "export const MODE = 'relaxed';\n";
      throw new Error(`unexpected read: ${relativePath}`);
    };
    const listDir = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings") return ["autonomy.ts"];
      if (relativePath === "packages/gittensory-engine/src/settings") return ["autonomy.ts"];
      return [];
    };
    const result = checkEngineParityDrift({ root: "/fake", readFile, listDir });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("src/settings/autonomy.ts");
    expect(result.failures[0]).toContain("packages/gittensory-engine/src/settings/autonomy.ts");
    expect(result.failures[0]).toContain("drifted apart");
  });

  it("discovers real in-scope pairs in the repository (regression guard)", () => {
    const pairs = discoverEngineParityPairs({ root: process.cwd() });
    expect(pairs.length).toBeGreaterThanOrEqual(14);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "guardrail-config.ts")).toBe(true);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "change-guardrail.ts")).toBe(true);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "duplicate-winner.ts")).toBe(false);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "check-names.ts")).toBe(false);
  });

  it("the real repo's hand-duplicated pairs agree after normalization (regression guard)", () => {
    const result = checkEngineParityDrift({ root: process.cwd() });
    expect(result.failures).toEqual([]);
  });

  describe("engine version skew", () => {
    it("classifies equal, behind, and ahead boundary cases", () => {
      expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
      expect(describeEngineVersionSkew("0.2.0", "0.2.0")).toBe("equal");
      expect(compareSemver("0.1.9", "0.2.0")).toBe(-1);
      expect(describeEngineVersionSkew("0.1.9", "0.2.0")).toBe("behind");
      expect(compareSemver("0.3.0", "0.2.0")).toBe(1);
      expect(describeEngineVersionSkew("0.3.0", "0.2.0")).toBe("ahead");
    });

    it("passes when installed engine matches or exceeds the expected version", () => {
      const equal = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => "0.2.0",
        readExpected: () => "0.2.0",
      });
      expect(equal.failures).toEqual([]);
      expect(equal.skew).toBe("equal");

      const ahead = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => "0.2.1",
        readExpected: () => "0.2.0",
      });
      expect(ahead.failures).toEqual([]);
      expect(ahead.skew).toBe("ahead");
    });

    it("fails when installed engine is behind the monorepo expected version", () => {
      const result = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => "0.1.0",
        readExpected: () => "0.2.0",
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("behind");
      expect(result.skew).toBe("behind");
    });

    it("fails when expected or installed engine versions are unavailable", () => {
      const missingExpected = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => {
          throw new Error("missing");
        },
        resolveInstalled: () => "0.2.0",
        readExpected: () => null,
      });
      expect(missingExpected.failures[0]).toContain("Could not read expected");

      const missingInstalled = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => null,
        readExpected: () => "0.2.0",
      });
      expect(missingInstalled.failures[0]).toContain("not installed");
    });

    it("treats unparseable semver as behind", () => {
      expect(compareSemver("not-a-version", "0.2.0")).toBe(-1);
      expect(describeEngineVersionSkew("not-a-version", "0.2.0")).toBe("behind");
    });
    it("default version readers handle missing or corrupt installs", () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), "engine-parity-missing-"));
      try {
        expect(defaultResolveInstalledEngineVersion(emptyRoot)).toBeNull();
        expect(defaultReadExpectedEngineVersion(emptyRoot)).toBeNull();
        expect(defaultReadExpectedEngineVersion("/fake", () => {
          throw new Error("unreadable");
        })).toBeNull();

        const engineDir = join(emptyRoot, "node_modules", "@jsonbored", "gittensory-engine");
        mkdirSync(engineDir, { recursive: true });
        writeFileSync(join(engineDir, "package.json"), "not-json");
        expect(defaultResolveInstalledEngineVersion(emptyRoot)).toBeNull();
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });

    it("fails when the miner engine pin drifts from the monorepo engine package version", () => {
      const result = checkMinerEngineVersionPinSync({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === "packages/gittensory-miner/expected-engine.version") return "0.1.0\n";
          throw new Error(`unexpected read: ${relativePath}`);
        },
        readExpected: () => "0.2.0",
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("out of sync");
    });

    it("uses default version readers against the real monorepo workspace", () => {
      expect(defaultResolveInstalledEngineVersion(process.cwd())).toMatch(/^\d+\.\d+\.\d+$/);
      expect(defaultReadExpectedEngineVersion(process.cwd())).toBe("0.2.1");
      const result = runEngineParityChecks({ root: process.cwd() });
      expect(result.failures).toEqual([]);
    });
  });

  it("runEngineParityMain returns 1 and logs failures when checks fail", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = runEngineParityMain("/definitely-not-a-gittensory-root");
    expect(exitCode).toBe(1);
    expect(errorLog).toHaveBeenCalled();
  });

  it("runEngineParityMain returns 0 for the real monorepo workspace", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runEngineParityMain(process.cwd())).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Engine-parity check ok:/);
  });

  it("prints a clean summary and exits 0 for the real repo state when run as a subprocess", () => {
    const output = execFileSync(TSX_BIN, ["scripts/check-engine-parity.ts"], { encoding: "utf8" });
    expect(output).toMatch(/Engine-parity check ok:/);
    expect(output).toMatch(/hand-duplicated file pair/);
  });

  it("exits non-zero when run outside the monorepo workspace", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "engine-parity-empty-"));
    try {
      expect(() =>
        execFileSync(TSX_BIN, [join(process.cwd(), "scripts/check-engine-parity.ts")], {
          cwd: emptyRoot,
          encoding: "utf8",
        }),
      ).toThrow();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("runEngineParityChecks aggregates drift and skew failures", () => {
    const combined = runEngineParityChecks({
      root: "/fake",
      readFile: (_root: string, relativePath: string) => {
        if (relativePath === "packages/gittensory-engine/package.json") return JSON.stringify({ version: "0.2.0" });
        if (relativePath === "src/settings/autonomy.ts") return "export const MODE = 'strict';\n";
        if (relativePath === "packages/gittensory-engine/src/settings/autonomy.ts") return "export const MODE = 'relaxed';\n";
        throw new Error(`unexpected read: ${relativePath}`);
      },
      listDir: (_root: string, relativePath: string) => {
        if (relativePath === "src/settings") return ["autonomy.ts"];
        if (relativePath === "packages/gittensory-engine/src/settings") return ["autonomy.ts"];
        return [];
      },
      resolveInstalled: () => "0.1.0",
      readExpected: () => "0.2.0",
    });
    expect(combined.failures.length).toBeGreaterThanOrEqual(2);
  });

  describe("gate-logic version-bump tripwire (#4518)", () => {
    it("names the actual twin file pair", () => {
      expect(GATE_LOGIC_TWIN_FILES).toEqual(["src/rules/advisory.ts", "packages/gittensory-engine/src/advisory/gate-advisory.ts"]);
    });

    it("passes when neither twin was touched, regardless of whether the version changed", () => {
      expect(checkGateLogicVersionBump({ changedFiles: ["src/other-file.ts"], engineVersionChanged: false }).failures).toEqual([]);
      expect(checkGateLogicVersionBump({ changedFiles: [], engineVersionChanged: false }).failures).toEqual([]);
    });

    it("passes when a twin was touched AND the engine version changed", () => {
      const result = checkGateLogicVersionBump({ changedFiles: ["src/rules/advisory.ts"], engineVersionChanged: true });
      expect(result.failures).toEqual([]);
      expect(result.touchedTwins).toEqual(["src/rules/advisory.ts"]);
    });

    it("fails when the HOST twin was touched without a version bump", () => {
      const result = checkGateLogicVersionBump({ changedFiles: ["src/rules/advisory.ts", "src/unrelated.ts"], engineVersionChanged: false });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("src/rules/advisory.ts");
      expect(result.failures[0]).toContain("packages/gittensory-engine/package.json");
      expect(result.touchedTwins).toEqual(["src/rules/advisory.ts"]);
    });

    it("fails when the ENGINE twin was touched without a version bump", () => {
      const result = checkGateLogicVersionBump({
        changedFiles: ["packages/gittensory-engine/src/advisory/gate-advisory.ts"],
        engineVersionChanged: false,
      });
      expect(result.failures).toHaveLength(1);
      expect(result.touchedTwins).toEqual(["packages/gittensory-engine/src/advisory/gate-advisory.ts"]);
    });

    it("lists BOTH twins in the failure when both were touched without a version bump", () => {
      const result = checkGateLogicVersionBump({
        changedFiles: [...GATE_LOGIC_TWIN_FILES],
        engineVersionChanged: false,
      });
      expect(result.touchedTwins).toEqual([...GATE_LOGIC_TWIN_FILES]);
      expect(result.failures[0]).toContain("src/rules/advisory.ts");
      expect(result.failures[0]).toContain("gate-advisory.ts");
    });

    it("defaultGetChangedFiles fails safe to an empty list when the base ref cannot be resolved", () => {
      expect(defaultGetChangedFiles("/definitely-not-a-git-repo", "origin/main")).toEqual([]);
    });

    it("defaultDidEngineVersionChange fails safe to true when the base ref cannot be resolved", () => {
      expect(defaultDidEngineVersionChange("/definitely-not-a-git-repo", "origin/main")).toBe(true);
    });

    it("defaultGetChangedFiles resolves real changed files against a real git ref (regression guard)", () => {
      // HEAD vs itself is always an empty diff -- proves the real git plumbing runs without throwing.
      expect(defaultGetChangedFiles(process.cwd(), "HEAD")).toEqual([]);
    });

    it("defaultDidEngineVersionChange is false comparing HEAD's engine package.json against itself (regression guard)", () => {
      expect(defaultDidEngineVersionChange(process.cwd(), "HEAD")).toBe(false);
    });

    it("runGateLogicVersionBumpMain returns 0 and logs ok when nothing failed", () => {
      // Other tests earlier in this file spy on console.log/error without restoring, so a shared/leaked spy
      // can already have prior calls recorded by the time this runs -- assert BY CONTENT (some call matches),
      // never by position ([0]), and always restore this test's own spy.
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      // HEAD vs itself: no changed files, so the check trivially passes regardless of the real repo state.
      expect(runGateLogicVersionBumpMain(process.cwd(), "HEAD")).toBe(0);
      expect(log.mock.calls.some((c) => String(c[0]).includes("Gate-logic version-bump check ok"))).toBe(true);
      log.mockRestore();
    });

    it("runGateLogicVersionBumpMain fails safe to 0 (no touched twins) against a root with no git history", () => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      // No .git at all: defaultGetChangedFiles fails safe to [] (never blocks a PR over an environment
      // hiccup) -- the ACTUAL failure path is exercised end-to-end below with a real git fixture. Asserts
      // this test's OWN call never mentions "Gate-logic" (not "never called at all" -- a leaked, unrestored
      // spy from an earlier test in this file can carry prior unrelated calls into this one).
      expect(runGateLogicVersionBumpMain("/definitely-not-a-gittensory-root", "origin/main")).toBe(0);
      expect(errorLog.mock.calls.some((c) => String(c[0]).includes("Gate-logic"))).toBe(false);
      errorLog.mockRestore();
    });

    describe("end-to-end against a real git fixture", () => {
      function initFixtureRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), "engine-parity-gate-logic-"));
        const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
        git("init", "--quiet", "-b", "main");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");
        mkdirSync(join(dir, "src", "rules"), { recursive: true });
        mkdirSync(join(dir, "packages", "gittensory-engine"), { recursive: true });
        writeFileSync(join(dir, "src", "rules", "advisory.ts"), "export const V = 1;\n");
        writeFileSync(join(dir, "packages", "gittensory-engine", "package.json"), JSON.stringify({ name: "@jsonbored/gittensory-engine", version: "0.2.0" }));
        git("add", "-A");
        git("commit", "--quiet", "-m", "base");
        git("branch", "base-ref"); // a stable ref this test can diff against, independent of any real origin/main
        return dir;
      }

      it("fails when the host twin changes without a version bump", () => {
        const dir = initFixtureRepo();
        try {
          writeFileSync(join(dir, "src", "rules", "advisory.ts"), "export const V = 2;\n");
          execFileSync("git", ["add", "-A"], { cwd: dir });
          execFileSync("git", ["commit", "--quiet", "-m", "change gate logic"], { cwd: dir });

          const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
          expect(runGateLogicVersionBumpMain(dir, "base-ref")).toBe(1);
          expect(errorLog.mock.calls.some((c) => String(c[0]).includes("Gate-logic version-bump check found"))).toBe(true);
          errorLog.mockRestore();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("passes when the host twin changes together with a version bump", () => {
        const dir = initFixtureRepo();
        try {
          writeFileSync(join(dir, "src", "rules", "advisory.ts"), "export const V = 2;\n");
          writeFileSync(join(dir, "packages", "gittensory-engine", "package.json"), JSON.stringify({ name: "@jsonbored/gittensory-engine", version: "0.2.1" }));
          execFileSync("git", ["add", "-A"], { cwd: dir });
          execFileSync("git", ["commit", "--quiet", "-m", "change gate logic + bump"], { cwd: dir });

          const log = vi.spyOn(console, "log").mockImplementation(() => {});
          expect(runGateLogicVersionBumpMain(dir, "base-ref")).toBe(0);
          log.mockRestore();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it("passes when neither twin changes", () => {
        const dir = initFixtureRepo();
        try {
          writeFileSync(join(dir, "README.md"), "unrelated change\n");
          execFileSync("git", ["add", "-A"], { cwd: dir });
          execFileSync("git", ["commit", "--quiet", "-m", "unrelated"], { cwd: dir });

          expect(runGateLogicVersionBumpMain(dir, "base-ref")).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
});
