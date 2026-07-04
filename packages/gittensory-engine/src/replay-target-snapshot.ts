// Deterministic replay-target snapshot contract (#3010).
//
// This module owns the pure planning/validation half of historical replay snapshots. Callers still perform the git
// worktree export and history reads; the engine filters those already-read commit/tag/release records to the target
// commit boundary, derives a stable snapshot key, and fails fast if any context artifact leaks post-target time.

import { extractObjectiveAnchorHistory, type ObjectiveAnchorHistoryExtraction } from "./objective-anchor.js";

export type ReplayTargetRepoRef = {
  fullName: string;
  remoteUrl?: string | undefined;
  defaultBranch?: string | undefined;
};

export type ReplayTargetCommitInput = {
  sha: string;
  committedAt: string | Date;
  subject?: string | undefined;
  paths?: readonly string[] | undefined;
  parents?: readonly string[] | undefined;
};

export type ReplayTargetTagInput = {
  name: string;
  targetSha?: string | undefined;
  taggedAt?: string | Date | null | undefined;
};

export type ReplayTargetReleaseInput = {
  name: string;
  tagName: string;
  publishedAt?: string | Date | null | undefined;
};

export type ReplayTargetReadmeInput = {
  path: string;
  blobSha: string;
  text?: string | undefined;
  observedAt?: string | Date | null | undefined;
};

export type ReplayTargetTreeFileInput = {
  path: string;
  blobSha?: string | undefined;
  mode?: string | undefined;
  size?: number | undefined;
  observedAt?: string | Date | null | undefined;
};

export type ReplayTargetExternalReferenceInput = {
  kind: "issue" | "pull_request" | "discussion" | "manual" | string;
  id: string | number;
  observedAt?: string | Date | null | undefined;
};

export type ReplayTargetSnapshotInput = {
  repo: ReplayTargetRepoRef | string;
  targetCommitSha: string;
  targetCommittedAt?: string | Date | undefined;
  exportRoot?: string | undefined;
  commits: readonly ReplayTargetCommitInput[];
  tags?: readonly ReplayTargetTagInput[] | undefined;
  releases?: readonly ReplayTargetReleaseInput[] | undefined;
  readme?: ReplayTargetReadmeInput | null | undefined;
  treeFiles?: readonly ReplayTargetTreeFileInput[] | undefined;
  externalReferences?: readonly ReplayTargetExternalReferenceInput[] | undefined;
};

export type ReplayTargetSnapshotCommit = {
  sha: string;
  committedAt: string;
  subject: string | null;
  paths: string[];
  parents: string[];
};

export type ReplayTargetSnapshotTag = {
  name: string;
  targetSha: string | null;
  taggedAt: string | null;
};

export type ReplayTargetSnapshotRelease = {
  name: string;
  tagName: string;
  publishedAt: string | null;
};

export type ReplayTargetSnapshotReadme = {
  path: string;
  blobSha: string;
  text: string | null;
  observedAt: string | null;
};

export type ReplayTargetSnapshotTreeFile = {
  path: string;
  blobSha: string | null;
  mode: string | null;
  size: number | null;
  observedAt: string | null;
};

export type ReplayTargetSnapshotReference = {
  kind: string;
  id: string;
  observedAt: string | null;
};

export type ReplayTargetSnapshotExportPlan = {
  strategy: "git-worktree";
  sourceCommit: string;
  destinationKey: string;
  exportRoot: string;
  worktreePath: string;
  contextPath: string;
};

export type ReplayTargetSnapshotContext = {
  commits: ReplayTargetSnapshotCommit[];
  tags: ReplayTargetSnapshotTag[];
  releases: ReplayTargetSnapshotRelease[];
  readme: ReplayTargetSnapshotReadme | null;
  treeFiles: ReplayTargetSnapshotTreeFile[];
  externalReferences: ReplayTargetSnapshotReference[];
  history: ObjectiveAnchorHistoryExtraction;
};

