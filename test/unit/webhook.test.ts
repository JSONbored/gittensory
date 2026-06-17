import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { handleGitHubWebhook } from "../../src/github/webhook";
import { getWebhookEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("github webhook body reader edge cases", () => {
  it("skips undefined stream chunks and still rejects invalid signatures", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(undefined as unknown as Uint8Array);
        controller.close();
      },
    });
    const request = { body } as unknown as Request;
    const env = createTestEnv();
    const headers: Record<string, string> = {
      "x-github-delivery": "stream-edge-case",
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=bad",
    };
    const context = {
      req: {
        raw: request,
        header(name: string) {
          return headers[name.toLowerCase()] ?? null;
        },
      },
      env,
      json(payload: unknown, status?: number) {
        return Response.json(payload, status === undefined ? undefined : { status });
      },
    } as unknown as Context<{ Bindings: Env }>;

    const response = await handleGitHubWebhook(context);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_signature" });
  });
});

describe("github webhook enqueue failure (#786)", () => {
  it("flags the event 'error' and returns 500 when the queue send fails", async () => {
    const env = createTestEnv();
    env.JOBS = {
      send: async () => {
        throw new Error("queue unavailable");
      },
    } as unknown as typeof env.JOBS;
    const rawBody = JSON.stringify({ action: "opened", repository: { full_name: "JSONbored/gittensory" }, installation: { id: 1 } });
    const signature = await signWebhook(rawBody, env.GITHUB_WEBHOOK_SECRET);
    const request = new Request("https://example.com/webhook", { method: "POST", body: rawBody });
    const headers: Record<string, string> = {
      "x-github-delivery": "enqueue-fail-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    };
    const context = {
      req: {
        raw: request,
        header(name: string) {
          return headers[name.toLowerCase()] ?? null;
        },
      },
      env,
      json(payload: unknown, status?: number) {
        return Response.json(payload, status === undefined ? undefined : { status });
      },
    } as unknown as Context<{ Bindings: Env }>;

    const response = await handleGitHubWebhook(context);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "enqueue_failed" });
    // Flagged "error" so the dedup guard lets GitHub redeliver instead of suppressing it.
    const event = await getWebhookEvent(env, "enqueue-fail-1");
    expect(event?.status).toBe("error");
  });
});

async function signWebhook(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
