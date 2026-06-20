import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useApiResource } from "@/lib/api/use-api-resource";

type MockPayload = { ok: boolean };

function Probe({ mock }: { mock?: MockPayload }) {
  const state = useApiResource<MockPayload>("/v1/example", "Example", undefined, {
    mockData: mock,
  });
  return <div>{state.status === "ready" ? "ready" : state.status}</div>;
}

describe("useApiResource dev mocks", () => {
  it("serves mockData in dev without calling the network", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<Probe mock={{ ok: true }} />);
    await waitFor(() => {
      expect(screen.getByText("ready")).toBeTruthy();
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
