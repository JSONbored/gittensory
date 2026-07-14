import { describe, expect, it } from "vitest";
import { defaultRetryBackoffMs, fetchWithRetry } from "../../packages/loopover-miner/lib/http-retry.js";

const noSleep = () => Promise.resolve();

/** A fetchFn driven by a scripted list of behaviours: a number ⇒ a response with that status, "throw" ⇒ reject. */
function scriptedFetch(script: Array<number | "throw">) {
  let call = 0;
  const calls: unknown[] = [];
  const fn = async (url: unknown) => {
    calls.push(url);
    const step = script[Math.min(call, script.length - 1)] ?? 200;
    call += 1;
    if (step === "throw") throw new Error("network down");
    return { status: step };
  };
  return { fn, get calls() { return calls; } };
}

describe("fetchWithRetry (#4829)", () => {
  it("returns a 2xx response on the first attempt with no retry", async () => {
    const f = scriptedFetch([200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { sleepFn: noSleep });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(1);
  });

  it("returns a 4xx immediately without retrying (client errors are not transient)", async () => {
    const f = scriptedFetch([404, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { sleepFn: noSleep });
    expect(res.status).toBe(404);
    expect(f.calls).toHaveLength(1);
  });

  it("retries a transient 5xx and returns the eventual success", async () => {
    const f = scriptedFetch([503, 500, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 5, sleepFn: noSleep });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(3);
  });

  it("does NOT retry a thrown network error — it propagates immediately (poller #4281 contract)", async () => {
    const f = scriptedFetch(["throw", 200]);
    await expect(fetchWithRetry(f.fn, "u", undefined, { sleepFn: noSleep })).rejects.toThrow("network down");
    expect(f.calls).toHaveLength(1); // no retry on a thrown error
  });

  it("returns the last 5xx response once attempts are exhausted (caller handles it)", async () => {
    const f = scriptedFetch([500]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 3, sleepFn: noSleep });
    expect(res.status).toBe(500);
    expect(f.calls).toHaveLength(3);
  });

  it("makes exactly one attempt when maxAttempts is 1 (returns the 5xx, no retry)", async () => {
    const f = scriptedFetch([500, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 1, sleepFn: noSleep });
    expect(res.status).toBe(500);
    expect(f.calls).toHaveLength(1);
  });

  it("uses the built-in sleep + backoff when none are injected (0ms backoff keeps the test fast)", async () => {
    // No sleepFn and no backoffMs ⇒ exercises the default sleep (real setTimeout) with a 0ms delay, via a 5xx retry.
    const f = scriptedFetch([500, 200]);
    const res = await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 2, backoffMs: () => 0 });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(2);
  });

  it("sleeps the backoff between attempts and floors a bad maxAttempts to the default", async () => {
    const delays: number[] = [];
    const sleepFn = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const f = scriptedFetch([500]); // always 5xx ⇒ retries until the (default 3) attempts are used up
    // maxAttempts "0.5" floors to 0 ⇒ below 1 ⇒ falls back to the default of 3, so 2 sleeps happen.
    await fetchWithRetry(f.fn, "u", undefined, { maxAttempts: 0.5 as unknown as number, sleepFn, backoffMs: (a) => a * 10 });
    expect(f.calls).toHaveLength(3);
    expect(delays).toEqual([10, 20]);
  });
});

describe("defaultRetryBackoffMs (#4829)", () => {
  it("grows exponentially from the base and caps", () => {
    expect(defaultRetryBackoffMs(1)).toBe(500);
    expect(defaultRetryBackoffMs(2)).toBe(1000);
    expect(defaultRetryBackoffMs(3)).toBe(2000);
    expect(defaultRetryBackoffMs(100)).toBe(10_000); // capped
    expect(defaultRetryBackoffMs(0)).toBe(500); // attempt clamped to >= 1
  });
});
