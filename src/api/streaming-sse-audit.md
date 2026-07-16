# Streaming / SSE inventory for the API layer

> Research/audit deliverable for #6303, groundwork for the chat-interface spec (#6230, alongside the
> UI-primitives inventory #6244). **Audit and documentation only — no code changed.** Whoever
> eventually implements incremental streaming of a chat agent's response (once #6230's scope lands)
> should start here.

## Scope & method

Audited `src/api/routes.ts` and swept the rest of the tree (`src/**`, `packages/*/src/**`,
`apps/*/src/**`) for every response-streaming primitive — `ReadableStream` / `TransformStream`
responses, `text/event-stream` (SSE), `EventSource`, `WebSocketPair`, Durable Objects, and Hono's
`hono/streaming` helpers (`streamSSE` / `streamText`) — plus the Cloudflare Workers deployment
config (`wrangler.jsonc`) and the self-host Node runtime (`src/server.ts`, `src/selfhost/`). Each
finding carries a `file:line` reference.

## Bottom line

**There is no existing outgoing-streaming or SSE response infrastructure to reuse.** Every API
handler builds a complete response and returns it whole (`c.json(...)`), and no route returns a
`ReadableStream`/`TransformStream` body, sets `text/event-stream`, or opens a WebSocket. A chat
streaming surface would be built from scratch. The platform *primitives* it needs (Hono streaming
helpers, and a provisioned Durable Object namespace) are present but unused for this purpose, and the
self-host runtime imposes a real dual-implementation constraint (below).

## What exists today

### Framework & response model
- The API is a **Hono** app (`src/api/routes.ts:1`, `hono` `^4.12.27` in `package.json`). Handlers
  register with `app.get(...)` and return whole responses via `c.json(...)` throughout. Hono ships
  `hono/streaming` (`streamSSE`, `streamText`) but **no file in the repo imports it** — confirmed by
  a tree-wide grep.

### The one stream in the API is *incoming*, not reusable for SSE
- `readRequestBodyWithLimit` (`src/api/routes.ts:399-421`) reads `request.body` as a `ReadableStream`
  purely to **buffer an inbound request body into a string** under a byte cap. It is request-side
  ingestion, not a streamed response, and does not generalize to server-sent output.

### Durable Objects: capability is wired, but only for rate limiting
- One Durable Object exists: `RateLimiter` (`src/auth/rate-limit.ts:27`, `extends DurableObject`),
  bound as `RATE_LIMITER` in `wrangler.jsonc:272-278` with migration tag `v1-rate-limiter`
  (`wrangler.jsonc:280-285`). This proves the DO capability is provisioned and deployable in this
  Worker — the same primitive the sibling repo's `resources/subscribe` SSE pattern relies on for
  single-point coordination — **but it does no streaming**; it only gates request rates.
- `wrangler.jsonc:268-271` already carries a TODO for a *second* DO (`SubmissionLock` per-PR mutex),
  showing the "add a DO class + its own `migrations` tag + a `durable_objects` binding" path is a
  known, planned pattern in this repo — the closest procedural precedent for adding a streaming DO.

### WebSockets: none server-side
- No `WebSocketPair` / `.accept()` / hibernation anywhere. The only `ws:`/`wss:` references are URL
  *validation* (`src/review/content-lane/safe-url.ts:106`) and the self-host puppeteer stub's
  browser sidecar (`src/selfhost/stubs/puppeteer.ts`) — neither is a WebSocket server endpoint.

### `text/event-stream` appears only as a *validator*, not a producer
- `src/review/content-lane/registry-logic.ts:643-645` checks whether a *third-party repo's* claimed
  `sse` endpoint actually serves `text/event-stream`. This audits **other** repos' SSE claims; the
  loopover API never emits that content type itself.

### `ReadableStream` elsewhere is storage I/O, not HTTP
- `src/selfhost/blob-store.ts:32` and `src/selfhost/s3-blob-store.ts:71` accept `ReadableStream` as a
  `put()` value type for R2 / S3 blob writes — storage-layer plumbing, unrelated to streaming an
  HTTP response to a client.

