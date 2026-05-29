import { createSessionForGitHubUser, isAuthorizedGitHubSessionLogin } from "./security";
import { recordAuditEvent } from "../db/repositories";
import type { JsonValue } from "../types";

type GitHubDeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
};

type GitHubAccessTokenResponse =
  | { access_token: string; token_type?: string; scope?: string }
  | { error: string; error_description?: string };

type GitHubUserResponse = {
  login?: string;
  id?: number;
  message?: string;
};

export async function startGitHubDeviceFlow(env: Env): Promise<GitHubDeviceCodeResponse> {
  if (!env.GITHUB_OAUTH_CLIENT_ID) throw new Error("github_oauth_not_configured");
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "gittensory-api",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      scope: "read:user",
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<GitHubDeviceCodeResponse> & { error?: string; error_description?: string };
  if (!response.ok || payload.error) throw new Error(payload.error_description ?? payload.error ?? "github_device_flow_start_failed");
  if (!payload.device_code || !payload.user_code || !payload.verification_uri || !payload.expires_in) throw new Error("github_device_flow_response_invalid");
  return {
    device_code: payload.device_code,
    user_code: payload.user_code,
    verification_uri: payload.verification_uri,
    expires_in: payload.expires_in,
    ...(payload.interval === undefined ? {} : { interval: payload.interval }),
  };
}

export async function pollGitHubDeviceFlow(env: Env, deviceCode: string) {
  if (!env.GITHUB_OAUTH_CLIENT_ID) throw new Error("github_oauth_not_configured");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "gittensory-api",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as GitHubAccessTokenResponse;
  if ("error" in tokenPayload) {
    await recordAuditEvent(env, {
      eventType: "auth.github_device_poll",
      outcome: tokenPayload.error === "authorization_pending" || tokenPayload.error === "slow_down" ? "denied" : "error",
      detail: tokenPayload.error,
    });
    return {
      status: tokenPayload.error,
      message: tokenPayload.error_description,
    };
  }
  if (!tokenPayload.access_token) throw new Error("github_access_token_missing");
  return createSessionFromGitHubToken(env, tokenPayload.access_token, {
    source: "github_device_flow",
    scopes: parseScopes(tokenPayload.scope),
  });
}

export async function createSessionFromGitHubToken(
  env: Env,
  githubToken: string,
  metadata: Record<string, JsonValue> = {},
): Promise<{ token: string; login: string; expiresAt: string; scopes: string[] }> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "user-agent": "gittensory-api",
      "x-github-api-version": "2022-11-28",
    },
  });
  const user = (await response.json().catch(() => ({}))) as GitHubUserResponse;
  if (!response.ok || !user.login) {
    await recordAuditEvent(env, {
      eventType: "auth.github_session",
      outcome: "denied",
      detail: user.message ?? "github_user_validation_failed",
    });
    throw new Error("github_user_validation_failed");
  }
  if (!isAuthorizedGitHubSessionLogin(env, user.login)) {
    await recordAuditEvent(env, {
      eventType: "auth.github_session",
      actor: user.login,
      outcome: "denied",
      detail: "github_user_not_authorized",
    });
    throw new Error("github_user_not_authorized");
  }
  const scopes = Array.isArray(metadata.scopes) ? metadata.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const githubUser = user.id === undefined ? { login: user.login } : { login: user.login, id: user.id };
  const { token, session } = await createSessionForGitHubUser(env, githubUser, { scopes, metadata });
  return { token, login: session.login, expiresAt: session.expiresAt, scopes: session.scopes };
}

function parseScopes(scopeHeader: string | undefined): string[] {
  return (scopeHeader ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}
