import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildClaimPlan, buildTaskGraph, validateIdeaSubmission } from "../../src/idea-intake";
import { createTestEnv } from "../helpers/d1";

// #6756: POST /v1/loop/plan-idea-claims — the REST mirror bringing loopover_plan_idea_claims to the same
// parity its same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. The route
// reproduces the MCP handler (validate → task-graph → buildClaimPlan), so these pin the ROUTE contract:
// the claim plan is returned unmodified, and a malformed/empty submission comes back as the engine's
// actionable error list rather than a silent failure.
const apiHeaders = (env: Env) => ({
  authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`,
  "content-type": "application/json",
});
const PATH = "/v1/loop/plan-idea-claims";

const post = (env: Env, body: unknown) =>
  createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

const VALID = {
  id: "idea-1",
  title: "Retry uploads on 5xx",
  body: "Uploads fail silently on 5xx.",
  targetRepo: { kind: "existing", repo: "acme/widgets" },
};

function expectedPayload(body: unknown) {
  const validated = validateIdeaSubmission(body);
  if (!validated.ok) return { ok: false as const, errors: validated.errors };
  const graph = buildTaskGraph(validated.idea, (body as { decomposition?: never }).decomposition);
  const claimPlan = buildClaimPlan(graph, validated.idea.targetRepo);
  return { ok: true as const, verdict: claimPlan.graphVerdict, claimPlan };
}

describe("POST /v1/loop/plan-idea-claims (#6756)", () => {
  it("turns a valid submission into a claim plan", async () => {
    const env = createTestEnv();
    const response = await post(env, VALID);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      verdict: string;
      claimPlan: { ideaId: string; claimable: unknown[]; deferred: unknown[]; skipped: unknown[] };
    };
    expect(payload.ok).toBe(true);
    expect(["go", "raise", "avoid"]).toContain(payload.verdict);
    expect(payload.claimPlan.ideaId).toBe("idea-1");
    // Single-issue baseline → exactly one disposition slot across the three buckets.
    expect(payload.claimPlan.claimable.length + payload.claimPlan.deferred.length + payload.claimPlan.skipped.length).toBe(1);
  });

  it("matches the pure handler for every accepted shape — parity with the MCP tool", async () => {
    const env = createTestEnv();
    const cases: unknown[] = [
      VALID,
      { ...VALID, priority: "high" },
      { ...VALID, constraints: ["no new deps"], acceptanceHints: ["covered by a unit test"] },
      { ...VALID, decomposition: [{ key: "a", title: "Only issue", body: "Body." }] },
      {
        ...VALID,
        decomposition: [
          { key: "a", title: "First", body: "Body." },
          { key: "b", title: "Second", body: "Body.", dependsOn: ["a"] },
        ],
      },
      // #7635: a provision target has no repo, so the consumer's `resolveIdeaTargetRepo(...) ?? ""` falls back to
      // an empty targetRepo on the plan — exercises the null/provision branch of that unwrap.
      { ...VALID, targetRepo: { kind: "provision" } },
    ];
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      await expect(response.json(), JSON.stringify(body)).resolves.toEqual(
        JSON.parse(JSON.stringify(expectedPayload(body))),
      );
    }
    // The provision case specifically drives the empty-repo plan (the `?? ""` fallback).
    const provisionResponse = await post(env, { ...VALID, targetRepo: { kind: "provision" } });
    const provisionPayload = (await provisionResponse.json()) as { claimPlan: { targetRepo: string } };
    expect(provisionPayload.claimPlan.targetRepo).toBe("");
  });

  it("returns the engine's actionable error list for a malformed or empty submission", async () => {
    const env = createTestEnv();
    const cases: unknown[] = [
      {},
      { ...VALID, id: "" },
      { ...VALID, title: "" },
      { ...VALID, body: "" },
      { ...VALID, targetRepo: { kind: "existing", repo: "" } },
    ];
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json(), JSON.stringify(body)).resolves.toEqual(
        JSON.parse(JSON.stringify(expectedPayload(body))),
      );
    }
  });

  it("rejects an unparseable body with 400", async () => {
    const env = createTestEnv();
    // Zod rejects non-array decomposition before the engine runs.
    const response = await post(env, { ...VALID, decomposition: "nope" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_plan_idea_claims_request" });

    const malformed = await createApp().request(
      PATH,
      { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" },
      createTestEnv(),
    );
    expect(malformed.status).toBe(400);
  });

  it("leaks no wallet/hotkey/trust-score terms", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, VALID)).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
