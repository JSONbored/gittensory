import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.REES_SHARED_SECRET = "topsecret";

const { incr } = await import("../dist/metrics.js");
const { app } = await import("../dist/server.js");

after(() => {
  delete process.env.REES_SHARED_SECRET;
});

test("/metrics rejects unauthenticated scrapes when the shared secret is configured", async () => {
  const response = await app.request("/metrics");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("/metrics returns Prometheus text to callers with the shared bearer secret", async () => {
  incr("rees_enrich_requests_total", { status: "ok" });

  const response = await app.request("/metrics", {
    headers: { authorization: "Bearer topsecret" },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(await response.text(), /# HELP rees_enrich_requests_total/);
});
