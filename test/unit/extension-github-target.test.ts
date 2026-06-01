import { describe, expect, it } from "vitest";

// @ts-expect-error Plain MV3 JavaScript module.
import { isSupportedGitHubOverlayPath, parseGitHubPageTarget } from "../../apps/gittensory-extension/github-target.js";

describe("extension GitHub URL detection", () => {
  it("parses pull request paths", () => {
    expect(parseGitHubPageTarget("/JSONbored/gittensory/pull/145")).toEqual({
      kind: "pull",
      owner: "JSONbored",
      repo: "gittensory",
      pullNumber: 145,
    });
    expect(parseGitHubPageTarget("/JSONbored/gittensory/pull/145/files")).toEqual({
      kind: "pull",
      owner: "JSONbored",
      repo: "gittensory",
      pullNumber: 145,
    });
    expect(isSupportedGitHubOverlayPath("/JSONbored/gittensory/pull/145")).toBe(true);
  });

  it("parses issue paths", () => {
    expect(parseGitHubPageTarget("/JSONbored/gittensory/issues/42")).toEqual({
      kind: "issue",
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 42,
    });
    expect(parseGitHubPageTarget("/JSONbored/gittensory/issues/42#issuecomment-1")).toEqual({
      kind: "issue",
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 42,
    });
    expect(isSupportedGitHubOverlayPath("/JSONbored/gittensory/issues/42")).toBe(true);
  });

  it("rejects non-overlay GitHub paths and invalid numbers", () => {
    expect(parseGitHubPageTarget("/JSONbored/gittensory")).toBeNull();
    expect(parseGitHubPageTarget("/JSONbored/gittensory/pull/0")).toBeNull();
    expect(parseGitHubPageTarget("/JSONbored/gittensory/issues/0")).toBeNull();
    expect(parseGitHubPageTarget("/settings/profile")).toBeNull();
    expect(isSupportedGitHubOverlayPath("/orgs/gittensory/projects/1")).toBe(false);
  });
});
