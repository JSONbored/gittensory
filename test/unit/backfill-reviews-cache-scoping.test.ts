import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequestDetailSyncState,
  listPullRequestReviews,
  markPullRequestReviewsInvalidated,
  upsertPullRequestDetailSyncState,
  upsertPullRequestFromGitHub,
  upsertPullRequestReview,
} from "../../src/db/repositories";
import { refreshPullRequestDetails } from "../../src/github/backfill";
import { clearGitHubResponseCacheForTest } from "../../src/github/client";
import { resetMetrics } from "../../src/selfhost/metrics";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { createTestEnv } from "../helpers/d1";

describe("GitHub PR reviews cache scoping (#2537)", () => {
  afterEach(() => {
    clearGitHubResponseCacheForTest();
    resetMetrics();
    vi.unstubAllGlobals();
  });

  async function seedRegisteredRepo(env: Env) {
    await persistRegistrySnapshot(
      env,
      normalizeRegistryPayload(
        { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0, trusted_label_pipeline: true, label_multipliers: {} } },
        { kind: "raw-github", url: "https://example.test/master_repositories.json" },
        "2026-05-23T00:00:00.000Z",
      ),
    );
  }

  function stubFetchTracking(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      urls.push(url);
      return handler(url, init);
    });
    return urls;
  }

  it("fetches and stores reviews on first sync when no sync-state row exists (cache miss)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 60,
      title: "Open PR, never synced",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-60" },
      labels: [],
      body: "",
    });
    const urls = stubFetchTracking((url) =>
      url.includes("/pulls/60/reviews")
        ? Response.json([{ id: 1, user: { login: "maintainer" }, state: "APPROVED", author_association: "OWNER", submitted_at: "2026-05-20T00:00:00.000Z" }])
        : Response.json([]),
    );

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 60);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/60/reviews"))).toBe(true);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 60)).toEqual([expect.objectContaining({ reviewerLogin: "maintainer", state: "APPROVED" })]);
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 60)).toMatchObject({ status: "complete" });
  });

  it("does not re-fetch reviews when reviewsSyncedAt is set and no invalidation has been recorded (cache hit), and leaves stored rows untouched", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 61,
      title: "Open PR, reviews already synced",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-61" },
      labels: [],
      body: "",
    });
    await upsertPullRequestReview(env, {
      id: "JSONbored/gittensory#61#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 61,
      reviewerLogin: "maintainer",
      state: "APPROVED",
      authorAssociation: "OWNER",
      submittedAt: "2026-05-19T00:00:00.000Z",
      payload: { id: 1 },
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 61,
      status: "complete",
      headSha: "head-61",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) => (url.includes("/reviews") ? new Response("must not be called", { status: 500 }) : Response.json([])));

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 61);

    expect(result).toMatchObject({ status: "complete", warnings: [] });
    expect(urls.some((url) => url.includes("/pulls/61/reviews"))).toBe(false);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 61)).toEqual([expect.objectContaining({ reviewerLogin: "maintainer", state: "APPROVED" })]);
  });

  it("does not re-fetch reviews when reviewsInvalidatedAt predates reviewsSyncedAt (stale invalidation, still a cache hit)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 62,
      title: "Open PR, invalidation predates sync",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-62" },
      labels: [],
      body: "",
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 62,
      status: "complete",
      headSha: "head-62",
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
      reviewsInvalidatedAt: "2026-05-19T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) => (url.includes("/reviews") ? new Response("must not be called", { status: 500 }) : Response.json([])));

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 62);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/62/reviews"))).toBe(false);
  });

  it("re-fetches reviews on the next sync after markPullRequestReviewsInvalidated bumps reviewsInvalidatedAt past reviewsSyncedAt (cache invalidation)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 63,
      title: "Open PR, invalidated after sync",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-63" },
      labels: [],
      body: "",
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 63,
      status: "complete",
      headSha: "head-63",
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
    });

    await markPullRequestReviewsInvalidated(env, "JSONbored/gittensory", 63);
    expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 63)).toMatchObject({
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
      status: "complete",
      headSha: "head-63",
    });

    const urls = stubFetchTracking((url) =>
      url.includes("/pulls/63/reviews")
        ? Response.json([{ id: 2, user: { login: "second-reviewer" }, state: "CHANGES_REQUESTED", author_association: "NONE", submitted_at: "2026-05-21T00:00:00.000Z" }])
        : Response.json([]),
    );

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 63);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/63/reviews"))).toBe(true);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 63)).toEqual([expect.objectContaining({ reviewerLogin: "second-reviewer", state: "CHANGES_REQUESTED" })]);
  });

  it("REGRESSION: a prior FAILED review fetch does not poison the cache — the next sync retries reviews even though reviewsSyncedAt is already set", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 65,
      title: "Open PR, review fetch failed last time",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-65" },
      labels: [],
      body: "",
    });
    // Simulates the state left behind by a run whose review fetch failed: reviewsSyncedAt IS stamped (every
    // caller stamps it unconditionally), but errorSummary records the review-specific failure.
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 65,
      status: "partial",
      headSha: "head-65",
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
      errorSummary: "Review sync failed for #65: GitHub REST and GraphQL detail fetches failed.",
    });
    const urls = stubFetchTracking((url) =>
      url.includes("/pulls/65/reviews")
        ? Response.json([{ id: 3, user: { login: "late-reviewer" }, state: "APPROVED", author_association: "NONE", submitted_at: "2026-05-22T00:00:00.000Z" }])
        : Response.json([]),
    );

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 65);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/65/reviews"))).toBe(true);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 65)).toEqual([expect.objectContaining({ reviewerLogin: "late-reviewer" })]);
  });

  it("does not treat a FILES-only failure as a reason to re-fetch reviews (only a review-specific failure forces a retry)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 66,
      title: "Open PR, prior FILES failure only",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-66" },
      labels: [],
      body: "",
    });
    await upsertPullRequestReview(env, {
      id: "JSONbored/gittensory#66#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 66,
      reviewerLogin: "maintainer",
      state: "APPROVED",
      authorAssociation: "OWNER",
      submittedAt: "2026-05-19T00:00:00.000Z",
      payload: { id: 1 },
    });
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 66,
      status: "partial",
      // headSha intentionally omitted/mismatched so files remain "not up to date" too — the point of this
      // test is only that the FILES failure text in errorSummary must not be mistaken for a reviews failure.
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
      errorSummary: "File sync failed for #66: GitHub REST and GraphQL detail fetches failed.",
    });
    const urls = stubFetchTracking((url) => (url.includes("/pulls/66/reviews") ? new Response("must not be called", { status: 500 }) : Response.json([])));

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 66);

    expect(result).toMatchObject({ status: "complete" });
    expect(urls.some((url) => url.includes("/pulls/66/reviews"))).toBe(false);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 66)).toEqual([expect.objectContaining({ reviewerLogin: "maintainer" })]);
  });

  it("REGRESSION: a head SHA change alone does not invalidate cached reviews (reviews are independent of the head, unlike files)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 64,
      title: "Open PR, new commit pushed",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-new" },
      labels: [],
      body: "",
    });
    await upsertPullRequestReview(env, {
      id: "JSONbored/gittensory#64#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 64,
      reviewerLogin: "maintainer",
      state: "APPROVED",
      authorAssociation: "OWNER",
      submittedAt: "2026-05-19T00:00:00.000Z",
      payload: { id: 1 },
    });
    // Sync state was stamped for a DIFFERENT (older) head SHA — files caching would treat this as stale, but
    // reviews caching must not, since reviews.reviewsSyncedAt has no head-SHA gate at all.
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 64,
      status: "complete",
      headSha: "head-old",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) =>
      url.includes("/pulls/64/files")
        ? Response.json([{ filename: "src/new.ts", status: "added", additions: 3, deletions: 0, changes: 3 }])
        : url.includes("/reviews")
          ? new Response("must not be called", { status: 500 })
          : Response.json([]),
    );

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 64);

    expect(result).toMatchObject({ status: "complete" });
    // Files WERE refetched (head changed)...
    expect(urls.some((url) => url.includes("/pulls/64/files"))).toBe(true);
    // ...but reviews were NOT — the core distinction from the files cache.
    expect(urls.some((url) => url.includes("/pulls/64/reviews"))).toBe(false);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 64)).toEqual([expect.objectContaining({ reviewerLogin: "maintainer", state: "APPROVED" })]);
  });

  it("REGRESSION (gate finding): a manual force-files refresh does not also force an unrelated reviews refetch", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await seedRegisteredRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 67,
      title: "Open PR, manual force-files refresh",
      state: "open",
      user: { login: "oktofeesh1" },
      head: { sha: "head-67" },
      labels: [],
      body: "",
    });
    await upsertPullRequestReview(env, {
      id: "JSONbored/gittensory#67#1",
      repoFullName: "JSONbored/gittensory",
      pullNumber: 67,
      reviewerLogin: "maintainer",
      state: "APPROVED",
      authorAssociation: "OWNER",
      submittedAt: "2026-05-19T00:00:00.000Z",
      payload: { id: 1 },
    });
    // Same head SHA + a fresh reviewsSyncedAt — reviews ARE cache-current; `force: true` must only re-fetch
    // files (its own documented purpose), never reviews (an earlier version of this cache accidentally
    // skipped the whole sync-state row lookup whenever `forceFiles && headSha`, which zeroed out
    // `reviewsUpToDate` too and forced an unrelated reviews refetch on every manual files-only force).
    await upsertPullRequestDetailSyncState(env, {
      repoFullName: "JSONbored/gittensory",
      pullNumber: 67,
      status: "complete",
      headSha: "head-67",
      filesSyncedAt: "2026-05-20T00:00:00.000Z",
      reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
    });
    const urls = stubFetchTracking((url) =>
      url.includes("/pulls/67/files")
        ? Response.json([{ filename: "src/refreshed.ts", status: "modified", additions: 1, deletions: 1, changes: 2 }])
        : url.includes("/reviews")
          ? new Response("must not be called", { status: 500 })
          : Response.json([]),
    );

    const result = await refreshPullRequestDetails(env, "JSONbored/gittensory", 67, { force: true });

    expect(result).toMatchObject({ status: "complete" });
    // Files WERE refetched (force: true)...
    expect(urls.some((url) => url.includes("/pulls/67/files"))).toBe(true);
    // ...but reviews were NOT — forceFiles must never bleed into the (unrelated) reviews cache decision.
    expect(urls.some((url) => url.includes("/pulls/67/reviews"))).toBe(false);
    expect(await listPullRequestReviews(env, "JSONbored/gittensory", 67)).toEqual([expect.objectContaining({ reviewerLogin: "maintainer", state: "APPROVED" })]);
  });

  describe("markPullRequestReviewsInvalidated", () => {
    it("creates a sync-state row if none exists yet", async () => {
      const env = createTestEnv();
      expect(await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 70)).toBeNull();

      await markPullRequestReviewsInvalidated(env, "JSONbored/gittensory", 70);

      const state = await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 70);
      expect(state).not.toBeNull();
      expect(state?.reviewsInvalidatedAt).toBeTruthy();
    });

    it("updates ONLY reviewsInvalidatedAt when a row already exists, leaving filesSyncedAt/reviewsSyncedAt/checksSyncedAt/headSha unchanged", async () => {
      const env = createTestEnv();
      await upsertPullRequestDetailSyncState(env, {
        repoFullName: "JSONbored/gittensory",
        pullNumber: 71,
        status: "complete",
        headSha: "sha-preserved",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
        reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
        checksSyncedAt: "2026-05-20T00:00:00.000Z",
        errorSummary: "prior warning",
      });

      await markPullRequestReviewsInvalidated(env, "JSONbored/gittensory", 71);

      const state = await getPullRequestDetailSyncState(env, "JSONbored/gittensory", 71);
      expect(state).toMatchObject({
        status: "complete",
        headSha: "sha-preserved",
        filesSyncedAt: "2026-05-20T00:00:00.000Z",
        reviewsSyncedAt: "2026-05-20T00:00:00.000Z",
        checksSyncedAt: "2026-05-20T00:00:00.000Z",
        errorSummary: "prior warning",
      });
      expect(state?.reviewsInvalidatedAt).toBeTruthy();
      expect(state?.reviewsInvalidatedAt).not.toBe("2026-05-20T00:00:00.000Z");
    });
  });
});
