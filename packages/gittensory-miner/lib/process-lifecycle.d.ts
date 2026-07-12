/** Process lifecycle / crash-safety for the miner CLI (#4826). Local stores register on open and the CLI installs
 * signal/error handlers once at startup so an interrupted run closes every open ledger cleanly. */

/** A closable store (`{ close() }`) or a plain cleanup callback. */
export type CleanupResource = { close: () => void } | (() => void);

/** The subset of `process` the handlers use; injectable for tests. */
export type ProcessLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  exit: (code?: number) => void;
};

export type InstallCliSignalHandlersOptions = {
  process?: ProcessLike;
  log?: (message: string) => void;
  exit?: (code: number) => void;
  /** Reinstall even if handlers were already installed (mainly for tests). */
  force?: boolean;
};

/** Register a resource to close on exit; returns an idempotent unregister function. */
export function registerCleanupResource(resource: CleanupResource | null | undefined): () => void;

export function cleanupResourceCount(): number;

export function closeAllCleanupResources(options?: { onError?: (error: unknown) => void }): void;

/** Install signal + error handlers once. Returns false if already installed (and `force` was not set). */
export function installCliSignalHandlers(options?: InstallCliSignalHandlersOptions): boolean;

export function resetProcessLifecycleForTesting(): void;
