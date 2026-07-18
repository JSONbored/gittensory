import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoModeBanner } from "./components/demo-mode-banner";

describe("DemoModeBanner (#5963)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders nothing outside demo mode", () => {
    vi.stubEnv("VITE_DEMO_MODE", "");
    const { container } = render(<DemoModeBanner />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the synthetic-data notice in demo mode", () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    render(<DemoModeBanner />);
    expect(screen.getByRole("status").textContent).toMatch(/synthetic sample data/i);
  });
});
