import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    createFileRoute: () => (options: { component: unknown }) => ({ options }),
  };
});

import { EarningsPage } from "./routes/earnings";

describe("EarningsPage (#7673)", () => {
  it("renders the not-yet-available placeholder without inventing earnings figures", () => {
    render(<EarningsPage />);

    expect(screen.getByRole("heading", { name: "Earnings — not yet available" })).toBeTruthy();
    expect(screen.getByText("Not yet available")).toBeTruthy();
    expect(screen.getByText(/placeholder only/i)).toBeTruthy();
    expect(screen.queryByText(/\d+(\.\d+)?\s*(alpha|tao|usd|\$)/i)).toBeNull();
  });
});
