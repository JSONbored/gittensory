import { readFileSync } from "node:fs";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { counterValue, gauge, incr, renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import {
  createRedisResponseCache,
  hitRatio,
  REDIS_GITHUB_RESPONSE_CACHE_HIT_RATIO_METRIC,
  REDIS_GITHUB_RESPONSE_CACHE_METRIC,
  redisResponseCacheHitRatio,
} from "../../src/selfhost/redis-response-cache";

function fakeRedis(): {
  redis: Redis;
  store: Map<string, string>;
  ttl: () => number;
} {
  const store = new Map<string, string>();
  let lastTtl = -1;
  const redis = {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string, _ex: "EX", ttl: number) {
      store.set(k, v);
      lastTtl = ttl;
      return "OK";
    },
  } as unknown as Redis;
  return { redis, store, ttl: () => lastTtl };
}

const URL_A = "https://api.github.com/repos/o/r/pulls/1";

afterEach(() => resetMetrics());

describe("Redis response-cache hit-ratio metrics (#2090)", () => {
  it("computes mixed, all-hit, all-miss, and zero-sample ratios", () => {
    expect(hitRatio(3, 1)).toBe(0.75);
    expect(hitRatio(4, 0)).toBe(1);
    expect(hitRatio(0, 5)).toBe(0);
    expect(hitRatio(0, 0)).toBe(0);
  });

  it("samples zero when the hit and miss counters are absent", () => {
    expect(redisResponseCacheHitRatio(counterValue)).toBe(0);
  });

  it("renders the hit-ratio gauge from the current hit and miss counters", async () => {
    incr(REDIS_GITHUB_RESPONSE_CACHE_METRIC, { result: "hit" }, 3);
    incr(REDIS_GITHUB_RESPONSE_CACHE_METRIC, { result: "miss" }, 1);
    gauge(REDIS_GITHUB_RESPONSE_CACHE_HIT_RATIO_METRIC, () => redisResponseCacheHitRatio(counterValue));

    expect(await renderMetrics()).toContain(
      "# HELP gittensory_redis_gh_response_cache_hit_ratio Current in-process hit ratio for the Redis-backed GitHub response cache.\n# TYPE gittensory_redis_gh_response_cache_hit_ratio gauge\ngittensory_redis_gh_response_cache_hit_ratio 0.75",
    );
  });

  it("wires the hit-ratio gauge into the self-host server scrape", () => {
    const server = readFileSync("src/server.ts", "utf8");

    expect(server).toContain(
      "gauge(REDIS_GITHUB_RESPONSE_CACHE_HIT_RATIO_METRIC, () => redisResponseCacheHitRatio(counterValue));",
    );
  });
});

