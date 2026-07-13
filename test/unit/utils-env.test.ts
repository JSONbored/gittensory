import { describe, expect, it } from "vitest";
import { dualPrefixEnvFlag, dualPrefixEnvStrictFlag, dualPrefixEnvString } from "../../src/utils/env";

// #4774: GITTENSORY_ -> LOOPOVER_ self-host env var prefix rename, dual-read. This is a DUAL-READ addition,
// never a cutover -- an existing self-hoster's .env with only the legacy GITTENSORY_ name must keep working
// completely unchanged. The new LOOPOVER_ name wins when both are set (mirrors resolveSentryRelease's
// existing "explicit override first" precedent in src/selfhost/sentry.ts).
describe("dualPrefixEnvString", () => {
  it("reads via the NEW LOOPOVER_ prefix alone (legacy unset)", () => {
    expect(dualPrefixEnvString({ LOOPOVER_VERSION: "1.2.3" }, "VERSION")).toBe("1.2.3");
  });

  it("still reads via the legacy GITTENSORY_ prefix alone — an untouched .env keeps working unchanged", () => {
    expect(dualPrefixEnvString({ GITTENSORY_VERSION: "1.2.3" }, "VERSION")).toBe("1.2.3");
  });

  it("the NEW LOOPOVER_ prefix wins when BOTH are set", () => {
    expect(
      dualPrefixEnvString({ GITTENSORY_VERSION: "old-value", LOOPOVER_VERSION: "new-value" }, "VERSION"),
    ).toBe("new-value");
  });

  it("returns undefined when neither prefix is set", () => {
    expect(dualPrefixEnvString({}, "VERSION")).toBeUndefined();
  });

  it("treats a blank/whitespace-only LOOPOVER_ value as unset and falls through to the legacy prefix", () => {
    expect(dualPrefixEnvString({ GITTENSORY_VERSION: "old-value", LOOPOVER_VERSION: "   " }, "VERSION")).toBe(
      "old-value",
    );
  });

  it("trims surrounding whitespace off whichever value wins", () => {
    expect(dualPrefixEnvString({ LOOPOVER_VERSION: "  1.2.3  " }, "VERSION")).toBe("1.2.3");
    expect(dualPrefixEnvString({ GITTENSORY_VERSION: "  1.2.3  " }, "VERSION")).toBe("1.2.3");
  });

  it("treats a blank/whitespace-only legacy value the same as unset", () => {
    expect(dualPrefixEnvString({ GITTENSORY_VERSION: "   " }, "VERSION")).toBeUndefined();
  });
});

describe("dualPrefixEnvFlag", () => {
  it("accepts the codebase-standard truthy strings via either prefix, case-insensitively", () => {
    for (const value of ["1", "true", "YES", "On"]) {
      expect(dualPrefixEnvFlag({ GITTENSORY_ENABLE_PAGERDUTY: value }, "ENABLE_PAGERDUTY")).toBe(true);
      expect(dualPrefixEnvFlag({ LOOPOVER_ENABLE_PAGERDUTY: value }, "ENABLE_PAGERDUTY")).toBe(true);
    }
  });

  it("treats anything else (including unset) as disabled", () => {
    for (const value of [undefined, "", "0", "false", "nah"]) {
      expect(dualPrefixEnvFlag({ GITTENSORY_ENABLE_PAGERDUTY: value }, "ENABLE_PAGERDUTY")).toBe(false);
    }
    expect(dualPrefixEnvFlag({}, "ENABLE_PAGERDUTY")).toBe(false);
  });

  it("the NEW LOOPOVER_ prefix wins when BOTH are set", () => {
    expect(
      dualPrefixEnvFlag({ GITTENSORY_ENABLE_PAGERDUTY: "true", LOOPOVER_ENABLE_PAGERDUTY: "false" }, "ENABLE_PAGERDUTY"),
    ).toBe(false);
    expect(
      dualPrefixEnvFlag({ GITTENSORY_ENABLE_PAGERDUTY: "false", LOOPOVER_ENABLE_PAGERDUTY: "true" }, "ENABLE_PAGERDUTY"),
    ).toBe(true);
  });
});

describe("dualPrefixEnvStrictFlag", () => {
  it("requires the exact string \"1\" — a loose-truthy value does NOT count", () => {
    expect(dualPrefixEnvStrictFlag({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, "ENABLE_UNSAFE_CODEX_REVIEWER")).toBe(true);
    expect(dualPrefixEnvStrictFlag({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "true" }, "ENABLE_UNSAFE_CODEX_REVIEWER")).toBe(false);
    expect(dualPrefixEnvStrictFlag({}, "ENABLE_UNSAFE_CODEX_REVIEWER")).toBe(false);
  });

  it("still accepts the legacy GITTENSORY_ name alone — an untouched .env keeps working unchanged", () => {
    expect(dualPrefixEnvStrictFlag({ GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, "ENABLE_UNSAFE_CODEX_REVIEWER")).toBe(true);
  });

  it("accepts the NEW LOOPOVER_ name alone", () => {
    expect(dualPrefixEnvStrictFlag({ LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER: "1" }, "ENABLE_UNSAFE_CODEX_REVIEWER")).toBe(true);
  });

  it("the NEW LOOPOVER_ name wins when BOTH are set — does not silently broaden accepted values", () => {
    // Legacy is the strict "1" (would enable on its own); new name is present but not "1" -> new wins -> disabled.
    expect(
      dualPrefixEnvStrictFlag(
        { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "1", LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER: "true" },
        "ENABLE_UNSAFE_CODEX_REVIEWER",
      ),
    ).toBe(false);
    // New name is exactly "1" -> enabled, even though legacy differs.
    expect(
      dualPrefixEnvStrictFlag(
        { GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER: "0", LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER: "1" },
        "ENABLE_UNSAFE_CODEX_REVIEWER",
      ),
    ).toBe(true);
  });
});
