import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnalyticsWindowToggle } from "@/components/site/analytics-window-toggle";

describe("AnalyticsWindowToggle", () => {
  it("renders every window option and marks the current value as pressed (default)", () => {
    render(<AnalyticsWindowToggle value="30d" onChange={() => {}} />);
    const active = screen.getByRole("radio", { name: "Last 30 days" });
    expect(active.getAttribute("data-state")).toBe("on");
    expect(screen.getByRole("radio", { name: "Last 7 days" }).getAttribute("data-state")).toBe(
      "off",
    );
    expect(screen.getByRole("radio", { name: "Last 90 days" }).getAttribute("data-state")).toBe(
      "off",
    );
  });

  it("calls onChange with the selected window when switching", () => {
    const onChange = vi.fn();
    render(<AnalyticsWindowToggle value="30d" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    expect(onChange).toHaveBeenCalledWith("7d");
  });

  it("does not fire onChange when the already-active window is re-pressed", () => {
    const onChange = vi.fn();
    render(<AnalyticsWindowToggle value="30d" onChange={onChange} />);
    // Radix emits "" on deselect; the toggle must swallow it to keep a window selected.
    fireEvent.click(screen.getByRole("radio", { name: "Last 30 days" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
