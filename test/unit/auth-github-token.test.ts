import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { completeGitHubWebOAuth, pollGitHubDeviceFlow, startGitHubWebOAuth } from "../../src/auth/github-oauth";
import { authenticatePrivateToken, createSessionForGitHubUser, revokeSession } from "../../src/auth/security";
import { deleteSessionGitHubToken, getDecryptedSessionGitHubToken, storeSessionGitHubToken } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const SECRET = "example-unit-test-encryption-secret-32-bytes-long";

describe("session GitHub token storage (#6114)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores an encrypted token at session creation and decrypts it at call time", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBe("gh-token-abc123");

    // The persisted row stores ciphertext, never the plaintext token.
    const row = await env.DB.prepare("select ciphertext, iv from auth_session_github_tokens where session_id = ?").bind(session.id).first<{ ciphertext: string; iv: string }>();
    expect(row?.ciphertext).not.toContain("gh-token-abc123");
  });

  it("does not persist anything when no githubToken is supplied (ordinary sessions unaffected)", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 });
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBeNull();
    const row = await env.DB.prepare("select session_id from auth_session_github_tokens where session_id = ?").bind(session.id).first();
    expect(row ?? null).toBeNull();
  });

  it("REGRESSION: session creation still succeeds when TOKEN_ENCRYPTION_SECRET is unset, warning instead of throwing (#6114 -- unlike BYOK/Linear keys, there is no re-mint fallback for a user's own OAuth token)", async () => {
    const env = createTestEnv({});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { token, session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-xyz" });
    expect(token).toBeTruthy(); // the loopover session itself was still created
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBeNull();
    expect(warnings.mock.calls.some(([line]) => String(line).includes("session_github_token_persist_skipped") && String(line).includes(session.id))).toBe(true);
    warnings.mockRestore();
  });

  it("returns null (not throw) when decrypting with a rotated/wrong encryption secret", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    const wrongSecretEnv = { ...env, TOKEN_ENCRYPTION_SECRET: "totally-different-example-secret-32-bytes-min" } as unknown as Env;
    await expect(getDecryptedSessionGitHubToken(wrongSecretEnv, session.id)).resolves.toBeNull();
    const noSecretEnv = { ...env, TOKEN_ENCRYPTION_SECRET: undefined } as unknown as Env;
    await expect(getDecryptedSessionGitHubToken(noSecretEnv, session.id)).resolves.toBeNull();
  });

  it("returns null for a session id that was never stored at all", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(getDecryptedSessionGitHubToken(env, "nonexistent-session-id")).resolves.toBeNull();
  });

  it("replaces the stored token on re-authentication, not append/duplicate", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "first-token" });
    await storeSessionGitHubToken(env, session.id, "second-token");
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBe("second-token");
    const count = await env.DB.prepare("select count(*) as n from auth_session_github_tokens where session_id = ?").bind(session.id).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("revokeSession deletes the stored GitHub token, not just the loopover session", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token, session } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    const identity = await authenticatePrivateToken(env, token);
    await revokeSession(env, identity);
    await expect(getDecryptedSessionGitHubToken(env, session.id)).resolves.toBeNull();
    const row = await env.DB.prepare("select session_id from auth_session_github_tokens where session_id = ?").bind(session.id).first();
    expect(row ?? null).toBeNull();
  });

  it("deleteSessionGitHubToken is a no-op (not an error) when nothing was ever stored", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await expect(deleteSessionGitHubToken(env, "nonexistent-session-id")).resolves.toBeUndefined();
  });

  it("never appears in plaintext in the session-creation audit event", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "super-secret-gh-token-value" });
    const events = await env.DB.prepare("select metadata_json, detail from audit_events where event_type = ?").bind("auth.session_created").all<{ metadata_json: string; detail: string | null }>();
    expect(JSON.stringify(events.results)).not.toContain("super-secret-gh-token-value");
  });

  it("the device-flow login persists the token end-to-end (not just the isolated repository function)", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", TOKEN_ENCRYPTION_SECRET: SECRET });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "device-flow-gh-token", scope: "read:user" });
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });
    const result = await pollGitHubDeviceFlow(env, "device-code");
    if (!("token" in result)) throw new Error("expected an authenticated session result");
    const identity = await authenticatePrivateToken(env, result.token);
    if (identity?.kind !== "session") throw new Error("expected a session identity");
    await expect(getDecryptedSessionGitHubToken(env, identity.session.id)).resolves.toBe("device-flow-gh-token");
  });

  it("the web-OAuth login persists the token end-to-end", async () => {
    const env = createTestEnv({ GITHUB_OAUTH_CLIENT_ID: "client-id", GITHUB_OAUTH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_SECRET: SECRET });
    const started = await startGitHubWebOAuth(env, "https://api.example/v1/auth/github/start", undefined);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("access_token")) return Response.json({ access_token: "web-oauth-gh-token", scope: "read:user" });
      if (url === "https://api.github.com/user") return Response.json({ login: "jsonbored", id: 42 });
      return Response.json({});
    });
    const session = await completeGitHubWebOAuth(env, "https://api.example/v1/auth/github/callback", {
      code: "code",
      state: started.state,
      cookieState: started.state,
    });
    const identity = await authenticatePrivateToken(env, session.token);
    if (identity?.kind !== "session") throw new Error("expected a session identity");
    await expect(getDecryptedSessionGitHubToken(env, identity.session.id)).resolves.toBe("web-oauth-gh-token");
  });
});

describe("POST /v1/auth/github/token route (#6114)", () => {
  it("returns the session's live GitHub token, never cached", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "gh-token-abc123" });
    const res = await app.request("/v1/auth/github/token", { method: "POST", headers: { cookie: `loopover_session=${token}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "gh-token-abc123" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 github_token_unavailable when no token was persisted for this session", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 });
    const res = await app.request("/v1/auth/github/token", { method: "POST", headers: { cookie: `loopover_session=${token}` } }, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "github_token_unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const res = await app.request("/v1/auth/github/token", { method: "POST" }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "browser_session_required" });
  });

  it("rejects the static mcp/api shared-secret identities -- session-only, since they represent no single logged-in GitHub user", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const apiRes = await app.request("/v1/auth/github/token", { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } }, env);
    expect(apiRes.status).toBe(403);
    const mcpRes = await app.request("/v1/auth/github/token", { method: "POST", headers: { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}` } }, env);
    expect(mcpRes.status).toBe(403);
  });

  it("records product-usage telemetry without ever including the token", async () => {
    const app = createApp();
    const env = createTestEnv({ TOKEN_ENCRYPTION_SECRET: SECRET });
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 42 }, { githubToken: "super-secret-value" });
    const res = await app.request(
      "/v1/auth/github/token",
      { method: "POST", headers: { cookie: `loopover_session=${token}`, "x-loopover-mcp-client": "test" } },
      env,
    );
    expect(res.status).toBe(200);
    const events = await env.DB.prepare("select * from product_usage_events where event_name = ?").bind("github_token_fetched").all();
    expect(events.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(events.results)).not.toContain("super-secret-value");
  });
});
