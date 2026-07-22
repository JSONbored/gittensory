// Tests for the AMS hosted-container entry point (#7182). runDiscover/runManagePoll/runAttempt and the
// health server are all mocked -- no real GitHub calls, no real HTTP listener bound.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HealthServerOptions = { port: number; probes: Array<{ name: string; check: () => Promise<boolean> }> };

const runDiscover = vi.fn(async (_args: string[]) => 0);
const runManagePoll = vi.fn(async (_args: string[]) => 0);
const runAttempt = vi.fn(async (_args: string[]) => 0);
const startAmsHealthServer = vi.fn(async (_options: HealthServerOptions) => ({ close: (cb: () => void) => cb() }));

vi.mock("../../packages/loopover-miner/lib/discover-cli.js", () => ({ runDiscover }));
vi.mock("../../packages/loopover-miner/lib/manage-poll.js", () => ({ runManagePoll }));
vi.mock("../../packages/loopover-miner/lib/attempt-cli.js", () => ({ runAttempt }));
vi.mock("../../packages/loopover-miner/lib/ams-health-server.js", () => ({ startAmsHealthServer }));

const { isHostedCycleCommand, runHostedEntry } = await import("../../packages/loopover-miner/lib/hosted-entry.js");

let stateDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  stateDir = mkdtempSync(join(tmpdir(), "loopover-miner-hosted-entry-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("isHostedCycleCommand (#7182)", () => {
  it("recognizes exactly the three one-shot cycle commands", () => {
    expect(isHostedCycleCommand("discover")).toBe(true);
    expect(isHostedCycleCommand("manage-poll")).toBe(true);
    expect(isHostedCycleCommand("attempt")).toBe(true);
  });

  it("rejects the continuous self-scheduling `loop` command and anything unknown", () => {
    expect(isHostedCycleCommand("loop")).toBe(false);
    expect(isHostedCycleCommand("status")).toBe(false);
    expect(isHostedCycleCommand("")).toBe(false);
  });
});

describe("runHostedEntry (#7182)", () => {
  it("returns 2 and never starts the health server when no cycle name is given", async () => {
    const exitCode = await runHostedEntry([], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(2);
    expect(startAmsHealthServer).not.toHaveBeenCalled();
  });

  it("returns 2 and never starts the health server for an unknown cycle name", async () => {
    const exitCode = await runHostedEntry(["loop"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(2);
    expect(startAmsHealthServer).not.toHaveBeenCalled();
  });

  it("dispatches 'discover' to runDiscover, forwarding the remaining args, and returns its exit code", async () => {
    runDiscover.mockResolvedValueOnce(0);

    const exitCode = await runHostedEntry(["discover", "--search", "label:good-first-issue"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(0);
    expect(runDiscover).toHaveBeenCalledWith(["--search", "label:good-first-issue"]);
  });

  it("dispatches 'manage-poll' to runManagePoll, forwarding the remaining args", async () => {
    await runHostedEntry(["manage-poll", "acme/widgets", "42", "--json"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(runManagePoll).toHaveBeenCalledWith(["acme/widgets", "42", "--json"]);
  });

  it("dispatches 'attempt' to runAttempt, forwarding the remaining args", async () => {
    await runHostedEntry(["attempt", "some-item-id"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(runAttempt).toHaveBeenCalledWith(["some-item-id"]);
  });

  it("propagates the underlying cycle command's real failure exit code (2)", async () => {
    runDiscover.mockResolvedValueOnce(2);

    const exitCode = await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(exitCode).toBe(2);
  });

  it("starts the health server on the given port with a state-dir readiness probe", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir }, port: 9090 });

    expect(startAmsHealthServer).toHaveBeenCalledTimes(1);
    const call = startAmsHealthServer.mock.calls[0]![0];
    expect(call.port).toBe(9090);
    expect(call.probes).toHaveLength(1);
    expect(call.probes[0]?.name).toBe("state_dir");
  });

  it("defaults the health server port to 8080 when not given", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    expect(startAmsHealthServer.mock.calls[0]![0].port).toBe(8080);
  });

  it("the state_dir probe passes when the resolved state directory exists", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } });

    const call = startAmsHealthServer.mock.calls[0]![0];
    await expect(call.probes[0]!.check()).resolves.toBe(true);
  });

  it("the state_dir probe fails when the resolved state directory does not exist", async () => {
    await runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: join(stateDir, "does-not-exist") } });

    const call = startAmsHealthServer.mock.calls[0]![0];
    await expect(call.probes[0]!.check()).resolves.toBe(false);
  });

  it("closes the health server even when the cycle command throws, and still propagates the error", async () => {
    const close = vi.fn((cb: () => void) => cb());
    startAmsHealthServer.mockResolvedValueOnce({ close } as never);
    runDiscover.mockRejectedValueOnce(new Error("boom"));

    await expect(runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } })).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("propagates a health-server startup failure without crashing on the never-assigned server", async () => {
    startAmsHealthServer.mockRejectedValueOnce(new Error("port already in use"));

    await expect(runHostedEntry(["discover"], { env: { LOOPOVER_MINER_CONFIG_DIR: stateDir } })).rejects.toThrow("port already in use");
    expect(runDiscover).not.toHaveBeenCalled();
  });

  it("defaults env to process.env when no override is passed", async () => {
    const exitCode = await runHostedEntry(["discover"]);
    expect(typeof exitCode).toBe("number");
  });
});
