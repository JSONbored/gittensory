import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bin, tempEnvPrefix } from "./support/miner-cli-harness";
import {
  initPortfolioQueueStore,
  resolvePortfolioQueueDbPath,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";

// True end-to-end tests (#4869): these spawn the REAL `gittensory-miner` binary as a subprocess against a real
// temp state directory — no injected fakes — and drive full offline workflows across multiple invocations, the
// gap the issue calls out (the existing harness tests only cover --version/--help/update-check and unit-level
// discover). `discover` is intentionally not spawned here: it needs live GitHub, which a real subprocess can't be
// handed an injected fetcher for, so its own suite covers it at the (fake-injected) unit level instead.

const dirs: string[] = [];

/** A fresh temp state dir + the env that points the CLI at it and disables the opportunistic npm update check
 *  (so the workflows stay fully offline and deterministic). */
function e2eEnv(): Record<string, string> {
  const dir = tempEnvPrefix();
  dirs.push(dir);
  return { GITTENSORY_MINER_CONFIG_DIR: dir, GITTENSORY_MINER_NO_UPDATE_CHECK: "1" };
}

/** Spawn the real binary, returning stdout/stderr/exit-code separately (unlike the harness's combined capture,
 *  so a `--json` payload on stdout is cleanly parseable). */
function cli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [bin, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gittensory-miner CLI — true end-to-end workflows (#4869)", () => {
  it("status --json reports the real installed package and the local state directory", () => {
    const env = e2eEnv();
    const { stdout, status } = cli(["status", "--json"], env);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.package.name).toBe("@jsonbored/gittensory-miner");
    expect(parsed.stateDir).toBe(env.GITTENSORY_MINER_CONFIG_DIR);
    expect(parsed.node).toContain("v");
    expect(parsed).toHaveProperty("driver");
  });

  it("doctor --json runs the offline check suite (no network) and returns a parseable report", () => {
    const env = e2eEnv();
    const { stdout } = cli(["doctor", "--json"], env);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.ok).toBe("boolean");
    const names = parsed.checks.map((check: { name: string }) => check.name);
    // The offline credential/version checks are present (exit code is env-dependent, so we assert the flow ran).
    expect(names).toContain("node-version");
    expect(names).toContain("github-token");
    expect(names).toContain("coding-agent-credential");
  });

  it("drives a full queue lifecycle through the real binary: seeded → list → next → done", () => {
    const env = e2eEnv();
    // Seed one item into the real portfolio-queue store the CLI resolves and reads.
    const store = initPortfolioQueueStore(resolvePortfolioQueueDbPath(env));
    store.enqueue({ repoFullName: "acme/widgets", identifier: "issue:42", priority: 5 });
    store.close();

    const listed = JSON.parse(cli(["queue", "list", "--json"], env).stdout);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({ identifier: "issue:42", status: "queued" });

    const claimed = JSON.parse(cli(["queue", "next", "--json"], env).stdout);
    expect(claimed.entry).toMatchObject({ identifier: "issue:42", status: "in_progress" });

    const done = cli(["queue", "done", "acme/widgets", "issue:42", "--json"], env);
    expect(done.status).toBe(0);
    expect(JSON.parse(done.stdout).entry.status).toBe("done");

    // Re-read via the real binary a second time: persistence held across three separate processes.
    const after = JSON.parse(cli(["queue", "list", "--json"], env).stdout);
    expect(after.entries[0].status).toBe("done");
  });

  it("queue commands on an empty store return deterministic, parseable results and exit codes", () => {
    const env = e2eEnv();
    expect(JSON.parse(cli(["queue", "list", "--json"], env).stdout).entries).toEqual([]);
    expect(JSON.parse(cli(["queue", "next", "--json"], env).stdout).entry).toBeNull();

    const missing = cli(["queue", "done", "acme/widgets", "nope", "--json"], env);
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: "queue_entry_not_found" });
  });

  it("an unknown subcommand exits non-zero with a discoverable message", () => {
    const env = e2eEnv();
    const { status, stdout, stderr } = cli(["definitely-not-a-command"], env);
    expect(status).toBe(1);
    expect(`${stdout}${stderr}`).toContain("Unknown command");
  });
});
