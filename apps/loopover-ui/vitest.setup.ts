import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { patchJsdomLocalStorageForNode26 } from "../../test/helpers/vitest-jsdom-node26-localstorage";

// Unmount React trees between tests so jsdom state never leaks across cases.
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver -- recharts' ResponsiveContainer (used by any chart/sparkline) needs one to
// mount at all. A no-op stub is the standard fix: it never actually resizes in a test DOM, and no test here
// asserts on a resize-driven re-render, only on the rendered markup.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// See vitest-jsdom-node26-localstorage.ts's own header: Node 26's broken globalThis.localStorage
// accessor shadows jsdom's real Storage before Vitest can install it. Exercised directly by
// use-local-storage.test.ts, plus routes/index, api/try-it, app-panels/onboarding-preview-card, and
// lib/analytics-window.
patchJsdomLocalStorageForNode26();
