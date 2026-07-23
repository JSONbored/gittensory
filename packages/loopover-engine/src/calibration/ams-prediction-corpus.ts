// AMS-side calibration corpus (#8183, epic #8172): pair the miner's own predicted gate verdicts
// (prediction-ledger rows) with the realized PR outcomes it later observed (event-ledger `pr_outcome`
// events) into the SAME labeled BacktestCase shape the ORB calibration primitives consume. Cases are built
// directly (each prediction IS the decision instance and the outcome IS its verdict — there is no
// nearest-following-override ambiguity to resolve, so routing through buildBacktestCorpus would only
// launder per-prediction labels through a per-target event pairing that can mislabel multi-head PRs);
// everything downstream — scoreBacktest, compareBacktestScores, splitBacktestCorpus, the renderer — is
// reused untouched, which is the reuse boundary #8172 draws: adapters over the miner ledger, not new math.
//
// CLASS MAPPING (the miner's reversal analog): a prediction is one directional call — `merge` or `close` —
// and the realized outcome either agrees (label `confirmed`, the prediction was right) or contradicts it
// (label `reversed`, the prediction was wrong: a merge-shaped prediction whose PR was CLOSED, or a
// close-shaped prediction whose PR was MERGED). `hold`-shaped and unrecognized predictions carry no
// direction a realized outcome can confirm or reverse, so they are skipped — the same "only the decided
// ones count" posture buildCalibrationReport (packages/loopover-miner/lib/calibration.ts) takes.
//
// Fully local by design: both inputs come from a single node's own ledgers, and nothing here performs IO.
import type { BacktestCase } from "./backtest-corpus.js";

/** The synthetic rule id AMS prediction cases are labeled under — one rule, mirroring how #8157 mapped
 *  ORB's decision-level history onto `ai_consensus_defect`. Never reuse an ORB rule id here: the two
 *  deployments' corpora must stay distinguishable at a glance. */
export const AMS_GATE_PREDICTION_RULE_ID = "ams_gate_prediction";

/** A prediction-ledger row, as the miner's thin reader projects it (lib/prediction-ledger.ts's entries). */
export type AmsPredictionRecord = {
  repoFullName: string;
  /** The PR number the prediction targeted. */
  targetId: number;
  headSha: string | null;
  /** The predicted gate verdict (`merge`/`close`/`hold`/…). */
  conclusion: string;
  readinessScore: number | null;
  /** Which engine build produced the prediction — carried into case metadata so a corpus can be filtered
   *  to comparable builds ({@link filterCasesByEngineVersion}). */
  engineVersion: string;
  /** ISO timestamp the prediction was recorded. */
  ts: string;
};

/** The latest realized outcome for one PR, as readPrOutcomes (lib/pr-outcome.ts) reduces the event
 *  stream: `merged` or `closed` (anything else is not terminal and never labels a case). */
export type AmsRealizedOutcome = {
  repoFullName: string;
  prNumber: number;
  decision: string;
  /** ISO timestamp the outcome was observed. */
  recordedAt: string;
};

/**
 * Build the labeled AMS prediction corpus. Deterministic join key: repo + PR number. Re-predictions of the
 * SAME (repo, PR, headSha) collapse to the LATEST by timestamp — one decision instance per head, matching
 * the precision join's per-decision counting — while predictions for DIFFERENT heads of one PR each stand
 * as their own case (each was a real call the node made). Malformed rows on either side are skipped, never
 * guessed at. Pure and deterministic: same ledgers in, same corpus out.
 */
