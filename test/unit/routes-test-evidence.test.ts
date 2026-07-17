import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildTestEvidenceReport } from "../../src/signals/test-evidence";
import { createTestEnv } from "../helpers/d1";

// #6749: POST /v1/lint/test-evidence — the REST mirror bringing loopover_check_test_evidence to the parity its
// same-tier sibling /v1/lint/slop-risk already has. The builder's own correctness is pinned independently by
// test-evidence-report.test.ts; these assert the ROUTE contract: schema parity with the MCP tool's shape, the
// verdict passed through unmodified, and 400s on invalid input.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/lint/test-evidence";
const post = (env: Env, body: unknown) => createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

describe("POST /v1/lint/test-evidence (#6749)", () => {
  it("returns the shared builder's verdict for every arm", async () => {
    const env = createTestEnv();
    const cases = [
      { changedPaths: ["src/a.ts"] },
      { changedPaths: ["src/a.ts"], testFiles: ["test/a.test.ts"] },
      { changedPaths: ["src/a.ts"], tests: ["ran `go test ./...` locally, no new file"] },
      { changedPaths: ["README.md"] },
      { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], testFiles: ["test/a.test.ts"] },
      { changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], testFiles: ["test/a.test.ts"] },
      { changedPaths: [] },
    ];
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      await expect(response.json()).resolves.toEqual(JSON.parse(JSON.stringify(buildTestEvidenceReport(body))));
    }
  });

  it("accepts exactly what the MCP tool's checkTestEvidenceShape accepts (schema parity)", async () => {
    const env = createTestEnv();
    // `tests` is an ARRAY of strings on the tool, not free text — the mirror must agree.
    expect((await post(env, { changedPaths: ["src/a.ts"], tests: ["a", "b"] })).status).toBe(200);
    // An empty changedPaths array is valid for the tool (it yields "absent"), so the route must not reject it.
    expect((await post(env, { changedPaths: [] })).status).toBe(200);
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    for (const body of [{}, { changedPaths: "nope" }, { changedPaths: ["src/a.ts"], tests: "free text is not an array" }, { changedPaths: [""] }]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_test_evidence_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("uploads no source and leaks no private terms — path metadata only", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, { changedPaths: ["src/a.ts"] })).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
