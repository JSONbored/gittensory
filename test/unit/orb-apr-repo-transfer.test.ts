import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInstallationToken } from "../../src/github/app";
import {
  evaluateAprRepoTransferRequestEligibility,
  initiateAprRepoTransfer,
  loadAprIdeaCompletion,
  requestAprRepoTransfer,
} from "../../src/orb/apr-repo-transfer";
import { createTestEnv } from "../helpers/d1";

// The transfer initiation mints an App installation token. Mock that mint to return a plain opaque token string
// — NEVER a PEM/private-key block. A prior attempt at this issue was auto-closed by the secret scanner for a
// key-shaped fixture in the diff; the token is opaque to this module, so a bare string is a faithful stand-in.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
const mockedToken = vi.mocked(createInstallationToken);

/** Capture the outbound request so we can assert the endpoint, method, auth, and body. */
function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
}

describe("initiateAprRepoTransfer (#7638)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockResolvedValue("ghs_installation_token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the transfer endpoint with new_owner and the installation token, returning the pending destination", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    stubFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify({ full_name: "customer-acct/widgets" }), { status: 202 });
    });

    const env = createTestEnv();
    const result = await initiateAprRepoTransfer(env, 4242, "loopover-repos/widgets", "customer-acct");

    expect(mockedToken).toHaveBeenCalledWith(env, 4242);
    expect(seenUrl).toBe("https://api.github.com/repos/loopover-repos/widgets/transfer");
    expect(seenInit.method).toBe("POST");
    expect((seenInit.headers as Record<string, string>).authorization).toBe("Bearer ghs_installation_token");
    expect(JSON.parse(String(seenInit.body))).toEqual({ new_owner: "customer-acct" });
    expect(result).toEqual({ initiated: true, status: 202, newFullName: "customer-acct/widgets" });
  });

  it("models a successful response with no repo body as initiated with an unknown destination", async () => {
    stubFetch(() => new Response("", { status: 202 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: true, status: 202, newFullName: null });
  });

  it("treats a 2xx body that omits full_name as initiated with a null destination", async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 99 }), { status: 202 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: true, status: 202, newFullName: null });
  });

  it("returns a structured error (never throws) when the target account does not exist (422)", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "Could not resolve to a User with the login of 'ghost'." }), { status: 422 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "ghost");
    expect(result.initiated).toBe(false);
    expect(result).toMatchObject({ initiated: false, status: 422 });
    if (!result.initiated) expect(result.error).toContain("Could not resolve");
  });

  it("returns a structured error when the caller lacks admin access (403), with a fallback message on an empty body", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: false, status: 403, error: "transfer request failed (403)" });
  });

  it("falls back to a status message when response.text() rejects on a non-OK reply", async () => {
    stubFetch(
      () =>
        ({
          ok: false,
          status: 500,
          text: async () => {
            throw new Error("body unread");
          },
        }) as unknown as Response,
    );
    const result = await initiateAprRepoTransfer(createTestEnv(), 1, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({ initiated: false, status: 500, error: "transfer request failed (500)" });
  });
});

describe("evaluateAprRepoTransferRequestEligibility (#7742)", () => {
  it("allows a request only when the idea-completion signal is true", () => {
    expect(evaluateAprRepoTransferRequestEligibility({ ideaComplete: true })).toEqual({ allowed: true });
  });

  it("rejects when the idea is not complete — including an explicit false", () => {
    expect(evaluateAprRepoTransferRequestEligibility({ ideaComplete: false })).toEqual({
      allowed: false,
      reason: "idea_not_complete",
    });
  });
});

describe("loadAprIdeaCompletion (#7742)", () => {
  it("fail-closes to incomplete until a persisted #7591/#7664 record exists", async () => {
    await expect(loadAprIdeaCompletion(createTestEnv(), { repoFullName: "loopover-repos/widgets" })).resolves.toEqual({
      ideaComplete: false,
    });
    await expect(
      loadAprIdeaCompletion(createTestEnv(), { repoFullName: "loopover-repos/widgets", ideaId: "idea-1" }),
    ).resolves.toEqual({ ideaComplete: false });
  });
});

describe("requestAprRepoTransfer (#7742)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects without calling initiate when the trusted lookup reports incomplete (default fail-closed)", async () => {
    const initiate = vi.fn();
    const result = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate },
    );
    expect(result).toEqual({ status: "rejected", reason: "idea_not_complete" });
    expect(initiate).not.toHaveBeenCalled();
  });

  it("rejects when an injectable lookup reports incomplete, without calling initiate", async () => {
    const initiate = vi.fn();
    const loadCompletion = vi.fn().mockResolvedValue({ ideaComplete: false });
    const env = createTestEnv();
    const result = await requestAprRepoTransfer(
      env,
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct", ideaId: "idea-9" },
      { initiate, loadCompletion },
    );
    expect(loadCompletion).toHaveBeenCalledWith(env, { repoFullName: "loopover-repos/widgets", ideaId: "idea-9" });
    expect(result).toEqual({ status: "rejected", reason: "idea_not_complete" });
    expect(initiate).not.toHaveBeenCalled();
  });

  it("initiates when a trusted lookup reports complete and the GitHub call succeeds", async () => {
    const initiate = vi.fn().mockResolvedValue({ initiated: true, status: 202, newFullName: "customer-acct/widgets" });
    const loadCompletion = vi.fn().mockResolvedValue({ ideaComplete: true });
    const env = createTestEnv();
    const result = await requestAprRepoTransfer(
      env,
      { installationId: 7, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate, loadCompletion },
    );
    expect(initiate).toHaveBeenCalledWith(env, 7, "loopover-repos/widgets", "customer-acct");
    expect(result).toEqual({
      status: "initiated",
      transfer: { initiated: true, status: 202, newFullName: "customer-acct/widgets" },
    });
  });

  it("surfaces a structured failure when initiate returns initiated:false after a trusted complete lookup", async () => {
    const initiate = vi.fn().mockResolvedValue({ initiated: false, status: 403, error: "no admin" });
    const result = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { initiate, loadCompletion: async () => ({ ideaComplete: true }) },
    );
    expect(result).toEqual({
      status: "failed",
      transfer: { initiated: false, status: 403, error: "no admin" },
    });
  });

  it("defaults to initiateAprRepoTransfer when no initiate hook is supplied and completion is trusted-complete", async () => {
    mockedToken.mockResolvedValue("ghs_installation_token");
    stubFetch(() => new Response(JSON.stringify({ full_name: "customer-acct/widgets" }), { status: 202 }));
    const result = await requestAprRepoTransfer(
      createTestEnv(),
      { installationId: 1, repoFullName: "loopover-repos/widgets", newOwner: "customer-acct" },
      { loadCompletion: async () => ({ ideaComplete: true }) },
    );
    expect(result).toEqual({
      status: "initiated",
      transfer: { initiated: true, status: 202, newFullName: "customer-acct/widgets" },
    });
  });
});
