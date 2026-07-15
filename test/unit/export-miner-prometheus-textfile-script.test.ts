import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// export-miner-prometheus-textfile.sh (#4839): regression for #5934, where the script's default MINER_BIN
// fallback pointed at `gittensory-miner`, a binary the package never installs (its real `bin` entry is
// `loopover-miner`). With no LOOPOVER_MINER_BIN override -- the script's own documented zero-config usage --
// every `export_family` call hit "command not found" and, being fail-open per family, silently produced an
// empty .prom file instead of erroring loudly.

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "miner-prometheus-textfile-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** A fake `loopover-miner` that answers each of the script's four subcommands with distinguishable text, so
 *  tests can assert the export actually reached it (as opposed to falling back to a nonexistent binary). */
function fakeMinerBin(root: string, name = "loopover-miner"): string {
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const path = join(bin, name);
  writeFileSync(
    path,
    `#!/bin/sh
case "$1 $2" in
  "metrics ") echo "fake_prediction_calibration 1" ;;
  "queue metrics") echo "fake_portfolio_queue 1" ;;
  "ledger metrics") echo "fake_event_ledger 1" ;;
  "governor metrics") echo "fake_governor 1" ;;
  *) echo "unexpected args: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return bin;
}

function runExport(outFile: string, env: Record<string, string> = {}): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("sh", ["scripts/export-miner-prometheus-textfile.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPOVER_MINER_PROMETHEUS_TEXTFILE: outFile,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "" };
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    return { stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

describe("export-miner-prometheus-textfile.sh (#5934)", () => {
  it("defaults MINER_BIN to loopover-miner, not the nonexistent gittensory-miner", () => {
    const script = readFileSync(join(process.cwd(), "scripts/export-miner-prometheus-textfile.sh"), "utf8");
    expect(script).toMatch(/MINER_BIN="\$\{LOOPOVER_MINER_BIN:-loopover-miner\}"/);
  });

  it("REGRESSION: with no LOOPOVER_MINER_BIN override, invokes the real loopover-miner binary and populates every family", () => {
    const root = tmpRoot();
    const bin = fakeMinerBin(root);
    const outFile = join(root, "out", "miner.prom");

    const result = runExport(outFile, { PATH: `${bin}:${process.env.PATH ?? ""}` });

    expect(result.stderr).not.toMatch(/export failed/);
    const content = readFileSync(outFile, "utf8");
    expect(content).toContain("fake_prediction_calibration 1");
    expect(content).toContain("fake_portfolio_queue 1");
    expect(content).toContain("fake_event_ledger 1");
    expect(content).toContain("fake_governor 1");
  });

  it("still honors an explicit LOOPOVER_MINER_BIN override", () => {
    const root = tmpRoot();
    const bin = fakeMinerBin(root, "custom-miner-bin");
    const outFile = join(root, "out", "miner.prom");

    const result = runExport(outFile, {
      PATH: process.env.PATH ?? "",
      LOOPOVER_MINER_BIN: join(bin, "custom-miner-bin"),
    });

    expect(result.stderr).not.toMatch(/export failed/);
    const content = readFileSync(outFile, "utf8");
    expect(content).toContain("fake_prediction_calibration 1");
  });
});
