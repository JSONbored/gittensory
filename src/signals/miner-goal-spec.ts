import type { FocusManifestIssueDiscoveryPolicy } from "./focus-manifest";

/** Values carried over from `.gittensory.yml`'s focus-manifest discovery policy. */
export type MinerGoalSpecIssueDiscoveryPolicy = FocusManifestIssueDiscoveryPolicy;

/**
 * Maintainer-authored miner targeting preferences declared in `.gittensory-miner.yml`.
 *
 * This is intentionally small in the foundation phase: it only captures whether autonomous miner
 * work is allowed for the repo at all, which paths are preferred/blocked, which labels are preferred,
 * how many concurrent claims a single miner should hold, and whether issue discovery is encouraged.
 * Parsing and file discovery land in a follow-up issue.
 */
export type MinerGoalSpec = {
  /** Whether autonomous miners may target this repo. Default: true. */
  minerEnabled: boolean;
  /** Preferred work areas for miner-created changes. Glob list. Default: []. */
  wantedPaths: string[];
  /** Paths miners should avoid touching. Glob list. Default: []. */
  blockedPaths: string[];
  /** Labels miners should prefer when selecting or filing work. Default: []. */
  preferredLabels: string[];
  /** Maximum concurrent claims a miner should hold against this repo. Default: 1. */
  maxConcurrentClaims: number;
  /** Whether issue discovery work is encouraged for the repo. Default: neutral. */
  issueDiscoveryPolicy: MinerGoalSpecIssueDiscoveryPolicy;
};

/**
 * Safe defaults for an absent `.gittensory-miner.yml`.
 *
 * - `minerEnabled: true` keeps public repos targetable unless the owner explicitly opts out.
 * - empty path/label lists mean "no additional preference" rather than hidden policy.
 * - `maxConcurrentClaims: 1` keeps a miner from claiming multiple issues in the same repo by default.
 * - `issueDiscoveryPolicy: neutral` mirrors `.gittensory.yml`'s own default stance.
 */
export const DEFAULT_MINER_GOAL_SPEC: MinerGoalSpec = {
  minerEnabled: true,
  wantedPaths: [],
  blockedPaths: [],
  preferredLabels: [],
  maxConcurrentClaims: 1,
  issueDiscoveryPolicy: "neutral",
};
