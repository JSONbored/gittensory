import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAmsAttemptFailedPayload,
  buildAmsAttemptStartedPayload,
  buildAmsGovernorPausedPayload,
  buildAmsPrOutcomePayload,
  publishAmsNotificationEvents,
  scheduleAmsNotificationEvents,
} from "../../packages/loopover-miner/lib/ams-notifications.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSessionConfig(loginToken = "session-token"): { env: Record<string, string | undefined>; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ams-notifications-config-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      activeProfile: "default",
      profiles: {
        default: {
          apiUrl: "https://api.example.test",
          session: { token: loginToken },
        },
      },
    }),
  );
  return { env: { LOOPOVER_CONFIG_PATH: configPath }, root };
}

describe("ams-notifications (#7657)", () => {
  it("builds AMS payloads mirroring hosted DetectedNotificationEvent shape", () => {
    expect(
      buildAmsAttemptStartedPayload({
        recipientLogin: "Miner",
        repoFullName: "acme/widgets",
        issueNumber: 2,
        attemptId: "a1",
        detectedAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toMatchObject({
      eventType: "ams_attempt_started",
      recipientLogin: "miner",
      pullNumber: 2,
    });
    expect(
      buildAmsAttemptFailedPayload({
        recipientLogin: "miner",
        repoFullName: "acme/widgets",
        issueNumber: 2,
        attemptId: "a1",
        reason: "abandon",
      }).dedupKey,
    ).toContain(":abandon");
    expect(buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" }).pullNumber).toBe(0);
    expect(
      buildAmsPrOutcomePayload({
        recipientLogin: "miner",
        repoFullName: "acme/widgets",
        pullNumber: 9,
        decision: "closed",
        closedAt: "t",
      }).eventType,
    ).toBe("ams_pr_outcome");
  });

  it("uses an injected dispatch (job-dispatch evaluate→deliver shape) when provided", async () => {
    const dispatch = vi.fn(async () => undefined);
    const event = buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" });
    await expect(publishAmsNotificationEvents([event], { dispatch })).resolves.toEqual({ sent: 1 });
    expect(dispatch).toHaveBeenCalledWith([event]);
  });

  it("returns no_session without a loopover backend session", async () => {
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        env: { LOOPOVER_CONFIG_PATH: join(tmpdir(), "missing-loopover-config.json") },
      }),
    ).resolves.toEqual({ sent: 0, error: "no_session" });
  });

  it("POSTs to the contributor ams-notifications ingest when a session is present", async () => {
    const { env } = writeSessionConfig();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));
    const event = buildAmsAttemptStartedPayload({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      issueNumber: 1,
      attemptId: "a1",
      detectedAt: "2026-07-21T00:00:00.000Z",
    });
    await expect(publishAmsNotificationEvents([event], { env, fetchFn })).resolves.toEqual({ sent: 1 });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.example.test/v1/contributors/miner/ams-notifications",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
      }),
    );
  });

  it("reports http errors and mixed recipients on the HTTP path", async () => {
    const { env } = writeSessionConfig();
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        env,
        fetchFn,
      }),
    ).resolves.toEqual({ sent: 0, error: "http_500" });

    await expect(
      publishAmsNotificationEvents(
        [
          buildAmsGovernorPausedPayload({ recipientLogin: "a", pausedAt: "t" }),
          buildAmsGovernorPausedPayload({ recipientLogin: "b", pausedAt: "t" }),
        ],
        { env, fetchFn },
      ),
    ).resolves.toEqual({ sent: 0, error: "mixed_recipients" });
  });

  it("scheduleAmsNotificationEvents is fire-and-forget", async () => {
    const dispatch = vi.fn(async () => undefined);
    scheduleAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
      dispatch,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
  });

  it("reports dispatch failures without throwing", async () => {
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        dispatch: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toEqual({ sent: 0, error: "boom" });
  });

  it("returns sent 0 for an empty event list", async () => {
    await expect(publishAmsNotificationEvents([])).resolves.toEqual({ sent: 0 });
  });
});
