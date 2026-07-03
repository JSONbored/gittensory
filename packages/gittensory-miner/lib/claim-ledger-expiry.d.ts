export type ClaimStatus = "active" | "expired";

export type LocalClaimRecord = {
  id: string;
  status: ClaimStatus;
  claimedAtMs: number;
};

export type ClaimLedgerSweepStore = {
  listActiveClaims(): LocalClaimRecord[];
  expireClaim(claimId: string, expiredAtMs: number): void;
};

export const DEFAULT_CLAIM_MAX_AGE_MS: number;

export function findExpiredClaims(
  claims: LocalClaimRecord[],
  nowMs: number,
  maxAgeMs: number,
): LocalClaimRecord[];

export function sweepExpiredClaims(
  store: ClaimLedgerSweepStore,
  nowMs: number,
  maxAgeMs?: number,
): LocalClaimRecord[];
