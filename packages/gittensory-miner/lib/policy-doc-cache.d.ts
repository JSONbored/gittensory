export type PolicyDocCacheEntry = {
  etag: string;
  content: string;
};

export type PolicyDocCacheWrite = {
  url: string;
  etag: string;
  content: string;
  updatedAt: string;
};

export type PolicyDocCacheStore = {
  dbPath: string;
  get(url: string): PolicyDocCacheEntry | null;
  put(url: string, etag: string, content: string): PolicyDocCacheWrite;
  close(): void;
};

/** The read/write surface opportunity-fanout.js needs to inject a cache without depending on the SQLite store. */
export type PolicyDocCache = Pick<PolicyDocCacheStore, "get" | "put">;

export function resolvePolicyDocCacheDbPath(env?: Record<string, string | undefined>): string;

export function initPolicyDocCacheStore(dbPath?: string): PolicyDocCacheStore;