export type ReplayTargetSnapshotValidationViolation = {
  artifact: string;
  timestamp: string;
  targetCommittedAt: string;
  reason: "post_target_timestamp" | "missing_target_commit" | "invalid_timestamp";
};

export type ReplayTargetSnapshotValidation = {
  ok: boolean;
  violations: ReplayTargetSnapshotValidationViolation[];
};

export type ReplayTargetSnapshot = {
  snapshotId: string;
  repo: ReplayTargetRepoRef;
  targetCommitSha: string;
  targetCommittedAt: string;
  exportPlan: ReplayTargetSnapshotExportPlan;
  context: ReplayTargetSnapshotContext;
  excluded: {
    commits: ReplayTargetSnapshotCommit[];
    tags: ReplayTargetSnapshotTag[];
    releases: ReplayTargetSnapshotRelease[];
    readme: ReplayTargetSnapshotReadme | null;
    treeFiles: ReplayTargetSnapshotTreeFile[];
    externalReferences: ReplayTargetSnapshotReference[];
  };
  validation: ReplayTargetSnapshotValidation;
};

const DEFAULT_EXPORT_ROOT = ".gittensory/replay-targets";
const NULL_SHA = "0000000000000000000000000000000000000000";

function normalizeRepo(repo: ReplayTargetRepoRef | string): ReplayTargetRepoRef {
  const fullName = typeof repo === "string" ? repo : repo.fullName;
  const normalizedFullName = fullName.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(normalizedFullName)) {
    throw new Error("Replay target snapshot requires a repo full name in owner/name form.");
  }
  return typeof repo === "string"
    ? { fullName: normalizedFullName }
    : {
        fullName: normalizedFullName,
        ...(repo.remoteUrl?.trim() ? { remoteUrl: collapseInline(repo.remoteUrl) } : {}),
        ...(repo.defaultBranch?.trim() ? { defaultBranch: collapseInline(repo.defaultBranch) } : {}),
      };
}

function normalizeSha(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{7,40}$/u.test(normalized)) {
    throw new Error(`${field} must be a 7-40 character hex git SHA.`);
  }
  return normalized;
}

function normalizeOptionalSha(value: string | undefined): string | null {
  if (!value) return null;
  return normalizeSha(value, "targetSha");
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized.includes("\0") || normalized.startsWith("../")) {
    throw new Error("Replay target snapshot paths must be relative, non-empty, and inside the export root.");
  }
  return normalized.toLowerCase();
}

function normalizeMode(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 32 || /[\r\n\0]/u.test(normalized)) return null;
  return normalized;
}

