/** Process lifecycle / crash-safety for the miner CLI (#4826). The CLI dispatches through a chain of bare
 * `process.exit()` calls with no cleanup hook, so a SIGINT/SIGTERM mid-run — or an uncaught exception — used to
 * kill the process mid-write, leaving whatever local SQLite ledger it was touching in an undefined state. This
 * module is the single cleanup chokepoint: local stores register themselves when opened (see `local-store.js`), and
 * `installCliSignalHandlers` (called once at CLI startup) flushes/closes every still-open resource before exiting
 * cleanly on a signal, and logs + exits non-zero on an uncaught exception / unhandled rejection instead of crashing
 * silently. Cleanup ONLY — no command business logic lives here. Every dependency (`process`, `log`, `exit`) is
 * injectable so the handlers are unit-testable without actually signalling the test runner. */

// 128 + signal number, the conventional shell exit code for a process terminated by that signal (SIGINT=2 -> 130,
// SIGTERM=15 -> 143).
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/** Resources to close on exit. A resource is either a `{ close() }` object (e.g. an open SQLite store) or a plain
 * cleanup function. Held in insertion order so cleanup is deterministic. */
const cleanupResources = new Set();
let handlersInstalled = false;

/** Render any thrown value as a single log-safe string, preferring an Error's stack. */
function describeError(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  return String(value);
}

/**
 * Register a resource to be closed on clean exit or crash. Returns an idempotent unregister function (call it from
 * the resource's own normal `close()` so a resource closed during the happy path is not double-closed at exit).
 */
export function registerCleanupResource(resource) {
  if (resource === null || resource === undefined) return () => {};
  cleanupResources.add(resource);
  return () => {
    cleanupResources.delete(resource);
  };
}

/** Number of currently-registered cleanup resources (exposed for tests / diagnostics). */
export function cleanupResourceCount() {
  return cleanupResources.size;
}

/**
 * Close every registered resource, swallowing each individual failure (a store that fails to close must not stop
 * the others from closing) and reporting it via `options.onError`. Idempotent: the registry is emptied afterwards.
 */
export function closeAllCleanupResources(options = {}) {
  const onError = typeof options.onError === "function" ? options.onError : null;
  for (const resource of [...cleanupResources]) {
    try {
      if (typeof resource === "function") resource();
      else resource.close();
    } catch (error) {
      if (onError) onError(error);
    }
  }
  cleanupResources.clear();
}

/**
 * Install top-level signal + error handlers once. On SIGINT/SIGTERM: close all resources and exit with the
 * conventional 128+signal code. On uncaughtException/unhandledRejection: log the error, close all resources, and
 * exit non-zero. No-op (returns false) if already installed unless `options.force` is set. All of `process`, `log`,
 * and `exit` are injectable for testing.
 */
export function installCliSignalHandlers(options = {}) {
  const proc = options.process ?? process;
  const log = typeof options.log === "function" ? options.log : (message) => console.error(message);
  const exit = typeof options.exit === "function" ? options.exit : (code) => proc.exit(code);

  if (handlersInstalled && options.force !== true) return false;
  handlersInstalled = true;

  const runCleanup = () => {
    closeAllCleanupResources({
      onError: (error) => log(`gittensory-miner: cleanup error while exiting: ${describeError(error)}`),
    });
  };

  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    proc.on(signal, () => {
      log(`gittensory-miner: received ${signal}, closing open resources and exiting.`);
      runCleanup();
      exit(code);
    });
  }

  proc.on("uncaughtException", (error) => {
    log(`gittensory-miner: uncaught exception: ${describeError(error)}`);
    runCleanup();
    exit(1);
  });

  proc.on("unhandledRejection", (reason) => {
    log(`gittensory-miner: unhandled promise rejection: ${describeError(reason)}`);
    runCleanup();
    exit(1);
  });

  return true;
}

/** Test-only: clear the registry and the installed flag so each test starts from a clean lifecycle. */
export function resetProcessLifecycleForTesting() {
  cleanupResources.clear();
  handlersInstalled = false;
}
