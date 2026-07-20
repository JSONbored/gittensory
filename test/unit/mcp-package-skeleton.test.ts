import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mcpRoot = join(process.cwd(), "packages/loopover-mcp");

type McpPackageJson = {
  name: string;
  scripts: { build: string; "build:tsc": string; "build:verify": string };
  files: string[];
};

describe("loopover-mcp TypeScript build pipeline (#7328)", () => {
  it("exposes a real tsc build split like loopover-miner", () => {
    const pkg = JSON.parse(readFileSync(join(mcpRoot, "package.json"), "utf8")) as McpPackageJson;
    expect(pkg.name).toBe("@loopover/mcp");
    expect(pkg.scripts.build).toBe("npm run build:tsc && npm run build:verify");
    expect(pkg.scripts["build:tsc"]).toBe("tsc -p tsconfig.json");
    expect(pkg.scripts["build:verify"]).toBe("node scripts/check-syntax.mjs");
    expect(pkg.files).toEqual(
      expect.arrayContaining(["bin", "lib", "!bin/**/*.ts", "!lib/**/*.ts", "lib/**/*.d.ts"]),
    );
  });

  it("build:verify's syntax check covers bin and lib .js files", () => {
    const result = spawnSync("node", ["scripts/check-syntax.mjs"], { cwd: mcpRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/node --check passed for all \d+ files in bin\/ and lib\//);
  });
});
