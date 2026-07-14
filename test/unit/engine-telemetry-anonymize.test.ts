// App-vitest coverage for the engine telemetry-anonymization primitive (#5680). codecov/patch is computed from
// this app vitest run (vitest.config coverage includes packages/loopover-engine/src/**), so the changed engine
// lines need a vitest test that imports the SRC directly, in addition to the engine's own node:test suite.
import { describe, expect, it } from "vitest";
import { generateAnonSecret, hmacAnonymize } from "../../packages/loopover-engine/src/telemetry/anonymize";

describe("engine telemetry-anonymize primitive (#5680)", () => {
  it("generateAnonSecret returns a 64-char hex string and never collides across calls", () => {
    const a = generateAnonSecret();
    const b = generateAnonSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("hmacAnonymize is deterministic per value+secret, differs across values and across secrets, truncated to 24 hex chars", () => {
    const secret = "fixed-secret-for-test";
    expect(hmacAnonymize("acme/widgets", secret)).toBe(hmacAnonymize("acme/widgets", secret));
    expect(hmacAnonymize("acme/widgets", secret)).not.toBe(hmacAnonymize("acme/other", secret));
    expect(hmacAnonymize("acme/widgets", "secret-a")).not.toBe(hmacAnonymize("acme/widgets", "secret-b"));
    expect(hmacAnonymize("acme/widgets#42", secret)).toMatch(/^[0-9a-f]{24}$/);
  });

  it("matches Orb's own pre-extraction output for a known vector (regression)", () => {
    // Fixed vector captured from the original inline `hmacField` in orb-collector.ts before extraction —
    // guards against the refactor silently changing Orb's live anonymized output.
    expect(hmacAnonymize("acme/widgets", "known-fixed-secret")).toBe("7323d8850fac6d7c2c4bdfae");
  });
});
