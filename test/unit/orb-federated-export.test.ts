import { describe, expect, it } from "vitest";

import {
  buildFederatedSignatureBundle,
  canonicalizeFederatedBundle,
  exportFederatedSignatureBundle,
  FEDERATED_BUNDLE_SCHEMA_VERSION,
  isFederatedIntelligenceEnabled,
  signFederatedBundle,
  verifyFederatedBundle,
  type FederatedCalibrationSignature,
  type FederatedExportInput,
} from "../../src/orb/federated-export";

const SECRET = "instance-anon-secret";

const SIGNATURE: FederatedCalibrationSignature = {
  gateVerdict: "merge",
  outcome: "merged",
  reversalFlag: "none",
  gateReasoncodeBucket: "issue_policy",
  timeToCloseMs: 3_600_000,
};

const INPUT: FederatedExportInput = {
  instanceId: "inst-abc123",
  generatedAt: "2026-07-16T00:00:00.000Z",
  signatures: [SIGNATURE],
};

const ON = { present: true, enabled: true };
const OFF = { present: true, enabled: false };

describe("federated intelligence opt-in gate (#6478)", () => {
  it("is off for absent config, an absent block, and an explicit false", () => {
    expect(isFederatedIntelligenceEnabled(undefined)).toBe(false);
    expect(isFederatedIntelligenceEnabled(null)).toBe(false);
    expect(
      isFederatedIntelligenceEnabled({ present: false, enabled: false }),
    ).toBe(false);
    expect(isFederatedIntelligenceEnabled(OFF)).toBe(false);
  });

  it("is on only for an explicit enabled: true", () => {
    expect(isFederatedIntelligenceEnabled(ON)).toBe(true);
  });

  it("an opted-out instance produces NO bundle at all", () => {
    expect(exportFederatedSignatureBundle(OFF, INPUT, SECRET)).toBeNull();
    expect(exportFederatedSignatureBundle(undefined, INPUT, SECRET)).toBeNull();
    expect(exportFederatedSignatureBundle(null, INPUT, SECRET)).toBeNull();
    expect(
      exportFederatedSignatureBundle(
        { present: false, enabled: false },
        INPUT,
        SECRET,
      ),
    ).toBeNull();
  });
});

