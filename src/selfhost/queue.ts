// Self-host in-process job queue (#980). Replaces the Cloudflare Queue (env.JOBS) on a single container: a
// `Queue`-shaped binding whose send() enqueues a JobMessage (honoring delaySeconds), and an async worker that
// drains FIFO and invokes the same processJob the Worker's queue() handler uses. Failures retry up to
// maxRetries then drop (logged), mirroring the Queues DLQ at small scale. (A Redis/BullMQ backend is a
// follow-up for multi-replica; the cron sweep is the backstop either way.)
import type { JobMessage } from "../types";

export interface SelfHostQueue {
  /** The env.JOBS binding (send / sendBatch). */
  binding: Queue;
  /** Resolve when the queue is empty (tests / graceful shutdown). */
  drain(): Promise<void>;
  size(): number;
}

export function createInProcessQueue(consume: (message: JobMessage) => Promise<void>, opts: { maxRetries?: number } = {}): SelfHostQueue {
  const maxRetries = opts.maxRetries ?? 3;
  const queue: Array<{ message: JobMessage; attempts: number }> = [];
  let working = false;

  async function pump(): Promise<void> {
    if (working) return;
    working = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        try {
          await consume(item.message);
        } catch (error) {
          if (item.attempts + 1 < maxRetries) queue.push({ message: item.message, attempts: item.attempts + 1 });
          else console.error(JSON.stringify({ level: "error", event: "inproc_job_dropped", attempts: item.attempts + 1, error: error instanceof Error ? error.message : "unknown error" }));
        }
      }
    } finally {
      working = false;
    }
  }

  const send = (message: JobMessage, options?: { delaySeconds?: number }): Promise<void> => {
    const delayMs = (options?.delaySeconds ?? 0) * 1000;
    if (delayMs > 0) {
      setTimeout(() => {
        queue.push({ message, attempts: 0 });
        void pump();
      }, delayMs);
    } else {
      queue.push({ message, attempts: 0 });
      void pump();
    }
    return Promise.resolve();
  };

  const binding = {
    send,
    sendBatch: async (messages: Iterable<{ body: JobMessage }>) => {
      for (const m of messages) await send(m.body);
    },
  } as unknown as Queue;

  return { binding, drain: pump, size: () => queue.length };
}
