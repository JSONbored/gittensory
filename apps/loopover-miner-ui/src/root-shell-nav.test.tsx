import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nav active-route regression (#6828). Stub Link like chat-rail.test.tsx, but honor activeProps /
 * inactiveProps from a controllable mock path so we can assert aria-current + mint-underline classes
 * without standing up a full RouterProvider.
 */
let mockPath = "/";

vi.mock("@tanstack/react-router", async () => {
  const react = await import("react");
  return {
    createRootRoute: (options: unknown) => ({ options }),
    Outlet: () => null,
    Link: ({
      children,
      to,
      className,
      activeProps,
      inactiveProps,
      activeOptions: _activeOptions,
      ...rest
    }: {
      children?: React.ReactNode;
      to?: unknown;
      className?: string;
      activeProps?: Record<string, unknown>;
      inactiveProps?: Record<string, unknown>;
      activeOptions?: { exact?: boolean };
    }) => {
      const href = typeof to === "string" ? to : "#";
      const exact = _activeOptions?.exact === true;
      const isActive = exact ? mockPath === href : mockPath === href || mockPath.startsWith(`${href}/`);
      const stateProps = (isActive ? activeProps : inactiveProps) ?? {};
      const { className: stateClass, ...stateRest } = stateProps as {
        className?: string;
        [key: string]: unknown;
      };
      const mergedClass = [className, stateClass].filter(Boolean).join(" ");
      return react.createElement("a", { href, className: mergedClass || undefined, ...stateRest, ...rest }, children);
    },
  };
});

import { RootShell } from "./routes/__root";

const originalInnerWidth = window.innerWidth;

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: width < 768,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  mockPath = "/";
  setViewport(1200);
  document.documentElement.classList.add("dark");
});

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalInnerWidth });
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

describe("RootShell header nav (#6828)", () => {
  it("marks exactly the Overview link as current on `/` (exact match)", () => {
    mockPath = "/";
    render(
      <RootShell>
        <div>page</div>
      </RootShell>,
    );

    const current = screen.getAllByRole("link").filter((el) => el.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe("Overview");
    expect(current[0].className).toMatch(/after:bg-mint/);
    expect(screen.getByRole("link", { name: "Portfolio" }).getAttribute("aria-current")).toBeNull();
  });

  it("does not keep Overview current on a nested path (exact activeOptions)", () => {
    mockPath = "/portfolio";
    render(
      <RootShell>
        <div>page</div>
      </RootShell>,
    );

    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
    const portfolio = screen.getByRole("link", { name: "Portfolio" });
    expect(portfolio.getAttribute("aria-current")).toBe("page");
    expect(portfolio.className).toMatch(/after:bg-mint/);
  });

  it("highlights Run history, Ledgers, and Earnings on their own routes", () => {
    mockPath = "/run-history";
    const { rerender } = render(
      <RootShell>
        <div>page</div>
      </RootShell>,
    );
    expect(screen.getByRole("link", { name: "Run history" }).getAttribute("aria-current")).toBe("page");

    mockPath = "/ledgers";
    rerender(
      <RootShell>
        <div>page</div>
      </RootShell>,
    );
    expect(screen.getByRole("link", { name: "Ledgers" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Run history" }).getAttribute("aria-current")).toBeNull();

    mockPath = "/earnings";
    rerender(
      <RootShell>
        <div>page</div>
      </RootShell>,
    );
    const earnings = screen.getByRole("link", { name: "Earnings — not yet available" });
    expect(earnings.getAttribute("aria-current")).toBe("page");
    expect(earnings.className).toMatch(/after:bg-mint/);
    expect(screen.getByRole("link", { name: "Ledgers" }).getAttribute("aria-current")).toBeNull();
  });

  it("exposes a Primary nav landmark and sticky header chrome classes", () => {
    render(
      <RootShell>
        <div>page</div>
      </RootShell>,
    );

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    const header = document.querySelector("header");
    expect(header?.className).toMatch(/sticky/);
    expect(header?.className).toMatch(/backdrop-blur/);
  });

  it("renders the compact theme toggle with the dark→light accessible name", () => {
    render(
      <RootShell>
        <div>page</div>
      </RootShell>,
    );
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeTruthy();
  });
});