describe("createRedisResponseCache (#perf GitHub GET cache)", () => {
  it("get returns null for a missing url", async () => {
    expect(
      await createRedisResponseCache(fakeRedis().redis).get(URL_A),
    ).toBeNull();
    expect(await renderMetrics()).toContain(
      'gittensory_redis_gh_response_cache_total{result="miss"} 1',
    );
  });

  it("set then get round-trips status/body/content-type at the caller-supplied TTL", async () => {
    const f = fakeRedis();
    const cache = createRedisResponseCache(f.redis);
    await cache.set(
      URL_A,
      {
        status: 200,
        body: '{"x":1}',
        contentType: "application/json",
        link: '<https://api.github.com/repos/o/r/pulls?page=2>; rel="next"',
        etag: '"abc123"',
        lastModified: "Mon, 29 Jun 2026 20:00:00 GMT",
      },
      30,
    );
    expect(f.ttl()).toBe(30);
    expect(await cache.get(URL_A)).toEqual({
      status: 200,
      body: '{"x":1}',
      contentType: "application/json",
      link: '<https://api.github.com/repos/o/r/pulls?page=2>; rel="next"',
      etag: '"abc123"',
      lastModified: "Mon, 29 Jun 2026 20:00:00 GMT",
    });
    const metrics = await renderMetrics();
    expect(metrics).toContain(
      'gittensory_redis_gh_response_cache_total{result="set"} 1',
    );
    expect(metrics).toContain(
      'gittensory_redis_gh_response_cache_total{result="hit"} 1',
    );
  });

  it("replays cached branch-protection permission denials and missing resources", async () => {
    const f = fakeRedis();
    const cache = createRedisResponseCache(f.redis);
    const forbidden = {
      status: 403,
      body: '{"message":"Resource not accessible by integration"}',
      contentType: "application/json",
    };
    const missing = {
      status: 404,
      body: '{"message":"Branch not found"}',
      contentType: "application/json",
      link: '<https://api.github.com/repos/o/r/branches/dev/protection/required_status_checks?page=2>; rel="next"',
      etag: '"abc123"',
      lastModified: "Tue, 30 Jun 2026 20:00:00 GMT",
    };

    await cache.set("branch-protection-denied", forbidden, 3600);
    await cache.set("branch-protection-missing", missing, 3600);

    expect(await cache.get("branch-protection-denied")).toEqual(forbidden);
    expect(await cache.get("branch-protection-missing")).toEqual(missing);
  });

  it("uses the caller-supplied per-entry TTL from the shared GitHub client", async () => {
    const f = fakeRedis();
    await createRedisResponseCache(f.redis).set(
      URL_A,
      {
        status: 200,
        body: "{}",
        contentType: "application/json",
      },
      600,
    );
    expect(f.ttl()).toBe(600);
  });

  it("floors the TTL at 1s", async () => {
    const f = fakeRedis();
    await createRedisResponseCache(f.redis).set(
      URL_A,
      {
        status: 200,
        body: "{}",
        contentType: "application/json",
      },
      0,
    );
    expect(f.ttl()).toBe(1);
  });

  it("get returns null on malformed JSON", async () => {
    const f = fakeRedis();
    f.store.set("gh:resp:" + URL_A, "{nope");
    expect(await createRedisResponseCache(f.redis).get(URL_A)).toBeNull();
    expect(await renderMetrics()).toContain(
      'gittensory_redis_gh_response_cache_total{result="miss"} 1',
    );
  });

  it("get returns null when the stored shape is wrong", async () => {
    const f = fakeRedis();
    f.store.set("gh:resp:" + URL_A, JSON.stringify({ status: "200", body: 1 }));
    expect(await createRedisResponseCache(f.redis).get(URL_A)).toBeNull();
    expect(await renderMetrics()).toContain(
      'gittensory_redis_gh_response_cache_total{result="miss"} 1',
    );
  });

  it("get returns null for non-replayable cached responses", async () => {
    const f = fakeRedis();
    f.store.set(
      "gh:resp:" + URL_A,
      JSON.stringify({
        status: 500,
        body: "temporary failure",
        contentType: "text/plain",
      }),
    );
    expect(await createRedisResponseCache(f.redis).get(URL_A)).toBeNull();
  });

  it("get returns null for malformed replayable status values", async () => {
    const f = fakeRedis();
    const cache = createRedisResponseCache(f.redis);

    f.store.set(
      "gh:resp:string-status",
      JSON.stringify({
        status: "403",
        body: "{}",
        contentType: "application/json",
      }),
    );
    f.store.set(
      "gh:resp:too-low-status",
      JSON.stringify({
        status: 99,
        body: "{}",
        contentType: "application/json",
      }),
    );
    f.store.set(
      "gh:resp:too-high-status",
      JSON.stringify({
        status: 600,
        body: "{}",
        contentType: "application/json",
      }),
    );

    expect(await cache.get("string-status")).toBeNull();
    expect(await cache.get("too-low-status")).toBeNull();
    expect(await cache.get("too-high-status")).toBeNull();
  });

  it("ignores malformed optional replay headers while keeping the valid cached response", async () => {
    const f = fakeRedis();
    f.store.set(
      "gh:resp:" + URL_A,
      JSON.stringify({
        status: 200,
        body: "{}",
        contentType: "application/json",
        link: 42,
        etag: null,
        lastModified: {},
      }),
    );
    expect(await createRedisResponseCache(f.redis).get(URL_A)).toEqual({
      status: 200,
      body: "{}",
      contentType: "application/json",
    });
    expect(await renderMetrics()).toContain(
      'gittensory_redis_gh_response_cache_total{result="hit"} 1',
    );
  });

  it("records and rethrows Redis read errors", async () => {
    const redis = {
      async get() {
        throw new Error("redis read failed");
      },
    } as unknown as Redis;

    await expect(createRedisResponseCache(redis).get(URL_A)).rejects.toThrow(
      "redis read failed",
    );
    expect(await renderMetrics()).toContain(
      'gittensory_redis_gh_response_cache_total{result="error"} 1',
    );
  });

  it("records and rethrows Redis write errors", async () => {
    const redis = {
      async set() {
        throw new Error("redis write failed");
      },
    } as unknown as Redis;

    await expect(
      createRedisResponseCache(redis).set(
        URL_A,
        {
          status: 200,
          body: "{}",
          contentType: "application/json",
        },
        20,
      ),
    ).rejects.toThrow("redis write failed");
    expect(await renderMetrics()).toContain(
      'gittensory_redis_gh_response_cache_total{result="error"} 1',
    );
  });
});
