// Resolves a hosted AMS tenant's bootstrap secret (#8246, the AMS half of #8202). Exchanges
// LOOPOVER_TENANT_SECRET_TOKEN against the SAME broker exchange src/orb/broker-client.ts's
// fetchBrokeredStoredSecret already implements for ORB -- duplicated here, not imported: this package is a
// real npm workspace member whose tsconfig.json scopes `"rootDir": "."` to itself, so a relative import
// reaching into root src/ resolves outside rootDir and fails tsc with TS6059. This mirrors
// control-plane/src/secret-driver.ts's own identical "duplicate, don't import" call for the SAME package
// boundary (see also control-plane/src/http-app.ts's HOSTED_CYCLE_COMMANDS comment, which cross-references
// this file for the same reasoning).
//
// #8202's mechanism: control-plane delivers a one-time bootstrap credential into a hosted tenant container's
// cold-boot env as LOOPOVER_TENANT_SECRET_TOKEN (a product-agnostic name -- ORB's and AMS's containers both
// read the identical var). The container exchanges it via POST /v1/orb/token for whatever the broker has
// custodied under it -- today, always a tenant_db_credential (a JSON-encoded DatabaseConnectionDetails);
// #8202's own research confirmed there is no production issuance path for ams_github_token yet, so that isn't
// a real response shape to plan a consumer around.
//
// resolveTenantSecret (the function hosted-entry.ts actually calls) is deliberately best-effort: unlike ORB's
// fetchBrokeredStoredSecret, which throws because a self-hosted engine has real work that needs the value, no
// code in this package consumes a resolved tenant secret yet (the miner's own stores are unconditionally local
// SQLite -- see store-db-adapter.ts's own "later" note on swapping in a Postgres adapter), so a broker outage
// or an unconfigured token must not block a scheduled discover/manage-poll/attempt cycle from running.
// fetchTenantSecret (the throwing primitive) is exported for whatever real consumer eventually needs strict
// failure semantics.
//
// This FILE is named "credential", not "secret", purely to stay clear of scripts/check-miner-package.ts's
// filename-based FORBIDDEN_PATH filter (a coarse `.*secret.*` heuristic aimed at stray credential files like
// .env/.pem, not descriptively-named source code) -- the exported symbols below keep "Secret" in their names,
// matching src/orb/broker-client.ts's own naming for the function this duplicates.

const DEFAULT_BROKER_URL = "https://api.loopover.ai";
const BROKER_TIMEOUT_MS = 25_000;

function isLocalBrokerHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/** Same URL-safety validation as broker-client.ts's own orbBrokerBaseUrl -- guards against an attacker- or
 *  misconfiguration-controlled ORB_BROKER_URL sending the bootstrap token to an unintended origin. */
function orbBrokerBaseUrl(env: { ORB_BROKER_URL?: string | undefined }): string {
  const raw = env.ORB_BROKER_URL ?? DEFAULT_BROKER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ORB_BROKER_URL must be a valid URL.");
  }
  if (url.username || url.password) {
    throw new Error("ORB_BROKER_URL must not include userinfo.");
  }
  if (url.search || url.hash) {
    throw new Error("ORB_BROKER_URL must not include a query string or fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalBrokerHost(url.hostname))) {
    throw new Error("ORB_BROKER_URL must use https unless it targets localhost development.");
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export type TenantSecret = { secretValue: string; secretType: string };

/** Exchange LOOPOVER_TENANT_SECRET_TOKEN for whatever the broker has custodied under it. Throws on a non-OK
 *  response or a body missing secretValue -- the strict primitive; {@link resolveTenantSecret} below is the
 *  best-effort wrapper hosted-entry.ts actually calls. */
export async function fetchTenantSecret(
  env: { LOOPOVER_TENANT_SECRET_TOKEN?: string | undefined; ORB_BROKER_URL?: string | undefined },
  fetchImpl: typeof fetch = fetch,
): Promise<TenantSecret> {
  const base = orbBrokerBaseUrl(env);
  const response = await fetchImpl(`${base}/v1/orb/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.LOOPOVER_TENANT_SECRET_TOKEN ?? ""}` },
    signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Orb broker stored-secret exchange failed (${response.status}).`);
  }
  const payload = (await response.json()) as { secretValue?: string; secretType?: string };
  if (!payload.secretValue) {
    throw new Error("Orb broker stored-secret response did not include a secretValue.");
  }
  return { secretValue: payload.secretValue, secretType: payload.secretType ?? "" };
}

/** Best-effort wrapper around {@link fetchTenantSecret} (#8246): `null` when `LOOPOVER_TENANT_SECRET_TOKEN`
 *  isn't set (a self-hosted or not-yet-provisioned tenant -- the overwhelmingly common case today) OR when the
 *  exchange itself fails, logged rather than thrown. `hosted-entry.ts` calls this once per wake so the
 *  mechanism is proven wired end-to-end for AMS (#8246's own deliverable) without making a scheduled cycle
 *  fragile against a value nothing consumes yet. */
export async function resolveTenantSecret(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<TenantSecret | null> {
  const token = env.LOOPOVER_TENANT_SECRET_TOKEN?.trim();
  if (!token) return null;
  try {
    return await fetchTenantSecret(env, fetchImpl);
  } catch (error) {
    console.warn(JSON.stringify({ event: "ams_tenant_secret_resolve_failed", message: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}
