// #697 (roadmap #525): the metagraphed consumer. Validates a claimed Bittensor subnet/netuid against
// metagraphed (netuid existence + interface health) and adapts the verdict into advisory gate findings.
//
// This mirrors gittensor/api.ts's fetch discipline (JSON accept header, hard timeout, never let a slow
// upstream hang the Worker). It is fail-open and ADVISORY: any error, timeout, or unexpected shape maps to
// `unavailable`, which produces NO finding — a metagraphed outage must never block or spam a contributor
// (#525: advisory-first, no auto-block). The feature is dormant until `METAGRAPHED_API_URL` is configured.

import type { AdvisoryFinding } from "../types";
import { assessSubnetClaims, type NetuidValidation } from "../signals/subnet-claim";

/** Hard cap on a single metagraphed request so a slow/half-open upstream can never stall the webhook. */
export const METAGRAPHED_FETCH_TIMEOUT_MS = 10_000;

/** Tolerant view of metagraphed's subnet response. Only `exists === false` and `healthy === false` are
 *  treated as negative signals; any other/missing shape is read as "exists, healthy" so an unrecognized
 *  200 never yields a false-positive finding. `interfaceHealthy` / `interface.healthy` are accepted as
 *  aliases for `healthy` to match the netuid-existence/chain-binding shape from the reviewbot work. */
export type MetagraphedSubnetResponse = {
  netuid?: number;
  exists?: boolean;
  healthy?: boolean;
  interfaceHealthy?: boolean;
  interface?: { healthy?: boolean } | null;
};

/** Map a parsed metagraphed subnet response to a validation verdict. Exported for direct unit testing. */
export function interpretSubnetResponse(netuid: number, data: MetagraphedSubnetResponse): NetuidValidation {
  if (data.exists === false) {
    return { netuid, status: "not_found", detail: `metagraphed reports subnet ${netuid} does not exist.` };
  }
  const healthy = data.healthy ?? data.interfaceHealthy ?? data.interface?.healthy;
  if (healthy === false) {
    return { netuid, status: "exists_unhealthy", detail: `metagraphed reports subnet ${netuid} interface health did not pass.` };
  }
  return { netuid, status: "exists_healthy", detail: `metagraphed confirms subnet ${netuid}.` };
}

export type MetagraphedClientDeps = {
  /** metagraphed base URL (no trailing slash required). */
  readonly baseUrl: string;
  /** Injected fetch for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
};

/**
 * Validate one netuid against metagraphed. Never rejects: a 404 → `not_found`, any other non-2xx / network
 * error / timeout / parse failure → `unavailable`, and a 2xx is interpreted by {@link interpretSubnetResponse}.
 */
export async function validateNetuid(netuid: number, deps: MetagraphedClientDeps): Promise<NetuidValidation> {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const url = `${base}/subnets/${netuid}`;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "gittensory/0.1" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? METAGRAPHED_FETCH_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return { netuid, status: "not_found", detail: `metagraphed reports subnet ${netuid} does not exist.` };
    }
    if (!response.ok) {
      return { netuid, status: "unavailable", detail: `metagraphed returned status ${response.status} for subnet ${netuid}.` };
    }
    return interpretSubnetResponse(netuid, (await response.json()) as MetagraphedSubnetResponse);
  } catch {
    return { netuid, status: "unavailable", detail: `metagraphed could not be reached for subnet ${netuid}.` };
  }
}

/**
 * Top-level adapter used by the webhook pipeline: detect subnet claims in a contribution's title/body and
 * return advisory findings sourced from metagraphed. Returns `[]` (and makes no network call) when
 * `METAGRAPHED_API_URL` is unset, so the feature is fully opt-in and existing behavior is unchanged.
 */
export async function assessSubnetClaimFindings(
  env: Pick<Env, "METAGRAPHED_API_URL">,
  input: { readonly title?: string | null | undefined; readonly body?: string | null | undefined },
  deps: { readonly fetchImpl?: typeof fetch | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<AdvisoryFinding[]> {
  const baseUrl = env.METAGRAPHED_API_URL?.trim();
  if (!baseUrl) return [];
  return assessSubnetClaims(input, (netuid) =>
    validateNetuid(netuid, {
      baseUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    }),
  );
}
