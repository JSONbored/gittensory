import { describe, expect, it } from "vitest";
import { computeAudit, formatMarkdownReport, parseArgs, parseManifestOverlay } from "../../scripts/audit-quality-gate-min-score";

// Persisted `repo-focus-manifest` snapshot payloads, as scripts/../signals/focus-manifest.ts's *toJson serializers
// write them: `gate.readiness.minScore` (typed alias) and `settings.qualityGateMinScore` / `settings.autonomy`.
const gateReadiness = (minScore: number) => JSON.stringify({ gate: { readiness: { minScore } } });
const settingsThreshold = (minScore: number) => JSON.stringify({ settings: { qualityGateMinScore: minScore } });
const settingsAutonomy = (autonomy: Record<string, string>) => JSON.stringify({ settings: { autonomy } });

describe("parseManifestOverlay", () => {
  it("reads the typed gate.readiness.minScore threshold", () => {
    expect(parseManifestOverlay(gateReadiness(70))).toEqual({ minScore: 70, autonomy: undefined });
  });

  it("falls back to settings.qualityGateMinScore when no gate alias is present", () => {
    expect(parseManifestOverlay(settingsThreshold(55))).toEqual({ minScore: 55, autonomy: undefined });
  });

  it("lets the typed gate alias win over the generic settings threshold", () => {
    const payload = JSON.stringify({ gate: { readiness: { minScore: 80 } }, settings: { qualityGateMinScore: 40 } });
    expect(parseManifestOverlay(payload).minScore).toBe(80);
  });

  it("treats an absent, malformed, or non-numeric threshold as unset", () => {
    expect(parseManifestOverlay("{}").minScore).toBeNull();
    expect(parseManifestOverlay("not json").minScore).toBeNull();
    expect(parseManifestOverlay(JSON.stringify({ gate: { readiness: { minScore: "70" } } })).minScore).toBeNull();
    expect(parseManifestOverlay(JSON.stringify({ settings: { qualityGateMinScore: null } })).minScore).toBeNull();
  });

  it("normalizes a manifest-set autonomy override and drops unknown classes/levels", () => {
    const overlay = parseManifestOverlay(settingsAutonomy({ merge: "auto", bogus_class: "auto", review: "not_a_level" }));
    expect(overlay.autonomy).toEqual({ merge: "auto" });
  });
});

describe("computeAudit", () => {
  it("counts the no-threshold fraction over the repository_settings population", () => {
    const audit = computeAudit({
      settingsRows: [
        { repo_full_name: "o/has-gate", autonomy_json: "{}" },
        { repo_full_name: "o/has-settings-gate", autonomy_json: "{}" },
        { repo_full_name: "o/no-gate", autonomy_json: "{}" },
        { repo_full_name: "o/no-manifest", autonomy_json: "{}" },
      ],
      manifestRows: [
        { repo_full_name: "o/has-gate", payload_json: gateReadiness(70) },
        { repo_full_name: "o/has-settings-gate", payload_json: settingsThreshold(60) },
        { repo_full_name: "o/no-gate", payload_json: "{}" },
      ],
    });
    expect(audit.totalConfiguredRepos).toBe(4);
    expect(audit.reposWithThresholdSet).toBe(2);
    expect(audit.reposWithNoThreshold).toBe(2);
    expect(audit.fractionNoThreshold).toBeCloseTo(0.5);
  });

  it("reports 0 fraction for an empty population without dividing by zero", () => {
    const audit = computeAudit({ settingsRows: [], manifestRows: [] });
    expect(audit.totalConfiguredRepos).toBe(0);
    expect(audit.fractionNoThreshold).toBe(0);
  });

  it("resolves effective autonomy for the no-threshold population, DB row deny-by-default", () => {
    const audit = computeAudit({
      settingsRows: [{ repo_full_name: "o/db-auto", autonomy_json: JSON.stringify({ merge: "auto" }) }],
      manifestRows: [],
    });
    expect(audit.reposWithNoThreshold).toBe(1);
    // The one repo has merge=auto in its DB row; every other class is deny-by-default `observe`.
    expect(audit.noThresholdAutonomyByClass.merge).toEqual({ observe: 0, auto_with_approval: 0, auto: 1 });
    expect(audit.noThresholdAutonomyByClass.close).toEqual({ observe: 1, auto_with_approval: 0, auto: 0 });
  });

  it("lets a manifest autonomy override wholesale-replace the DB row's autonomy", () => {
    const audit = computeAudit({
      settingsRows: [{ repo_full_name: "o/overridden", autonomy_json: JSON.stringify({ merge: "auto" }) }],
      manifestRows: [{ repo_full_name: "o/overridden", payload_json: settingsAutonomy({ close: "auto_with_approval" }) }],
    });
    // The manifest override replaces the DB autonomy, so merge is back to `observe` and close is approval-gated.
    expect(audit.noThresholdAutonomyByClass.merge).toEqual({ observe: 1, auto_with_approval: 0, auto: 0 });
    expect(audit.noThresholdAutonomyByClass.close).toEqual({ observe: 0, auto_with_approval: 1, auto: 0 });
  });

  it("counts manifest-only threshold repos that sit outside the settings population", () => {
    const audit = computeAudit({
      settingsRows: [{ repo_full_name: "o/in-pop", autonomy_json: "{}" }],
      manifestRows: [
        { repo_full_name: "o/in-pop", payload_json: "{}" },
        { repo_full_name: "o/config-only", payload_json: gateReadiness(65) },
        { repo_full_name: "o/config-only-no-gate", payload_json: "{}" },
      ],
    });
    expect(audit.manifestOnlyThresholdRepos).toBe(1);
  });
});

describe("formatMarkdownReport", () => {
  it("renders a postable comment with the headline fraction and a per-class autonomy table", () => {
    const md = formatMarkdownReport(
      computeAudit({
        settingsRows: [
          { repo_full_name: "o/a", autonomy_json: JSON.stringify({ merge: "auto" }) },
          { repo_full_name: "o/b", autonomy_json: "{}" },
        ],
        manifestRows: [{ repo_full_name: "o/b", payload_json: gateReadiness(70) }],
      }),
    );
    expect(md).toContain("50.0%");
    expect(md).toContain("| `merge` |");
    expect(md).toContain("`qualityGateMinScore` set at all");
  });
});

describe("parseArgs", () => {
  it("defaults to the local loopover DB and flips flags", () => {
    expect(parseArgs([])).toEqual({ db: "loopover", remote: false, json: false });
    expect(parseArgs(["--remote", "--json", "--db", "custom"])).toEqual({ db: "custom", remote: true, json: true });
  });
});
