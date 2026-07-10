/**
 * Time-window options for the product analytics dashboard. The selected window
 * is threaded into the dashboard fetch as a `window` query param (which doubles
 * as the useApiResource cache/refetch key) and persisted per-browser.
 */
export const ANALYTICS_WINDOWS = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
] as const;

export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number]["value"];

export const DEFAULT_ANALYTICS_WINDOW: AnalyticsWindow = "30d";

const WINDOW_VALUES = new Set<string>(ANALYTICS_WINDOWS.map((option) => option.value));

/** Narrow an unknown (e.g. a persisted localStorage value) to a valid window. */
export function isAnalyticsWindow(value: unknown): value is AnalyticsWindow {
  return typeof value === "string" && WINDOW_VALUES.has(value);
}

/**
 * Append the selected window as a `window` query param, preserving any existing
 * query string and overriding a stale `window` if one is already present.
 */
export function withWindowParam(path: string, window: AnalyticsWindow): string {
  const [base, existingQuery = ""] = path.split("?");
  const params = new URLSearchParams(existingQuery);
  params.set("window", window);
  return `${base}?${params.toString()}`;
}
