export type OrbReleaseCommit = {
  sha?: string;
  subject?: string;
  body?: string;
  files?: string[];
};

export type OrbSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

export type OrbBetaSemver = OrbSemver & {
  betaNumber: number | null;
};

export type OrbReleaseReport = {
  due: boolean;
  targetVersion: string;
  nextTag: string;
  manifestVersion: string | null;
  manifestStale: boolean;
  inferredVersion: string;
  latestStableTag: string | null;
  latestTag: string | null;
  commits: OrbReleaseCommit[];
  commitsSinceStable: OrbReleaseCommit[];
};

export type OrbStableReleaseReport = {
  due: boolean;
  stableVersion: string;
  nextVersion: string;
  releaseType: "major" | "minor" | "patch" | null;
  latestStableTag: string | null;
  commits: OrbReleaseCommit[];
};

export function parseConventionalSubject(subject: string): {
  type: string | null;
  scope: string | null;
  breaking: boolean;
  description: string;
  conventional: boolean;
};
export function parseSemver(version: string): OrbSemver | null;
export function parseOrbBetaVersion(version: string): OrbBetaSemver | null;
export function compareSemver(leftVersion: string, rightVersion: string): number | null;
export function bumpVersion(version: string, releaseType: "major" | "minor" | "patch"): string;
export function latestStableOrbTag(tags: string[]): { tag: string; version: string } | null;
export function latestOrbTag(tags: string[]): { tag: string; version: string } | null;
export function isImageRelevantCommit(commit: OrbReleaseCommit): boolean;
export function selectImageRelevantCommits<T extends OrbReleaseCommit>(commits: T[]): T[];
export function inferReleaseType(commits: OrbReleaseCommit[]): "major" | "minor" | "patch" | null;
export function buildOrbReleaseReport(input: {
  tags: string[];
  manifestVersion: string | null;
  commits: { sinceStable: OrbReleaseCommit[]; sinceLastTag: OrbReleaseCommit[] };
}): OrbReleaseReport;
export function buildOrbStableReleaseReport(input: { tags: string[]; commitsSinceStable?: OrbReleaseCommit[] }): OrbStableReleaseReport;
