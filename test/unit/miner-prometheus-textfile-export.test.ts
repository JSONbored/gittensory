import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for #5934: scripts/export-miner-prometheus-textfile.sh bridges the miner's one-shot metrics
// CLI into a node_exporter textfile-collector .prom. Its default MINER_BIN must be the package's real bin entry
// `loopover-miner` (packages/loopover-miner/package.json), NOT the pre-rename `gittensory-miner`, which is not an
// installable binary after the rebrand's hard cutover -- an operator running the script with no LOOPOVER_MINER_BIN
// override would otherwise hit `command not found` (exit 127) and, since export_family is fail-open, silently
// produce an empty .prom on every run. This is a `scripts/**` file outside Codecov's coverage.include, so this
// content check is its guard. Pattern mirrors test/unit/miner-docker-compose.test.ts: readFileSync + assert.
const SCRIPT = readFileSync(join(process.cwd(), "scripts/export-miner-prometheus-textfile.sh"), "utf8");

describe("export-miner-prometheus-textfile.sh default MINER_BIN (#5934)", () => {
  it("defaults MINER_BIN to the real bin entry loopover-miner", () => {
    expect(SCRIPT).toContain('MINER_BIN="${LOOPOVER_MINER_BIN:-loopover-miner}"');
  });

  it("no longer references the pre-rename gittensory-miner binary", () => {
    // The hyphenated binary name specifically -- the OUT_FILE default filename `gittensory_miner.prom`
    // (underscore) is a separate cosmetic naming choice deliberately left unchanged by #5934.
    expect(SCRIPT).not.toContain("gittensory-miner");
  });
});
