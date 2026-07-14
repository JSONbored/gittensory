import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readmePath = join(process.cwd(), "packages/loopover-miner/README.md");

describe("gittensory-miner event ledger README (#2322)", () => {
  it("documents the append-only event ledger API surface", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(readme).toContain("initEventLedger");
    expect(readme).toContain("appendEvent");
    expect(readme).toContain("readEvents");
    expect(readme).toContain("append-only");
    expect(readme).toContain("Insert-only");
  });
});
