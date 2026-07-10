import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANALYTICS_WINDOW,
  isAnalyticsWindow,
  withWindowParam,
} from "@/lib/analytics-window";

describe("analytics-window helpers", () => {
  it("exposes a valid default window", () => {
    expect(isAnalyticsWindow(DEFAULT_ANALYTICS_WINDOW)).toBe(true);
  });

  it("narrows only known window values", () => {
    expect(isAnalyticsWindow("7d")).toBe(true);
    expect(isAnalyticsWindow("30d")).toBe(true);
    expect(isAnalyticsWindow("90d")).toBe(true);
    expect(isAnalyticsWindow("1d")).toBe(false);
    expect(isAnalyticsWindow("")).toBe(false);
    expect(isAnalyticsWindow(undefined)).toBe(false);
    expect(isAnalyticsWindow(7)).toBe(false);
  });

  it("appends the window as a query param on a bare path", () => {
    expect(withWindowParam("/v1/app/operator-dashboard", "7d")).toBe(
      "/v1/app/operator-dashboard?window=7d",
    );
  });

  it("preserves an existing query string", () => {
    expect(withWindowParam("/v1/app/operator-dashboard?flag=1", "90d")).toBe(
      "/v1/app/operator-dashboard?flag=1&window=90d",
    );
  });

  it("overrides a stale window already present in the query", () => {
    expect(withWindowParam("/v1/app/operator-dashboard?window=7d", "30d")).toBe(
      "/v1/app/operator-dashboard?window=30d",
    );
  });
});
