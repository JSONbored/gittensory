import { useSearch } from "@tanstack/react-router";

/** Dev-only screenshot fixtures. Enable with `?mock=1` (usually alongside `?preview=1`). */
export function isDevMockMode(search: string | Record<string, unknown> | undefined): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof search === "string") {
    return new URLSearchParams(search).get("mock") === "1";
  }
  if (search && typeof search === "object" && "mock" in search) {
    return search.mock === "1" || search.mock === 1 || search.mock === true;
  }
  if (typeof window !== "undefined") {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  }
  return false;
}

export function useDevMockMode(): boolean {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  if (isDevMockMode(search)) return true;
  if (typeof window !== "undefined") {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  }
  return false;
}
