import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGitHubResponseCacheForTest,
  githubRateLimitAdmissionKeyForInstallation,
  latestGitHubRestRateLimitObservation,
} from "../../src/github/client";
import { buildCapture, mapFilesToRoutes, resolvePreviewUrlTemplate, resolveVisualRoutes } from "../../src/review/visual/capture";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("visual capture preview discovery", () => {
  it("threads admission telemetry through deployment, checks, comments, and build-state fallbacks", async () => {
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    const seenUrls: string[] = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      const init = {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "33",
          "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
        },
      };
      if (url.includes("/deployments?")) return Response.json([], init);
      if (url.includes("/status")) return Response.json({ statuses: [] }, init);
      if (url.includes("/issues/7/comments")) return Response.json([], init);
      if (url.includes("/check-runs")) {
        return Response.json(
          { check_runs: [{ name: "Cloudflare Workers Builds", status: "completed", conclusion: "failure" }] },
          init,
        );
      }
      return Response.json({}, init);
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      {
        repoFullName: "owner/repo",
        prNumber: 7,
        headSha: "abc123",
        previewFromChecks: true,
      },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      key,
    );

    expect(seenUrls.some((url) => url.includes("/deployments?sha=abc123"))).toBe(true);
    expect(seenUrls.some((url) => url.includes("/commits/abc123/status"))).toBe(true);
    expect(seenUrls.some((url) => url.includes("/commits/abc123/check-runs"))).toBe(true);
    expect(seenUrls.some((url) => url.includes("/issues/7/comments"))).toBe(true);
    expect(result.previewPending).toBe(false);
    expect(result.routes).toEqual([
      {
        path: "/app",
        beforeUrl: undefined,
        beforeUrlMobile: undefined,
        afterUrl: "https://worker.example/gittensory/shot?placeholder=failed",
        afterUrlMobile: "https://worker.example/gittensory/shot?placeholder=failed",
      },
    ]);
    expect(latestGitHubRestRateLimitObservation(key)).toEqual({
      remaining: 33,
      resetAt: "2026-06-24T12:10:00.000Z",
      observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
    });
  });

  it("an explicit preview.url_template wins over the target's own previewUrl and skips discovery entirely", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      throw new Error("discovery must never be called when review.visual.preview.url_template is configured");
    });

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      {
        repoFullName: "owner/repo",
        prNumber: 42,
        headSha: "abc1234def5678900000000000000000000000a",
        previewUrl: "https://should-be-ignored.example.com",
        previewFromChecks: true,
      },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { preview: { urlTemplate: "https://pr-{number}-{head_sha_short}.preview.example.com" } },
    );

    expect(seenUrls).toEqual([]);
    expect(result.previewPending).toBe(false);
    expect(result.routes).toEqual([
      {
        path: "/app",
        beforeUrl: undefined,
        beforeUrlMobile: undefined,
        afterUrl: `https://worker.example/gittensory/shot?url=${encodeURIComponent("https://pr-42-abc1234.preview.example.com/app")}&w=1440&h=900`,
        afterUrlMobile: `https://worker.example/gittensory/shot?url=${encodeURIComponent("https://pr-42-abc1234.preview.example.com/app")}&w=390&h=844`,
      },
    ]);
  });

  it("an explicit routes.paths list replaces file-based route inference end to end", async () => {
    vi.stubGlobal("fetch", async () => Response.json([], { status: 200 }));

    const result = await buildCapture(
      createTestEnv({ PUBLIC_API_ORIGIN: "https://worker.example", PUBLIC_SITE_ORIGIN: "" }),
      "installation-token",
      { repoFullName: "owner/repo", prNumber: 1, previewFromChecks: false },
      ["apps/gittensory-ui/src/routes/app.index.tsx"],
      undefined,
      { routes: { paths: ["/pricing"] } },
    );

    expect(result.routes.map((route) => route.path)).toEqual(["/pricing"]);
  });
});

describe("resolvePreviewUrlTemplate (#3609)", () => {
  it("substitutes {number}, {head_sha}, and {head_sha_short}", () => {
    const url = resolvePreviewUrlTemplate("https://pr-{number}-{head_sha_short}.preview.example.com/{head_sha}", {
      number: 42,
      headSha: "abc1234def5678900000000000000000000000a",
    });
    expect(url).toBe("https://pr-42-abc1234.preview.example.com/abc1234def5678900000000000000000000000a");
  });

  it("leaves the sha placeholders empty when headSha is missing", () => {
    expect(resolvePreviewUrlTemplate("https://pr-{number}-{head_sha_short}.example.com/{head_sha}", { number: 7 })).toBe(
      "https://pr-7-.example.com/",
    );
  });

  it("is a no-op on a template with no placeholders", () => {
    expect(resolvePreviewUrlTemplate("https://staging.example.com", { number: 1, headSha: "abc" })).toBe("https://staging.example.com");
  });
});

describe("resolveVisualRoutes (#3610)", () => {
  const files = ["apps/gittensory-ui/src/routes/app.index.tsx"];
  const manyFiles = [
    "apps/gittensory-ui/src/routes/app.index.tsx",
    "apps/gittensory-ui/src/routes/app.analytics.tsx",
    "apps/gittensory-ui/src/routes/app.billing.tsx",
  ];

  it("falls through to file-based inference when config is absent, null, or empty", () => {
    expect(resolveVisualRoutes(files)).toEqual(["/app"]);
    expect(resolveVisualRoutes(files, null)).toEqual(["/app"]);
    expect(resolveVisualRoutes(files, {})).toEqual(["/app"]);
  });

  it("an explicit non-empty paths list replaces file-based inference entirely", () => {
    expect(resolveVisualRoutes(files, { paths: ["/pricing", "/docs"] })).toEqual(["/pricing", "/docs"]);
  });

  it("an explicit but empty paths list still falls through to inference", () => {
    expect(resolveVisualRoutes(files, { paths: [] })).toEqual(["/app"]);
  });

  it("maxRoutes caps an explicit paths list, not just inferred routes", () => {
    expect(resolveVisualRoutes(manyFiles, { paths: ["/a", "/b", "/c"], maxRoutes: 2 })).toEqual(["/a", "/b"]);
  });

  it("a maxRoutes of zero or negative falls back to the built-in default cap", () => {
    expect(resolveVisualRoutes(manyFiles, { maxRoutes: 0 })).toEqual(["/app", "/app/analytics"]);
    expect(resolveVisualRoutes(manyFiles, { maxRoutes: -1 })).toEqual(["/app", "/app/analytics"]);
  });
});

describe("mapFilesToRoutes maxRoutes parameter", () => {
  const manyFiles = [
    "apps/gittensory-ui/src/routes/app.index.tsx",
    "apps/gittensory-ui/src/routes/app.analytics.tsx",
    "apps/gittensory-ui/src/routes/app.billing.tsx",
  ];

  it("defaults to the built-in cap of 2", () => {
    expect(mapFilesToRoutes(manyFiles)).toEqual(["/app", "/app/analytics"]);
  });

  it("honors an explicit maxRoutes override", () => {
    expect(mapFilesToRoutes(manyFiles, undefined, 1)).toEqual(["/app"]);
    expect(mapFilesToRoutes(manyFiles, undefined, 3)).toEqual(["/app", "/app/analytics", "/app/billing"]);
  });
});
