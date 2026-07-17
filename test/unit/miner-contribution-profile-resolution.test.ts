import { describe, expect, it, vi } from "vitest";
import { resolveContributionProfiles } from "../../packages/loopover-miner/lib/contribution-profile-resolution.js";
import { emptyContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile.js";
import type { ContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile.js";
import type { ContributionProfileCacheReader } from "../../packages/loopover-miner/lib/contribution-profile-resolution.js";

const REPO = "acme/widgets";
const GENERATED_AT = "2026-07-01T00:00:00.000Z";

function fakeCache(overrides: Partial<ContributionProfileCacheReader> = {}): ContributionProfileCacheReader & {
  puts: Array<{ profile: ContributionProfile; nowMs: number | undefined }>;
} {
  const puts: Array<{ profile: ContributionProfile; nowMs: number | undefined }> = [];
  return {
    get: overrides.get ?? (() => null),
    put: (profile: ContributionProfile, nowMs?: number) => {
      puts.push({ profile, nowMs });
      return (
        (overrides.put as ContributionProfileCacheReader["put"] | undefined)?.(profile, nowMs) ?? {
          repoFullName: profile.repoFullName,
          fetchedAt: new Date(nowMs ?? Date.parse(GENERATED_AT)).toISOString(),
        }
      );
    },
    puts,
  };
}

function labelsResponse(labels: Array<{ name: string; description?: string | null }>) {
  return async () => Response.json(labels);
}

describe("resolveContributionProfiles (#6798)", () => {
  it("uses a fresh cached profile without extracting live", async () => {
    const cached = emptyContributionProfile(REPO, GENERATED_AT);
    const cache = fakeCache({ get: () => ({ profile: cached, fetchedAt: GENERATED_AT, stale: false }) });
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not fetch — cache is fresh");
    });

    const { profilesByRepo } = await resolveContributionProfiles([REPO], { cache, fetchImpl });

    expect(profilesByRepo.get(REPO)).toBe(cached);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cache.puts).toEqual([]);
  });

  it("extracts live and writes back to the cache on a stale cache entry", async () => {
    const stale = emptyContributionProfile(REPO, "2026-01-01T00:00:00.000Z");
    const cache = fakeCache({ get: () => ({ profile: stale, fetchedAt: "2026-01-01T00:00:00.000Z", stale: true }) });
    const fetchImpl = labelsResponse([]);

    const { profilesByRepo } = await resolveContributionProfiles([REPO], {
      cache,
      fetchImpl,
      generatedAt: GENERATED_AT,
    });

    const profile = profilesByRepo.get(REPO);
    expect(profile?.repoFullName).toBe(REPO);
    expect(profile).not.toBe(stale);
    expect(cache.puts).toEqual([{ profile, nowMs: undefined }]);
  });

  it("extracts live and writes back to the cache on a cache miss (null)", async () => {
    const cache = fakeCache({ get: () => null });
    const fetchImpl = labelsResponse([]);

    const { profilesByRepo } = await resolveContributionProfiles([REPO], {
      cache,
      fetchImpl,
      generatedAt: GENERATED_AT,
    });

    expect(profilesByRepo.get(REPO)?.repoFullName).toBe(REPO);
    expect(cache.puts).toHaveLength(1);
  });

  it("always extracts live and never touches a cache when none is supplied (dry-run posture)", async () => {
    const fetchImpl = labelsResponse([]);
    const { profilesByRepo } = await resolveContributionProfiles([REPO], { fetchImpl, generatedAt: GENERATED_AT });
    expect(profilesByRepo.get(REPO)?.repoFullName).toBe(REPO);
  });

  it("still returns the extracted profile when the cache write throws (non-fatal)", async () => {
    const cache = fakeCache({
      get: () => null,
      put: () => {
        throw new Error("disk full");
      },
    });
    const fetchImpl = labelsResponse([]);

    const { profilesByRepo } = await resolveContributionProfiles([REPO], {
      cache,
      fetchImpl,
      generatedAt: GENERATED_AT,
    });

    expect(profilesByRepo.get(REPO)?.repoFullName).toBe(REPO);
  });

  it("does not fetch label descriptions when the extracted profile has no label matchers at all", async () => {
    let labelsCallCount = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels")) {
        labelsCallCount += 1;
        return Response.json([]);
      }
      return new Response("", { status: 404 });
    };

    const { profilesByRepo, labelDescriptionsByRepo } = await resolveContributionProfiles([REPO], {
      fetchImpl,
      generatedAt: GENERATED_AT,
    });

    expect(profilesByRepo.get(REPO)?.eligibilityLabels.value).toBeNull();
    expect(labelDescriptionsByRepo.has(REPO)).toBe(false);
    // The extractor itself calls /labels once (for classification); the resolution helper adds no second
    // call when the profile doesn't need descriptions.
    expect(labelsCallCount).toBe(1);
  });

  it("fetches and populates label descriptions when the extracted profile needed a description-field matcher (the rust E-easy case)", async () => {
    let labelsCallCount = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/labels")) {
        labelsCallCount += 1;
        // Name alone doesn't match any recognized term; the description does -- forces a description-field
        // eligibility matcher out of the real extractor, exactly like rust's real-world E-easy label (#6794).
        return Response.json([{ name: "E-approachable", description: "good first issue material" }]);
      }
      return new Response("", { status: 404 });
    };

    const { profilesByRepo, labelDescriptionsByRepo } = await resolveContributionProfiles([REPO], {
      fetchImpl,
      generatedAt: GENERATED_AT,
    });

    expect(profilesByRepo.get(REPO)?.eligibilityLabels.value).toEqual([
      { field: "description", contains: "good first issue" },
    ]);
    expect(labelDescriptionsByRepo.get(REPO)).toEqual(new Map([["e-approachable", "good first issue material"]]));
    // Once from the extractor's own classification fetch, once more from resolveContributionProfiles's
    // additional fetchRepoLabelDescriptions call now that the profile needs it.
    expect(labelsCallCount).toBe(2);
  });

  it("resolves multiple distinct repos in parallel, keyed by their own repoFullName", async () => {
    const fetchImpl = labelsResponse([]);
    const { profilesByRepo } = await resolveContributionProfiles(["acme/widgets", "acme/gadgets"], {
      fetchImpl,
      generatedAt: GENERATED_AT,
    });

    expect(profilesByRepo.get("acme/widgets")?.repoFullName).toBe("acme/widgets");
    expect(profilesByRepo.get("acme/gadgets")?.repoFullName).toBe("acme/gadgets");
  });
});
