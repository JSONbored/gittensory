// Convergence (#1963 recap digest) — the opt-in config knob for the multi-repo MAINTAINER recap: wires the
// already-built pure pieces (services/maintainer-recap.ts's buildMaintainerRecap, #2239; services/
// maintainer-recap-calibration.ts's buildCalibrationRecapSection, #2243) into ONE default-OFF-gated
// orchestrator behind the `GITTENSORY_REVIEW_RECAP` flag, byte-for-byte mirroring the isOpsEnabled convention
// at src/review/ops-wire.ts:43 (`/^(1|true|yes|on)$/i`). Flag-OFF (default) → the caller never invokes
// runMaintainerRecap (same contract as isOpsEnabled/isSelfTuneEnabled), so no new D1 read and no delivery
// happens, exactly like ops/selftune/rag today.
//
// Distinct from services/review-recap.ts's PER-REPO generateAndSendReviewRecap: this digest spans EVERY
// registered repo in one report (services/maintainer-recap.ts's RecapReport), so delivery has no single
// repoFullName to route on — it reuses resolveDiscordWebhook's GLOBAL fallback (DISCORD_WEBHOOK_URL) with a
// fixed sentinel target key, the SAME webhook allowlist/validation notify-discord.ts's per-event notifier and
// review-recap.ts's sendReviewRecapToDiscord already use (no second Discord resolution mechanism).
import { listRepositories, recordAuditEvent } from "../db/repositories";
import { loadGatePrecisionReport } from "./gate-precision";
import { buildRepoOutcomeCalibration } from "./outcome-calibration";
import { buildMaintainerRecap, type MaintainerRecapRepoInput } from "./maintainer-recap";
import { buildCalibrationRecapSection } from "./maintainer-recap-calibration";
import { resolveDiscordWebhook } from "./notify-discord";
import { errorMessage, nowIso } from "../utils/json";
import type { RecapReport } from "../types";

/** True when the multi-repo maintainer recap digest is enabled. Flag-OFF (default) → runMaintainerRecap must
 *  never be invoked by the caller — see the module doc. Truthy follows the codebase convention
 *  (`/^(1|true|yes|on)$/i`, same as isOpsEnabled / isSelfTuneEnabled). */
export function isRecapEnabled(env: { GITTENSORY_REVIEW_RECAP?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_RECAP ?? "");
}

/** Sentinel target key for the install-wide digest (it spans every repo, not one) — used for BOTH the
 *  Discord webhook resolution (never matches a per-repo map/legacy-secret entry, so it always falls through
 *  to the global DISCORD_WEBHOOK_URL) and the audit-event targetKey. */
const MAINTAINER_RECAP_TARGET_KEY = "maintainer-recap:install";

/** The registered repos to fold into the digest — the SAME `isRegistered` scope opsScanRepos/selfTuneRepos
 *  use (the repos gittensory actually tracks outcomes for). A repo whose aggregation blips is skipped, never
 *  aborts the whole digest (mirrors runOpsAlerts' per-repo fail-safe). */
async function maintainerRecapRepoInputs(env: Env): Promise<MaintainerRecapRepoInput[]> {
  const repos = (await listRepositories(env)).filter((repo) => repo.isRegistered);
  const inputs: MaintainerRecapRepoInput[] = [];
  for (const repo of repos) {
    try {
      const [gatePrecision, calibration] = await Promise.all([loadGatePrecisionReport(env, repo.fullName), buildRepoOutcomeCalibration(env, repo.fullName)]);
      inputs.push({ gatePrecision, calibration });
    } catch {
      /* a per-repo aggregation blip must not blank the whole digest */
    }
  }
  return inputs;
}

/** Render the built RecapReport as a compact delivery body: the report's own top-line summary plus the
 *  calibration section (#2243) — the same two pieces a richer future formatter would compose. */
export function formatMaintainerRecap(report: RecapReport): string {
  const calibration = buildCalibrationRecapSection(report);
  return [...report.summary, ...calibration.lines].join("\n").slice(0, 1800);
}

/** Best-effort delivery to the install-wide Discord webhook, reusing {@link resolveDiscordWebhook}'s GLOBAL
 *  fallback (this digest has no single repo to route on). Never throws — a delivery failure is recorded to
 *  the audit ledger, mirroring sendReviewRecapToDiscord's fail-safe contract. */
async function deliverMaintainerRecap(env: Env, report: RecapReport): Promise<{ sent: boolean; reason?: string }> {
  const resolved = resolveDiscordWebhook(env, MAINTAINER_RECAP_TARGET_KEY);
  if (resolved.status !== "configured") {
    await recordAuditEvent(env, {
      eventType: "maintainer_recap_notification.discord",
      actor: "gittensory",
      targetKey: MAINTAINER_RECAP_TARGET_KEY,
      outcome: "denied",
      detail: resolved.reason,
      metadata: { windowDays: report.windowDays, repos: report.repos.length },
    });
    return { sent: false, reason: resolved.reason };
  }
  const body = {
    username: "Gittensory",
    embeds: [
      {
        title: `Maintainer recap (${report.windowDays}d)`,
        description: formatMaintainerRecap(report),
        color: 0x5865f2,
        footer: { text: `Gittensory · ${report.repos.length} repo(s)` },
      },
    ],
  };
  try {
    const response = await fetch(resolved.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`discord_webhook_http_${response.status}`);
    await recordAuditEvent(env, {
      eventType: "maintainer_recap_notification.discord",
      actor: "gittensory",
      targetKey: MAINTAINER_RECAP_TARGET_KEY,
      outcome: "completed",
      detail: "sent",
      metadata: { windowDays: report.windowDays, repos: report.repos.length, source: resolved.source },
    });
    return { sent: true };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 160);
    console.warn(JSON.stringify({ event: "maintainer_recap_discord_failed", message: detail }));
    await recordAuditEvent(env, {
      eventType: "maintainer_recap_notification.discord",
      actor: "gittensory",
      targetKey: MAINTAINER_RECAP_TARGET_KEY,
      outcome: "error",
      detail,
      metadata: { windowDays: report.windowDays, repos: report.repos.length },
    });
    return { sent: false, reason: detail };
  }
}

/**
 * The maintainer recap digest, run end-to-end: BUILDS (folds every registered repo's already-computed gate-
 * precision + outcome-calibration into a RecapReport, #2239) + FORMATS (the compact delivery body above) +
 * DELIVERS (the install-wide Discord webhook above). Always returns the computed report even when delivery
 * is denied/degraded, so a caller can inspect the numbers either way — mirrors generateAndSendReviewRecap's
 * contract.
 *
 * Caller MUST gate this on {@link isRecapEnabled} — it must only be invoked from a flag-ON path, so flag-OFF
 * this function is never reached and NO new D1 read or delivery ever happens, exactly like ops/selftune/rag
 * today.
 */
export async function runMaintainerRecap(env: Env): Promise<{ report: RecapReport; delivery: { sent: boolean; reason?: string } }> {
  const repos = await maintainerRecapRepoInputs(env);
  const report = buildMaintainerRecap({ generatedAt: nowIso(), repos });
  const delivery = await deliverMaintainerRecap(env, report);
  return { report, delivery };
}