export function buildAmsPredictionCorpus(
  predictions: readonly AmsPredictionRecord[],
  outcomes: readonly AmsRealizedOutcome[],
): BacktestCase[] {
  const outcomeByTarget = new Map<string, { direction: "merge" | "close"; recordedAt: string }>();
  for (const outcome of outcomes) {
    const direction = outcome.decision === "merged" ? "merge" : outcome.decision === "closed" ? "close" : null;
    if (!direction || !outcome.repoFullName.trim() || !Number.isInteger(outcome.prNumber)) continue;
    if (!Number.isFinite(Date.parse(outcome.recordedAt))) continue;
    // Inputs come from readPrOutcomes' latest-per-PR reduction already; when a caller hands raw duplicates
    // anyway, the last entry wins — the same "a later event supersedes" contract that reducer documents.
    outcomeByTarget.set(`${outcome.repoFullName}#${outcome.prNumber}`, { direction, recordedAt: outcome.recordedAt });
  }

  // Latest prediction per (repo, PR, headSha).
  const latestPerHead = new Map<string, AmsPredictionRecord>();
  for (const prediction of predictions) {
    if (!prediction.repoFullName.trim() || !Number.isInteger(prediction.targetId)) continue;
    if (!Number.isFinite(Date.parse(prediction.ts))) continue;
    const direction = predictionDirection(prediction.conclusion);
    if (!direction) continue; // hold-shaped or unrecognized: no direction to confirm/reverse
    const key = `${prediction.repoFullName}#${prediction.targetId}@${prediction.headSha ?? ""}`;
    const existing = latestPerHead.get(key);
    if (!existing || existing.ts < prediction.ts) latestPerHead.set(key, prediction);
  }

  const cases: BacktestCase[] = [];
  for (const prediction of latestPerHead.values()) {
    const targetKey = `${prediction.repoFullName}#${prediction.targetId}`;
    const outcome = outcomeByTarget.get(targetKey);
    if (!outcome) continue; // still pending: undecided predictions never enter the corpus
    const direction = predictionDirection(prediction.conclusion)!;
    const metadata: Record<string, unknown> = { engineVersion: prediction.engineVersion };
    if (prediction.headSha !== null) metadata.headSha = prediction.headSha;
    // The threshold classifier replays against `confidence` on the [0, 1] scale ORB's confidences use;
    // the readiness score is the miner's native confidence signal on a 0-100 scale (gate-advisory.ts
    // renders it as "N/100"), so it is normalized here. Out-of-range/absent stays unset — never guessed.
    if (prediction.readinessScore !== null && Number.isFinite(prediction.readinessScore) && prediction.readinessScore >= 0 && prediction.readinessScore <= 100) {
      metadata.confidence = prediction.readinessScore / 100;
    }
    // Each surviving prediction labels against ITS OWN direction — a multi-head PR whose heads predicted
    // opposite directions yields one confirmed and one reversed case, both correct.
    cases.push({
      ruleId: AMS_GATE_PREDICTION_RULE_ID,
      targetKey,
      outcome: direction,
      label: outcome.direction === direction ? "confirmed" : "reversed",
      firedAt: prediction.ts,
      decidedAt: outcome.recordedAt,
      metadata,
    });
  }
  // Deterministic output order regardless of Map iteration: by target, then firedAt, then head — one
  // composite key so the comparator has no order-of-evaluation-dependent arms (keys are unique: the
  // latest-per-head collapse above removed any (target, head) duplicate).
  const sortKey = (backtestCase: BacktestCase) => `${backtestCase.targetKey}\u0000${backtestCase.firedAt}\u0000${String(backtestCase.metadata?.headSha ?? "")}`;
  return cases.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
}

/** Restrict a corpus to the cases one engine build produced — comparable-build filtering (#8183). */
export function filterCasesByEngineVersion(cases: readonly BacktestCase[], engineVersion: string): BacktestCase[] {
  return cases.filter((backtestCase) => backtestCase.metadata?.engineVersion === engineVersion);
}

export type AmsCorpusStats = {
  cases: number;
  confirmed: number;
  reversed: number;
  /** Distinct engine builds present, ascending — the filter axis {@link filterCasesByEngineVersion} serves. */
  engineVersions: string[];
};

/** Aggregate numbers only — the shape the calibration CLI prints (#8183's read surface). */
export function computeAmsCorpusStats(cases: readonly BacktestCase[]): AmsCorpusStats {
  const engineVersions = new Set<string>();
  let confirmed = 0;
  let reversed = 0;
  for (const backtestCase of cases) {
    if (backtestCase.label === "confirmed") confirmed += 1;
    else reversed += 1;
    const version = backtestCase.metadata?.engineVersion;
    if (typeof version === "string" && version !== "") engineVersions.add(version);
  }
  return { cases: cases.length, confirmed, reversed, engineVersions: [...engineVersions].sort() };
}

function predictionDirection(conclusion: string): "merge" | "close" | null {
  const normalized = conclusion.trim().toLowerCase();
  return normalized === "merge" || normalized === "close" ? normalized : null;
}
