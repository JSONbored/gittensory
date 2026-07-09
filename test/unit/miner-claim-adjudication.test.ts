import { describe, expect, it } from "vitest";
import { adjudicateSoftClaim } from "../../packages/gittensory-miner/lib/claim-adjudication.js";

const EARLY = "2026-07-01T00:00:00.000Z";
const MID = "2026-07-03T00:00:00.000Z";
const LATE = "2026-07-05T00:00:00.000Z";

describe("adjudicateSoftClaim (#4291)", () => {
  it("wins with no competing claim (trivial winner)", () => {
    const r = adjudicateSoftClaim({ number: 7, claimedAt: EARLY }, []);
    expect(r).toEqual({ wins: true, winnerNumber: 7, contested: false });
  });

  it("treats a missing competing list as uncontested", () => {
    const r = adjudicateSoftClaim({ number: 7, claimedAt: EARLY });
    expect(r).toEqual({ wins: true, winnerNumber: 7, contested: false });
  });

  it("wins when this miner claimed strictly earliest among competitors", () => {
    const r = adjudicateSoftClaim({ number: 7, claimedAt: EARLY }, [{ number: 9, claimedAt: MID }]);
    expect(r.wins).toBe(true);
    expect(r.contested).toBe(true);
    expect(r.winnerNumber).toBe(7);
  });

  it("loses when a competitor claimed earlier, and names that winner", () => {
    const r = adjudicateSoftClaim({ number: 7, claimedAt: MID }, [{ number: 9, claimedAt: EARLY }]);
    expect(r.wins).toBe(false);
    expect(r.winnerNumber).toBe(9);
  });

  it("orders by the mapped claimedAt, not the PR number", () => {
    // Higher PR number (2) but earlier claim beats a lower number (1) that claimed later — proving `claimedAt` is
    // actually mapped to the election's `linkedIssueClaimedAt` rather than the members electing by number.
    const r = adjudicateSoftClaim({ number: 2, claimedAt: EARLY }, [{ number: 1, claimedAt: LATE }]);
    expect(r.wins).toBe(true);
  });

  it("fails closed when this miner's claim time is missing", () => {
    expect(adjudicateSoftClaim({ number: 7, claimedAt: null }, [{ number: 9, claimedAt: EARLY }]).wins).toBe(false);
    expect(adjudicateSoftClaim({ number: 7 }, [{ number: 9, claimedAt: EARLY }]).wins).toBe(false);
  });

  it("fails closed when a competitor's claim time is missing (sparse/invalid sibling)", () => {
    // A sibling with no election timestamp cannot be ordered against, so this miner cannot be proven the winner.
    expect(adjudicateSoftClaim({ number: 7, claimedAt: EARLY }, [{ number: 9, claimedAt: null }]).wins).toBe(false);
  });

  it("breaks an equal-timestamp tie by claim number (lower wins)", () => {
    expect(adjudicateSoftClaim({ number: 3, claimedAt: EARLY }, [{ number: 8, claimedAt: EARLY }]).wins).toBe(true);
    expect(adjudicateSoftClaim({ number: 8, claimedAt: EARLY }, [{ number: 3, claimedAt: EARLY }]).wins).toBe(false);
  });

  it("makes an unpublished claim (no number) lose an equal-timestamp tie to a real open PR", () => {
    const r = adjudicateSoftClaim({ claimedAt: EARLY }, [{ number: 5, claimedAt: EARLY }]);
    expect(r.wins).toBe(false);
    expect(r.winnerNumber).toBe(5);
  });
});
