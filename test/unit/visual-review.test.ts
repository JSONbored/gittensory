import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/d1";
import type { GitHubWebhookPayload, JobMessage } from "../../src/types";
import { REVIEW_MARKER, visualReviewAuditKey } from "../../src/visual/constants";
import { maybeEnqueueVisualReview } from "../../src/visual/webhook";
import { processVisualReview } from "../../src/visual/pipeline";
import {
  getVisualReviewTarget,
  isVisualReviewEnabled,
  setVisualReviewEnabled,
  transitionVisualReviewTarget,
  upsertVisualReviewTarget,
} from "../../src/visual/targets";

/** Env whose JOBS.send captures every enqueued message so tests can assert the webhook -> queue handoff. */
function envWithJobCapture(): { env: Env; jobs: JobMessage[] } {
  const jobs: JobMessage[] = [];
  const env = createTestEnv({
    JOBS: {
      async send(message: JobMessage) {
        jobs.push(message);
      },
    } as unknown as Queue,
  });
  return { env, jobs };
}

function prPayload(overrides: Partial<GitHubWebhookPayload> = {}): GitHubWebhookPayload {
  return {
    action: "opened",
    installation: { id: 42 },
    repository: { name: "demo", full_name: "octo/demo" },
    pull_request: {
      number: 7,
      title: "Tweak the landing page",
      state: "open",
      draft: false,
      head: { sha: "abc1234deadbeef", ref: "feature" },
      base: { ref: "main" },
    },
    ...overrides,
  };
}

describe("visual-review enablement settings", () => {
  it("is opt-in: a repo with no settings row is disabled", async () => {
    const env = createTestEnv();
    expect(await isVisualReviewEnabled(env, "octo/demo")).toBe(false);
  });

  it("enables and disables a repo idempotently", async () => {
    const env = createTestEnv();
    await setVisualReviewEnabled(env, "octo/demo", true);
    expect(await isVisualReviewEnabled(env, "octo/demo")).toBe(true);
    await setVisualReviewEnabled(env, "octo/demo", true); // idempotent re-enable
    expect(await isVisualReviewEnabled(env, "octo/demo")).toBe(true);
    await setVisualReviewEnabled(env, "octo/demo", false);
    expect(await isVisualReviewEnabled(env, "octo/demo")).toBe(false);
  });
});

describe("visual-review target state", () => {
  it("upsert is idempotent per (repo, pr, head) and resets to queued", async () => {
    const env = createTestEnv();
    const first = await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    const again = await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("queued");
  });

  it("a new head SHA creates a distinct target", async () => {
    const env = createTestEnv();
    const a = await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    const b = await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-b" });
    expect(b.id).not.toBe(a.id);
  });

  it("transition to failed records a default error message", async () => {
    const env = createTestEnv();
    const target = await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    await transitionVisualReviewTarget(env, target.id, "failed");
    const after = await getVisualReviewTarget(env, "octo/demo", 7, "sha-a");
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toBe("unknown error");
    expect(after?.attempts).toBe(0);
  });

  it("incrementAttempts on an unknown id starts from zero without throwing", async () => {
    const env = createTestEnv();
    await expect(transitionVisualReviewTarget(env, "missing-id", "capturing", { incrementAttempts: true })).resolves.toBeUndefined();
  });
});

