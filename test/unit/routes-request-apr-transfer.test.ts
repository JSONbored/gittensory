import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createInstallationToken } from "../../src/github/app";
import { loadAprIdeaCompletion } from "../../src/orb/apr-idea-completion";
import { createTestEnv } from "../helpers/d1";

// #7742: POST /v1/loop/request-apr-transfer — customer-facing request-only APR transfer. Completion is
// server-resolved (never from the body). Pins the ROUTE contract against real wiring; GitHub is mocked.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
vi.mock("../../src/orb/apr-idea-completion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orb/apr-idea-completion")>();
  return {
    ...actual,
    loadAprIdeaCompletion: vi.fn(actual.loadAprIdeaCompletion),
  };
});
const mockedToken = vi.mocked(createInstallationToken);
const mockedLoadCompletion = vi.mocked(loadAprIdeaCompletion);

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
}

const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/loop/request-apr-transfer";

const validBody = {
  installationId: 42,
  repoFullName: "loopover-repos/widgets",
  newOwner: "customer-acct",
};

const post = (env: Env, body: unknown) =>
  createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

describe("POST /v1/loop/request-apr-transfer (#7742)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockResolvedValue("ghs_installation_token");
    mockedLoadCompletion.mockReset();
    mockedLoadCompletion.mockResolvedValue({ ideaComplete: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 409 without contacting GitHub under the default fail-closed completion lookup", async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return new Response("{}", { status: 202 });
    });
    const response = await post(createTestEnv(), validBody);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ status: "rejected", reason: "idea_not_complete" });
    expect(fetchCalls).toBe(0);
    expect(mockedToken).not.toHaveBeenCalled();
    expect(mockedLoadCompletion).toHaveBeenCalled();
  });

  it("rejects a body that smuggles ideaComplete (strict schema) before any lookup or GitHub call", async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return new Response("{}", { status: 202 });
    });
    const response = await post(createTestEnv(), { ...validBody, ideaComplete: true });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request_apr_transfer_request" });
    expect(mockedLoadCompletion).not.toHaveBeenCalled();
    expect(fetchCalls).toBe(0);
    expect(mockedToken).not.toHaveBeenCalled();
  });

  it("returns 202 when a trusted server lookup reports complete and GitHub accepts", async () => {
    mockedLoadCompletion.mockResolvedValue({ ideaComplete: true });
    stubFetch(() => new Response(JSON.stringify({ full_name: "customer-acct/widgets" }), { status: 202 }));
    const response = await post(createTestEnv(), validBody);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "initiated",
      transfer: { initiated: true, status: 202, newFullName: "customer-acct/widgets" },
    });
  });

  it("returns 502 when a trusted lookup reports complete but GitHub rejects the transfer", async () => {
    mockedLoadCompletion.mockResolvedValue({ ideaComplete: true });
    stubFetch(() => new Response("", { status: 403 }));
    const response = await post(createTestEnv(), validBody);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      status: "failed",
      transfer: { initiated: false, status: 403, error: "transfer request failed (403)" },
    });
  });

  it("rejects an invalid or unparseable body with 400 before any GitHub call", async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return new Response("{}", { status: 202 });
    });
    const env = createTestEnv();
    for (const body of [
      {},
      { ...validBody, installationId: 0 },
      { ...validBody, installationId: -1 },
      { ...validBody, repoFullName: "" },
      { ...validBody, newOwner: "" },
      { ...validBody, ideaId: "" },
      { installationId: 1, repoFullName: "a/b" }, // missing newOwner
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request_apr_transfer_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: "{not json" }, env);
    expect(malformed.status).toBe(400);
    expect(fetchCalls).toBe(0);
    expect(mockedToken).not.toHaveBeenCalled();
  });

  it("forwards an optional ideaId to the trusted lookup without treating it as a completion claim", async () => {
    const response = await post(createTestEnv(), { ...validBody, ideaId: "idea-42" });
    expect(response.status).toBe(409);
    expect(mockedLoadCompletion).toHaveBeenCalledWith(expect.anything(), {
      repoFullName: "loopover-repos/widgets",
      ideaId: "idea-42",
    });
  });

  it("leaks no wallet/hotkey/trust-score terms", async () => {
    const text = JSON.stringify(await (await post(createTestEnv(), validBody)).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
