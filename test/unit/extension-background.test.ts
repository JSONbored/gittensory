import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// background.js statically imports its two handlers from ./auth.js. The vm `Script` runner cannot
// execute a top-level ESM `import`, so we strip that line and inject stubbed handlers as context
// globals -- the free identifiers `requestPullContext`/`logoutExtensionSession` resolve from them.
// This mirrors content.js's `__LOOPOVER_EXTENSION_TEST__` seam while keeping background.js's real
// message-routing and error-to-response mapping (lines 3-8) under test.
const backgroundSource = readFileSync(
  "apps/loopover-extension/background.js",
  "utf8",
).replace(/^import\s*\{[\s\S]*?\}\s*from\s*["']\.\/auth\.js["'];?\n?/, "");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("extension background message router", () => {
  it("resolves loopover:pull-context via requestPullContext and responds { ok: true, payload }", async () => {
    const requestPullContext = vi.fn(async () => ({ panels: [] }));
    const logoutExtensionSession = vi.fn();
    const { listener } = loadBackground({
      requestPullContext,
      logoutExtensionSession,
    });
    const sendResponse = vi.fn();

    const message = {
      type: "loopover:pull-context",
      owner: "JSONbored",
      repo: "loopover",
      pullNumber: 148,
    };
    const returned = listener(message, {}, sendResponse);
    await flush();

    expect(returned).toBe(true);
    expect(requestPullContext).toHaveBeenCalledWith(message);
    expect(logoutExtensionSession).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      payload: { panels: [] },
    });
  });

  it("resolves loopover:logout via logoutExtensionSession and responds { ok: true, payload }", async () => {
    const requestPullContext = vi.fn();
    const logoutExtensionSession = vi.fn(async () => ({ ok: true }));
    const { listener } = loadBackground({
      requestPullContext,
      logoutExtensionSession,
    });
    const sendResponse = vi.fn();

    const returned = listener({ type: "loopover:logout" }, {}, sendResponse);
    await flush();

    expect(returned).toBe(true);
    expect(logoutExtensionSession).toHaveBeenCalledTimes(1);
    expect(requestPullContext).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      payload: { ok: true },
    });
  });

  it("maps a rejected Error to { ok: false, error: message }", async () => {
    const requestPullContext = vi.fn(async () => {
      throw new Error("pull context unavailable");
    });
    const { listener } = loadBackground({
      requestPullContext,
      logoutExtensionSession: vi.fn(),
    });
    const sendResponse = vi.fn();

    listener({ type: "loopover:pull-context" }, {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "pull context unavailable",
    });
  });

  it("maps a rejected non-Error value to { ok: false, error: String(value) }", async () => {
    const logoutExtensionSession = vi.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "session gone";
    });
    const { listener } = loadBackground({
      requestPullContext: vi.fn(),
      logoutExtensionSession,
    });
    const sendResponse = vi.fn();

    listener({ type: "loopover:logout" }, {}, sendResponse);
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "session gone",
    });
  });

  it("returns false for an unrecognized message type without dispatching either handler", () => {
    const requestPullContext = vi.fn();
    const logoutExtensionSession = vi.fn();
    const { listener } = loadBackground({
      requestPullContext,
      logoutExtensionSession,
    });
    const sendResponse = vi.fn();

    expect(listener({ type: "loopover:unknown" }, {}, sendResponse)).toBe(
      false,
    );
    expect(requestPullContext).not.toHaveBeenCalled();
    expect(logoutExtensionSession).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("returns false for a nullish message without dispatching either handler", () => {
    const requestPullContext = vi.fn();
    const logoutExtensionSession = vi.fn();
    const { listener } = loadBackground({
      requestPullContext,
      logoutExtensionSession,
    });

    expect(listener(null, {}, vi.fn())).toBe(false);
    expect(requestPullContext).not.toHaveBeenCalled();
    expect(logoutExtensionSession).not.toHaveBeenCalled();
  });
});

function loadBackground(handlers: {
  requestPullContext: (...args: unknown[]) => unknown;
  logoutExtensionSession: (...args: unknown[]) => unknown;
}) {
  let listener:
    | ((
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => unknown)
    | undefined;
  const context: Record<string, unknown> = {
    // Share the host Error so background.js's `error instanceof Error` matches the errors our stubs
    // throw -- a contextified vm has its own Error intrinsic, unlike the extension's single realm.
    Error,
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn: typeof listener) => {
            listener = fn;
          },
        },
      },
    },
    requestPullContext: handlers.requestPullContext,
    logoutExtensionSession: handlers.logoutExtensionSession,
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(backgroundSource).runInContext(vmContext);
  if (!listener)
    throw new Error("background.js did not register an onMessage listener");
  return { listener };
}
