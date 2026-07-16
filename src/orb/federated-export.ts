// Federated fleet intelligence — EXPORT side (#6478, part of #1970). Packages a subset of the calibration
// signals this instance already computes locally (src/selfhost/orb-collector.ts) into a signed, anonymized
// bundle an operator can choose to share with the federated network, so a peer can benchmark its own gate
// precision against a fleet median (#6481) without anyone shipping raw review data around.
//
// Opt-in ONLY, and unlike ops:/publicStats: there is no env-var fallback: `federatedIntelligence.enabled` in
// the self-repo manifest is the single switch, and anything other than an explicit `true` means OFF. An
// instance that hasn't opted in builds no bundle and makes no call — byte-identical to before this module
// existed. That mirrors ORB_AIR_GAP's default-private posture rather than the Orb collector's always-on
// fleet-telemetry contract, because this is peer-to-peer sharing an operator must actively choose.
//
// WHAT LEAVES THE INSTANCE — the complete list, and there is nothing else in the shape to hold anything more:
//   - gate_verdict            the gate's own decision (merge | close | hold)
//   - outcome                 what actually happened to the PR (merged | closed)
//   - reversal_flag           none | reopened | reverted — the de-noised ground truth calibration needs
//   - gate_reasoncode_bucket  a fixed low-cardinality category, bucketed at the source (bucketReasonCode)
//   - time_to_close_ms        coarse cycle time
//
// WHAT DOES NOT, and cannot: source code, diffs, review comments, GitHub logins, repo names, PR numbers,
// commit SHAs, timestamps that could pin an event to a specific PR -- and, deliberately, NOT the Orb
// collector's repo_hash/pr_hash either. Those are pseudonymous per-PR identifiers: harmless for a collector
// that already knows the instance, but in a peer-to-peer bundle they would let a receiving peer correlate
// two bundles' events without ever needing to reverse the hash. Calibration medians don't need per-PR
// identity, so the identifiers are simply absent rather than hashed.
import { createHmac } from "node:crypto";
import type { FocusManifestFederatedIntelligenceConfig } from "../signals/focus-manifest";

/** The bundle format version, so a receiving peer can reject a shape it doesn't understand (#6480's job). */
export const FEDERATED_BUNDLE_SCHEMA_VERSION = 1;

/** One anonymized calibration signature: a single resolved PR reduced to the five fields above. */
export type FederatedCalibrationSignature = {
  gateVerdict: string | null;
  outcome: string;
  reversalFlag: "none" | "reopened" | "reverted";
  gateReasoncodeBucket: string;
  timeToCloseMs: number | null;
};

/** The unsigned bundle body. `instanceId` is the Orb's existing anonymized instance identity — a stable
 *  handle a peer can group by, never a repo/org/login. */
export type FederatedSignatureBundle = {
  schemaVersion: number;
  instanceId: string;
  generatedAt: string;
  signatures: FederatedCalibrationSignature[];
};

/** A bundle plus the HMAC a receiving peer verifies before trusting a byte of it. */
export type SignedFederatedBundle = {
  bundle: FederatedSignatureBundle;
  signature: string;
};

/** Everything the export needs from the caller. Passed in rather than read here so this module stays pure:
 *  no DB, no env, no clock — which is also what lets the tests below pin the exact bytes that get signed. */
export type FederatedExportInput = {
  instanceId: string;
  generatedAt: string;
  signatures: readonly FederatedCalibrationSignature[];
};

/** True only when the operator explicitly opted in. Absent config, absent block, or `enabled: false` all mean
 *  no — there is deliberately no env-var or allowlist fallback to widen this. */
export function isFederatedIntelligenceEnabled(
  config: FocusManifestFederatedIntelligenceConfig | null | undefined,
): boolean {
  return config?.enabled === true;
}

