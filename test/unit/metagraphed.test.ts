import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessSubnetClaimFindings,
  interpretSubnetResponse,
  METAGRAPHED_FETCH_TIMEOUT_MS,
  validateNetuid,
  type MetagraphedSubnetResponse,
} from "../../src/services/metagraphed";

/** Build a minimal fetch stub returning the given status + JSON body. */
function fetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interpretSubnetResponse", () => {
  it("maps explicit non-existence to not_found", () => {
    expect(interpretSubnetResponse(9, { exists: false }).status).toBe("not_found");
  });
  it("maps an unhealthy interface (any alias) to exists_unhealthy", () => {
    expect(interpretSubnetResponse(9, { healthy: false }).status).toBe("exists_unhealthy");
    expect(interpretSubnetResponse(9, { interfaceHealthy: false }).status).toBe("exists_unhealthy");
    expect(interpretSubnetResponse(9, { interface: { healthy: false } }).status).toBe("exists_unhealthy");
  });
  it("treats present/healthy/unknown shapes as exists_healthy", () => {
    expect(interpretSubnetResponse(9, { exists: true, healthy: true }).status).toBe("exists_healthy");
    expect(interpretSubnetResponse(9, { netuid: 9 }).status).toBe("exists_healthy");
    expect(interpretSubnetResponse(9, {} as MetagraphedSubnetResponse).status).toBe("exists_healthy");
    expect(interpretSubnetResponse(9, { interface: null }).status).toBe("exists_healthy");
  });
});

describe("validateNetuid", () => {
  it("maps HTTP 404 to not_found and strips a trailing slash from the base URL", async () => {
    const fetchImpl = fetchReturning(404, {});
    const result = await validateNetuid(42, { baseUrl: "https://meta.example/", fetchImpl });
    expect(result.status).toBe("not_found");
    expect(fetchImpl).toHaveBeenCalledWith("https://meta.example/subnets/42", expect.objectContaining({ headers: expect.any(Object) }));
  });

  it("maps other non-2xx responses to unavailable", async () => {
    const result = await validateNetuid(42, { baseUrl: "https://meta.example", fetchImpl: fetchReturning(503, {}) });
    expect(result.status).toBe("unavailable");
  });

  it("interprets a 2xx body (not_found / unhealthy / healthy)", async () => {
    expect((await validateNetuid(1, { baseUrl: "https://m", fetchImpl: fetchReturning(200, { exists: false }) })).status).toBe("not_found");
    expect((await validateNetuid(1, { baseUrl: "https://m", fetchImpl: fetchReturning(200, { healthy: false }) })).status).toBe("exists_unhealthy");
    expect((await validateNetuid(1, { baseUrl: "https://m", fetchImpl: fetchReturning(200, { healthy: true }) })).status).toBe("exists_healthy");
  });

  it("never rejects — network/parse errors map to unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await validateNetuid(42, { baseUrl: "https://meta.example", fetchImpl });
    expect(result.status).toBe("unavailable");
    expect(result.detail).toContain("42");
  });

  it("uses the global fetch and default timeout when none are injected", async () => {
    const globalFetch = fetchReturning(200, { healthy: true });
    vi.stubGlobal("fetch", globalFetch);
    const result = await validateNetuid(74, { baseUrl: "https://meta.example", timeoutMs: 1234 });
    expect(result.status).toBe("exists_healthy");
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(METAGRAPHED_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});

describe("assessSubnetClaimFindings", () => {
  it("is dormant (no findings, no fetch) when METAGRAPHED_API_URL is unset or blank", async () => {
    const fetchImpl = fetchReturning(404, {});
    expect(await assessSubnetClaimFindings({}, { title: "integrates subnet 42" }, { fetchImpl })).toEqual([]);
    expect(await assessSubnetClaimFindings({ METAGRAPHED_API_URL: "   " }, { title: "integrates subnet 42" }, { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces an advisory finding when a claimed subnet is not found (acceptance criterion)", async () => {
    const findings = await assessSubnetClaimFindings(
      { METAGRAPHED_API_URL: "https://meta.example" },
      { title: "feat: integrates subnet 999", body: "wires the new subnet" },
      { fetchImpl: fetchReturning(404, {}), timeoutMs: 2000 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("subnet_claim_not_found");
    expect(findings[0]?.detail).toContain("metagraphed");
  });

  it("falls back to global fetch when no fetchImpl is provided", async () => {
    const globalFetch = fetchReturning(200, { healthy: false });
    vi.stubGlobal("fetch", globalFetch);
    const findings = await assessSubnetClaimFindings({ METAGRAPHED_API_URL: "https://meta.example" }, { body: "uses subnet 5" });
    expect(findings.map((f) => f.code)).toEqual(["subnet_claim_unhealthy"]);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
