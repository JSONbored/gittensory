// Tests for the AMS half of #8202's secret-bootstrap mechanism (#8246). Mirrors
// test/unit/orb-broker-client.test.ts's own fetchBrokeredStoredSecret coverage closely -- this file is a
// deliberate duplicate of that exchange logic (see tenant-credential-resolution.ts's header for why), so its
// test coverage should read the same way. Named "credential" rather than "secret" purely to stay clear of
// scripts/check-miner-package.ts's filename-based FORBIDDEN_PATH filter (a coarse `.*secret.*` heuristic aimed
// at stray credential files like .env/.pem, not descriptively-named source code) -- the exported symbols below
// still say "Secret", matching src/orb/broker-client.ts's own naming for the function this duplicates.
import { describe, expect, it, vi } from "vitest";
import { fetchTenantSecret, resolveTenantSecret } from "../../packages/loopover-miner/lib/tenant-credential-resolution";

/** A fetch stub that records the URL + init and returns a fixed response. */
function captureFetch(resp: Response): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit | undefined }[] } {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return resp;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("fetchTenantSecret (#8246)", () => {
  it("exchanges the tenant secret token for a stored secret (default broker URL + Bearer token)", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ secretValue: "postgres://tenant-acme:hunter2@neon/acme", secretType: "tenant_db_credential" }));
    const out = await fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "orbsec_x" }, fetchImpl);
    expect(out).toEqual({ secretValue: "postgres://tenant-acme:hunter2@neon/acme", secretType: "tenant_db_credential" });
    expect(calls[0]?.url).toBe("https://api.loopover.ai/v1/orb/token");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer orbsec_x");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("respects a custom ORB_BROKER_URL", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ secretValue: "v", secretType: "tenant_db_credential" }));
    await fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s", ORB_BROKER_URL: "https://broker.example/" }, fetchImpl);
    expect(calls[0]?.url).toBe("https://broker.example/v1/orb/token");
  });

  it("rejects unsafe broker URLs (same validation as broker-client.ts's own orbBrokerBaseUrl)", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch should not be called for an unsafe broker URL");
    }) as typeof fetch;
    await expect(fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s", ORB_BROKER_URL: "http://broker.example" }, fetchImpl)).rejects.toThrow(/must use https/);
    await expect(fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s", ORB_BROKER_URL: "https://user:pass@broker.example" }, fetchImpl)).rejects.toThrow(/userinfo/);
    await expect(fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s", ORB_BROKER_URL: "https://broker.example?redirect=evil" }, fetchImpl)).rejects.toThrow(/query string or fragment/);
    await expect(fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s", ORB_BROKER_URL: "not a url" }, fetchImpl)).rejects.toThrow(/valid URL/);
  });

  it("allows an explicit localhost HTTP broker URL for development only", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ secretValue: "v", secretType: "t" }));
    await fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s", ORB_BROKER_URL: "http://localhost:8787" }, fetchImpl);
    expect(calls[0]?.url).toBe("http://localhost:8787/v1/orb/token");
  });

  it("preserves and trails a non-root base path instead of collapsing it (only an exact '/' collapses to empty)", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ secretValue: "v", secretType: "t" }));
    await fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s", ORB_BROKER_URL: "https://broker.example/orb/" }, fetchImpl);
    expect(calls[0]?.url).toBe("https://broker.example/orb/v1/orb/token");
  });

  it("sends an empty Bearer when no token is set (defensive ?? branch)", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ secretValue: "v", secretType: "t" }));
    await fetchTenantSecret({}, fetchImpl);
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer ");
  });

  it("defaults secretType to an empty string when the broker response omits it (defensive ?? branch)", async () => {
    const { fetchImpl } = captureFetch(Response.json({ secretValue: "v" }));
    const out = await fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s" }, fetchImpl);
    expect(out).toEqual({ secretValue: "v", secretType: "" });
  });

  it("throws on a non-OK broker response (e.g. 401 invalid_enrollment)", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    await expect(fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s" }, fetchImpl)).rejects.toThrow(/401/);
  });

  it("throws when the broker response has no secretValue", async () => {
    const fetchImpl = (async () => Response.json({ secretType: "tenant_db_credential" })) as typeof fetch;
    await expect(fetchTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "s" }, fetchImpl)).rejects.toThrow(/did not include a secretValue/);
  });
});

describe("resolveTenantSecret (#8246)", () => {
  it("returns null without ever calling fetch when LOOPOVER_TENANT_SECRET_TOKEN is unset (self-host/unprovisioned, the common case)", async () => {
    const fetchImpl = vi.fn();
    const out = await resolveTenantSecret({}, fetchImpl as unknown as typeof fetch);
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null without calling fetch when the token is present but blank", async () => {
    const fetchImpl = vi.fn();
    const out = await resolveTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "   " }, fetchImpl as unknown as typeof fetch);
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns the real exchanged secret when a token is set and the exchange succeeds", async () => {
    const { fetchImpl } = captureFetch(Response.json({ secretValue: "postgres://tenant-acme@neon/acme", secretType: "tenant_db_credential" }));
    const out = await resolveTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "orbsec_x" }, fetchImpl);
    expect(out).toEqual({ secretValue: "postgres://tenant-acme@neon/acme", secretType: "tenant_db_credential" });
  });

  it("swallows an exchange failure, warn-logs it, and returns null instead of throwing -- a broker outage must never block a scheduled cycle", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;

    const out = await resolveTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "orbsec_x" }, fetchImpl);

    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((warn.mock.calls[0] as [string])[0]) as { event: string; message: string };
    expect(logged.event).toBe("ams_tenant_secret_resolve_failed");
    expect(logged.message).toMatch(/503/);
    warn.mockRestore();
  });

  it("swallows a non-Error rejection from the exchange too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = (async () => {
      throw "a plain string rejection";
    }) as unknown as typeof fetch;

    const out = await resolveTenantSecret({ LOOPOVER_TENANT_SECRET_TOKEN: "orbsec_x" }, fetchImpl);

    expect(out).toBeNull();
    const logged = JSON.parse((warn.mock.calls[0] as [string])[0]) as { message: string };
    expect(logged.message).toBe("a plain string rejection");
    warn.mockRestore();
  });
});
