import type { EventLedger, LedgerEntry } from "./event-ledger.js";

export type ParsedLedgerListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      since: number | null;
      type: string | null;
    }
  | { error: string };

export function parseLedgerListArgs(args: string[]): ParsedLedgerListArgs;

export function filterLedgerEvents(
  events: LedgerEntry[],
  options?: { type?: string | null },
): LedgerEntry[];

export const AUDIT_FEED_ENTRY_FIELDS: readonly [
  "eventType",
  "repoFullName",
  "outcome",
  "actor",
  "detail",
  "createdAt",
];

export function projectLedgerEventToAuditFeedEntry(entry: LedgerEntry): {
  eventType: string;
  repoFullName: string | null;
  outcome: string | null;
  actor: string | null;
  detail: string | null;
  createdAt: string;
};

export type AuditFeedMcpFilterInput = {
  repoFullName?: string | null;
  since?: number | null;
  type?: string | null;
};

export function normalizeAuditFeedMcpFilter(input?: AuditFeedMcpFilterInput): {
  repoFullName: string | null;
  since: number | null;
  type: string | null;
};

export function collectEventLedgerAuditFeed(
  eventLedger: EventLedger,
  filter?: { repoFullName?: string | null; since?: number | null; type?: string | null },
): {
  repoFullName?: string;
  events: Array<{
    eventType: string;
    repoFullName: string | null;
    outcome: string | null;
    actor: string | null;
    detail: string | null;
    createdAt: string;
  }>;
};

export function renderLedgerTable(events: LedgerEntry[]): string;

export function renderEventLedgerMetrics(events: readonly LedgerEntry[]): string;

export function runLedgerList(
  args: string[],
  options?: { initEventLedger?: () => EventLedger },
): number;

export function runLedgerMetrics(
  args: string[],
  options?: { initEventLedger?: () => EventLedger },
): number;

export function runLedgerCli(
  subcommand: string | undefined,
  args: string[],
  options?: { initEventLedger?: () => EventLedger },
): number;
