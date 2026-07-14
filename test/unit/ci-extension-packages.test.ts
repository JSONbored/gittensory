import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("browser extension workspace packages (#4866)", () => {
  it("declares workspace package.json files for both extensions", () => {
    const maintainer = JSON.parse(read("apps/loopover-extension/package.json"));
    const miner = JSON.parse(read("apps/loopover-miner-extension/package.json"));

    expect(maintainer.name).toBe("@loopover/extension");
    expect(miner.name).toBe("@loopover/miner-extension");
    expect(maintainer.scripts.build).toContain("build-extension.mjs");
    expect(miner.scripts.build).toContain("build-miner-extension.mjs");
    expect(miner.scripts.lint).toContain("node --check");
    expect(miner.scripts.typecheck).toBe("npm run lint");
  });

  it("wires extension lint/typecheck/build scripts into root package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["extension:lint"]).toContain("@loopover/extension");
    expect(pkg.scripts["miner-extension:build"]).toContain("@loopover/miner-extension");
    expect(pkg.scripts["ui:build"]).toContain("miner-extension:build");
  });

  it("includes both extensions in ci.yml's ui path filter and validate-code steps", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("apps/loopover-miner-extension/**");
    expect(workflow).toContain("scripts/build-miner-extension.mjs");
    expect(workflow).toContain("name: Extension lint");
    expect(workflow).toContain("npm run extension:lint && npm run miner-extension:lint");
    expect(workflow).toContain("npm run extension:typecheck && npm run miner-extension:typecheck");
    expect(workflow).toContain(
      "npm run extension:build && npm run miner-extension:build && npm --workspace @loopover/ui run build",
    );
  });
});
