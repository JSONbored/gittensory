import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount React trees between tests so jsdom state never leaks across cases.
afterEach(() => {
  cleanup();
});

// jsdom does not implement window.scrollTo -- @tanstack/react-router calls it on every route
// resolution regardless of the `scrollRestoration` option, which otherwise logs a noisy
// "Not implemented" error to stderr on every test that mounts a RouterProvider.
window.scrollTo = () => {};
