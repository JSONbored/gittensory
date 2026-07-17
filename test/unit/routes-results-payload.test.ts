import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildResultsPayload, type IterationResult } from "../../src/results-payload";
import { createTestEnv } from "../helpers/d1";

// #6752: POST /v1/loop/results-payload — the REST mirror bringing loopover_build_results_payload to the same
// parity its same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. The route delegates to
// the pure buildResultsPayload (covered by its own unit tests in results-payload.test.ts), so these pin the ROUTE
// contract: the composed payload is returned unmodified for every shape the MCP tool accepts, and a bad body is
// rejected rather than passed through to the composer.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/loop/results-payload";

const post = (env: Env, body: unknown) =>
  createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

describe("POST /v1/loop/results-payload (#6752)", () => {
  it("composes the customer-facing result for an iteration that opened a PR", async () => {
    const env = createTestEnv();
    const response = await post(env, {
      repoFullName: "acme/widgets",
      prNumber: 42,
      title: "Add retry to the upload client",
      changedFiles: [
        { path: "src/upload.ts", additions: 12, deletions: 3 },
        { path: "test/upload.test.ts", additions: 30, deletions: 0 },
      ],
      status: "merged",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      prLink: "https://github.com/acme/widgets/pull/42",
      totals: { files: 2, additions: 42, deletions: 3 },
    });
  });

  it("returns null prLink when the iteration opened no pull request", async () => {
    const env = createTestEnv();
    const response = await post(env, { repoFullName: "acme/widgets", prNumber: null, title: "Nothing to open" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ prLink: null, totals: { files: 0, additions: 0, deletions: 0 } });
  });

  it("returns exactly what the pure composer returns for every shape the tool accepts", async () => {
    const env = createTestEnv();
    // One case per meaningful arm of the composer's input: PR/no-PR, absent vs null prNumber, each status,
    // absent/empty/partial changedFiles, and a change over the diff-preview cap (totals must still count all).
    const cases: IterationResult[] = [
      { repoFullName: "acme/widgets", prNumber: 42, title: "Opened", status: "open" },
      { repoFullName: "acme/widgets", prNumber: 42, title: "Merged", status: "merged" },
      { repoFullName: "acme/widgets", prNumber: 42, title: "Closed", status: "closed" },
      { repoFullName: "acme/widgets", prNumber: 7, title: "Status omitted defaults to open" },
      { repoFullName: "acme/widgets", title: "prNumber absent entirely" },
      { repoFullName: "acme/widgets", prNumber: null, title: "prNumber null" },
      { repoFullName: "acme/widgets", prNumber: 9, title: "Empty changed set", changedFiles: [] },
      { repoFullName: "acme/widgets", prNumber: 9, title: "Counts omitted", changedFiles: [{ path: "README.md" }] },
      {
        repoFullName: "acme/widgets",
        prNumber: 9,
        title: "Over the preview cap",
        changedFiles: Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, additions: i, deletions: 1 })),
      },
    ];
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      // PARITY: the route must return exactly what the pure composer the MCP tool calls returns.
      await expect(response.json(), JSON.stringify(body)).resolves.toEqual(JSON.parse(JSON.stringify(buildResultsPayload(body))));
    }
  });

  it("rejects an invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    for (const body of [
      {},
      { title: "missing repoFullName" },
      { repoFullName: "", title: "empty repoFullName" },
      { repoFullName: "acme/widgets" },
      { repoFullName: "acme/widgets", title: 7 },
      { repoFullName: "acme/widgets", title: "bad status", status: "reopened" },
      { repoFullName: "acme/widgets", title: "bad prNumber", prNumber: 1.5 },
      { repoFullName: "acme/widgets", title: "bad changedFiles", changedFiles: [{ additions: 1 }] },
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_results_payload_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("leaks no wallet/hotkey/trust-score terms", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, { repoFullName: "acme/widgets", prNumber: 42, title: "Add retry" })).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
