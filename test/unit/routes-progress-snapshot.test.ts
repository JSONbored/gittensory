import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildProgressSnapshot } from "../../src/loop-progress";
import { createTestEnv } from "../helpers/d1";

// #6753: POST /v1/loop/progress-snapshot — the REST mirror bringing loopover_build_progress_snapshot to the
// same parity its same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. The route
// delegates to the pure buildProgressSnapshot (covered by its own unit tests), so these pin the ROUTE
// contract: the snapshot is returned unmodified, and a bad body is rejected.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/loop/progress-snapshot";

const post = (env: Env, body: unknown) =>
  createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

describe("POST /v1/loop/progress-snapshot (#6753)", () => {
  it("returns a progress snapshot for a healthy mid-run loop", async () => {
    const env = createTestEnv();
    const body = {
      iteration: 2,
      maxIterations: 5,
      phase: "coding",
      status: "running",
      recentActivity: [{ step: "edit", detail: "touched routes.ts" }],
    };
    const response = await post(env, body);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      phase: "coding",
      status: "running",
      iteration: 2,
      maxIterations: 5,
      percentComplete: 40,
      done: false,
    });
  });

  it("matches the pure builder for every representative state — parity with the MCP tool", async () => {
    const env = createTestEnv();
    const cases = [
      { iteration: 0, phase: "queued", status: "running" },
      { iteration: 1, maxIterations: 4, phase: "claiming", status: "running" },
      { iteration: 3, maxIterations: 3, phase: "done", status: "converged" },
      { iteration: 1, maxIterations: null, phase: "reviewing", status: "error" },
      {
        iteration: 2,
        maxIterations: 10,
        phase: "submitting",
        status: "abandoned",
        recentActivity: [
          { step: "plan", at: "2026-07-17T00:00:00.000Z" },
          { step: "code", detail: "wrote tests" },
        ],
      },
    ] as const;
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      // PARITY: the route must return exactly what the pure builder the MCP tool calls returns.
      await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify(buildProgressSnapshot(body))));
    }
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    for (const body of [
      {},
      { iteration: 1, phase: "coding" },
      { iteration: 1, phase: "bogus", status: "running" },
      { iteration: 1.5, phase: "coding", status: "running" },
      { iteration: 1, phase: "coding", status: "running", recentActivity: "nope" },
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_progress_snapshot_request" });
    }
    const malformed = await createApp().request(
      PATH,
      { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" },
      createTestEnv(),
    );
    expect(malformed.status).toBe(400);
  });

  it("leaks no wallet/hotkey/trust-score terms", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(
      await (
        await post(env, { iteration: 1, maxIterations: 2, phase: "coding", status: "running" })
      ).json(),
    );
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