describe("maybeEnqueueVisualReview", () => {
  it("does nothing when the repo has not opted in", async () => {
    const { env, jobs } = envWithJobCapture();
    expect(await maybeEnqueueVisualReview(env, "d1", prPayload())).toBe(false);
    expect(jobs).toHaveLength(0);
  });

  it("records a queued target and enqueues a visual-review job for an opted-in repo", async () => {
    const { env, jobs } = envWithJobCapture();
    await setVisualReviewEnabled(env, "octo/demo", true);

    expect(await maybeEnqueueVisualReview(env, "d1", prPayload())).toBe(true);

    const target = await getVisualReviewTarget(env, "octo/demo", 7, "abc1234deadbeef");
    expect(target?.status).toBe("queued");
    expect(target?.installationId).toBe(42);
    expect(jobs).toEqual([
      { type: "visual-review", requestedBy: "webhook", deliveryId: "d1", repoFullName: "octo/demo", pullNumber: 7, headSha: "abc1234deadbeef" },
    ]);
  });

  it("skips draft PRs", async () => {
    const { env, jobs } = envWithJobCapture();
    await setVisualReviewEnabled(env, "octo/demo", true);
    const payload = prPayload({ pull_request: { ...prPayload().pull_request!, draft: true } });
    expect(await maybeEnqueueVisualReview(env, "d1", payload)).toBe(false);
    expect(jobs).toHaveLength(0);
  });

  it("skips non-trigger actions and missing head SHA", async () => {
    const { env, jobs } = envWithJobCapture();
    await setVisualReviewEnabled(env, "octo/demo", true);
    expect(await maybeEnqueueVisualReview(env, "d1", prPayload({ action: "closed" }))).toBe(false);
    expect(await maybeEnqueueVisualReview(env, "d1", prPayload({ pull_request: { number: 7, title: "x", state: "open" } }))).toBe(false);
    expect(jobs).toHaveLength(0);
  });

  it("skips webhooks that are not PR events", async () => {
    const { env } = envWithJobCapture();
    await setVisualReviewEnabled(env, "octo/demo", true);
    expect(await maybeEnqueueVisualReview(env, "d1", { action: "opened", repository: { name: "demo", full_name: "octo/demo" } })).toBe(false);
  });

  it("skips when the webhook action is absent", async () => {
    const { env, jobs } = envWithJobCapture();
    await setVisualReviewEnabled(env, "octo/demo", true);
    const payload: GitHubWebhookPayload = {
      repository: { name: "demo", full_name: "octo/demo" },
      pull_request: { number: 7, title: "x", state: "open", draft: false, head: { sha: "abc1234deadbeef" } },
    };
    expect(await maybeEnqueueVisualReview(env, "d1", payload)).toBe(false);
    expect(jobs).toHaveLength(0);
  });

  it("enqueues with null installation/base when those fields are absent", async () => {
    const { env, jobs } = envWithJobCapture();
    await setVisualReviewEnabled(env, "octo/demo", true);
    const payload: GitHubWebhookPayload = {
      action: "opened",
      repository: { name: "demo", full_name: "octo/demo" },
      pull_request: { number: 7, title: "x", state: "open", draft: false, head: { sha: "abc1234deadbeef" } },
    };
    expect(await maybeEnqueueVisualReview(env, "d1", payload)).toBe(true);
    const target = await getVisualReviewTarget(env, "octo/demo", 7, "abc1234deadbeef");
    expect(target?.installationId).toBeNull();
    expect(target?.baseSha).toBeNull();
    expect(jobs).toHaveLength(1);
  });

  it("is fail-safe: a queue send error is audited and returns false", async () => {
    const env = createTestEnv({
      JOBS: {
        async send() {
          throw new Error("queue unavailable");
        },
      } as unknown as Queue,
    });
    await setVisualReviewEnabled(env, "octo/demo", true);
    expect(await maybeEnqueueVisualReview(env, "d1", prPayload())).toBe(false);
  });
});

describe("processVisualReview", () => {
  it("transitions queued -> capturing for an existing target", async () => {
    const env = createTestEnv();
    await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    await processVisualReview(env, { deliveryId: "d1", repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    const target = await getVisualReviewTarget(env, "octo/demo", 7, "sha-a");
    expect(target?.status).toBe("capturing");
    expect(target?.attempts).toBe(1);
  });

  it("is a no-op when the target was superseded (missing row)", async () => {
    const env = createTestEnv();
    await expect(processVisualReview(env, { deliveryId: "d1", repoFullName: "octo/demo", pullNumber: 7, headSha: "gone" })).resolves.toBeUndefined();
  });

  it("writes an R2 intake audit log when a bucket binding is present", async () => {
    const puts: Array<{ key: string; body: unknown }> = [];
    const env = createTestEnv({
      VISUAL_REVIEW_BUCKET: {
        async put(key: string, body: unknown) {
          puts.push({ key, body });
        },
      } as unknown as R2Bucket,
    });
    await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    await processVisualReview(env, { deliveryId: "d1", repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(visualReviewAuditKey("octo/demo", 7, "sha-a"));
  });

  it("transitions to failed and rethrows when a bound R2 write fails", async () => {
    const env = createTestEnv({
      VISUAL_REVIEW_BUCKET: {
        async put() {
          throw new Error("r2 down");
        },
      } as unknown as R2Bucket,
    });
    await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    await expect(processVisualReview(env, { deliveryId: "d1", repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" })).rejects.toThrow("r2 down");
    const target = await getVisualReviewTarget(env, "octo/demo", 7, "sha-a");
    expect(target?.status).toBe("failed");
    expect(target?.lastError).toBe("r2 down");
  });

  it("completes capturing without R2 write when VISUAL_REVIEW_BUCKET binding is absent", async () => {
    const env = createTestEnv(); // no VISUAL_REVIEW_BUCKET — graceful degradation
    await upsertVisualReviewTarget(env, { repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" });
    await expect(processVisualReview(env, { deliveryId: "d1", repoFullName: "octo/demo", pullNumber: 7, headSha: "sha-a" })).resolves.toBeUndefined();
    const target = await getVisualReviewTarget(env, "octo/demo", 7, "sha-a");
    expect(target?.status).toBe("capturing");
    expect(target?.attempts).toBe(1);
  });
});

describe("visual-review constants", () => {
  it("exposes a stable managed-comment marker", () => {
    expect(REVIEW_MARKER).toBe("<!-- gittensory-visual-review:v1 -->");
  });
});
