import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = resolve("scripts/selfhost-post-update-check.sh");
const sandboxDirs: string[] = [];

afterEach(() => {
  while (sandboxDirs.length > 0) {
    const dir = sandboxDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createSandbox() {
  const base = mkdtempSync(join(tmpdir(), "gittensory-selfhost-post-update-"));
  sandboxDirs.push(base);
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(base, "docker-compose.yml"), "services: {}\n");

  writeExecutable(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then
  exit 0
fi
if [ "$1" = "compose" ] && [ "$4" = "ps" ] && [ "$5" = "-q" ]; then
  printf 'container-1\\n'
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then
  if [[ "$3" == *'.State.Health'* ]]; then
    printf 'healthy\\n'
  else
    printf 'ghcr.io/jsonbored/gittensory-selfhost:test\\n'
  fi
  exit 0
fi
exit 0
`,
  );

  writeExecutable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
exit "\${CURL_STATUS:-0}"
`,
  );

  writeExecutable(
    join(bin, "sleep"),
    `#!/usr/bin/env bash
exit 0
`,
  );

  return { base, bin };
}

function run(env: Record<string, string>) {
  const { base, bin } = createSandbox();
  return spawnSync("bash", [SCRIPT], {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, ...env },
  });
}

describe("selfhost-post-update-check.sh", () => {
  it("falls back for non-numeric readiness retry settings without evaluating them as Bash arithmetic", () => {
    const marker = join(tmpdir(), `gittensory-ready-injection-${process.pid}`);
    rmSync(marker, { force: true });

    const result = run({
      SELFHOST_READY_RETRIES: `ready[$(touch ${marker})]`,
      SELFHOST_READY_RETRY_DELAY_SECONDS: `ready[$(touch ${marker})]`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("invalid SELFHOST_READY_RETRIES");
    expect(result.stderr).toContain("invalid SELFHOST_READY_RETRY_DELAY_SECONDS");
    expect(existsSync(marker)).toBe(false);
  });

  it("reports failed readiness using the validated retry budget", () => {
    const result = run({
      CURL_STATUS: "22",
      SELFHOST_READY_RETRIES: "2",
      SELFHOST_READY_RETRY_DELAY_SECONDS: "3",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("after 2 attempts (6s)");
  });
});
