import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount React trees between tests so jsdom state never leaks across cases (mirrors
// apps/loopover-miner-ui/vitest.setup.ts's own cleanup).
afterEach(() => {
  cleanup();
});

// Node 26 predefines its own experimental `globalThis.localStorage` accessor (nodejs/node#60303) that
// returns undefined unless the process was started with --localstorage-file. Because that property already
// *exists* on globalThis before jsdom's env is installed, Vitest's populateGlobal skips copying jsdom's
// working Storage over it, so any bare `localStorage.*` call would throw "Cannot read properties of
// undefined" on Node 26+ -- no component here calls it today, but this package is a shared UI kit other
// workspaces build on, so the guard is preventive rather than a fix for a currently-red test. jsdom's real
// Storage still lives on the raw JSDOM window (globalThis.jsdom.window, a distinct object from the
// `window`/globalThis alias); point the global at it unconditionally -- a no-op on Node 22/24 where
// globalThis.localStorage already *is* this object, and the actual fix on Node 26+. A `??=` guard would not
// help (the broken accessor already counts as "present"); the property is configurable so redefining it is
// safe. Mirrors apps/loopover-miner-ui/vitest.setup.ts's own guard (#7597).
const jsdomLocalStorage = (globalThis as { jsdom?: { window?: { localStorage?: Storage } } }).jsdom?.window
  ?.localStorage;
if (jsdomLocalStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    value: jsdomLocalStorage,
    configurable: true,
    writable: true,
  });
}
