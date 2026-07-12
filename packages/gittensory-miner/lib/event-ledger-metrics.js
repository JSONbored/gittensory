// Event-ledger scrape surface (#4841): a pure Prometheus text-exposition renderer that turns the miner's local
// event-ledger audit trail into scrape-able counters, so a self-hoster's Grafana/alerting can ingest event activity
// without polling `ledger list --json`. Side-effect-free — a caller reads the ledger and prints this — mirroring the
// metric-naming (`gittensory_miner_*_total`) and HELP/TYPE/escaping conventions of the miner prediction renderer
// (packages/gittensory-engine/src/miner-prediction-metrics.ts).

export const MINER_EVENTS_TOTAL = "gittensory_miner_events_total";

/** HELP text escapes backslash and newline. */
function escapeHelpText(help) {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Prometheus label-value escaping (backslash, double-quote, newline) so an arbitrary event type can never break
 *  the line. */
function escapeLabelValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render event-ledger entries as Prometheus text-exposition format: one `gittensory_miner_events_total{type="..."}`
 * counter per distinct event type, emitted in sorted order for deterministic output. Always emits HELP/TYPE, so the
 * surface is well-formed even for an empty ledger.
 * @param {ReadonlyArray<{ type: string }>} events
 * @returns {string}
 */
export function renderEventLedgerMetrics(events) {
  const totalByType = new Map();
  for (const event of events) {
    totalByType.set(event.type, (totalByType.get(event.type) ?? 0) + 1);
  }

  const lines = [];
  lines.push(`# HELP ${MINER_EVENTS_TOTAL} ${escapeHelpText("Entries recorded in the miner's local event ledger, by event type.")}`);
  lines.push(`# TYPE ${MINER_EVENTS_TOTAL} counter`);
  for (const [type, count] of [...totalByType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${MINER_EVENTS_TOTAL}{type="${escapeLabelValue(type)}"} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}
