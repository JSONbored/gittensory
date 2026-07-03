import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATION_FILE = "0101_fix_linked_issue_gate_mode_default.sql";

// Replays every migrations/*.sql file BEFORE 0101 into a fresh in-memory DB (mirrors
// scripts/check-schema-drift.mjs's own "replay migrations into node:sqlite" approach), so the table shape
// this test inserts into is exactly what migration 0101 itself was written against -- not a guess. The
// TestD1Database helper (test/helpers/d1.ts) can't be reused here: it concatenates and applies EVERY
// migration (including 0101) up front, so the `repository_settings` table would already be empty-and-fixed
// by the time a test could insert a "bad state" row -- there would be nothing left for 0101 to correct.
function applyMigrationsBefore(cutoffFile: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync("migrations")
    .filter((file) => file.endsWith(".sql") && file < cutoffFile)
    .sort();
  for (const file of files) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  return db;
}

function applyMigration(db: DatabaseSync, file: string): void {
  db.exec(readFileSync(`migrations/${file}`, "utf8"));
}

function insertRepositorySettingsRow(
  db: DatabaseSync,
  repoFullName: string,
  linkedIssueGateMode: string,
  requireLinkedIssue: 0 | 1,
): void {
  db.prepare(
    "INSERT INTO repository_settings (repo_full_name, linked_issue_gate_mode, require_linked_issue) VALUES (?, ?, ?)",
  ).run(repoFullName, linkedIssueGateMode, requireLinkedIssue);
}

function readLinkedIssueGateMode(db: DatabaseSync, repoFullName: string): string {
  const row = db
    .prepare("SELECT linked_issue_gate_mode FROM repository_settings WHERE repo_full_name = ?")
    .get(repoFullName) as { linked_issue_gate_mode: string } | undefined;
  if (!row) throw new Error(`no repository_settings row for ${repoFullName}`);
  return row.linked_issue_gate_mode;
}

describe("migration 0101: fix linked_issue_gate_mode default drift (#selfhost-linked-issue-gate-drift)", () => {
  it("flips a 'block' row with no explicit require_linked_issue opt-in to 'advisory'", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/drifted-repo", "block", 0);

    applyMigration(db, MIGRATION_FILE);

    expect(readLinkedIssueGateMode(db, "acme/drifted-repo")).toBe("advisory");
  });

  it("leaves a 'block' row alone when require_linked_issue is an explicit maintainer opt-in", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/explicit-opt-in", "block", 1);

    applyMigration(db, MIGRATION_FILE);

    expect(readLinkedIssueGateMode(db, "acme/explicit-opt-in")).toBe("block");
  });

  it("leaves an already-advisory row unchanged", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/already-advisory", "advisory", 0);

    applyMigration(db, MIGRATION_FILE);

    expect(readLinkedIssueGateMode(db, "acme/already-advisory")).toBe("advisory");
  });

  it("leaves an 'off' row unchanged (not a drifted value at all)", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/gate-off", "off", 0);

    applyMigration(db, MIGRATION_FILE);

    expect(readLinkedIssueGateMode(db, "acme/gate-off")).toBe("off");
  });

  it("is idempotent -- running it a second time changes nothing further", () => {
    const db = applyMigrationsBefore(MIGRATION_FILE);
    insertRepositorySettingsRow(db, "acme/drifted-repo", "block", 0);
    insertRepositorySettingsRow(db, "acme/explicit-opt-in", "block", 1);

    applyMigration(db, MIGRATION_FILE);
    applyMigration(db, MIGRATION_FILE);

    expect(readLinkedIssueGateMode(db, "acme/drifted-repo")).toBe("advisory");
    expect(readLinkedIssueGateMode(db, "acme/explicit-opt-in")).toBe("block");
  });
});
