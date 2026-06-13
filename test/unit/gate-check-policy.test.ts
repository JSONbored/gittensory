import { describe, expect, it } from "vitest";
import { gateCheckPolicy } from "../../src/queue/processors";
import { evaluateGateCheck } from "../../src/rules/advisory";
import type { FocusManifestGateConfig } from "../../src/signals/focus-manifest";
import type { Advisory, RepositorySettings } from "../../src/types";

function settings(over: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    linkedIssueGateMode: "advisory",
    duplicatePrGateMode: "block",
    qualityGateMode: "advisory",
    qualityGateMinScore: null,
    ...over,
  } as unknown as RepositorySettings;
}

function gate(over: Partial<FocusManifestGateConfig> = {}): FocusManifestGateConfig {
  return { present: true, linkedIssue: null, duplicates: null, readinessMode: null, readinessMinScore: null, ...over };
}

function missingIssueAdvisory(): Advisory {
  return {
    id: "advisory-policy",
    targetType: "pull_request",
    targetKey: "owner/repo#7",
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "sha7",
    conclusion: "neutral",
    severity: "warning",
    title: "Gittensory advisory available",
    summary: "1 advisory finding generated.",
    findings: [{ code: "missing_linked_issue", title: "No linked issue detected", severity: "warning", detail: "No closing reference.", action: "Link the issue." }],
    generatedAt: "2026-06-13T00:00:00.000Z",
  };
}

describe("gateCheckPolicy precedence (.gittensory.yml gate config > DB settings)", () => {
  it("uses DB settings when no manifest gate config is provided", () => {
    const policy = gateCheckPolicy(settings({ linkedIssueGateMode: "block" }), 80, true);
    expect(policy.linkedIssueGateMode).toBe("block");
    expect(policy.duplicatePrGateMode).toBe("block");
    expect(policy.qualityGateMode).toBe("advisory");
    expect(policy.readinessScore).toBe(80);
    expect(policy.confirmedContributor).toBe(true);
  });

  it("lets the manifest authoritatively override each blocker mode over DB settings", () => {
    const policy = gateCheckPolicy(
      settings({ linkedIssueGateMode: "advisory", duplicatePrGateMode: "block", qualityGateMode: "off", qualityGateMinScore: 10 }),
      55,
      true,
      gate({ linkedIssue: "block", duplicates: "off", readinessMode: "block", readinessMinScore: 70 }),
    );
    expect(policy.linkedIssueGateMode).toBe("block"); // manifest "block" beats DB "advisory"
    expect(policy.duplicatePrGateMode).toBe("off"); // manifest "off" beats DB "block"
    expect(policy.qualityGateMode).toBe("block"); // manifest readiness.mode
    expect(policy.qualityGateMinScore).toBe(70); // manifest readiness.minScore
  });

  it("falls back to DB per-field when only some manifest fields are set", () => {
    const policy = gateCheckPolicy(settings({ linkedIssueGateMode: "advisory", duplicatePrGateMode: "block" }), null, false, gate({ linkedIssue: "block" }));
    expect(policy.linkedIssueGateMode).toBe("block"); // overridden by manifest
    expect(policy.duplicatePrGateMode).toBe("block"); // falls back to DB
    expect(policy.qualityGateMode).toBe("advisory"); // falls back to DB
    expect(policy.confirmedContributor).toBe(false);
  });

  it("end-to-end: a manifest linkedIssue:block blocks a confirmed author's no-issue PR even when DB is advisory", () => {
    const blocked = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(settings({ linkedIssueGateMode: "advisory" }), null, true, gate({ linkedIssue: "block" })));
    expect(blocked.conclusion).toBe("failure");
    expect(blocked.blockers.map((finding) => finding.code)).toEqual(["missing_linked_issue"]);
  });

  it("end-to-end: a manifest linkedIssue:advisory un-blocks even when DB is block (config-as-code relief)", () => {
    const relieved = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(settings({ linkedIssueGateMode: "block" }), null, true, gate({ linkedIssue: "advisory" })));
    expect(relieved.conclusion).toBe("success");
  });

  it("still only blocks confirmed contributors regardless of the manifest config", () => {
    const nonConfirmed = evaluateGateCheck(missingIssueAdvisory(), gateCheckPolicy(settings({ linkedIssueGateMode: "advisory" }), null, false, gate({ linkedIssue: "block" })));
    expect(nonConfirmed.conclusion).toBe("neutral");
    expect(nonConfirmed.blockers).toEqual([]);
  });
});
