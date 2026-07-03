import { detectMigrationCollisions, extractMigrationNumber, KNOWN_MIGRATION_DUPLICATES } from "../db/migration-collisions";
import { listMigrationFilenamesAtRef } from "../github/migration-tree";
import type { GitHubRateLimitAdmissionKey } from "../github/client";
import type { PullRequestFileRecord } from "../types";

export type MigrationCollisionHold = { reason: string; comment: string };

export function migrationFilenamesForLiveRecheck(changedFiles: readonly Pick<PullRequestFileRecord, "path" | "status" | "previousFilename">[]): { prMigrationFilenames: string[]; prRemovedMigrationFilenames: string[] } {
  const prMigrationFilenames = changedFiles
    .filter((f) => f.status !== "removed" && f.path.startsWith("migrations/") && f.path.endsWith(".sql"))
    .map((f) => f.path.slice("migrations/".length));
  const prRemovedMigrationFilenames = changedFiles.flatMap((f) => {
    const removed: string[] = [];
    if (f.status === "removed" && f.path.startsWith("migrations/") && f.path.endsWith(".sql")) {
      removed.push(f.path.slice("migrations/".length));
    }
    if (f.previousFilename && f.previousFilename.startsWith("migrations/") && f.previousFilename.endsWith(".sql")) {
      removed.push(f.previousFilename.slice("migrations/".length));
    }
    return removed;
  });
  return { prMigrationFilenames, prRemovedMigrationFilenames };
}

/**
 * Live premerge migrations/** collision recheck (#2550). Always reads the base tree fresh; callers invoke this
 * both while planning and again at merge actuation so an approval-queue wait or concurrent sibling merge cannot
 * reuse a stale no-collision decision.
 */
export async function resolveLiveMigrationCollisionHold(args: {
  repoFullName: string;
  baseRef: string | null | undefined;
  token: string | undefined;
  admissionKey: GitHubRateLimitAdmissionKey | undefined;
  prMigrationFilenames: string[];
  prRemovedMigrationFilenames: string[];
}): Promise<MigrationCollisionHold | undefined> {
  if (!args.baseRef) return undefined;
  const liveFilenames = await listMigrationFilenamesAtRef(args.repoFullName, args.baseRef, args.token, args.admissionKey);
  if (liveFilenames === null) return undefined;
  const removedFromBase = new Set(args.prRemovedMigrationFilenames);
  const effectiveLiveFilenames = liveFilenames.filter((f) => !removedFromBase.has(f));
  const union = [...new Set([...effectiveLiveFilenames, ...args.prMigrationFilenames])];
  const prNumbers = new Set(args.prMigrationFilenames.map((f) => extractMigrationNumber(f)).filter((n): n is number => n !== null));
  const collisions = detectMigrationCollisions(union, KNOWN_MIGRATION_DUPLICATES).filter((c) => prNumbers.has(c.number));
  if (collisions.length === 0) return undefined;
  const detail = collisions.map((c) => `${c.paddedNumber}: ${c.files.join(", ")}`).join("; ");
  return {
    reason: `live migrations/** collision on ${args.baseRef} (${detail})`,
    comment: `Gittensory: a live check of \`migrations/**\` on \`${args.baseRef}\` found a migration-number collision that isn't visible from this PR's own diff — another PR merged a same-numbered migration file since this PR's CI last ran (**${detail}**). This PR is held for manual review — please rebase onto the latest \`${args.baseRef}\` and renumber your migration to the next free number before this can merge.`,
  };
}
