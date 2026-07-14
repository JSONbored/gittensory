import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENGINE_VERSION } from "../../packages/loopover-engine/src/version";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../packages/loopover-engine/package.json");

describe("ENGINE_VERSION", () => {
  it("matches packages/loopover-engine/package.json version", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(barrel.ENGINE_VERSION).toBe(ENGINE_VERSION);
    expect(barrel.ENGINE_VERSION.length).toBeGreaterThan(0);
  });
});
