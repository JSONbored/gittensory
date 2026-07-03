import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/migration-tree", () => ({
  listMigrationFilenamesAtRef: vi.fn(async () => []),
}));

import { listMigrationFilenamesAtRef } from "../../src/github/migration-tree";
import { migrationFilenamesForLiveRecheck, resolveLiveMigrationCollisionHold } from "../../src/services/migration-collision-recheck";

describe("migration collision live recheck helpers (#2550)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts added migrations and base-side removals separately", () => {
    expect(
      migrationFilenamesForLiveRecheck([
        { path: "migrations/0100_new.sql", status: "added", previousFilename: null },
        { path: "migrations/0101_renamed.sql", status: "renamed", previousFilename: "migrations/0101_old.sql" },
        { path: "migrations/0102_deleted.sql", status: "removed", previousFilename: null },
        { path: "src/app.ts", status: "modified", previousFilename: "src/old.ts" },
      ]),
    ).toEqual({
      prMigrationFilenames: ["0100_new.sql", "0101_renamed.sql"],
      prRemovedMigrationFilenames: ["0101_old.sql", "0102_deleted.sql"],
    });
  });

  it("fails open without a base ref or when the live tree cannot be read", async () => {
    await expect(resolveLiveMigrationCollisionHold({ repoFullName: "owner/repo", baseRef: null, token: undefined, admissionKey: undefined, prMigrationFilenames: ["0100_pr.sql"], prRemovedMigrationFilenames: [] })).resolves.toBeUndefined();
    vi.mocked(listMigrationFilenamesAtRef).mockResolvedValueOnce(null);
    await expect(resolveLiveMigrationCollisionHold({ repoFullName: "owner/repo", baseRef: "main", token: undefined, admissionKey: undefined, prMigrationFilenames: ["0100_pr.sql"], prRemovedMigrationFilenames: [] })).resolves.toBeUndefined();
  });

  it("reports only collisions involving this PR after subtracting removed base filenames", async () => {
    vi.mocked(listMigrationFilenamesAtRef).mockResolvedValueOnce(["0099_a.sql", "0099_b.sql", "0100_sibling.sql", "0101_old.sql"]);
    const hold = await resolveLiveMigrationCollisionHold({ repoFullName: "owner/repo", baseRef: "main", token: "t", admissionKey: undefined, prMigrationFilenames: ["0100_pr.sql", "0101_new.sql"], prRemovedMigrationFilenames: ["0101_old.sql"] });
    expect(hold?.reason).toContain("0100: 0100_pr.sql, 0100_sibling.sql");
    expect(hold?.reason).not.toContain("0099");
    expect(hold?.reason).not.toContain("0101");
  });

  it("returns undefined when the fresh union has no PR-number collision", async () => {
    vi.mocked(listMigrationFilenamesAtRef).mockResolvedValueOnce(["0099_a.sql"]);
    await expect(resolveLiveMigrationCollisionHold({ repoFullName: "owner/repo", baseRef: "main", token: "t", admissionKey: undefined, prMigrationFilenames: ["0100_pr.sql"], prRemovedMigrationFilenames: [] })).resolves.toBeUndefined();
  });
});
