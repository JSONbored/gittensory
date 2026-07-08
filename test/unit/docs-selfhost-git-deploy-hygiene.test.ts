import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Drift guard (#1660): the Git-backed update flow -- the .gitignore backup-file catch-alls, the
// scripts/selfhost-update.sh wrapper, and the operations docs describing it -- must stay aligned
// so an operator following the docs actually gets the script's real safety behavior.

const GITIGNORE = ".gitignore";
const UPDATE_SCRIPT = "scripts/selfhost-update.sh";
const PREBUILT_SCRIPT = "scripts/deploy-selfhost-prebuilt.sh";
const POST_UPDATE_SCRIPT = "scripts/selfhost-post-update-check.sh";
const OPERATIONS = "apps/gittensory-ui/src/routes/docs.self-hosting-operations.tsx";

const gitignore = readFileSync(GITIGNORE, "utf8");
const updateScript = readFileSync(UPDATE_SCRIPT, "utf8");
const operations = readFileSync(OPERATIONS, "utf8");

describe("self-host git-deploy hygiene (#1660)", () => {
  it(".gitignore catches ad-hoc operator backup files as trailing patterns", () => {
    expect(gitignore).toContain("*.bak-*");
    expect(gitignore).toContain("*.backup-*");
    // Trailing: the general catch-alls must come after the narrower, already-shipped patterns
    // they generalize, so this test fails loudly if a future edit reorders them.
    const deployBackupsIndex = gitignore.indexOf(".deploy-backups/");
    const generalBakIndex = gitignore.indexOf("*.bak-*");
    const generalBackupIndex = gitignore.indexOf("*.backup-*");
    expect(deployBackupsIndex).toBeGreaterThan(-1);
    expect(generalBakIndex).toBeGreaterThan(deployBackupsIndex);
    expect(generalBackupIndex).toBeGreaterThan(deployBackupsIndex);
  });

  it("does not shadow any file actually tracked in the repo", () => {
    // The real regression concern: .gitignore has no effect on a file git already tracks -- it
    // keeps being tracked, staged, and diffed normally forever, ignore pattern or not (verified:
    // `git add -A` still stages a modification to an already-tracked-but-now-ignored file). The
    // actual risk is the opposite direction -- a future PR that genuinely intends to add a NEW
    // tracked file whose name happens to match `*.bak-*` or `*.backup-*` would have that file
    // silently excluded from `git status`'s untracked list and from `git add -A`/`git add .`, so
    // it could go uncommitted without anyone noticing (an explicit `git add <path>` at least warns
    // and needs `-f`; a broad add just skips it quietly). Ask git itself, rather than approximating
    // the glob in JS, since git's own matcher is the one that actually enforces these patterns.
    const result = spawnSync("git", ["ls-files"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const trackedFiles = result.stdout.split("\n").filter(Boolean);
    const bakLikeGlob = /(^|\/)[^/]*\.(bak|backup)-[^/]*$/;
    const shadowed = trackedFiles.filter((path) => bakLikeGlob.test(path));
    expect(shadowed).toEqual([]);
  });

  it("wraps fetch, fast-forward-only merge, rebuild, and the post-update check", () => {
    expect(updateScript).toContain("#!/usr/bin/env bash");
    expect(updateScript).toContain("set -euo pipefail");
    expect(updateScript).toContain("git fetch");
    expect(updateScript).toContain("git merge --ff-only");
    expect(updateScript).toContain(PREBUILT_SCRIPT.replace("scripts/", ""));
    expect(updateScript).toContain(POST_UPDATE_SCRIPT.replace("scripts/", ""));
  });

  it("refuses to proceed on a dirty tree, the wrong branch, or a non-fast-forward", () => {
    expect(updateScript).toContain("git status --porcelain");
    expect(updateScript).toContain("current_branch");
    expect(updateScript).toMatch(/if\s*\[\s*-n\s*"\$\(git status --porcelain\)"\s*\]/);
  });

  it("never force-pushes, hard-resets, or force-merges on the operator's behalf", () => {
    expect(updateScript).not.toContain("git push");
    expect(updateScript).not.toContain("reset --hard");
    expect(updateScript).not.toContain("--force");
    expect(updateScript).not.toContain("clean -f");
    expect(updateScript).not.toContain("merge --no-ff");
  });

  it("supports overriding the remote/branch and skipping the health probe", () => {
    expect(updateScript).toContain("SELFHOST_UPDATE_REMOTE");
    expect(updateScript).toContain("SELFHOST_UPDATE_BRANCH");
    expect(updateScript).toContain("SELFHOST_SKIP_POST_UPDATE_CHECK");
  });

  it("operations docs point operators at the wrapper script and its safety guarantees", () => {
    expect(operations).toContain("scripts/selfhost-update.sh");
    expect(operations).toContain("*.bak-*");
    expect(operations).toContain("*.backup-*");
    expect(operations).toContain("git merge --ff-only");
    expect(operations).toContain("SELFHOST_SKIP_POST_UPDATE_CHECK");
  });

  it("operations docs still name every operator-owned path the script must never touch", () => {
    expect(operations).toContain("gittensory-config/");
    expect(operations).toContain(".deploy-backups/");
    expect(operations).toContain("*.local");
  });
});
