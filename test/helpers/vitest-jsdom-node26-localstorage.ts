/**
 * Node 26 predefines its own experimental `globalThis.localStorage` accessor (nodejs/node#60303) that
 * returns undefined unless the process was started with --localstorage-file. Because that property
 * already *exists* on globalThis before jsdom's environment is installed, Vitest's populateGlobal skips
 * copying jsdom's working Storage over it, so any bare `localStorage.*` call throws "Cannot read
 * properties of undefined" under Node 26 while passing on Node 22/24.
 *
 * Call this once from a jsdom-environment vitest.setup.ts. Points globalThis.localStorage at jsdom's
 * real Storage from the raw JSDOM window unconditionally: a no-op where the global already is that
 * object, the fix on Node 26+. A `??=` guard would not help (the broken accessor already counts as
 * "present"); the property is configurable so redefining it is safe.
 *
 * Shared by apps/loopover-ui, apps/loopover-miner-ui, and packages/loopover-ui-kit's vitest.setup.ts
 * (originally three separate copies of this same guard -- #7597, #7612) so a future jsdom-environment
 * workspace only has to import this rather than rediscover the bug.
 */
export function patchJsdomLocalStorageForNode26(): void {
  const jsdomLocalStorage = (globalThis as { jsdom?: { window?: { localStorage?: Storage } } }).jsdom
    ?.window?.localStorage;
  if (jsdomLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", {
      value: jsdomLocalStorage,
      configurable: true,
      writable: true,
    });
  }
}
