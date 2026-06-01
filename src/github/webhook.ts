import type { Context } from "hono";
import { getWebhookEvent, recordWebhookEvent } from "../db/repositories";
import type { GitHubWebhookPayload, JobMessage } from "../types";
import { sha256Hex, verifyGitHubSignature } from "../utils/crypto";

export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024;

export async function handleGitHubWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const deliveryId = c.req.header("x-github-delivery") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;
  const signature = c.req.header("x-hub-signature-256") ?? null;
  if (!deliveryId || !eventName) {
    return c.json({ error: "missing_github_headers" }, 400);
  }

  const contentLength = parseContentLength(c.req.header("content-length") ?? null);
  if (contentLength === "invalid") {
    return c.json({ error: "invalid_content_length" }, 400);
  }
  if (contentLength !== null && contentLength > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
    return c.json({ error: "webhook_body_too_large" }, 413);
  }

  const bodyRead = await readRequestTextWithinLimit(c.req.raw, MAX_GITHUB_WEBHOOK_BODY_BYTES);
  if (!bodyRead.ok) {
    return c.json({ error: "webhook_body_too_large" }, 413);
  }

  const rawBody = bodyRead.text;
  const verified = await verifyGitHubSignature(rawBody, signature, c.env.GITHUB_WEBHOOK_SECRET);
  if (!verified) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const payloadHash = await sha256Hex(rawBody);
  const existingEvent = await getWebhookEvent(c.env, deliveryId);
  if (existingEvent && existingEvent.payloadHash === payloadHash && existingEvent.status !== "error") {
    return c.json({ ok: true, deliveryId, eventName, status: "duplicate" }, 202);
  }

  await recordWebhookEvent(c.env, {
    deliveryId,
    eventName,
    action: payload.action,
    installationId: payload.installation?.id,
    repositoryFullName: payload.repository?.full_name,
    payloadHash,
    status: "queued",
  });

  const message: JobMessage = {
    type: "github-webhook",
    deliveryId,
    eventName,
    payload,
  };
  await c.env.JOBS.send(message);

  return c.json({ ok: true, deliveryId, eventName, status: "queued" }, 202);
}

export async function readRequestTextWithinLimit(
  request: Request,
  maxBytes: number = MAX_GITHUB_WEBHOOK_BODY_BYTES,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { ok: false };
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
}

function parseContentLength(value: string | null): number | "invalid" | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}
