import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAIM_MAX_AGE_MS,
  findExpiredClaims,
  sweepExpiredClaims,
} from "../../packages/gittensory-miner/lib/claim-ledger-expiry.js";
import type {
  ClaimLedgerSweepStore,
  LocalClaimRecord,
} from "../../packages/gittensory-miner/lib/claim-ledger-expiry.js";

const NOW = 1_700_000_000_000;
const MAX_AGE = 14 * 24 * 60 * 60 * 1000;

function claim(overrides: Partial<LocalClaimRecord> = {}): LocalClaimRecord {
  return { id: "c1", status: "active", claimedAtMs: NOW, ...overrides };
}

describe("gittensory-miner claim-ledger expiry sweep (#2316)", () => {
  it("exposes a ~14-day default ceiling", () => {
    expect(DEFAULT_CLAIM_MAX_AGE_MS).toBe(MAX_AGE);
  });

  it("returns nothing when no active claim has aged past the ceiling", () => {
    const claims = [
      claim({ id: "fresh", claimedAtMs: NOW - 1000 }),
      claim({ id: "half", claimedAtMs: NOW - MAX_AGE / 2 }),
    ];
    expect(findExpiredClaims(claims, NOW, MAX_AGE)).toEqual([]);
  });

  it("returns every active claim when all have aged out", () => {
    const claims = [
      claim({ id: "a", claimedAtMs: NOW - MAX_AGE - 1 }),
      claim({ id: "b", claimedAtMs: NOW - MAX_AGE * 3 }),
    ];
    expect(findExpiredClaims(claims, NOW, MAX_AGE).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("selects only the aged-out claims in a mixed ledger, preserving order and references", () => {
    const stale = claim({ id: "stale", claimedAtMs: NOW - MAX_AGE - 5 });
    const claims = [
      claim({ id: "fresh", claimedAtMs: NOW - 10 }),
      stale,
      claim({ id: "recent", claimedAtMs: NOW - 1 }),
    ];
    const expired = findExpiredClaims(claims, NOW, MAX_AGE);
    expect(expired).toEqual([stale]);
    expect(expired[0]).toBe(stale);
  });

  it("treats the exact boundary (age === maxAgeMs) as expired but one ms under as active", () => {
    const onBoundary = claim({ id: "boundary", claimedAtMs: NOW - MAX_AGE });
    const underBoundary = claim({ id: "under", claimedAtMs: NOW - MAX_AGE + 1 });
    expect(findExpiredClaims([onBoundary, underBoundary], NOW, MAX_AGE)).toEqual([onBoundary]);
  });

  it("never expires a non-active claim", () => {
    const claims = [claim({ id: "done", status: "expired", claimedAtMs: NOW - MAX_AGE * 2 })];
    expect(findExpiredClaims(claims, NOW, MAX_AGE)).toEqual([]);
  });

  it("fails closed on a future timestamp (negative age)", () => {
    const claims = [claim({ id: "future", claimedAtMs: NOW + MAX_AGE })];
    expect(findExpiredClaims(claims, NOW, MAX_AGE)).toEqual([]);
  });

  it("fails closed on missing or non-finite claim timing", () => {
    const claims = [
      claim({ id: "nan", claimedAtMs: Number.NaN }),
      claim({ id: "infinite", claimedAtMs: Number.POSITIVE_INFINITY }),
      { id: "untimed", status: "active" } as unknown as LocalClaimRecord,
    ];
    expect(findExpiredClaims(claims, NOW, MAX_AGE)).toEqual([]);
  });

  it("ignores nullish rows without throwing", () => {
    const claims = [null, undefined, claim({ id: "old", claimedAtMs: NOW - MAX_AGE })] as unknown as LocalClaimRecord[];
    expect(findExpiredClaims(claims, NOW, MAX_AGE).map((c) => c.id)).toEqual(["old"]);
  });

  it("rejects malformed arguments", () => {
    expect(() => findExpiredClaims(null as unknown as LocalClaimRecord[], NOW, MAX_AGE)).toThrow("invalid_claims");
    expect(() => findExpiredClaims([], Number.NaN, MAX_AGE)).toThrow("invalid_now_ms");
    expect(() => findExpiredClaims([], NOW, Number.NaN)).toThrow("invalid_max_age_ms");
    expect(() => findExpiredClaims([], NOW, -1)).toThrow("invalid_max_age_ms");
  });

  describe("sweepExpiredClaims", () => {
    function fakeStore(claims: LocalClaimRecord[]): ClaimLedgerSweepStore & { expired: Array<[string, number]> } {
      const expired: Array<[string, number]> = [];
      return {
        expired,
        listActiveClaims: () => claims,
        expireClaim: (claimId, expiredAtMs) => {
          expired.push([claimId, expiredAtMs]);
        },
      };
    }

    it("transitions each expired claim through the store and returns them", () => {
      const store = fakeStore([
        claim({ id: "fresh", claimedAtMs: NOW - 1 }),
        claim({ id: "stale", claimedAtMs: NOW - MAX_AGE - 1 }),
      ]);
      const result = sweepExpiredClaims(store, NOW, MAX_AGE);
      expect(result.map((c) => c.id)).toEqual(["stale"]);
      expect(store.expired).toEqual([["stale", NOW]]);
    });

    it("uses the default ceiling when maxAgeMs is omitted", () => {
      const store = fakeStore([claim({ id: "aged", claimedAtMs: NOW - DEFAULT_CLAIM_MAX_AGE_MS })]);
      expect(sweepExpiredClaims(store, NOW).map((c) => c.id)).toEqual(["aged"]);
      expect(store.expired).toEqual([["aged", NOW]]);
    });

    it("makes no store writes when nothing is stale", () => {
      const store = fakeStore([claim({ id: "fresh", claimedAtMs: NOW })]);
      expect(sweepExpiredClaims(store, NOW, MAX_AGE)).toEqual([]);
      expect(store.expired).toEqual([]);
    });

    it("rejects a store missing the required APIs", () => {
      expect(() => sweepExpiredClaims(null as unknown as ClaimLedgerSweepStore, NOW, MAX_AGE)).toThrow(
        "invalid_claim_ledger_store",
      );
      expect(() =>
        sweepExpiredClaims({ listActiveClaims: () => [] } as unknown as ClaimLedgerSweepStore, NOW, MAX_AGE),
      ).toThrow("invalid_claim_ledger_store");
    });
  });
});
