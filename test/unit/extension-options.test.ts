import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// options.js statically imports its auth helpers from ./auth.js. As with background.js, the vm
// `Script` runner cannot execute a top-level ESM `import`, so we strip that block and inject stubbed
// auth helpers plus a fake DOM as context globals. options.js runs `void refreshSettings()` and wires
// up its form/logout listeners at load time, so each `loadOptions(...)` exercises `refreshSettings()`
// once and hands back the fake elements plus the captured event handlers.
const optionsSource = readFileSync(
  "apps/loopover-extension/options.js",
  "utf8",
).replace(/^import\s*\{[\s\S]*?\}\s*from\s*["']\.\/auth\.js["'];?\n?/, "");

const DEFAULT_API_ORIGIN = "https://api.loopover.ai";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("extension options page", () => {
  it("refreshSettings shows the no-session summary and disables session controls", async () => {
    const { dom } = await loadOptions({
      session: session({ sessionToken: "" }),
    });

    expect(dom.sessionSummary.textContent).toBe("No extension session stored.");
    expect(dom.apiOrigin.value).toBe(DEFAULT_API_ORIGIN);
    expect(dom.sessionToken.placeholder).toBe(
      "Paste gts_ extension session token",
    );
    expect(dom.logout.disabled).toBe(true);
    expect(dom.clearLocal.disabled).toBe(true);
  });

  it("refreshSettings flags an expired session", async () => {
    const { dom } = await loadOptions({
      session: session({
        sessionToken: "gts_stored",
        expired: true,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    });

    expect(dom.sessionSummary.textContent).toBe(
      "Stored extension session is expired. Save a fresh token or clear local state.",
    );
    expect(dom.logout.disabled).toBe(false);
    expect(dom.clearLocal.disabled).toBe(false);
    expect(dom.sessionToken.placeholder).toBe(
      "Stored locally - leave blank to keep current token",
    );
  });

  it("refreshSettings reports a valid session and appends the expiry when present", async () => {
    const { dom } = await loadOptions({
      session: session({
        sessionToken: "gts_stored",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    });

    expect(dom.sessionSummary.textContent).toBe(
      "Extension session stored in browser local storage. Expires 2030-01-01T00:00:00.000Z.",
    );
    expect(dom.apiOrigin.value).toBe(DEFAULT_API_ORIGIN);
    expect(dom.sessionExpiresAt.value).toBe("2030-01-01T00:00:00.000Z");
  });

  it("refreshSettings omits the expiry sentence for a valid session without an expiresAt", async () => {
    const { dom } = await loadOptions({
      session: session({ sessionToken: "gts_stored", expiresAt: "" }),
    });

    expect(dom.sessionSummary.textContent).toBe(
      "Extension session stored in browser local storage.",
    );
  });

  it("submit stores a token when one is entered and reports the saved-session status", async () => {
    const auth = authStubs();
    const { dom, handlers } = await loadOptions({
      session: session({ sessionToken: "" }),
      auth,
    });
    dom.apiOrigin.value = "  https://api.loopover.test  ";
    dom.sessionToken.value = `  gts_${"a".repeat(64)}  `;
    dom.sessionExpiresAt.value = " 2030-01-01T00:00:00.000Z ";
    const event = { preventDefault: vi.fn() };

    await handlers.submit(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(auth.saveExtensionApiOrigin).toHaveBeenCalledWith(
      "https://api.loopover.test",
    );
    expect(auth.storeExtensionSessionToken).toHaveBeenCalledWith({
      token: `gts_${"a".repeat(64)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: ["extension:pull_context"],
    });
    expect(dom.status.textContent).toBe("Extension session saved locally.");
  });

  it("submit falls back to the default origin and skips token storage when the field is blank", async () => {
    const auth = authStubs();
    const { dom, handlers } = await loadOptions({
      session: session({ sessionToken: "" }),
      auth,
    });
    dom.apiOrigin.value = "   ";
    dom.sessionToken.value = "   ";

    await handlers.submit({ preventDefault: vi.fn() });

    expect(auth.saveExtensionApiOrigin).toHaveBeenCalledWith(
      DEFAULT_API_ORIGIN,
    );
    expect(auth.storeExtensionSessionToken).not.toHaveBeenCalled();
    expect(dom.status.textContent).toBe("Settings saved.");
  });

  it("submit surfaces the error message when saving fails", async () => {
    const auth = authStubs();
    auth.saveExtensionApiOrigin.mockRejectedValueOnce(
      new Error("origin rejected"),
    );
    const { dom, handlers } = await loadOptions({
      session: session({ sessionToken: "" }),
      auth,
    });

    await handlers.submit({ preventDefault: vi.fn() });

    expect(dom.status.textContent).toBe("origin rejected");
  });

  it("logout clears local state and refreshes on the happy path", async () => {
    const auth = authStubs();
    const { dom, handlers } = await loadOptions({
      session: session({ sessionToken: "gts_stored" }),
      auth,
    });

    await handlers.logout();

    expect(auth.logoutExtensionSession).toHaveBeenCalledTimes(1);
    expect(auth.clearExtensionSession).not.toHaveBeenCalled();
    expect(dom.status.textContent).toBe(
      "Logged out and cleared the local extension session.",
    );
    expect(dom.logout.disabled).toBe(false);
  });

  it("logout still clears local state when the revoke call throws", async () => {
    const auth = authStubs();
    auth.logoutExtensionSession.mockRejectedValueOnce(
      new Error("network down"),
    );
    const { dom, handlers } = await loadOptions({
      session: session({ sessionToken: "gts_stored" }),
      auth,
    });

    await handlers.logout();

    expect(auth.clearExtensionSession).toHaveBeenCalledTimes(1);
    expect(dom.status.textContent).toBe("network down");
    expect(dom.logout.disabled).toBe(false);
  });

  it("clearLocal wipes the session and reports the cleared status", async () => {
    const auth = authStubs();
    const { dom, handlers } = await loadOptions({
      session: session({ sessionToken: "gts_stored" }),
      auth,
    });

    await handlers.clearLocal();

    expect(auth.clearExtensionSession).toHaveBeenCalledTimes(1);
    expect(dom.status.textContent).toBe("Local extension session cleared.");
  });
});

type Session = {
  apiOrigin: string;
  sessionToken: string;
  expiresAt: string;
  expired: boolean;
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    apiOrigin: DEFAULT_API_ORIGIN,
    sessionToken: "",
    expiresAt: "",
    expired: false,
    ...overrides,
  };
}

function authStubs() {
  return {
    DEFAULT_API_ORIGIN,
    clearExtensionSession: vi.fn(async () => {}),
    loadExtensionSession: vi.fn(async () => session()),
    logoutExtensionSession: vi.fn(async () => ({ ok: true })),
    saveExtensionApiOrigin: vi.fn(async () => {}),
    storeExtensionSessionToken: vi.fn(async () => {}),
  };
}

async function loadOptions(opts: {
  session: Session;
  auth?: ReturnType<typeof authStubs>;
}) {
  const auth = opts.auth ?? authStubs();
  auth.loadExtensionSession.mockImplementation(async () => opts.session);

  const dom = fakeDom();

  const context: Record<string, unknown> = {
    ...auth,
    // Share the host Error so options.js's `error instanceof Error` matches the errors our stubs
    // throw -- a contextified vm has its own Error intrinsic, unlike the extension's single realm.
    Error,
    document: {
      querySelector: (selector: string) => dom.bySelector[selector] ?? null,
    },
    // setTimeout is left inert so showStatus() does not asynchronously wipe the text we assert on.
    window: { setTimeout: vi.fn() },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(optionsSource).runInContext(vmContext);

  const handlers = {
    submit: (event?: unknown) => dom.form.dispatch("submit", event),
    logout: () => dom.logout.dispatch("click"),
    clearLocal: () => dom.clearLocal.dispatch("click"),
  };

  // Let the load-time `void refreshSettings()` settle before assertions.
  await flush();
  return { dom, handlers };
}

function fakeElement() {
  const listeners: Record<string, (event?: unknown) => unknown> = {};
  return {
    value: "",
    placeholder: "",
    textContent: "",
    disabled: false,
    addEventListener(type: string, fn: (event?: unknown) => unknown) {
      listeners[type] = fn;
    },
    async dispatch(type: string, event?: unknown) {
      return listeners[type]?.(event);
    },
  };
}

function fakeDom() {
  const form = fakeElement();
  const status = fakeElement();
  const apiOrigin = fakeElement();
  const sessionToken = fakeElement();
  const sessionExpiresAt = fakeElement();
  const sessionSummary = fakeElement();
  const logout = fakeElement();
  const clearLocal = fakeElement();
  return {
    form,
    status,
    apiOrigin,
    sessionToken,
    sessionExpiresAt,
    sessionSummary,
    logout,
    clearLocal,
    bySelector: {
      "#settings": form,
      "#status": status,
      "#apiOrigin": apiOrigin,
      "#sessionToken": sessionToken,
      "#sessionExpiresAt": sessionExpiresAt,
      "#sessionSummary": sessionSummary,
      "#logout": logout,
      "#clearLocal": clearLocal,
    } as Record<string, ReturnType<typeof fakeElement>>,
  };
}
