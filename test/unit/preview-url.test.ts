import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGitHubResponseCacheForTest, githubRateLimitAdmissionKeyForInstallation, latestGitHubRestRateLimitObservation } from "../../src/github/client";
import { extractPreviewUrl, getPreviewBuildState } from "../../src/review/visual/preview-url";

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("preview-url GitHub reads", () => {
  it("records REST admission telemetry only for installation-token preview lookups", async () => {
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { check_runs: [] },
        {
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
          },
        },
      ),
    );

    await expect(
      getPreviewBuildState({ token: "dummy-user-token", repo: { owner: "o", repo: "r" }, sha: "abc123" }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toBeNull();

    await expect(
      getPreviewBuildState({
        token: "dummy-installation-token",
        repo: { owner: "o", repo: "r" },
        sha: "abc123",
        rateLimitAdmissionKey: key,
      }),
    ).resolves.toBe("absent");
    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 42,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
    });
  });
});

describe("extractPreviewUrl", () => {
  it("returns null for null, undefined, or empty input", () => {
    expect(extractPreviewUrl(null)).toBeNull();
    expect(extractPreviewUrl(undefined)).toBeNull();
    expect(extractPreviewUrl("")).toBeNull();
  });

  it("returns null when the text contains no URL at all", () => {
    expect(extractPreviewUrl("no link here, just prose")).toBeNull();
  });

  it("returns null when the only URL is not a Cloudflare preview host", () => {
    expect(extractPreviewUrl("see https://github.com/acme/widgets/pull/1 for details")).toBeNull();
  });

  it("skips a URL-like substring that fails to parse and falls through to null", () => {
    expect(extractPreviewUrl("broken http://[not-a-valid-host link")).toBeNull();
  });

  it("keeps scanning past a non-matching URL to return a later *.workers.dev origin", () => {
    expect(extractPreviewUrl("ref https://github.com/acme/widgets then https://widgets-preview.acme.workers.dev/home")).toBe(
      "https://widgets-preview.acme.workers.dev",
    );
  });

  it("matches a *.pages.dev host as well as *.workers.dev", () => {
    expect(extractPreviewUrl("deploy: https://widgets.pages.dev/preview")).toBe("https://widgets.pages.dev");
  });

  it("matches the host case-insensitively and returns the bare origin without the path", () => {
    expect(extractPreviewUrl("HTTPS://Widgets.WORKERS.DEV/some/path?x=1")).toBe("https://widgets.workers.dev");
  });
});
