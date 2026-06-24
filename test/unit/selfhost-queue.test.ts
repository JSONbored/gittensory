import { describe, expect, it } from "vitest";
import { createInProcessQueue } from "../../src/selfhost/queue";
import type { JobMessage } from "../../src/types";

describe("createInProcessQueue (#980 self-host job queue)", () => {
  it("send() enqueues; the worker drains FIFO through the consumer", async () => {
    const seen: JobMessage[] = [];
    const q = createInProcessQueue(async (m) => void seen.push(m));
    await q.binding.send({ type: "a" } as unknown as JobMessage);
    await q.binding.send({ type: "b" } as unknown as JobMessage);
    await q.drain();
    expect(seen).toEqual([{ type: "a" }, { type: "b" }]);
    expect(q.size()).toBe(0);
  });

  it("retries a failing job up to maxRetries, then drops it (never throws)", async () => {
    let calls = 0;
    const q = createInProcessQueue(
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      { maxRetries: 2 },
    );
    await q.binding.send({ type: "x" } as unknown as JobMessage);
    await q.drain();
    expect(calls).toBe(2); // first attempt + one retry, then dropped
    expect(q.size()).toBe(0);
  });
});