describe("federated signature bundle contents (#6478)", () => {
  // The auditable allowlist. This is the schema guard the issue asks for: adding a field to the exported
  // shape fails HERE, so a new field can only ship with someone deliberately widening this list.
  it("SCHEMA: a signature carries exactly the five allowlisted fields and nothing else", () => {
    const bundle = buildFederatedSignatureBundle(INPUT);
    expect(Object.keys(bundle.signatures[0]!).sort()).toEqual([
      "gateReasoncodeBucket",
      "gateVerdict",
      "outcome",
      "reversalFlag",
      "timeToCloseMs",
    ]);
  });

  it("SCHEMA: the bundle envelope carries exactly schemaVersion, instanceId, generatedAt, signatures", () => {
    expect(Object.keys(buildFederatedSignatureBundle(INPUT)).sort()).toEqual([
      "generatedAt",
      "instanceId",
      "schemaVersion",
      "signatures",
    ]);
  });

  it("drops any field the caller supplies that is not on the allowlist", () => {
    // A caller holding a richer row (the Orb collector's FleetEvent carries repo_hash/pr_hash) must not be
    // able to leak it through by passing the whole object -- the bundle is constructed field-by-field.
    const leaky = {
      ...SIGNATURE,
      repo_hash: "deadbeef",
      pr_hash: "cafebabe",
      prBody: "secret",
    } as FederatedCalibrationSignature;
    const bundle = buildFederatedSignatureBundle({
      ...INPUT,
      signatures: [leaky],
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("cafebabe");
    expect(serialized).not.toContain("secret");
  });

  it("stamps the schema version so a peer can reject a shape it doesn't understand", () => {
    expect(buildFederatedSignatureBundle(INPUT).schemaVersion).toBe(
      FEDERATED_BUNDLE_SCHEMA_VERSION,
    );
  });

  it("carries every signature it was given, in order", () => {
    const second: FederatedCalibrationSignature = {
      ...SIGNATURE,
      outcome: "closed",
      reversalFlag: "reverted",
    };
    const bundle = buildFederatedSignatureBundle({
      ...INPUT,
      signatures: [SIGNATURE, second],
    });
    expect(bundle.signatures).toEqual([SIGNATURE, second]);
  });

  it("handles an empty signature set (an opted-in instance with nothing resolved yet)", () => {
    expect(
      buildFederatedSignatureBundle({ ...INPUT, signatures: [] }).signatures,
    ).toEqual([]);
  });

  it("preserves a null gateVerdict and a null timeToCloseMs rather than coercing them", () => {
    const sparse: FederatedCalibrationSignature = {
      ...SIGNATURE,
      gateVerdict: null,
      timeToCloseMs: null,
    };
    const bundle = buildFederatedSignatureBundle({
      ...INPUT,
      signatures: [sparse],
    });
    expect(bundle.signatures[0]!.gateVerdict).toBeNull();
    expect(bundle.signatures[0]!.timeToCloseMs).toBeNull();
  });
});

describe("federated bundle signing (#6478)", () => {
  it("an opted-in instance produces a bundle whose signature verifies", () => {
    const signed = exportFederatedSignatureBundle(ON, INPUT, SECRET);
    expect(signed).not.toBeNull();
    expect(verifyFederatedBundle(signed!, SECRET)).toBe(true);
  });

  it("rejects a tampered bundle body", () => {
    const signed = exportFederatedSignatureBundle(ON, INPUT, SECRET)!;
    const tampered = {
      ...signed,
      bundle: {
        ...signed.bundle,
        signatures: [{ ...SIGNATURE, outcome: "closed" }],
      },
    };
    expect(verifyFederatedBundle(tampered, SECRET)).toBe(false);
  });

  it("rejects a bundle signed with a different instance's secret", () => {
    const signed = exportFederatedSignatureBundle(ON, INPUT, SECRET)!;
    expect(verifyFederatedBundle(signed, "someone-elses-secret")).toBe(false);
  });

  it("signs deterministically: the same bundle and secret always produce the same signature", () => {
    const a = signFederatedBundle(buildFederatedSignatureBundle(INPUT), SECRET);
    const b = signFederatedBundle(buildFederatedSignatureBundle(INPUT), SECRET);
    expect(a).toBe(b);
  });

  it("canonicalization is order-independent, so a re-serialized bundle still verifies", () => {
    const bundle = buildFederatedSignatureBundle(INPUT);
    // A peer that parsed and rebuilt the object with keys in a different order must sign identically.
    const reordered = {
      signatures: bundle.signatures.map((s) => ({
        timeToCloseMs: s.timeToCloseMs,
        gateReasoncodeBucket: s.gateReasoncodeBucket,
        reversalFlag: s.reversalFlag,
        outcome: s.outcome,
        gateVerdict: s.gateVerdict,
      })),
      generatedAt: bundle.generatedAt,
      instanceId: bundle.instanceId,
      schemaVersion: bundle.schemaVersion,
    } as typeof bundle;
    expect(canonicalizeFederatedBundle(reordered)).toBe(
      canonicalizeFederatedBundle(bundle),
    );
    expect(
      verifyFederatedBundle(
        { bundle: reordered, signature: signFederatedBundle(bundle, SECRET) },
        SECRET,
      ),
    ).toBe(true);
  });

  it("the signature covers the instance id, so a bundle can't be replayed as another instance's", () => {
    const signed = exportFederatedSignatureBundle(ON, INPUT, SECRET)!;
    const impersonated = {
      ...signed,
      bundle: { ...signed.bundle, instanceId: "inst-someone-else" },
    };
    expect(verifyFederatedBundle(impersonated, SECRET)).toBe(false);
  });
});

describe("federated export fail-safe (#6478)", () => {
  it("returns null instead of throwing when building the bundle fails", () => {
    // A caller whose signature list explodes on read must not take the gate's review path down with it.
    const exploding = {
      instanceId: "inst-abc123",
      generatedAt: "2026-07-16T00:00:00.000Z",
      get signatures(): readonly FederatedCalibrationSignature[] {
        throw new Error("store unavailable");
      },
    } as FederatedExportInput;
    expect(() =>
      exportFederatedSignatureBundle(ON, exploding, SECRET),
    ).not.toThrow();
    expect(exportFederatedSignatureBundle(ON, exploding, SECRET)).toBeNull();
  });
});
