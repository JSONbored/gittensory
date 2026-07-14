import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event as SentryEvent } from "@sentry/react";

const mocks = vi.hoisted(() => {
  const scope = { setTag: vi.fn() };
  return {
    scope,
    init: vi.fn(),
    withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
    captureException: vi.fn(),
  };
});
vi.mock("@sentry/react", () => ({
  init: mocks.init,
  withScope: mocks.withScope,
  captureException: mocks.captureException,
}));

import {
  captureBrowserError,
  initBrowserSentry,
  isBrowserSentryConfigured,
  resetBrowserSentryForTest,
  scrubBrowserEvent,
} from "./browser-sentry";

beforeEach(() => {
  vi.clearAllMocks();
  resetBrowserSentryForTest();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isBrowserSentryConfigured", () => {
  it("false when VITE_SENTRY_DSN is unset or blank", () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    expect(isBrowserSentryConfigured()).toBe(false);
    vi.stubEnv("VITE_SENTRY_DSN", "   ");
    expect(isBrowserSentryConfigured()).toBe(false);
  });

  it("true when VITE_SENTRY_DSN is set", () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o0.ingest.sentry.io/0");
    expect(isBrowserSentryConfigured()).toBe(true);
  });
});

describe("initBrowserSentry", () => {
  it("is a no-op (never calls Sentry.init) when VITE_SENTRY_DSN is unset", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    initBrowserSentry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("calls Sentry.init with the DSN/release/environment when configured", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_RELEASE", "gittensory-ui@abc123");
    vi.stubEnv("VITE_SENTRY_ENVIRONMENT", "staging");
    initBrowserSentry();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
    const options = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.dsn).toBe("https://key@o0.ingest.sentry.io/0");
    expect(options.release).toBe("gittensory-ui@abc123");
    expect(options.environment).toBe("staging");
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeSendTransaction).toBe("function");
  });

  it("defaults environment to production/development from import.meta.env.PROD when VITE_SENTRY_ENVIRONMENT is unset", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_ENVIRONMENT", "");
    initBrowserSentry();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
    const options = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(["production", "development"]).toContain(options.environment);
  });

  it("#1737: never configures Session Replay or performance tracing -- error tracking only", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o0.ingest.sentry.io/0");
    initBrowserSentry();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
    const options = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.integrations).toBeUndefined();
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.replaysSessionSampleRate).toBeUndefined();
    expect(options.replaysOnErrorSampleRate).toBeUndefined();
  });

  it("beforeSend runs the event through scrubbing + tagging before Sentry would send it", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o0.ingest.sentry.io/0");
    initBrowserSentry();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
    const options = mocks.init.mock.calls[0]![0] as {
      beforeSend: (e: SentryEvent) => SentryEvent | null;
    };
    const result = options.beforeSend({
      user: { id: "1" },
      extra: { token: "shh" },
    } as SentryEvent);
    expect(result?.user).toBeUndefined();
    expect(result?.extra?.token).toBe("[redacted]");
    expect(result?.tags?.app_surface).toBe("operator_ui");
  });
});

describe("captureBrowserError", () => {
  it("is a no-op before Sentry has initialized", () => {
    captureBrowserError(new Error("boom"), { boundary: "test" });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("captures with a boundary tag once initialized", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://key@o0.ingest.sentry.io/0");
    initBrowserSentry();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledTimes(1));
    const error = new Error("boom");
    captureBrowserError(error, { boundary: "tanstack_root_error_component" });
    expect(mocks.scope.setTag).toHaveBeenCalledWith("boundary", "tanstack_root_error_component");
    expect(mocks.captureException).toHaveBeenCalledWith(error);
  });
});

describe("scrubBrowserEvent", () => {
  it("drops user unconditionally -- no PII ever leaves the browser", () => {
    const event = { user: { id: "123", email: "a@b.com" } } as SentryEvent;
    expect(scrubBrowserEvent(event)?.user).toBeUndefined();
  });

  it("strips cookies, headers, and body data from request", () => {
    const event = {
      request: {
        url: "https://x",
        cookies: { session: "abc" },
        headers: { Authorization: "Bearer x" },
        data: { password: "hunter2" },
      },
    } as SentryEvent;
    const scrubbed = scrubBrowserEvent(event);
    expect(scrubbed?.request).toEqual({ url: "https://x" });
  });

  it("redacts secret-shaped keys in contexts/extra/tags, including nested", () => {
    const event = { extra: { apiToken: "shh", nested: { authorization: "shh2" } } } as SentryEvent;
    const scrubbed = scrubBrowserEvent(event);
    expect((scrubbed?.extra as Record<string, unknown>)?.apiToken).toBe("[redacted]");
    const nested = (scrubbed?.extra as Record<string, unknown>)?.nested as Record<string, unknown>;
    expect(nested?.authorization).toBe("[redacted]");
  });

  it("redacts a secret-shaped VALUE even under an innocuous key", () => {
    const event = { message: "call failed with token gts_abcdefghijklmnopqrstuvwx" } as SentryEvent;
    expect(scrubBrowserEvent(event)?.message).not.toContain("gts_abcdefghijklmnopqrstuvwx");
  });

  it("redacts a JWT-shaped value", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const event = { message: `auth failed: ${jwt}` } as SentryEvent;
    expect(scrubBrowserEvent(event)?.message).not.toContain(jwt);
  });

  it("redacts a local filesystem path (a dev-mode stack trace concern, not just secrets)", () => {
    const event = {
      message: "failed to load /Users/dev/secret-project/config.json",
    } as SentryEvent;
    expect(scrubBrowserEvent(event)?.message).not.toContain("/Users/dev/secret-project");
  });

  it("caps recursion depth instead of infinitely descending a deeply nested value", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 10; i += 1) deep = { child: deep };
    const event = { extra: { deep } } as unknown as SentryEvent;
    const scrubbed = scrubBrowserEvent(event);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain("leaf");
    expect(serialized).toContain("[redacted]");
  });

  it("fails closed: returns null instead of throwing when scrubbing itself errors", () => {
    const poison = {};
    Object.defineProperty(poison, "user", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(scrubBrowserEvent(poison as SentryEvent)).toBeNull();
  });

  it("preserves breadcrumbs array shape while scrubbing each entry", () => {
    const event = {
      breadcrumbs: [{ message: "click", data: { password: "x" } }],
    } as unknown as SentryEvent;
    const scrubbed = scrubBrowserEvent(event);
    const crumb = scrubbed?.breadcrumbs?.[0] as { message: string; data: Record<string, unknown> };
    expect(crumb.data.password).toBe("[redacted]");
    expect(crumb.message).toBe("click");
  });
});
