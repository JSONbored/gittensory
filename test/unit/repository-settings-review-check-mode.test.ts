import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #2852/#5373/#6444: reviewCheckMode is config-as-code only now (Batch C, loopover#6444) -- the
// repository_settings.review_check_mode DB column was dropped entirely, so getRepositorySettings/
// upsertRepositorySettings always return the hardcoded "disabled" default here regardless of what a
// caller passes in; resolveEffectiveSettings (not this DB layer) overlays a repo's .loopover.yml
// gate.checkMode value on top. The DB round-trip/invalid-value tests this file used to carry no longer
// apply once there is no column left to round-trip through.
describe("repository_settings: reviewCheckMode default (#2852)", () => {
  it("getRepositorySettings returns disabled for a repo with no DB row at all (conservative, opt-in default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.reviewCheckMode).toBe("disabled");
  });

  it("upsertRepositorySettings ignores any caller-supplied reviewCheckMode -- the read-back is always the hardcoded default", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-both" });
    const settings = await getRepositorySettings(env, "acme/omits-both");
    expect(settings.reviewCheckMode).toBe("disabled");
  });
});
