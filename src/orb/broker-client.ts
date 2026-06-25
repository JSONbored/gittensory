// Self-host BROKER CLIENT (#1255). A self-hosted engine exchanges its operator-issued enrollment secret for a
// short-lived GitHub installation token from the central Orb (POST /v1/orb/token), so it can act on its own repos
// WITHOUT ever holding a GitHub App private key (gittensory holds the Orb App key centrally and mints on demand —
// the das-github-mirror model). Used by createInstallationToken in broker mode; the installation-token CACHE lives
// with the App-key path in src/github/app.ts (one mint per ~hour per installation, broker or local).
//
// The signal is the ENROLLMENT SECRET's presence: a brokered self-host sets ORB_ENROLLMENT_SECRET (issued by the
// operator), cloud never does — so this path is inert on cloud and the deploy is byte-identical there.

/** The Orb's hosted broker base; override (ORB_BROKER_URL) only to point at a private gittensory deployment. */
const DEFAULT_BROKER_URL = "https://gittensory-api.aethereal.dev";
const BROKER_TIMEOUT_MS = 10_000;

/** True when GitHub tokens should be sourced from the central Orb broker (a brokered self-host) rather than minted
 *  locally from an App key — i.e. an enrollment secret is configured. Cloud never sets it ⇒ false there. */
export function isOrbBrokerMode(env: { ORB_ENROLLMENT_SECRET?: string | undefined }): boolean {
  return Boolean(env.ORB_ENROLLMENT_SECRET);
}

export type BrokeredInstallationToken = { token: string; installationId: number; expiresAtMs: number };

/** Exchange the enrollment secret for a brokered installation token + its expiry (ms epoch). Throws on a non-OK
 *  response (401 invalid_enrollment / 403 installation_not_eligible / 5xx) or a tokenless body — a brokered
 *  self-host holds no App key to fall back to, so a mint failure is fatal for that request exactly like the
 *  App-key path, and the queue's existing retry/dead-letter handling covers a transient broker outage. */
export async function fetchBrokeredInstallationToken(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined },
  fetchImpl: typeof fetch = fetch,
): Promise<BrokeredInstallationToken> {
  const base = (env.ORB_BROKER_URL ?? DEFAULT_BROKER_URL).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/v1/orb/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.ORB_ENROLLMENT_SECRET ?? ""}` },
    signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Orb broker token exchange failed (${response.status}).`);
  }
  const payload = (await response.json()) as { token?: string; installationId?: number; expiresAt?: string };
  if (!payload.token) {
    throw new Error("Orb broker token response did not include a token.");
  }
  const expiresAtMs = payload.expiresAt ? Date.parse(payload.expiresAt) : Date.now() + 50 * 60_000;
  return { token: payload.token, installationId: payload.installationId ?? 0, expiresAtMs };
}
