import { describe, expect, it } from "vitest";
import { fetchBrokeredInstallationToken, isOrbBrokerMode } from "../../src/orb/broker-client";

/** A fetch stub that records the URL + init and returns a fixed response. */
function captureFetch(resp: Response): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit | undefined }[] } {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return resp;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("isOrbBrokerMode", () => {
  it("is on only when an enrollment secret is configured", () => {
    expect(isOrbBrokerMode({})).toBe(false);
    expect(isOrbBrokerMode({ ORB_ENROLLMENT_SECRET: "orbsec_x" })).toBe(true);
  });
});

describe("fetchBrokeredInstallationToken", () => {
  it("exchanges the secret for a token + parses the expiry (default broker URL + Bearer secret)", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "ghs_x", installationId: 42, expiresAt: "2026-06-25T09:00:00Z" }));
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "orbsec_x" }, fetchImpl);
    expect(out).toEqual({ token: "ghs_x", installationId: 42, expiresAtMs: Date.parse("2026-06-25T09:00:00Z") });
    expect(calls[0]?.url).toBe("https://gittensory-api.aethereal.dev/v1/orb/token");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer orbsec_x");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("defaults installationId + expiry when absent, and strips a trailing slash from a custom broker URL", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "ghs_y" }));
    const out = await fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s", ORB_BROKER_URL: "https://broker.example/" }, fetchImpl);
    expect(out.token).toBe("ghs_y");
    expect(out.installationId).toBe(0); // payload.installationId ?? 0
    expect(out.expiresAtMs).toBeGreaterThan(Date.now()); // payload.expiresAt absent → ~50min default
    expect(calls[0]?.url).toBe("https://broker.example/v1/orb/token");
  });

  it("sends an empty Bearer when no secret is set (defensive ?? branch)", async () => {
    const { fetchImpl, calls } = captureFetch(Response.json({ token: "t" }));
    await fetchBrokeredInstallationToken({}, fetchImpl);
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer ");
  });

  it("throws on a non-OK broker response (e.g. 403 installation_not_eligible)", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s" }, fetchImpl)).rejects.toThrow(/403/);
  });

  it("throws when the broker response has no token", async () => {
    const fetchImpl = (async () => Response.json({ installationId: 1 })) as typeof fetch;
    await expect(fetchBrokeredInstallationToken({ ORB_ENROLLMENT_SECRET: "s" }, fetchImpl)).rejects.toThrow(/did not include a token/);
  });
});