/** Reduce an input signature to EXACTLY the allowlisted fields. Written as an explicit construction rather
 *  than a spread/pick of the caller's object: a spread would silently carry any extra property the caller
 *  happened to hold, which is precisely the leak this bundle exists to make impossible. */
function toAllowlistedSignature(
  signature: FederatedCalibrationSignature,
): FederatedCalibrationSignature {
  return {
    gateVerdict: signature.gateVerdict,
    outcome: signature.outcome,
    reversalFlag: signature.reversalFlag,
    gateReasoncodeBucket: signature.gateReasoncodeBucket,
    timeToCloseMs: signature.timeToCloseMs,
  };
}

/** Build the unsigned bundle body from local calibration input. Pure. */
export function buildFederatedSignatureBundle(
  input: FederatedExportInput,
): FederatedSignatureBundle {
  return {
    schemaVersion: FEDERATED_BUNDLE_SCHEMA_VERSION,
    instanceId: input.instanceId,
    generatedAt: input.generatedAt,
    signatures: input.signatures.map(toAllowlistedSignature),
  };
}

/** The exact bytes that get signed. Serialized field-by-field in a fixed order rather than via JSON.stringify
 *  over the whole object, so the signature can never depend on key insertion order — a receiving peer that
 *  re-serializes the parsed bundle must arrive at the same string, or verification would fail for a bundle
 *  nobody tampered with. */
export function canonicalizeFederatedBundle(
  bundle: FederatedSignatureBundle,
): string {
  return JSON.stringify([
    bundle.schemaVersion,
    bundle.instanceId,
    bundle.generatedAt,
    bundle.signatures.map((signature) => [
      signature.gateVerdict,
      signature.outcome,
      signature.reversalFlag,
      signature.gateReasoncodeBucket,
      signature.timeToCloseMs,
    ]),
  ]);
}

/**
 * TODO(#6477): placeholder key derivation. #6477 decides how a federated signing key is actually established,
 * rotated, and trusted between peers; until it lands, the caller's own per-instance secret is used directly so
 * the bundle format and its verification path can ship and be tested now. This is deliberately NOT a trust
 * scheme: it proves in-transit integrity to a peer that already holds the key, and nothing more.
 */
function deriveSigningKey(secret: string): string {
  return createHmac("sha256", secret)
    .update(`federated-bundle:v${FEDERATED_BUNDLE_SCHEMA_VERSION}`)
    .digest("hex");
}

/** HMAC-sign a bundle so a receiving peer can verify it wasn't altered in transit. */
export function signFederatedBundle(
  bundle: FederatedSignatureBundle,
  secret: string,
): string {
  return createHmac("sha256", deriveSigningKey(secret))
    .update(canonicalizeFederatedBundle(bundle))
    .digest("hex");
}

/** Verify a bundle against its signature. The counterpart #6480's import side needs; kept here so the format
 *  and its verification can never drift apart into two files. */
export function verifyFederatedBundle(
  signed: SignedFederatedBundle,
  secret: string,
): boolean {
  return signFederatedBundle(signed.bundle, secret) === signed.signature;
}

/**
 * The export entry point: returns a signed bundle when the operator opted in, and `null` otherwise.
 *
 * Fail-safe by construction. Returning null (rather than throwing) on the opted-out path means a caller can
 * treat "no bundle" as the ordinary case, and any unexpected error while building one is swallowed into that
 * same null — an export problem must never reach the gate's own review/merge behavior, matching every other
 * feature's fail-safe convention in this codebase.
 */
export function exportFederatedSignatureBundle(
  config: FocusManifestFederatedIntelligenceConfig | null | undefined,
  input: FederatedExportInput,
  secret: string,
): SignedFederatedBundle | null {
  if (!isFederatedIntelligenceEnabled(config)) return null;
  try {
    const bundle = buildFederatedSignatureBundle(input);
    return { bundle, signature: signFederatedBundle(bundle, secret) };
  } catch {
    // Never let an export failure surface into the caller's review path (#6478).
    return null;
  }
}
