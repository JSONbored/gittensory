import * as React from "react";
import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";
import { initBrowserSentry } from "./lib/browser-sentry";

// A no-op when VITE_SENTRY_DSN is unset (#1737) -- called before hydration so the earliest possible
// client-side errors are still covered once the (dynamically imported) SDK chunk resolves.
initBrowserSentry();

React.startTransition(() => {
  hydrateRoot(
    document,
    React.createElement(React.StrictMode, null, React.createElement(StartClient)),
  );
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
