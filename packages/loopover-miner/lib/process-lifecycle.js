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
    if (value instanceof Error)
        return value.stack ?? value.message;
    return String(value);
}
/**
 * Register a resource to be closed on clean exit or crash. Returns an idempotent unregister function (call it from
 * the resource's own normal `close()` so a resource closed during the happy path is not double-closed at exit).
 */
export function registerCleanupResource(resource) {
    if (resource === null || resource === undefined)
        return () => { };
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
            if (typeof resource === "function")
                resource();
            else
                resource.close();
        }
        catch (error) {
            if (onError)
                onError(error);
        }
    }
    cleanupResources.clear();
}
/**
 * Install top-level signal + error handlers once. On SIGINT/SIGTERM: close all resources and exit with the
 * conventional 128+signal code. On uncaughtException/unhandledRejection: log the error, AWAIT the optional
 * captureError hook (so a captured Sentry event has a chance to actually flush before the process exits),
 * close all resources, and exit non-zero. No-op (returns false) if already installed unless `options.force` is
 * set. All of `process`, `log`, `exit`, and `captureError` are injectable for testing.
 */
export function installCliSignalHandlers(options = {}) {
    const proc = options.process ?? process;
    const log = typeof options.log === "function" ? options.log : (message) => console.error(message);
    const exit = typeof options.exit === "function" ? options.exit : (code) => proc.exit(code);
    // Optional Sentry (or any) capture hook -- decoupled from a specific implementation so this module stays
    // fully unit-testable without mocking Sentry (#6011). No-op default matches this module's pre-existing
    // behavior for every caller that doesn't pass one.
    const captureError = typeof options.captureError === "function" ? options.captureError : () => { };
    if (handlersInstalled && options.force !== true)
        return false;
    handlersInstalled = true;
    const runCleanup = () => {
        closeAllCleanupResources({
            onError: (error) => log(`loopover-miner: cleanup error while exiting: ${describeError(error)}`),
        });
    };
    for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
        proc.on(signal, () => {
            log(`loopover-miner: received ${signal}, closing open resources and exiting.`);
            runCleanup();
            exit(code);
        });
    }
    // Awaited (not fire-and-forget): captureError is expected to both capture AND flush before returning (see
    // captureMinerErrorAndFlush in bin/loopover-miner.js) -- Sentry.captureException only QUEUES an event, and
    // process.exit() tears the process down immediately without waiting for any pending HTTP delivery, so a
    // synchronous capture-then-exit would make the crash-capture path a near-total no-op in practice. Node does
    // not require these handlers to be synchronous: nothing exits the process until this handler itself calls
    // `exit()`, so awaiting first is safe. captureError's own default is a synchronous no-op, so `await`-ing it
    // is a harmless no-op for every caller that doesn't pass one.
    proc.on("uncaughtException", async (error) => {
        log(`loopover-miner: uncaught exception: ${describeError(error)}`);
        await captureError(error, { kind: "uncaughtException" });
        runCleanup();
        exit(1);
    });
    proc.on("unhandledRejection", async (reason) => {
        log(`loopover-miner: unhandled promise rejection: ${describeError(reason)}`);
        await captureError(reason, { kind: "unhandledRejection" });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJvY2Vzcy1saWZlY3ljbGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwcm9jZXNzLWxpZmVjeWNsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7OzsrRkFPK0Y7QUF5Qi9GLGtIQUFrSDtBQUNsSCxzQkFBc0I7QUFDdEIsTUFBTSxpQkFBaUIsR0FBMkIsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sRUFBRSxHQUFHLEVBQUUsT0FBTyxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFFL0Y7NEVBQzRFO0FBQzVFLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLEVBQW1CLENBQUM7QUFDcEQsSUFBSSxpQkFBaUIsR0FBRyxLQUFLLENBQUM7QUFFOUIsd0ZBQXdGO0FBQ3hGLFNBQVMsYUFBYSxDQUFDLEtBQWM7SUFDbkMsSUFBSSxLQUFLLFlBQVksS0FBSztRQUFFLE9BQU8sS0FBSyxDQUFDLEtBQUssSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDO0lBQ2hFLE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3ZCLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsdUJBQXVCLENBQUMsUUFBNEM7SUFDbEYsSUFBSSxRQUFRLEtBQUssSUFBSSxJQUFJLFFBQVEsS0FBSyxTQUFTO1FBQUUsT0FBTyxHQUFHLEVBQUUsR0FBRSxDQUFDLENBQUM7SUFDakUsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQy9CLE9BQU8sR0FBRyxFQUFFO1FBQ1YsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ3BDLENBQUMsQ0FBQztBQUNKLENBQUM7QUFFRCwwRkFBMEY7QUFDMUYsTUFBTSxVQUFVLG9CQUFvQjtJQUNsQyxPQUFPLGdCQUFnQixDQUFDLElBQUksQ0FBQztBQUMvQixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLHdCQUF3QixDQUFDLFVBQWtELEVBQUU7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