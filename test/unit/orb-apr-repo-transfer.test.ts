import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInstallationToken } from "../../src/github/app";
import { initiateAprRepoTransfer } from "../../src/orb/apr-repo-transfer";
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
    // A 202 with an unparseable/empty body still means "initiated" — the destination path is simply not known yet.
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
});
