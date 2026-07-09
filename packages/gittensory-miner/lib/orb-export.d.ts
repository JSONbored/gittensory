export function bucketReasonCode(summary: string | null | undefined): string;

export function isMinerOrbExportEnabled(
  env?: Record<string, string | undefined>,
  config?: { orbExport?: boolean },
): boolean;

export function resolveOrbExportStateDbPath(env?: Record<string, string | undefined>): string;

export interface OrbExportStateStore {
  dbPath: string;
  getFlag(key: string): string | null;
  setFlag(key: string, value: string): void;
  close(): void;
}

export function initOrbExportStateStore(dbPath?: string): OrbExportStateStore;

export function closeDefaultOrbExportStateStore(): void;

export function minerInstanceId(anonSecret: string): string;

export function hmacField(value: string, secret: string): string;

export function buildTargetId(repoFullName: string, prNumber: number): string;

export function getOrCreateAnonSecret(stateStore: OrbExportStateStore): string;

export function readLastExportedSeq(stateStore: OrbExportStateStore): number;

export function writeLastExportedSeq(stateStore: OrbExportStateStore, seq: number): void;

export interface MinerOrbFleetEvent {
  repo_hash: string;
  pr_hash: string;
  gate_verdict: string | null;
  outcome: string;
  reversal_flag: "none";
  gate_reasoncode_bucket: string;
  time_to_close_ms: null;
  decision_timestamp: null;
  outcome_timestamp: string;
}

export interface MinerOrbLedgerEntry {
  seq: number;
  type: string;
  repoFullName: string;
  payload: unknown;
  createdAt?: string;
}

export function ledgerEntryToFleetEvent(
  entry: MinerOrbLedgerEntry,
  options?: { secret?: string; anonymize?: boolean },
): MinerOrbFleetEvent | null;

export interface MinerOrbEventLedger {
  readEvents(filter?: { since?: number; repoFullName?: string }): unknown[];
}

export function selectPrOutcomeEvents(
  eventLedger: MinerOrbEventLedger,
  since: number,
  batchSize: number,
): MinerOrbLedgerEntry[];

export interface ExportMinerOrbBatchOptions {
  env?: Record<string, string | undefined>;
  config?: { orbExport?: boolean };
  eventLedger?: MinerOrbEventLedger;
  stateStore?: OrbExportStateStore;
  stateDbPath?: string;
  batchSize?: number;
  fetchFn?: typeof fetch;
}

export function exportMinerOrbBatch(options?: ExportMinerOrbBatchOptions): Promise<number>;
