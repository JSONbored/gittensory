import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const libPath = resolve("scripts/lib/selfhost-deploy-common.sh");

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-selfhost-deploy-common-"));
  const binDir = join(dir, "bin");
  const infisicalLog = join(dir, "infisical-calls.log");
  mkdirSync(binDir);

  // Wraps a plain `echo` so a test can tell whether the wrapped command actually ran (its own stdout) and,
  // separately, whether it ran directly or via the fake infisical binary below (that binary's own log).
  const wrapperPath = join(dir, "wrapper.sh");
  writeFileSync(
    wrapperPath,
    `#!/usr/bin/env bash
set -euo pipefail
. "${libPath.replace(/\\/g, "/")}"
maybe_infisical_run echo actual-command-ran
`,
  );
  chmodSync(wrapperPath, 0o755);

  function writeFakeInfisical() {
    writeFileSync(
      join(binDir, "infisical"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${infisicalLog.replace(/\\/g, "/")}"
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
`,
    );
    chmodSync(join(binDir, "infisical"), 0o755);
  }

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    readInfisicalCalls: () => readOptional(infisicalLog),
    writeFakeInfisical,
    run(env: Record<string, string> = {}) {
      return spawnSync("bash", [wrapperPath], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
      });
    },
  };
}

describe("maybe_infisical_run (#5120)", () => {
  it("runs the wrapped command directly when SELFHOST_USE_INFISICAL is unset -- the zero-dependency default path", () => {
    const harness = createHarness();
    try {
      const result = harness.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("actual-command-ran");
      expect(harness.readInfisicalCalls()).toBe("");
    } finally {
      harness.cleanup();
    }
  });

  it("runs the wrapped command directly when SELFHOST_USE_INFISICAL=0 (explicit opt-out, same as default)", () => {
    const harness = createHarness();
    try {
      const result = harness.run({ SELFHOST_USE_INFISICAL: "0" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("actual-command-ran");
      expect(harness.readInfisicalCalls()).toBe("");
    } finally {
      harness.cleanup();
    }
  });

  it("prefixes the command with `infisical run --` when SELFHOST_USE_INFISICAL=1 and infisical is available", () => {
    const harness = createHarness();
    harness.writeFakeInfisical();
    try {
      const result = harness.run({ SELFHOST_USE_INFISICAL: "1" });
      expect(result.status, result.stderr).toBe(0);
      // The wrapped command still genuinely ran (via infisical's own exec passthrough)...
      expect(result.stdout).toContain("actual-command-ran");
      // ...and it ran THROUGH infisical, not directly -- proving the opt-in actually wires the wrapper in.
      expect(harness.readInfisicalCalls()).toBe("run -- echo actual-command-ran\n");
    } finally {
      harness.cleanup();
    }
  });

  it("fails closed with a clear error when SELFHOST_USE_INFISICAL=1 but infisical is not installed", () => {
    const harness = createHarness();
    try {
      const result = harness.run({ SELFHOST_USE_INFISICAL: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("required command not found: infisical");
      expect(result.stdout).not.toContain("actual-command-ran");
    } finally {
      harness.cleanup();
    }
  });
});
