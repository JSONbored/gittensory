import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCalibrationCli, toAmsRealizedOutcomes } from "../../packages/loopover-miner/lib/calibration-cli.js";
import { initEventLedger, resolveEventLedgerDbPath } from "../../packages/loopover-miner/lib/event-ledger.js";
import {
  initPredictionLedger,
  resolvePredictionLedgerDbPath,
} from "../../packages/loopover-miner/lib/prediction-ledger.js";
import * as predictionLedger from "../../packages/loopover-miner/lib/prediction-ledger.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envForTempStores(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "miner-calibration-cli-"));
  tempDirs.push(dir);
  return { LOOPOVER_MINER_CONFIG_DIR: dir };
}

function seedPrediction(env: Record<string, string | undefined>, targetId: number, conclusion: string) {
  const store = initPredictionLedger(resolvePredictionLedgerDbPath(env));
  store.appendPrediction({
    repoFullName: "acme/widgets",
    targetId,
    conclusion,
    pack: "oss",
    readinessScore: 90,
    blockerCodes: [],
    warningCodes: [],
    engineVersion: "1.0.0",
  });
  store.close();
}

function seedOutcomeEvent(
  env: Record<string, string | undefined>,
  payload: Record<string, unknown>,
  type = "pr_outcome",
) {
  const ledger = initEventLedger(resolveEventLedgerDbPath(env));
  ledger.appendEvent({ type, repoFullName: "acme/widgets", payload });
  ledger.close();
}

describe("loopover-miner calibration CLI (#4849)", () => {
  it("joins a merge prediction with a merged outcome and renders the per-project accuracy", () => {
    const env = envForTempStores();
    seedPrediction(env, 42, "merge");
    seedOutcomeEvent(env, { prNumber: 42, decision: "merged" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("acme/widgets: 1 decided");
    expect(output).toContain("merge 1/1 (100%)");
    expect(output).toContain("close 0/0 (n/a)"); // no close predictions ⇒ n/a
  });

  it("renders n/a merge precision and a realized close precision for a close-only project", () => {
    const env = envForTempStores();
    seedPrediction(env, 99, "close");
    seedOutcomeEvent(env, { prNumber: 99, decision: "closed" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("merge 0/0 (n/a)"); // no merge predictions ⇒ n/a
    expect(output).toContain("close 1/1 (100%)"); // realized close ⇒ precision rendered
  });

  it("emits the structured report under --json", () => {
    const env = envForTempStores();
    seedPrediction(env, 7, "merge");
    seedOutcomeEvent(env, { prNumber: 7, decision: "merged" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli(["--json"], env)).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.hasSignal).toBe(true);
    expect(report.rows[0]).toMatchObject({ project: "acme/widgets", mergeConfirmed: 1, mergePrecision: 1 });
  });

  it("reports no signal when there are no decided predictions", () => {
    const env = envForTempStores();
    seedPrediction(env, 1, "merge"); // prediction with no realized outcome yet
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("no decided predictions");
  });

  it("takes the latest outcome per PR and skips non-outcome / malformed events", () => {
    const env = envForTempStores();
    seedPrediction(env, 5, "merge");
    seedOutcomeEvent(env, { prNumber: 5, decision: "closed" }); // earlier, superseded
    seedOutcomeEvent(env, { prNumber: 5, decision: "merged" }); // latest wins
    seedOutcomeEvent(env, { note: "not a pr outcome" }, "some_other_event"); // wrong type ⇒ ignored
    seedOutcomeEvent(env, { prNumber: "bad" }); // malformed payload ⇒ ignored
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli(["--json"], env)).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.rows[0]).toMatchObject({ mergeConfirmed: 1, mergeFalse: 0 }); // latest "merged" confirmed the merge
  });

  it("prints the #8183 corpus stats line: labeled cases with class counts + engine build, aggregates only", () => {
    const env = envForTempStores();
    seedPrediction(env, 42, "merge"); // merged -> confirmed
    seedPrediction(env, 43, "merge"); // closed -> reversed
    seedOutcomeEvent(env, { prNumber: 42, decision: "merged" });
    seedOutcomeEvent(env, { prNumber: 43, decision: "closed" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(runCalibrationCli([], env)).toBe(0);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("corpus (ams_gate_prediction): 2 case(s) | confirmed 1 | reversed 1 | engine build(s): 1.0.0");
    expect(output).not.toContain("#42"); // corpus CONTENT never prints -- aggregates only
  });

  it("renders the explicit empty-corpus line and embeds corpus stats under --json (#8183)", () => {
    const env = envForTempStores();
    seedPrediction(env, 1, "merge"); // pending: no outcome -> zero labeled cases
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runCalibrationCli([], env)).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("corpus: no labeled cases yet");

    log.mockClear();
    seedOutcomeEvent(env, { prNumber: 1, decision: "merged" });
    expect(runCalibrationCli(["--json"], env)).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.corpus).toEqual({ ruleId: "ams_gate_prediction", cases: 1, confirmed: 1, reversed: 0, engineVersions: ["1.0.0"] });
  });

  it("toAmsRealizedOutcomes drops events without a usable repoFullName (#8183)", () => {
    // Direct mapper call: LedgerEntry.repoFullName is nullable for other event kinds, and the mapper must
    // never fabricate a repo for a malformed pr_outcome row.
    const rows = toAmsRealizedOutcomes([
      { id: 1, seq: 1, type: "pr_outcome", repoFullName: null, payload: { prNumber: 5, decision: "merged" }, createdAt: "2026-07-01T00:00:00.000Z" },
      { id: 2, seq: 2, type: "pr_outcome", repoFullName: "  ", payload: { prNumber: 6, decision: "merged" }, createdAt: "2026-07-01T00:00:00.000Z" },
      { id: 3, seq: 3, type: "pr_outcome", repoFullName: "acme/widgets", payload: { prNumber: 7, decision: "closed" }, createdAt: "2026-07-01T00:00:00.000Z" },
    ] as never);
    expect(rows).toEqual([{ repoFullName: "acme/widgets", prNumber: 7, decision: "closed", recordedAt: "2026-07-01T00:00:00.000Z" }]);
  });

  it("rejects an unknown option with exit code 1", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCalibrationCli(["--bogus"], envForTempStores())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option");
  });

  // #5834: the check only rejected tokens starting with "-", so a stray positional was silently ignored and the
  // command reported a calibration run the operator never asked for. This command takes no positionals at all.
  it("rejects a stray positional argument with exit code 1 (#5834)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCalibrationCli(["foo"], envForTempStores())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option: foo");
  });

  it("rejects a stray positional alongside --json, on the JSON error contract (#5834)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCalibrationCli(["--json", "extra"], envForTempStores())).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
    expect(String(JSON.parse(String(log.mock.calls[0]?.[0])).error)).toContain("Unknown option: extra");
    expect(err).not.toHaveBeenCalled();
  });

  it("emits JSON when ledger open fails with --json (#4836)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(predictionLedger, "initPredictionLedger").mockImplementation(() => {
      throw new Error("corrupt_prediction_ledger");
    });
    expect(runCalibrationCli(["--json"], envForTempStores())).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "corrupt_prediction_ledger",
    });
    expect(err).not.toHaveBeenCalled();
  });
});
