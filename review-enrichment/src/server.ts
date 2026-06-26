// Gittensory review-enrichment service (REES) — #1473 scaffold.
//
// Given a PR (repo, number, headSha, diff, files, short-lived token), this service runs the heavy/external/
// historical analysis the no-checkout `claude --print` reviewer is blind to, and returns a pre-rendered,
// public-safe "review brief" the engine splices into the prompt next to grounding + RAG. The engine treats any
// timeout/error as "no brief" and proceeds — so this service is strictly additive and fully fail-safe.
//
// THIS scaffold ships the contract + transport only: /health, /ready, and an authenticated /v1/enrich that
// returns an empty (non-partial) brief. The analyzers — dependency/CVE (#1474), license (#1475), secret (#1476),
// static+complexity (#1477), history (#1478) — land behind this stable contract, each filling one `findings` key.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { verifyBearer } from "./auth.js";

/** Engine → service request. The engine already has the diff + files, so the service needs NO repo checkout. */
export interface EnrichRequest {
  repoFullName: string;
  prNumber: number;
  headSha?: string;
  baseSha?: string;
  title?: string;
  body?: string;
  author?: string;
  files?: Array<{
    path: string;
    status?: string;
    patch?: string;
    additions?: number;
    deletions?: number;
  }>;
  diff?: string;
  /** Short-lived broker token for OSV/license/history fetches. Never logged. */
  githubToken?: string;
  budget?: { timeoutMs?: number; maxBriefChars?: number };
  analyzers?: string[];
}

/** Service → engine response. `promptSection` is spliced verbatim; `findings` is the structured backing data. */
export interface ReviewBrief {
  schemaVersion: 1;
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
  generatedAtIso: string;
  elapsedMs: number;
  partial: boolean;
  analyzerStatus: Record<string, "ok" | "degraded" | "skipped">;
  findings: Record<string, unknown>;
  promptSection: string;
  systemSuffix: string;
}

const app = new Hono();

app.get("/health", (c) =>
  c.json({ status: "ok", service: "review-enrichment" }),
);
app.get("/ready", (c) => c.json({ ready: true }));

app.post("/v1/enrich", async (c) => {
  const start = Date.now();
  const secret = process.env.REES_SHARED_SECRET;
  // No secret configured ⇒ the service is not ready to authenticate anything; fail closed.
  if (!secret) return c.json({ error: "service_not_configured" }, 503);
  if (!verifyBearer(c.req.header("authorization"), secret))
    return c.json({ error: "unauthorized" }, 401);

  const payload = (await c.req
    .json()
    .catch(() => null)) as EnrichRequest | null;
  if (
    !payload ||
    typeof payload.repoFullName !== "string" ||
    typeof payload.prNumber !== "number"
  ) {
    return c.json({ error: "bad_request" }, 400);
  }

  // Scaffold: no analyzers wired yet (#1474-#1478). Return an empty, non-partial brief so the engine seam
  // (#1472) can integrate and smoke-test end-to-end. As analyzers land they populate `findings`/`analyzerStatus`
  // and render into `promptSection`.
  const brief: ReviewBrief = {
    schemaVersion: 1,
    repoFullName: payload.repoFullName,
    prNumber: payload.prNumber,
    headSha: payload.headSha ?? null,
    generatedAtIso: new Date().toISOString(),
    elapsedMs: Date.now() - start,
    partial: false,
    analyzerStatus: {},
    findings: {},
    promptSection: "",
    systemSuffix: "",
  };
  return c.json(brief);
});

const port = Number(process.env.PORT ?? "8080");
serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ event: "rees_listening", port: info.port }));
});

export { app };
