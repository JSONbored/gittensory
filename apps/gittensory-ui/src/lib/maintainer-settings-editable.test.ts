import { describe, expect, it } from "vitest";

import {
  buildMaintainerSettingsSavePayload,
  MAINTAINER_SETTINGS_EDITABLE_KEYS,
} from "@/lib/maintainer-settings-editable";

describe("maintainer-settings-editable (#2218)", () => {
  it("buildMaintainerSettingsSavePayload includes every editable key", () => {
    const settings = {
      commentMode: "detected_contributors_only" as const,
      publicAudienceMode: "oss_maintainer" as const,
      publicSignalLevel: "standard" as const,
      publicSurface: "comment_and_label" as const,
      checkRunMode: "enabled" as const,
      checkRunDetailLevel: "standard" as const,
      gateCheckMode: "enabled" as const,
      gatePack: "gittensor" as const,
      linkedIssueGateMode: "advisory" as const,
      duplicatePrGateMode: "advisory" as const,
      qualityGateMode: "advisory" as const,
      qualityGateMinScore: null,
      mergeReadinessGateMode: "off" as const,
      manifestPolicyGateMode: "off" as const,
      firstTimeContributorGrace: false,
      slopGateMode: "off" as const,
      slopGateMinScore: null,
      slopAiAdvisory: false,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      badgeEnabled: false,
      publicQualityMetrics: false,
      commandAuthorization: {},
      autonomy: {},
      autoMaintain: { requireApprovals: 1, mergeMethod: "squash" as const },
      agentPaused: false,
      agentDryRun: false,
    };

    const payload = buildMaintainerSettingsSavePayload(settings, {
      linkedIssueGateMode: "block",
    });
    expect(Object.keys(payload).sort()).toEqual([...MAINTAINER_SETTINGS_EDITABLE_KEYS].sort());
    expect(payload.linkedIssueGateMode).toBe("block");
    expect(payload.commentMode).toBe("detected_contributors_only");
  });
});
