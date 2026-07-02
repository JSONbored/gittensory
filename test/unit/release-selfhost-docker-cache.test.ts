import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release-selfhost.yml Docker layer caching (#2502)", () => {
  it("caches the multi-arch build-push-action step via the GHA backend, matching selfhost.yml's CI build", () => {
    const releaseWorkflow = read(".github/workflows/release-selfhost.yml");
    const selfhostWorkflow = read(".github/workflows/selfhost.yml");

    const buildStep = releaseWorkflow.slice(
      releaseWorkflow.indexOf("- name: Build + push (linux/amd64 + linux/arm64)"),
    );
    expect(buildStep).toContain("cache-from: type=gha");
    expect(buildStep).toContain("cache-to: type=gha,mode=max");

    // Neither workflow sets a custom `scope:`, so both land in the GHA cache backend's default scope --
    // this is what lets the release build inherit layers selfhost.yml's own CI build already cached for
    // the identical Dockerfile/commit, not just cache across its own releases.
    expect(buildStep).not.toContain("scope=");
    expect(selfhostWorkflow).toContain("--cache-from type=gha");
    expect(selfhostWorkflow).toContain("--cache-to type=gha,mode=max");
  });
});
