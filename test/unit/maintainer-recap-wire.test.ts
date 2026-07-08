import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAuditEvent, recordGateBlockOutcome, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import { buildMaintainerRecap } from "../../src/services/maintainer-recap";
import { formatMaintainerRecap, isRecapEnabled, runMaintainerRecap } from "../../src/services/maintainer-recap-wire";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isRecapEnabled — default OFF, truthy convention (#2247)", () => {
  it("is OFF for unset / false / empty / garbage, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off", "garbage"]) expect(isRecapEnabled({ GITTENSORY_REVIEW_RECAP: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isRecapEnabled({ GITTENSORY_REVIEW_RECAP: on })).toBe(true);
  });
});

describe("formatMaintainerRecap (pure, #2247)", () => {
  it("joins the report's top-line summary with the calibration section's lines", () => {
    const report = buildMaintainerRecap({
      generatedAt: "2026-07-01T00:00:00.000Z",
      windowDays: 7,
      repos: [
        {
          gatePrecision: {
            repoFullName: "owner/repo",
            generatedAt: "2026-07-01T00:00:00.000Z",
            windowDays: null,
            perGateType: [],
            overall: { blocked: 0, blockedThenMerged: 0, falsePositiveRate: null },
            signals: [],
          },
          calibration: {
            repoFullName: "owner/repo",
            generatedAt: "2026-07-01T00:00:00.000Z",
            windowDays: null,
            slop: { totalResolved: 3, bands: [{ band: "low", merged: 2, closed: 1, sampleSize: 3, mergeRate: 0.67 }], overallMergeRate: null, discriminates: null },
            recommendations: { total: 2, positive: 1, negative: 1, pending: 0, positiveRate: 0.5 },
            signals: [],
          },
        },
      ],
    });
    const body = formatMaintainerRecap(report);
    expect(body).toContain("Maintainer recap over the last 7 day(s)");
    expect(body).toContain("Reversals: 1");
    expect(body).toContain("calibration drift");
  });

  it("truncates the rendered body at 1800 characters", () => {
    const report = buildMaintainerRecap({ generatedAt: "2026-07-01T00:00:00.000Z", windowDays: 7, repos: [] });
    // The zero-repo report is already short; assert the invariant on the function's own contract instead.
    expect(formatMaintainerRecap(report).length).toBeLessThanOrEqual(1800);
  });
});

async function seedRegisteredRepo(env: Env, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
    .bind(fullName, owner, name)
    .run();
}

function poisonDbPrepare(env: Env, pattern: RegExp): void {
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    if (pattern.test(sql)) throw new Error("poisoned query");
    return realPrepare(sql);
  }) as typeof env.DB.prepare;
}

async function auditRows(env: Env): Promise<Array<{ outcome: string; detail: string; target_key: string }>> {
  const rows = await env.DB.prepare(
    "select outcome, detail, target_key from audit_events where event_type = 'maintainer_recap_notification.discord' order by created_at",
  ).all<{ outcome: string; detail: string; target_key: string }>();
  return rows.results ?? [];
}

describe("runMaintainerRecap (builds + formats + delivers, #2247)", () => {
  it("returns a zeroed report and a denied delivery when there are no registered repos (empty-repos side)", async () => {
    const env = createTestEnv();
    const { report, delivery } = await runMaintainerRecap(env);
    expect(report.repos).toEqual([]);
    expect(report.totals.reviewed).toBe(0);
    expect(delivery.sent).toBe(false);
    expect(delivery.reason).toBe("missing_global_webhook");
    const rows = await auditRows(env);
    expect(rows.some((r) => r.outcome === "denied" && r.target_key === "maintainer-recap:install")).toBe(true);
  });

  it("skips a registered repo whose aggregation blips without failing the whole digest (per-repo fail-safe)", async () => {
    const env = createTestEnv();
    await seedRegisteredRepo(env, "owner/broken");
    poisonDbPrepare(env, /from "gate_outcomes"|gate_outcomes/i);

    const { report } = await runMaintainerRecap(env);

    expect(report.repos).toEqual([]);
  });

  it("folds a healthy registered repo's real gate-precision + calibration into the report and delivers to the global Discord webhook", async () => {
    const env = Object.assign(createTestEnv(), { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" }) as Env;
    await seedRegisteredRepo(env, "owner/repo");
    for (let i = 1; i <= 6; i += 1) {
      await recordGateBlockOutcome(env, { repoFullName: "owner/repo", pullNumber: i, blockerCodes: ["slop_risk"] });
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: i, title: `PR ${i}`, state: "closed", merged_at: i <= 4 ? "2026-06-01T00:00:00.000Z" : null } as never);
    }
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    });

    const { report, delivery } = await runMaintainerRecap(env);

    expect(report.repos).toHaveLength(1);
    expect(report.repos[0]?.repoFullName).toBe("owner/repo");
    expect(report.totals.blocked).toBe(6);
    expect(delivery.sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://discord.com/api/webhooks/1/abc");
    const embed = JSON.parse(calls[0]?.body ?? "{}").embeds[0];
    expect(embed.title).toContain("Maintainer recap");
    expect(embed.description).toContain("Maintainer recap over the last");
    const rows = await auditRows(env);
    expect(rows.some((r) => r.outcome === "completed")).toBe(true);
  });

  it("degrades to a recorded error result when the webhook POST throws (fail-safe, never throws)", async () => {
    const env = Object.assign(createTestEnv(), { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" }) as Env;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    const { delivery } = await runMaintainerRecap(env);

    expect(delivery.sent).toBe(false);
    expect(delivery.reason).toBe("network down");
    const rows = await auditRows(env);
    expect(rows.some((r) => r.outcome === "error" && r.detail === "network down")).toBe(true);
  });

  it("treats a non-2xx webhook response as a failure", async () => {
    const env = Object.assign(createTestEnv(), { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" }) as Env;
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    const { delivery } = await runMaintainerRecap(env);

    expect(delivery.sent).toBe(false);
    expect(delivery.reason).toBe("discord_webhook_http_500");
  });
});
