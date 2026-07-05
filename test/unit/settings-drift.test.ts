import { describe, expect, it, vi } from "vitest";
import * as repositories from "../../src/db/repositories";
import { parseFocusManifest } from "../../src/signals/focus-manifest";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { computeSettingsDrift, computeSettingsDriftForRepo } from "../../src/settings/settings-drift";
import type { RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function fields(entries: ReturnType<typeof computeSettingsDrift>): string[] {
  return entries.map((entry) => entry.field).sort();
}

describe("computeSettingsDrift (#config-drift-audit)", () => {
  it("reports no drift for an empty manifest", () => {
    const dbSettings = { gittensorLabel: "gittensor", qualityGateMinScore: 50 } as RepositorySettings;
    expect(computeSettingsDrift(dbSettings, parseFocusManifest(null))).toEqual([]);
  });

  it("reports a settings: override that differs from the DB value", () => {
    const dbSettings = { gittensorLabel: "gittensor" } as RepositorySettings;
    const manifest = parseFocusManifest({ settings: { gittensorLabel: "custom-label" } });
    const drift = computeSettingsDrift(dbSettings, manifest);
    expect(drift).toEqual([{ field: "gittensorLabel", dbValue: "gittensor", effectiveValue: "custom-label" }]);
  });

  it("does NOT report drift when the manifest sets the SAME value already in the DB", () => {
    const dbSettings = { gittensorLabel: "gittensor" } as RepositorySettings;
    const manifest = parseFocusManifest({ settings: { gittensorLabel: "gittensor" } });
    expect(computeSettingsDrift(dbSettings, manifest)).toEqual([]);
  });

  it("reports a gate: override the same way as an equivalent settings: override", () => {
    const dbSettings = { gateCheckMode: "off" } as RepositorySettings;
    const manifest = parseFocusManifest({ gate: { enabled: true } });
    const drift = computeSettingsDrift(dbSettings, manifest);
    expect(drift).toEqual([{ field: "gateCheckMode", dbValue: "off", effectiveValue: "enabled" }]);
  });

  it("detects array-valued drift (hardGuardrailGlobs) by content, not by reference", () => {
    const dbSettings = { hardGuardrailGlobs: ["src/scoring/**"] } as RepositorySettings;
    const sameContent = parseFocusManifest({ settings: { hardGuardrailGlobs: ["src/scoring/**"] } });
    expect(computeSettingsDrift(dbSettings, sameContent)).toEqual([]);

    const different = parseFocusManifest({ settings: { hardGuardrailGlobs: ["src/settings/**"] } });
    const drift = computeSettingsDrift(dbSettings, different);
    expect(drift).toEqual([{ field: "hardGuardrailGlobs", dbValue: ["src/scoring/**"], effectiveValue: ["src/settings/**"] }]);
  });

  it("detects object-valued drift (typeLabels) from a sparse per-category manifest override", () => {
    const dbSettings = { typeLabels: { bug: "bug", feature: "enhancement" } } as unknown as RepositorySettings;
    const manifest = parseFocusManifest({ settings: { typeLabels: { bug: "defect" } } });
    const drift = computeSettingsDrift(dbSettings, manifest);
    expect(drift).toEqual([
      { field: "typeLabels", dbValue: { bug: "bug", feature: "enhancement" }, effectiveValue: { bug: "defect", feature: "enhancement" } },
    ]);
  });

  it("does not report contributorBlacklist drift from the shared/global blacklist merge alone (manifest-independent normalization, not manifest shadowing)", () => {
    const dbSettings = { contributorBlacklist: [] } as unknown as RepositorySettings;
    // No manifest override at all, but a non-empty shared/global blacklist -- resolveEffectiveSettings ALWAYS
    // merges this in regardless of manifest presence, so it must not be misreported as manifest-driven drift.
    const drift = computeSettingsDrift(dbSettings, parseFocusManifest(null), [{ login: "GlobalBad", reason: "global" }]);
    expect(drift.some((entry) => entry.field === "contributorBlacklist")).toBe(false);
  });

  it("still reports a MANIFEST-driven contributorBlacklist entry on top of an unrelated shared blacklist", () => {
    const dbSettings = { contributorBlacklist: [] } as unknown as RepositorySettings;
    const manifest = parseFocusManifest({ settings: { contributorBlacklist: [{ login: "ManifestBad" }] } });
    const drift = computeSettingsDrift(dbSettings, manifest, [{ login: "GlobalBad", reason: "global" }]);
    const entry = drift.find((e) => e.field === "contributorBlacklist");
    expect(entry?.effectiveValue).toEqual(expect.arrayContaining([expect.objectContaining({ login: "ManifestBad" }), expect.objectContaining({ login: "GlobalBad" })]));
  });

  it("does not report drift for a DB field the manifest never touches, even when other fields drift", () => {
    const dbSettings = { gittensorLabel: "gittensor", checkRunMode: "enabled" } as RepositorySettings;
    const manifest = parseFocusManifest({ settings: { gittensorLabel: "custom-label" } });
    expect(fields(computeSettingsDrift(dbSettings, manifest))).toEqual(["gittensorLabel"]);
  });
});

describe("computeSettingsDriftForRepo — live DB + manifest fetch (#config-drift-audit)", () => {
  it("reports no drift for a repo with DB settings only, no manifest", async () => {
    const env = createTestEnv();
    const repo = "acme/no-manifest";
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, 'acme', 'no-manifest', 1, 1)").bind(repo).run();
    await repositories.upsertRepositorySettings(env, { repoFullName: repo, gittensorLabel: "gittensor" });
    expect(await computeSettingsDriftForRepo(env, repo)).toEqual([]);
  });

  it("reports drift for a repo whose manifest shadows a DB-stored field", async () => {
    const env = createTestEnv();
    const repo = "acme/shadowed";
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, 'acme', 'shadowed', 1, 1)").bind(repo).run();
    await Promise.all([
      repositories.upsertRepositorySettings(env, { repoFullName: repo, gittensorLabel: "gittensor" }),
      upsertRepoFocusManifest(env, repo, { settings: { gittensorLabel: "manifest-label" } }, "api_record"),
    ]);
    const drift = await computeSettingsDriftForRepo(env, repo);
    expect(drift).toEqual([{ field: "gittensorLabel", dbValue: "gittensor", effectiveValue: "manifest-label" }]);
  });

  it("falls back to an empty shared blacklist (never throws) when the global blacklist read rejects", async () => {
    const env = createTestEnv();
    const repo = "acme/blacklist-read-fails";
    await env.DB.prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, 'acme', 'blacklist-read-fails', 1, 1)").bind(repo).run();
    await repositories.upsertRepositorySettings(env, { repoFullName: repo, gittensorLabel: "gittensor" });
    const getGlobalSpy = vi.spyOn(repositories, "getGlobalContributorBlacklist").mockRejectedValue(new Error("transient DB issue"));
    try {
      await expect(computeSettingsDriftForRepo(env, repo)).resolves.toEqual([]);
    } finally {
      getGlobalSpy.mockRestore();
    }
  });
});
