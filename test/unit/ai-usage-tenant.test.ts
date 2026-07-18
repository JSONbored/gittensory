import { describe, expect, it } from "vitest";
import { recordAiUsageEvent, sumAiCostForTenantSince } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #7176: ai_usage_events gained a nullable installation_id tenant column for centralized hosted billing, plus a
// sumAiCostForTenantSince aggregate. These pin: the column is written when supplied and stays null otherwise
// (self-host unaffected), and the aggregate is correctly scoped by tenant + time window.
const base = {
  feature: "ai_review",
  model: "claude-sonnet-5",
  status: "ok",
  estimatedNeurons: 10,
  costUsd: 0.5,
};

async function installationOf(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT installation_id FROM ai_usage_events WHERE id = ?").bind(id).first<{ installation_id: string | null }>();
  return row?.installation_id ?? null;
}

describe("ai_usage_events tenant column + billing aggregate (#7176)", () => {
  it("writes installation_id when a hosted caller supplies it", async () => {
    const env = createTestEnv();
    await recordAiUsageEvent(env, { ...base, installationId: "inst-42", metadata: {}, detail: "x" });
    const { results } = await env.DB.prepare("SELECT id, installation_id FROM ai_usage_events").all<{ id: string; installation_id: string | null }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.installation_id).toBe("inst-42");
  });

  it("leaves installation_id null for a self-host caller that omits it (byte-identical to today)", async () => {
    const env = createTestEnv();
    await recordAiUsageEvent(env, { ...base });
    const { results } = await env.DB.prepare("SELECT id FROM ai_usage_events").all<{ id: string }>();
    expect(await installationOf(env, results[0]!.id)).toBeNull();
    // Explicit null is also accepted and stays null.
    await recordAiUsageEvent(env, { ...base, installationId: null });
    const rows = await env.DB.prepare("SELECT installation_id FROM ai_usage_events").all<{ installation_id: string | null }>().then((r) => r.results);
    expect(rows.every((r) => r.installation_id === null)).toBe(true);
  });

  it("sums cost per tenant since a timestamp, ignoring other tenants, older rows, and null-tenant self-host rows", async () => {
    const env = createTestEnv();
    // Two events for inst-1 after the window, one before it, one for inst-2, one self-host (null tenant).
    const since = "2026-07-10T00:00:00.000Z";
    const seed = async (installationId: string | null, costUsd: number, createdAt: string) => {
      await recordAiUsageEvent(env, { ...base, costUsd, installationId });
      // Backdate the just-inserted row (recordAiUsageEvent stamps nowIso()), so the window filter is exercised.
      await env.DB.prepare("UPDATE ai_usage_events SET created_at = ? WHERE created_at = (SELECT max(created_at) FROM ai_usage_events)").bind(createdAt).run();
    };
    await seed("inst-1", 1.25, "2026-07-11T00:00:00.000Z");
    await seed("inst-1", 0.75, "2026-07-12T00:00:00.000Z");
    await seed("inst-1", 9.0, "2026-07-01T00:00:00.000Z"); // before the window
    await seed("inst-2", 4.0, "2026-07-13T00:00:00.000Z"); // different tenant
    await seed(null, 3.0, "2026-07-14T00:00:00.000Z"); // self-host, null tenant

    expect(await sumAiCostForTenantSince(env, "inst-1", since)).toBeCloseTo(2.0, 5);
    expect(await sumAiCostForTenantSince(env, "inst-2", since)).toBeCloseTo(4.0, 5);
    // A tenant with no rows sums to 0, not an error.
    expect(await sumAiCostForTenantSince(env, "inst-none", since)).toBe(0);
  });
});
