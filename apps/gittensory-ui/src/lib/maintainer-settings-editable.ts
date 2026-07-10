/**
 * Maintainer-editable repository settings keys and save-payload builder (#130, #2218). Shared between the
 * full settings editor (maintainer-settings.tsx) and the one-click gate ramp control so both hit PUT /settings
 * with the same merge shape.
 */

import type { GateMode } from "@/lib/gate-ramp";

export type MaintainerSettingsEditable = {
  commentMode: "off" | "detected_contributors_only" | "all_prs";
  publicAudienceMode: "oss_maintainer" | "gittensor_only";
  publicSignalLevel: "minimal" | "standard";
  publicSurface: "off" | "comment_and_label" | "comment_only" | "label_only";
  checkRunMode: "off" | "enabled";
  checkRunDetailLevel: "minimal" | "standard" | "deep";
  gateCheckMode: "off" | "enabled";
  gatePack: "gittensor" | "oss-anti-slop";
  linkedIssueGateMode: GateMode;
  duplicatePrGateMode: GateMode;
  qualityGateMode: GateMode;
  qualityGateMinScore: number | null;
  mergeReadinessGateMode: GateMode;
  manifestPolicyGateMode: GateMode;
  firstTimeContributorGrace: boolean;
  slopGateMode: GateMode;
  slopGateMinScore: number | null;
  slopAiAdvisory: boolean;
  autoLabelEnabled: boolean;
  gittensorLabel: string;
  createMissingLabel: boolean;
  includeMaintainerAuthors: boolean;
  requireLinkedIssue: boolean;
  badgeEnabled: boolean;
  publicQualityMetrics: boolean;
  commandAuthorization: {
    default?: Array<"maintainer" | "collaborator" | "pr_author" | "confirmed_miner">;
    commands?: Record<string, Array<"maintainer" | "collaborator" | "pr_author" | "confirmed_miner">>;
  };
  autonomy: Partial<
    Record<
      "review" | "request_changes" | "approve" | "merge" | "close" | "label",
      "observe" | "suggest" | "propose" | "auto_with_approval" | "auto"
    >
  >;
  autoMaintain: { requireApprovals: number; mergeMethod: "merge" | "squash" | "rebase" };
  agentPaused: boolean;
  agentDryRun: boolean;
  reviewCheckMode?: "required" | "visible" | "disabled";
};

/** Keys sent verbatim to PUT /settings (PATCH-style merge on the server). */
export const MAINTAINER_SETTINGS_EDITABLE_KEYS = [
  "commentMode",
  "publicAudienceMode",
  "publicSignalLevel",
  "publicSurface",
  "checkRunMode",
  "checkRunDetailLevel",
  "gateCheckMode",
  "gatePack",
  "linkedIssueGateMode",
  "duplicatePrGateMode",
  "qualityGateMode",
  "qualityGateMinScore",
  "mergeReadinessGateMode",
  "manifestPolicyGateMode",
  "firstTimeContributorGrace",
  "slopGateMode",
  "slopGateMinScore",
  "slopAiAdvisory",
  "autoLabelEnabled",
  "gittensorLabel",
  "createMissingLabel",
  "includeMaintainerAuthors",
  "requireLinkedIssue",
  "badgeEnabled",
  "publicQualityMetrics",
  "commandAuthorization",
  "autonomy",
  "autoMaintain",
  "agentPaused",
  "agentDryRun",
] as const satisfies ReadonlyArray<keyof MaintainerSettingsEditable>;

export type MaintainerSettingsEditableKey = (typeof MAINTAINER_SETTINGS_EDITABLE_KEYS)[number];

/** Build the PUT /settings body from a loaded settings object (optionally merged with a patch first). */
export function buildMaintainerSettingsSavePayload(
  settings: MaintainerSettingsEditable,
  patch: Partial<MaintainerSettingsEditable> = {},
): Record<string, unknown> {
  const merged = { ...settings, ...patch };
  return Object.fromEntries(
    MAINTAINER_SETTINGS_EDITABLE_KEYS.map((key) => [key, merged[key]]),
  );
}
