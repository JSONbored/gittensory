import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useLocalStorage } from "@/lib/use-local-storage";

describe("useLocalStorage legacyKey migration (rebrand key rename)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reads the new key directly when it's already present, ignoring any legacy key", async () => {
    window.localStorage.setItem("new.key", JSON.stringify("from-new"));
    window.localStorage.setItem("legacy.key", JSON.stringify("from-legacy"));
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("from-new");
  });

  it("falls back to the legacy key when the new key is absent, and migrates the value forward", async () => {
    window.localStorage.setItem("legacy.key", JSON.stringify("carried-over"));
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("carried-over");
    // Migrated forward: the new key now holds the value directly, without removing the legacy key.
    expect(window.localStorage.getItem("new.key")).toBe(JSON.stringify("carried-over"));
    expect(window.localStorage.getItem("legacy.key")).toBe(JSON.stringify("carried-over"));
  });

  it("uses the initial value when neither the new nor the legacy key is present", async () => {
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("initial");
    expect(window.localStorage.getItem("new.key")).toBeNull();
  });

  it("behaves exactly as before when no legacyKey is given at all", async () => {
    window.localStorage.setItem("solo.key", JSON.stringify("value"));
    const { result } = renderHook(() => useLocalStorage<string>("solo.key", "initial"));
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(result.current[0]).toBe("value");
  });

  it("writes through the new key going forward after a migration", async () => {
    window.localStorage.setItem("legacy.key", JSON.stringify("old-value"));
    const { result } = renderHook(() =>
      useLocalStorage<string>("new.key", "initial", "legacy.key"),
    );
    await waitFor(() => expect(result.current[2]).toBe(true));
    act(() => result.current[1]("new-value"));
    expect(window.localStorage.getItem("new.key")).toBe(JSON.stringify("new-value"));
  });
});