function normalizeSize(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function collapseInline(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
}

function parseInstant(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function requireInstant(value: string | Date | undefined, field: string): string {
  const parsed = parseInstant(value);
  if (!parsed) throw new Error(`${field} must be a valid timestamp.`);
  return parsed;
}

function compareIso(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function isAtOrBefore(value: string | null, cutoff: string): boolean {
  return value === null || value <= cutoff;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function snapshotKey(repoFullName: string, targetCommitSha: string, targetCommittedAt: string, context: ReplayTargetSnapshotContext): string {
  const payload = JSON.stringify({
    repoFullName,
    targetCommitSha,
    targetCommittedAt,
    commits: context.commits.map((commit) => [commit.sha, commit.committedAt]),
    tags: context.tags.map((tag) => [tag.name, tag.targetSha, tag.taggedAt]),
    releases: context.releases.map((release) => [release.name, release.tagName, release.publishedAt]),
    readme: context.readme ? [context.readme.path, context.readme.blobSha, context.readme.observedAt] : null,
    treeFiles: context.treeFiles.map((file) => [file.path, file.blobSha, file.mode, file.size]),
    references: context.externalReferences.map((reference) => [reference.kind, reference.id, reference.observedAt]),
  });
  return `${repoFullName.replace("/", "__")}@${targetCommitSha}-${stableHash(payload)}`;
}

function normalizeCommit(input: ReplayTargetCommitInput): ReplayTargetSnapshotCommit {
  return {
    sha: normalizeSha(input.sha, "commit.sha"),
    committedAt: requireInstant(input.committedAt, "commit.committedAt"),
    subject: input.subject?.trim() ? collapseInline(input.subject) : null,
    paths: uniqueSorted((input.paths ?? []).map(normalizePath)),
    parents: uniqueSorted((input.parents ?? []).map((sha) => normalizeSha(sha, "commit.parents"))),
  };
}

function normalizeTag(input: ReplayTargetTagInput): ReplayTargetSnapshotTag {
  const name = collapseInline(input.name);
  if (!name) throw new Error("tag.name must be non-empty.");
  return {
    name,
    targetSha: normalizeOptionalSha(input.targetSha),
    taggedAt: parseInstant(input.taggedAt),
  };
}

function normalizeRelease(input: ReplayTargetReleaseInput): ReplayTargetSnapshotRelease {
  const name = collapseInline(input.name);
  const tagName = collapseInline(input.tagName);
  if (!name || !tagName) throw new Error("release name and tagName must be non-empty.");
  return {
    name,
    tagName,
    publishedAt: parseInstant(input.publishedAt),
  };
}

function normalizeReadme(input: ReplayTargetReadmeInput | null | undefined): ReplayTargetSnapshotReadme | null {
  if (!input) return null;
  return {
    path: normalizePath(input.path),
    blobSha: normalizeSha(input.blobSha, "readme.blobSha"),
    text: input.text === undefined ? null : input.text.replace(/\r\n/gu, "\n"),
    observedAt: parseInstant(input.observedAt),
  };
}

function normalizeTreeFile(input: ReplayTargetTreeFileInput): ReplayTargetSnapshotTreeFile {
  return {
    path: normalizePath(input.path),
    blobSha: normalizeOptionalSha(input.blobSha),
    mode: normalizeMode(input.mode),
    size: normalizeSize(input.size),
    observedAt: parseInstant(input.observedAt),
  };
}

function normalizeReference(input: ReplayTargetExternalReferenceInput): ReplayTargetSnapshotReference {
  const kind = collapseInline(input.kind).toLowerCase().replace(/[\s-]+/gu, "_");
  const id = collapseInline(String(input.id));
  if (!kind || !id) throw new Error("external reference kind and id must be non-empty.");
  return {
    kind,
    id,
    observedAt: parseInstant(input.observedAt),
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sortCommits(commits: readonly ReplayTargetSnapshotCommit[]): ReplayTargetSnapshotCommit[] {
  return [...commits].sort((left, right) => left.committedAt.localeCompare(right.committedAt) || left.sha.localeCompare(right.sha));
}

function sortTags(tags: readonly ReplayTargetSnapshotTag[]): ReplayTargetSnapshotTag[] {
  return [...tags].sort((left, right) => compareIso(left.taggedAt, right.taggedAt) || left.name.localeCompare(right.name));
}

function sortReleases(releases: readonly ReplayTargetSnapshotRelease[]): ReplayTargetSnapshotRelease[] {
  return [...releases].sort((left, right) => compareIso(left.publishedAt, right.publishedAt) || left.name.localeCompare(right.name));
}

function sortTreeFiles(files: readonly ReplayTargetSnapshotTreeFile[]): ReplayTargetSnapshotTreeFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

function sortReferences(references: readonly ReplayTargetSnapshotReference[]): ReplayTargetSnapshotReference[] {
  return [...references].sort(
    (left, right) => compareIso(left.observedAt, right.observedAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

function buildHistoryExtraction(commits: readonly ReplayTargetSnapshotCommit[]): ObjectiveAnchorHistoryExtraction {
  // Reuse objective-anchor's history extractor instead of inventing a second commit-feature path for replay context.
  return extractObjectiveAnchorHistory(
    commits.map((commit) => ({
      id: `commit:${commit.sha}`,
      source: "commit",
      paths: commit.paths,
      titles: commit.subject ? [commit.subject] : [],
    })),
  );
}

function markdownSafe(value: string): string {
  return collapseInline(value).replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function markdownList(values: readonly string[]): string {
  if (values.length === 0) return "- none";
  return values.map((value) => `- ${markdownSafe(value)}`).join("\n");
}

function commitLine(commit: ReplayTargetSnapshotCommit): string {
  const subject = commit.subject ? ` ${markdownSafe(commit.subject)}` : "";
  return `${commit.sha.slice(0, 12)} ${commit.committedAt}${subject}`;
}

function tagLine(tag: ReplayTargetSnapshotTag): string {
  const target = tag.targetSha ? ` -> ${tag.targetSha.slice(0, 12)}` : "";
  const time = tag.taggedAt ? ` at ${tag.taggedAt}` : "";
  return `${tag.name}${target}${time}`;
}

function releaseLine(release: ReplayTargetSnapshotRelease): string {
  const time = release.publishedAt ? ` at ${release.publishedAt}` : "";
  return `${release.name} (${release.tagName})${time}`;
}

function treeFileLine(file: ReplayTargetSnapshotTreeFile): string {
  const size = file.size === null ? "size n/a" : `${file.size} bytes`;
  const blob = file.blobSha ? ` ${file.blobSha.slice(0, 12)}` : "";
  return `${file.path} (${size}${blob})`;
}

function referenceLine(reference: ReplayTargetSnapshotReference): string {
  const time = reference.observedAt ? ` at ${reference.observedAt}` : "";
  return `${reference.kind}:${reference.id}${time}`;
}

function createExportPlan(input: {
  exportRoot: string;
  snapshotId: string;
  targetCommitSha: string;
}): ReplayTargetSnapshotExportPlan {
  const exportRoot = normalizePath(input.exportRoot);
  const worktreePath = `${exportRoot}/${input.snapshotId}/tree`;
  const contextPath = `${exportRoot}/${input.snapshotId}/context.json`;
  return {
    strategy: "git-worktree",
    sourceCommit: input.targetCommitSha,
    destinationKey: input.snapshotId,
    exportRoot,
    worktreePath,
    contextPath,
  };
}

function timestampViolations(input: {
  targetCommittedAt: string;
  commits: readonly ReplayTargetSnapshotCommit[];
  tags: readonly ReplayTargetSnapshotTag[];
  releases: readonly ReplayTargetSnapshotRelease[];
  readme: ReplayTargetSnapshotReadme | null;
  treeFiles: readonly ReplayTargetSnapshotTreeFile[];
  externalReferences: readonly ReplayTargetSnapshotReference[];
}): ReplayTargetSnapshotValidationViolation[] {
  const violations: ReplayTargetSnapshotValidationViolation[] = [];
  const pushIfPostTarget = (artifact: string, timestamp: string | null): void => {
    if (timestamp && timestamp > input.targetCommittedAt) {
      violations.push({
        artifact,
        timestamp,
        targetCommittedAt: input.targetCommittedAt,
        reason: "post_target_timestamp",
      });
    }
  };
  input.commits.forEach((commit) => pushIfPostTarget(`commit:${commit.sha}`, commit.committedAt));
  input.tags.forEach((tag) => pushIfPostTarget(`tag:${tag.name}`, tag.taggedAt));
  input.releases.forEach((release) => pushIfPostTarget(`release:${release.name}`, release.publishedAt));
  pushIfPostTarget(input.readme ? `readme:${input.readme.path}` : "readme", input.readme?.observedAt ?? null);
  input.treeFiles.forEach((file) => pushIfPostTarget(`tree:${file.path}`, file.observedAt));
  input.externalReferences.forEach((reference) => pushIfPostTarget(`${reference.kind}:${reference.id}`, reference.observedAt));
  return violations;
}

export function validateReplayTargetSnapshot(snapshot: ReplayTargetSnapshot): ReplayTargetSnapshotValidation {
  const violations = timestampViolations({
    targetCommittedAt: snapshot.targetCommittedAt,
    commits: snapshot.context.commits,
    tags: snapshot.context.tags,
    releases: snapshot.context.releases,
    readme: snapshot.context.readme,
    treeFiles: snapshot.context.treeFiles,
    externalReferences: snapshot.context.externalReferences,
  });
  if (!snapshot.context.commits.some((commit) => commit.sha === snapshot.targetCommitSha)) {
    violations.push({
      artifact: `commit:${snapshot.targetCommitSha}`,
      timestamp: snapshot.targetCommittedAt,
      targetCommittedAt: snapshot.targetCommittedAt,
      reason: "missing_target_commit",
    });
  }
  return { ok: violations.length === 0, violations };
}

export function assertReplayTargetSnapshotValid(snapshot: ReplayTargetSnapshot): ReplayTargetSnapshot {
  const validation = validateReplayTargetSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`Replay target snapshot contains post-target or incomplete artifacts: ${validation.violations[0]!.artifact}`);
  }
  return { ...snapshot, validation };
}

export function renderReplayTargetSnapshotManifestMarkdown(snapshot: ReplayTargetSnapshot): string {
  const validation = validateReplayTargetSnapshot(snapshot);
  const lines = [
    "# Replay Target Snapshot",
    "",
    `Snapshot: ${markdownSafe(snapshot.snapshotId)}`,
    `Repo: ${markdownSafe(snapshot.repo.fullName)}`,
    `Target commit: ${markdownSafe(snapshot.targetCommitSha)}`,
    `Target time: ${markdownSafe(snapshot.targetCommittedAt)}`,
    "",
    "## Export Plan",
    "",
    `- strategy: ${snapshot.exportPlan.strategy}`,
    `- worktree: ${markdownSafe(snapshot.exportPlan.worktreePath)}`,
    `- context: ${markdownSafe(snapshot.exportPlan.contextPath)}`,
    "",
    "## Included Context",
    "",
    "Commits:",
    markdownList(snapshot.context.commits.map(commitLine)),
    "",
    "Tags:",
    markdownList(snapshot.context.tags.map(tagLine)),
    "",
    "Releases:",
    markdownList(snapshot.context.releases.map(releaseLine)),
    "",
    "README:",
    snapshot.context.readme
      ? `- ${markdownSafe(snapshot.context.readme.path)} ${snapshot.context.readme.blobSha.slice(0, 12)}`
      : "- none",
    "",
    "Tree files:",
    markdownList(snapshot.context.treeFiles.map(treeFileLine)),
    "",
    "External references:",
    markdownList(snapshot.context.externalReferences.map(referenceLine)),
    "",
    "## Excluded Post-Target Context",
    "",
    "Commits:",
    markdownList(snapshot.excluded.commits.map(commitLine)),
    "",
    "Tags:",
    markdownList(snapshot.excluded.tags.map(tagLine)),
    "",
    "Releases:",
    markdownList(snapshot.excluded.releases.map(releaseLine)),
    "",
    "README:",
    snapshot.excluded.readme
      ? `- ${markdownSafe(snapshot.excluded.readme.path)} ${snapshot.excluded.readme.blobSha.slice(0, 12)}`
      : "- none",
    "",
    "Tree files:",
    markdownList(snapshot.excluded.treeFiles.map(treeFileLine)),
    "",
    "External references:",
    markdownList(snapshot.excluded.externalReferences.map(referenceLine)),
    "",
    "## Validation",
    "",
    validation.ok
      ? "- ok"
      : validation.violations
          .map((violation) => `- ${markdownSafe(violation.artifact)}: ${markdownSafe(violation.reason)}`)
          .join("\n"),
  ];
  return `${lines.join("\n")}\n`;
}

export function createReplayTargetSnapshot(input: ReplayTargetSnapshotInput): ReplayTargetSnapshot {
  const repo = normalizeRepo(input.repo);
  const requestedTargetCommitSha = normalizeSha(input.targetCommitSha, "targetCommitSha");
  const commits = sortCommits(input.commits.map(normalizeCommit));
  const targetCommit = commits.find(
    (commit) => commit.sha === requestedTargetCommitSha || commit.sha.startsWith(requestedTargetCommitSha),
  );
  const targetCommitSha = targetCommit?.sha ?? requestedTargetCommitSha;
  const targetCommittedAt = input.targetCommittedAt
    ? requireInstant(input.targetCommittedAt, "targetCommittedAt")
    : targetCommit?.committedAt;
  if (!targetCommittedAt) {
    throw new Error("targetCommittedAt is required when the target commit is absent from the commit history.");
  }

  const includedCommits = sortCommits(commits.filter((commit) => commit.committedAt <= targetCommittedAt));
  const excludedCommits = sortCommits(commits.filter((commit) => commit.committedAt > targetCommittedAt));
  const includedCommitShas = new Set(includedCommits.map((commit) => commit.sha));

  const tags = (input.tags ?? []).map(normalizeTag);
  const includedTags = sortTags(
    tags.filter((tag) => (tag.taggedAt ? tag.taggedAt <= targetCommittedAt : tag.targetSha ? includedCommitShas.has(tag.targetSha) : false)),
  );
  const excludedTags = sortTags(tags.filter((tag) => !includedTags.includes(tag)));
  const includedTagNames = new Set(includedTags.map((tag) => tag.name));

  const releases = (input.releases ?? []).map(normalizeRelease);
  const includedReleases = sortReleases(
    releases.filter((release) =>
      release.publishedAt ? release.publishedAt <= targetCommittedAt : includedTagNames.has(release.tagName),
    ),
  );
  const excludedReleases = sortReleases(releases.filter((release) => !includedReleases.includes(release)));

  const readme = normalizeReadme(input.readme);
  const includedReadme = readme && isAtOrBefore(readme.observedAt, targetCommittedAt) ? readme : null;
  const excludedReadme = readme && !includedReadme ? readme : null;

  const treeFiles = sortTreeFiles((input.treeFiles ?? []).map(normalizeTreeFile));
  const includedTreeFiles = sortTreeFiles(treeFiles.filter((file) => isAtOrBefore(file.observedAt, targetCommittedAt)));
  const excludedTreeFiles = sortTreeFiles(treeFiles.filter((file) => !includedTreeFiles.includes(file)));

  const externalReferences = sortReferences((input.externalReferences ?? []).map(normalizeReference));
  const includedReferences = sortReferences(externalReferences.filter((reference) => isAtOrBefore(reference.observedAt, targetCommittedAt)));
  const excludedReferences = sortReferences(externalReferences.filter((reference) => !includedReferences.includes(reference)));

  const context: ReplayTargetSnapshotContext = {
    commits: includedCommits,
    tags: includedTags,
    releases: includedReleases,
    readme: includedReadme,
    treeFiles: includedTreeFiles,
    externalReferences: includedReferences,
    history: buildHistoryExtraction(includedCommits),
  };
  const snapshotId = snapshotKey(repo.fullName, targetCommitSha, targetCommittedAt, context);
  const exportPlan = createExportPlan({
    exportRoot: input.exportRoot ?? DEFAULT_EXPORT_ROOT,
    snapshotId,
    targetCommitSha,
  });
  const snapshot: ReplayTargetSnapshot = {
    snapshotId,
    repo,
    targetCommitSha,
    targetCommittedAt,
    exportPlan,
    context,
    excluded: {
      commits: excludedCommits,
      tags: excludedTags,
      releases: excludedReleases,
      readme: excludedReadme,
      treeFiles: excludedTreeFiles,
      externalReferences: excludedReferences,
    },
    validation: { ok: true, violations: [] },
  };
  return assertReplayTargetSnapshotValid(snapshot);
}