### The AI provider layer buffers, so there is no upstream token stream to forward
- The LLM-routing infra the chat surface would sit on (`src/selfhost/ai.ts`) calls providers with
  `await res.json()` for OpenAI-compatible `/chat/completions` (`:333`, `:346`), Anthropic
  `/v1/messages` (`:387`, `:394`), and embeddings (`:301`, `:320`). None pass `stream: true` or parse
  a provider SSE stream — completions are fetched whole. So even the *source* of tokens is
  non-streaming today; incremental chat output requires adding streaming to this layer too, not just
  the response path.

## What would need to be built from scratch

1. **A streaming response path.** A new endpoint returning a `ReadableStream`/`TransformStream` body
   (or using Hono's `streamSSE`) with `Content-Type: text/event-stream`. No such handler exists.
2. **Streaming provider calls.** Add `stream: true` + SSE parsing to `src/selfhost/ai.ts`'s provider
   fetches so tokens can be forwarded as they arrive instead of after `res.json()` resolves.
3. **(If multiplexed/subscribable, per the `resources/subscribe` precedent) a streaming Durable
   Object.** Following the `RateLimiter` shape and the `wrangler.jsonc:268-271` `SubmissionLock`
   playbook: a new DO class + `new_sqlite_classes` migration tag + a `durable_objects` binding, ideally
   with WebSocket Hibernation to avoid holding the DO resident (and billed) while idle between tokens.
   For a simple per-request response stream (one client, no fan-out), a plain streamed `Response` from
   the Worker is sufficient and a DO is **not** required.

## Cloudflare Workers-specific constraints (this repo's deploy model)

The API deploys as a Cloudflare Worker (`wrangler.jsonc:5-13`: `main: src/index.ts`, `compatibility_date`
`2026-05-28`, `nodejs_compat`, `placement.mode: "smart"`) **and** self-hosts as a Node process serving
the *same* Hono app (`src/server.ts:13,866`, `@hono/node-server`). Streaming has to work — or degrade
sanely — on both.

- **Workers can hold a long-lived streamed response.** A Worker may return a `ReadableStream` body and
  keep it open while tokens are produced. The relevant limit is **CPU time**, which counts compute, not
  wall-clock spent awaiting I/O — an SSE stream mostly idle-waiting on an upstream LLM burns little CPU.
  A DO-backed design is what enables coordination/fan-out; a single-client stream does not need one.
- **Workers are stateless per request.** There is no in-process pub/sub across requests. Any
  subscribe/broadcast (multiple viewers of one run, resumable streams) must be centralized in a Durable
  Object — the same reason the sibling repo used a DO for `resources/subscribe`. This repo already
  proves DOs deploy here (`RateLimiter`) but has never used one for streaming.
- **Self-host is the binding constraint.** On self-host the Worker runtime is absent: `cloudflare:workers`
  is aliased to a stub whose `DurableObject` base class does nothing, and the `RateLimiter` DO is
  **never instantiated** (`src/selfhost/cf-workers-shim.ts:1-6`; `env.RATE_LIMITER` is `undefined`). So a
  **DO-based streaming design would not run self-hosted** — self-host would need a parallel path (native
  Node SSE over `@hono/node-server`, which has no Workers CPU limit but also no DO coordination). A
  chat-streaming design that must serve both deployments should prefer a **plain streamed `Response`**
  (works identically on Workers and Node) and treat any DO-coordinated multiplexing as a
  Workers-hosted-only enhancement with an explicit self-host fallback.

## Reuse / build summary

| Need | Status | Reference |
| --- | --- | --- |
| Hono streaming helpers (`streamSSE`/`streamText`) | available, unused | `hono` `^4.12.27`; no importer in-tree |
| An SSE / streamed-response endpoint | **build from scratch** | none in `src/api/routes.ts` |
| Streaming from the LLM provider | **build from scratch** (buffers today) | `src/selfhost/ai.ts:333,346,387,394` |
| Durable Object capability (for fan-out/subscribe) | provisioned, rate-limit-only | `src/auth/rate-limit.ts:27`; `wrangler.jsonc:272-285` |
| DO-add procedure (class + migration + binding) | documented precedent | `wrangler.jsonc:268-271` (`SubmissionLock` TODO) |
| WebSocket server endpoint | none | — |
| Self-host parity for a DO-based stream | **not available** (DO stubbed) | `src/selfhost/cf-workers-shim.ts:1-6` |
