// Self-host Node entry (#980). Runs gittensory's SAME Worker handlers on Node: builds an `Env` where the
// Cloudflare bindings are self-host adapters (D1→node:sqlite, Queue→in-process), serves the Hono app via
// @hono/node-server, drives the in-process queue with the same processJob, and ticks the same scheduled
// handler on a timer. The Cloudflare Worker (src/index.ts) is untouched — this is a parallel entry the
// self-host esbuild build bundles (aliasing `cloudflare:workers` to the shim).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import worker from "./index";
import { processJob } from "./queue/processors";
import { createD1Adapter, nodeSqliteDriver } from "./selfhost/d1-adapter";
import { runSelfHostMigrations } from "./selfhost/migrate";
import { createInProcessQueue } from "./selfhost/queue";
import type { JobMessage } from "./types";

/** Resolve `<NAME>_FILE` env vars (Docker secrets / multi-line keys) into `<NAME>` at startup. */
function loadFileSecrets(): void {
  for (const key of Object.keys(process.env)) {
    if (!key.endsWith("_FILE") || !process.env[key]) continue;
    const target = key.slice(0, -"_FILE".length);
    if (process.env[target]) continue; // an explicit value wins
    try {
      process.env[target] = readFileSync(process.env[key] as string, "utf8").trim();
    } catch {
      console.error(JSON.stringify({ level: "error", event: "selfhost_secret_file_unreadable", var: key }));
    }
  }
}

async function main(): Promise<void> {
  loadFileSecrets();

  const sqlite = new DatabaseSync(process.env.DATABASE_PATH ?? "/data/gittensory.sqlite");
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const db = createD1Adapter(nodeSqliteDriver(sqlite as never));
  const applied = await runSelfHostMigrations(db, process.env.MIGRATIONS_DIR ?? "migrations");
  console.log(JSON.stringify({ event: "selfhost_migrations_applied", count: applied }));

  // The queue consumer captures `env`, assigned just below — the first send only happens once an HTTP/cron
  // event arrives, by which point env is set.
  let env: Env;
  const queue = createInProcessQueue(async (message: JobMessage) => {
    await processJob(env, message);
  });
  env = { ...process.env, DB: db, JOBS: queue.binding, AI: undefined } as unknown as Env;

  const ctx = {
    waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => undefined),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const port = Number(process.env.PORT ?? 8787);
  serve(
    {
      fetch: (request: Request) => {
        // A binding-free liveness probe (the Hono app also exempts /health from auth + rate-limit).
        if (new URL(request.url).pathname === "/health") {
          return new Response(JSON.stringify({ status: "ok" }), { headers: { "content-type": "application/json" } });
        }
        return worker.fetch(request, env, ctx);
      },
      port,
    },
    () => console.log(JSON.stringify({ event: "selfhost_listening", port })),
  );

  // Cron — gittensory ticks ~every 2 minutes; drive the SAME scheduled handler.
  const intervalMs = Number(process.env.CRON_INTERVAL_MS ?? 120_000);
  setInterval(() => {
    const controller = { scheduledTime: Date.now(), cron: "*/2 * * * *", noRetry: () => undefined } as unknown as ScheduledController;
    Promise.resolve(worker.scheduled(controller, env, ctx)).catch((error) =>
      console.error(JSON.stringify({ level: "error", event: "selfhost_cron_error", error: error instanceof Error ? error.message : "unknown error" })),
    );
  }, intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
