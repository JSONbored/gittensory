// #697 (roadmap #525): gittensory consumes metagraphed — validate subnet/netuid claims as gate evidence.
//
// PURE core of the subnet-claim gate signal. It (a) detects when a contribution's text claims to integrate
// a Bittensor subnet/netuid, and (b) turns a metagraphed validation verdict for that netuid into a
// public-safe, ADVISORY `AdvisoryFinding`. The actual metagraphed HTTP call lives in
// ../services/metagraphed.ts (injected here as `validate`), so this module stays deterministic and
// unit-testable without a network.
//
// Advisory-first (#525): findings are `warning` severity at most — they surface evidence, they never hard
// block. Public-safe (#542): wording uses only subnet/netuid/interface/metagraphed vocabulary and is run
// through `isPublicSafeText` in tests, so it carries no reward/score/identity language.

import type { AdvisoryFinding } from "../types";

/** A subnet/netuid integration claim parsed from contribution text. */
export type SubnetClaim = { readonly netuid: number; readonly raw: string };

/** Verdict for one claimed netuid, sourced from metagraphed. `unavailable` = could not validate (metagraphed
 *  unreachable/unexpected) — deliberately produces NO finding so a metagraphed outage is never noisy. */
export type NetuidValidationStatus = "exists_healthy" | "exists_unhealthy" | "not_found" | "unavailable";

export type NetuidValidation = {
  readonly netuid: number;
  readonly status: NetuidValidationStatus;
  readonly detail: string;
};

/** Validate a single netuid against metagraphed. Implemented by ../services/metagraphed.ts; injected so the
 *  pure layer can be tested with a fake. Must never reject — connectivity failures map to `unavailable`. */
export type NetuidValidator = (netuid: number) => Promise<NetuidValidation>;

/** Highest netuid we treat as a plausible subnet claim. Keeps detection from matching years / PR numbers /
 *  large unrelated integers (Bittensor netuids are small and dense from 0). */
export const MAX_RECOGNIZED_NETUID = 1023;

// Matches "subnet 42", "subnet #42", "subnet-42", "subnets 42", "netuid 42", "netuid: 5", "net uid 5",
// "netuid=12", "sn74", "SN 74", "subnet number 7". The number is captured; a separator is optional but the
// number must follow within optional whitespace/separator so plain words ("subnetwork", "snapshot") miss.
const SUBNET_CLAIM_PATTERN = /\b(?:net\s?uid|subnets?|sn)\s*(?:number\s*)?[:#=-]?\s*(\d{1,5})\b/gi;

/**
 * Detect distinct subnet/netuid integration claims in free text (PR/issue title + body). Returns at most one
 * claim per netuid (first mention wins), sorted ascending for deterministic output. Out-of-range numbers
 * (> MAX_RECOGNIZED_NETUID) are ignored to avoid false positives on years/IDs.
 */
export function detectSubnetClaims(text: string | null | undefined): SubnetClaim[] {
  if (!text) return [];
  const byNetuid = new Map<number, string>();
  for (const match of text.matchAll(SUBNET_CLAIM_PATTERN)) {
    const netuid = Number(match[1]);
    if (!Number.isInteger(netuid) || netuid < 0 || netuid > MAX_RECOGNIZED_NETUID) continue;
    if (!byNetuid.has(netuid)) byNetuid.set(netuid, match[0].trim());
  }
  return [...byNetuid.entries()].map(([netuid, raw]) => ({ netuid, raw })).sort((a, b) => a.netuid - b.netuid);
}

/**
 * Turn one metagraphed verdict into an advisory finding. Returns `null` when there is nothing to surface —
 * the netuid exists and is healthy, or metagraphed could not be reached (`unavailable`). Only a missing
 * (`not_found`) or unhealthy (`exists_unhealthy`) subnet produces a finding.
 */
export function buildSubnetClaimFinding(validation: NetuidValidation): AdvisoryFinding | null {
  const { netuid } = validation;
  if (validation.status === "not_found") {
    return {
      code: "subnet_claim_not_found",
      severity: "warning",
      title: `Claimed subnet ${netuid} was not found via metagraphed`,
      detail: `This contribution references subnet/netuid ${netuid}, but metagraphed reports no such subnet on the network. ${validation.detail}`,
      action: `Verify the netuid and correct or remove the subnet ${netuid} integration claim.`,
      publicText: `metagraphed could not find subnet ${netuid}; verify the referenced netuid.`,
    };
  }
  if (validation.status === "exists_unhealthy") {
    return {
      code: "subnet_claim_unhealthy",
      severity: "warning",
      title: `Claimed subnet ${netuid} appears unhealthy via metagraphed`,
      detail: `metagraphed reports subnet/netuid ${netuid} exists but its interface health check did not pass, so the integration claim could not be confirmed as healthy. ${validation.detail}`,
      action: `Confirm the subnet ${netuid} interface is reachable, or note the integration as experimental.`,
      publicText: `metagraphed reports subnet ${netuid} exists but its interface health check did not pass.`,
    };
  }
  return null;
}

/**
 * Assess all subnet/netuid claims in a contribution's title + body and return the advisory findings sourced
 * from metagraphed. Validates each distinct claimed netuid via the injected validator. Deterministic and
 * never throws (the validator must map failures to `unavailable`). Empty result = no claims, or all claimed
 * subnets validated cleanly / could not be checked.
 */
export async function assessSubnetClaims(
  input: { readonly title?: string | null | undefined; readonly body?: string | null | undefined },
  validate: NetuidValidator,
): Promise<AdvisoryFinding[]> {
  const claims = detectSubnetClaims(`${input.title ?? ""}\n${input.body ?? ""}`);
  const findings: AdvisoryFinding[] = [];
  for (const claim of claims) {
    const finding = buildSubnetClaimFinding(await validate(claim.netuid));
    if (finding) findings.push(finding);
  }
  return findings;
}
