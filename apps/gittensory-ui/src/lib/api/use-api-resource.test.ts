import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { useApiResource } from "@/lib/api/use-api-resource";

describe("useApiResource loadedAt (#2219)", () => {
  it("stamps loadedAt when a load succeeds, so headers can show 'last refresh'", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { rows: [] }, status: 200, durationMs: 5 });
    const before = Date.now();
    const { result } = renderHook(() => useApiResource<{ rows: [] }>("/v1/thing", "Thing"));
    expect(result.current.loadedAt).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.loadedAt).toBeGreaterThanOrEqual(before);
    expect(result.current.loadedAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps loadedAt null on a failed load", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "boom", status: 500, durationMs: 5 });
    const { result } = renderHook(() => useApiResource("/v1/thing", "Thing"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.loadedAt).toBeNull();
  });

  it("keeps loadedAt null when the resource is disabled", async () => {
    const { result } = renderHook(() =>
      useApiResource("/v1/thing", "Thing", undefined, { enabled: false }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("disabled");
    expect(result.current.loadedAt).toBeNull();
  });
});

describe("useApiResource errorKind/errorStatus (#793)", () => {
  it("carries the apiFetch failure kind and status through to the error state", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "http",
      message: "500 Internal Server Error",
      status: 500,
      durationMs: 5,
    });
    const { result } = renderHook(() => useApiResource("/v1/thing", "Thing"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ errorKind: "http", errorStatus: 500 });
  });

  it("carries a network failure kind with no status", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "network",
      message: "fetch failed",
      durationMs: 5,
    });
    const { result } = renderHook(() => useApiResource("/v1/thing", "Thing"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ errorKind: "network", errorStatus: undefined });
  });

  it("carries a timeout failure kind", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      kind: "timeout",
      message: "Request timed out",
      durationMs: 5,
    });
    const { result } = renderHook(() => useApiResource("/v1/thing", "Thing"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ errorKind: "timeout" });
  });

  it("leaves errorKind undefined for the synthetic disabled sentinel", async () => {
    const { result } = renderHook(() =>
      useApiResource("/v1/thing", "Thing", undefined, { enabled: false }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    const state = result.current;
    if (state.status !== "error") throw new Error("expected error status");
    expect(state.error).toBe("disabled");
    expect(state.errorKind).toBeUndefined();
  });
});
