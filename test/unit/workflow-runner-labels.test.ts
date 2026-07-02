import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("workflow runner labels", () => {
  it("keeps only the build/test job on the gittensory runner pool; non-build jobs run on GitHub-hosted runners", () => {
    const workflow = read(".github/workflows/ci.yml");
    const trustedRunnerExpression =
      '${{ fromJSON((github.event_name == \'pull_request\' && github.event.pull_request.head.repo.fork == true) && \'["ubuntu-latest"]\' || \'["self-hosted","gittensory"]\') }}';

    // Only validate-code (the npm/build/test job that benefits from the self-hosted VPS's cached toolchain)
    // stays on the fork-aware trusted-pool expression. changes/security/validate do no build/test work, so
    // they're unconditionally ubuntu-latest -- fanning them out to self-hosted only competed with
    // validate-code for the same scarce runner pool (#2501, #2507).
    expect(workflow.match(new RegExp(escapeRegExp(trustedRunnerExpression), "g")) ?? []).toHaveLength(1);
    expect(workflow).toContain("validate-code:");
    expect(workflow).toContain("needs: [changes, validate-code, security]");
    expect(workflow).not.toContain("\n  lint:\n");
    expect(workflow).not.toContain("\n  test:\n");
    expect(workflow).not.toContain("\n  workers:\n");
    expect(workflow).not.toContain("\n  mcp:\n");
    expect(workflow).not.toContain("\n  rees:\n");
    expect(workflow).not.toContain("\n  ui:\n");
    expect(workflow).not.toContain("|| 'self-hosted'");
    expect(workflow).not.toContain('"fork-ci"');

    const changesJob = workflow.slice(workflow.indexOf("\n  changes:\n"), workflow.indexOf("\n  validate-code:\n"));
    expect(changesJob).toContain("runs-on: ubuntu-latest");
    const securityJob = workflow.slice(workflow.indexOf("\n  security:\n"), workflow.indexOf("\n  validate:\n"));
    expect(securityJob).toContain("runs-on: ubuntu-latest");
    const validateJob = workflow.slice(workflow.indexOf("\n  validate:\n"));
    expect(validateJob).toContain("runs-on: ubuntu-latest");
  });

  it("keeps scheduled audit work on the trusted self-hosted pool", () => {
    const workflow = read(".github/workflows/audit.yml");

    expect(workflow).toContain("runs-on: [self-hosted, gittensory]");
    expect(workflow).not.toContain("|| 'self-hosted'");
  });

  it("cancels a superseded selfhost.yml run instead of letting it run to completion (#2496)", () => {
    const workflow = read(".github/workflows/selfhost.yml");

    // Same push/pr split as ci.yml's own group, for the same reason: distinct main-branch pushes must not
    // cancel each other's validation, only a superseded run on the SAME ref/PR should be cancelled.
    expect(workflow).toContain(
      "group: selfhost-${{ github.ref }}-${{ github.event_name == 'push' && github.sha || 'pr' }}",
    );
    expect(workflow).toContain("cancel-in-progress: true");
    // Must be a literal boolean, not an expression -- ci.yml's own comment documents that an expression here
    // causes GitHub to fail the workflow at startup (startup_failure).
    expect(workflow).not.toMatch(/cancel-in-progress:\s*\$\{\{/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
