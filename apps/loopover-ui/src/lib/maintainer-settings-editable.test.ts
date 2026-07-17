import { describe, expect, it } from "vitest";

import {
  buildMaintainerSettingsSavePayload,
  MAINTAINER_SETTINGS_EDITABLE_KEYS,
  type MaintainerSettingsEditable,
} from "@/lib/maintainer-settings-editable";

const SETTINGS: MaintainerSettingsEditable = {
  gatePack: "gittensor",
  mergeReadinessGateMode: "off",
  manifestPolicyGateMode: "off",
  slopGateMode: "off",
  slopGateMinScore: null,
  slopAiAdvisory: false,
  autoLabelEnabled: true,
  requireLinkedIssue: false,
  commandAuthorization: {},
  autonomy: {},
  agentPaused: false,
  agentDryRun: false,
};

describe("maintainer-settings-editable (#2218)", () => {
  it("buildMaintainerSettingsSavePayload includes every editable key, verbatim, with no patch", () => {
    const payload = buildMaintainerSettingsSavePayload(SETTINGS);
    expect(Object.keys(payload).sort()).toEqual([...MAINTAINER_SETTINGS_EDITABLE_KEYS].sort());
    expect(payload.mergeReadinessGateMode).toBe("off");
    expect(payload.autoLabelEnabled).toBe(true);
  });

  it("buildMaintainerSettingsSavePayload merges a partial patch over the base settings", () => {
    const payload = buildMaintainerSettingsSavePayload(SETTINGS, {
      mergeReadinessGateMode: "block",
      manifestPolicyGateMode: "block",
    });
    expect(payload.mergeReadinessGateMode).toBe("block");
    expect(payload.manifestPolicyGateMode).toBe("block");
    // Untouched fields pass through unchanged.
    expect(payload.slopGateMode).toBe("off");
    expect(payload.autoLabelEnabled).toBe(true);
  });

  it("an empty patch object is a no-op (same as omitting it)", () => {
    expect(buildMaintainerSettingsSavePayload(SETTINGS, {})).toEqual(
      buildMaintainerSettingsSavePayload(SETTINGS),
    );
  });
});
