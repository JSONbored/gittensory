import {
  createAuthSession,
  getAuthSessionByTokenHash,
  recordAuditEvent,
  revokeAuthSession,
  touchAuthSession,
} from "../db/repositories";
import type { AuthSessionRecord, JsonValue } from "../types";
import { nowIso } from "../utils/json";

export type AuthIdentity =
  | { kind: "static"; actor: "api" | "mcp" | "internal" }
  | { kind: "session"; actor: string; session: AuthSessionRecord };

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function extractBearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() || undefined;
}

export async function timingSafeEqual(actual: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!actual || !expected) return false;
  const [left, right] = await Promise.all([sha256Bytes(actual), sha256Bytes(expected)]);
  let diff = left.length ^ right.length;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return diff === 0;
}

export async function hashToken(token: string): Promise<string> {
  return bytesToHex(await sha256Bytes(token));
}

export function createOpaqueToken(prefix = "gts"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${bytesToHex(bytes)}`;
}

export async function authenticatePrivateToken(env: Env, token: string | undefined): Promise<AuthIdentity | null> {
  if (!token) return null;
  if (await timingSafeEqual(token, env.GITTENSORY_API_TOKEN)) return { kind: "static", actor: "api" };
  if (await timingSafeEqual(token, env.GITTENSORY_MCP_TOKEN)) return { kind: "static", actor: "mcp" };
  return authenticateSessionToken(env, token);
}

export async function authenticateInternalToken(env: Env, token: string | undefined): Promise<AuthIdentity | null> {
  if (await timingSafeEqual(token, env.INTERNAL_JOB_TOKEN)) return { kind: "static", actor: "internal" };
  return null;
}

export async function authenticateSessionToken(env: Env, token: string | undefined): Promise<AuthIdentity | null> {
  if (!token) return null;
  const session = await getAuthSessionByTokenHash(env, await hashToken(token));
  if (!session) return null;
  if (session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
  await touchAuthSession(env, session.id);
  return { kind: "session", actor: session.login, session };
}

export async function createSessionForGitHubUser(
  env: Env,
  user: { login: string; id?: number | null },
  options: { scopes?: string[]; metadata?: Record<string, JsonValue> } = {},
): Promise<{ token: string; session: AuthSessionRecord }> {
  const token = createOpaqueToken();
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const session: AuthSessionRecord = {
    id: crypto.randomUUID(),
    tokenHash: await hashToken(token),
    login: user.login,
    githubUserId: user.id,
    scopes: options.scopes ?? [],
    expiresAt,
    createdAt: issuedAt,
    lastSeenAt: issuedAt,
    metadata: options.metadata ?? {},
  };
  await createAuthSession(env, session);
  await recordAuditEvent(env, {
    eventType: "auth.session_created",
    actor: user.login,
    outcome: "success",
    metadata: { scopes: session.scopes, githubUserId: user.id ?? null },
  });
  return { token, session };
}

export async function revokeSession(env: Env, identity: AuthIdentity | null): Promise<boolean> {
  if (!identity || identity.kind !== "session") return false;
  await revokeAuthSession(env, identity.session.id);
  await recordAuditEvent(env, {
    eventType: "auth.session_revoked",
    actor: identity.actor,
    outcome: "success",
  });
  return true;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
