import { describe, expect, it } from "vitest";

import { readStoredSessionToken } from "@/components/site/api/try-it";

describe("readStoredSessionToken legacyKey migration (rebrand key rename)", () => {
  it("reads the new key directly when present, ignoring any legacy key", () => {
    window.localStorage.clear();
    window.localStorage.setItem("loopover.session_token", "new-token");
    window.localStorage.setItem("gittensory.session_token", "legacy-token");
    expect(readStoredSessionToken(window.localStorage)).toBe("new-token");
  });

  it("falls back to the legacy key when the new key is absent, and migrates the value forward", () => {
    window.localStorage.clear();
    window.localStorage.setItem("gittensory.session_token", "legacy-token");
    expect(readStoredSessionToken(window.localStorage)).toBe("legacy-token");
    expect(window.localStorage.getItem("loopover.session_token")).toBe("legacy-token");
  });

  it("returns an empty string when neither key is present", () => {
    window.localStorage.clear();
    expect(readStoredSessionToken(window.localStorage)).toBe("");
  });
});
