import { initEventLedger } from "./event-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { isValidRepoSegment } from "./repo-clone.js";
const LEDGER_LIST_USAGE = "Usage: loopover-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]";
function parseRepoArg(value, usage) {
    if (!value)
        return { error: usage };
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined || !isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
        return { error: "Repository must be in owner/repo form." };
    }
    return { repoFullName: `${owner}/${repo}` };
}
function parseSinceArg(value) {
    const since = Number(value);
    if (!Number.isInteger(since) || since < 0) {
        return { error: "since must be a non-negative integer seq cursor." };
    }
    return { since };
}
export function parseLedgerListArgs(args) {
    const options = {
        json: false,
        repoFullName: null,
        since: null,
        type: null,
    };
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--repo") {
            const repoArg = args[index + 1];
            if (!repoArg || repoArg.startsWith("-"))
                return { error: LEDGER_LIST_USAGE };
            const repo = parseRepoArg(repoArg, LEDGER_LIST_USAGE);
            if ("error" in repo)
                return repo;
            options.repoFullName = repo.repoFullName;
            index += 1;
            continue;
        }
        if (token === "--since") {
            const sinceArg = args[index + 1];
            if (!sinceArg || sinceArg.startsWith("--"))
                return { error: LEDGER_LIST_USAGE };
            const parsedSince = parseSinceArg(sinceArg);
            if ("error" in parsedSince)
                return parsedSince;
            options.since = parsedSince.since;
            index += 1;
            continue;
        }
        if (token === "--type") {
            const type = args[index + 1];
            if (!type || type.startsWith("-"))
                return { error: LEDGER_LIST_USAGE };
            options.type = type.trim();
            index += 1;
            continue;
        }
        if (token.startsWith("-"))
            return { error: `Unknown option: ${token}` };
        positional.push(token);
    }
    if (positional.length > 0)
        return { error: LEDGER_LIST_USAGE };
    return options;
}
export function filterLedgerEvents(events, options = {}) {
    if (!Array.isArray(events))
        return [];
    const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
    if (!type)
        return events;
    return events.filter((entry) => entry.type === type);
}
/** Metadata-only audit-feed columns exposed by the MCP tool (#5158). */
export const AUDIT_FEED_ENTRY_FIELDS = Object.freeze([
    "eventType",
    "repoFullName",
    "outcome",
    "actor",
    "detail",
    "createdAt",
]);
function optionalMetadataString(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
/** Project one ledger row to the public, metadata-only audit-feed shape — never returns payload_json. */
export function projectLedgerEventToAuditFeedEntry(entry) {
    const payload = entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
        ? entry.payload
        : {};
    return {
        eventType: entry.type,
        repoFullName: entry.repoFullName,
        outcome: optionalMetadataString(payload.outcome),
        actor: optionalMetadataString(payload.actor),
        detail: optionalMetadataString(payload.detail),
        createdAt: entry.createdAt,
    };
}
/** Normalize optional MCP/JSON filter args into the shape `ledger list` already uses (#5158). */
export function normalizeAuditFeedMcpFilter(input = {}) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("filter must be an object");
    }
    const filter = { repoFullName: null, since: null, type: null };
    if (input.repoFullName !== undefined && input.repoFullName !== null) {
        const repo = parseRepoArg(String(input.repoFullName), "repoFullName must be in owner/repo form.");
        if ("error" in repo)
            throw new Error(repo.error);
        filter.repoFullName = repo.repoFullName;
    }
    if (input.since !== undefined && input.since !== null) {
        const parsedSince = parseSinceArg(String(input.since));
        if ("error" in parsedSince)
            throw new Error(parsedSince.error);
        filter.since = parsedSince.since;
    }
    if (input.type !== undefined && input.type !== null) {
        const trimmed = String(input.type).trim();
        if (!trimmed)
            throw new Error("type must be a non-empty string.");
        filter.type = trimmed;
    }
    return filter;
}
/** Read-only audit feed shared by the MCP audit-feed tool (#5158). */
export function collectEventLedgerAuditFeed(eventLedger, filter = {}) {
    const events = filterLedgerEvents(eventLedger.readEvents({
        repoFullName: filter.repoFullName ?? null,
        since: filter.since ?? null,
    }), { type: filter.type ?? null });
    return {
        ...(filter.repoFullName ? { repoFullName: filter.repoFullName } : {}),
        events: events.map(projectLedgerEventToAuditFeedEntry),
    };
}
function display(value) {
    if (value === null || value === undefined)
        return "-";
    return String(value);
}
export function renderLedgerTable(events) {
    if (!Array.isArray(events) || events.length === 0)
        return "no event ledger entries";
    const header = [
        "seq".padStart(4),
        "type".padEnd(20),
        "repo".padEnd(24),
        "created-at".padEnd(24),
    ].join(" ");
    const lines = events.map((entry) => [
        String(entry.seq).padStart(4),
        entry.type.padEnd(20),
        display(entry.repoFullName).padEnd(24),
        display(entry.createdAt).padEnd(24),
    ].join(" "));
    return [header, ...lines].join("\n");
}
const EVENT_LEDGER_METRICS_USAGE = "Usage: loopover-miner ledger metrics";
// Prometheus metric name for the per-type event-ledger counter. Mirrors the `loopover_miner_*_total` naming and
// the HELP/TYPE/label conventions of the engine's renderMinerPredictionMetrics
// (packages/loopover-engine/src/miner-prediction-metrics.ts) rather than importing across the package boundary.
const MINER_EVENTS_TOTAL = "loopover_miner_events_total";
/** HELP-text escaping — backslash + newline (mirrors miner-prediction-metrics.ts's escapeHelpText). */
function escapeHelpText(help) {
    return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
/** Prometheus label-value escaping — backslash, double-quote, newline — so an arbitrary event `type` string can
 *  never break the metric line (mirrors miner-prediction-metrics.ts's escapeLabelValue). */
function escapeLabelValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
/**
 * Render event-ledger activity as Prometheus text-exposition counters: one `loopover_miner_events_total{type}`
 * series per event type, so a self-hoster's own Grafana/alerting can scrape ledger activity instead of polling
 * `ledger list --json` (#4841). Pure + side-effect-free — the caller supplies the rows and prints the result;
 * deterministic (series emitted in sorted type order); always emits HELP/TYPE so an empty ledger is still a
 * well-formed exposition document.
 */
export function renderEventLedgerMetrics(events) {
    const totalByType = new Map();
    for (const entry of events) {
        totalByType.set(entry.type, (totalByType.get(entry.type) ?? 0) + 1);
    }
    const lines = [
        `# HELP ${MINER_EVENTS_TOTAL} ${escapeHelpText("Event-ledger entries the miner has recorded, by event type.")}`,
        `# TYPE ${MINER_EVENTS_TOTAL} counter`,
    ];
    for (const [type, count] of [...totalByType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`${MINER_EVENTS_TOTAL}{type="${escapeLabelValue(type)}"} ${count}`);
    }
    return `${lines.join("\n")}\n`;
}
function withEventLedger(options, run) {
    const ownsLedger = options.initEventLedger === undefined;
    const eventLedger = (options.initEventLedger ?? initEventLedger)();
    try {
        return run(eventLedger);
    }
    finally {
        if (ownsLedger)
            eventLedger.close();
    }
}
export function runLedgerList(args, options = {}) {
    const parsed = parseLedgerListArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    try {
        return withEventLedger(options, (eventLedger) => {
            const events = filterLedgerEvents(eventLedger.readEvents({
                repoFullName: parsed.repoFullName,
                since: parsed.since,
            }), { type: parsed.type });
            if (parsed.json) {
                console.log(JSON.stringify({ events }, null, 2));
            }
            else {
                console.log(renderLedgerTable(events));
            }
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
export function runLedgerMetrics(args, options = {}) {
    if (args.length > 0) {
        return reportCliFailure(argsWantJson(args), EVENT_LEDGER_METRICS_USAGE);
    }
    try {
        return withEventLedger(options, (eventLedger) => {
            // renderEventLedgerMetrics returns a newline-terminated document; console.log re-adds the terminator, so
            // trim it to emit exactly one trailing newline (mirrors metrics-cli.js's runMetrics).
            console.log(renderEventLedgerMetrics(eventLedger.readEvents()).trimEnd());
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(argsWantJson(args), describeCliError(error));
    }
}
export function runLedgerCli(subcommand, args, options = {}) {
    if (subcommand === "list")
        return runLedgerList(args, options);
    if (subcommand === "metrics")
        return runLedgerMetrics(args, options);
    return reportCliFailure(argsWantJson(args), `Unknown ledger subcommand: ${subcommand ?? ""}. ${LEDGER_LIST_USAGE}`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnQtbGVkZ2VyLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImV2ZW50LWxlZGdlci1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXBELE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUVyRCxNQUFNLGlCQUFpQixHQUNyQix1R0FBdUcsQ0FBQztBQWExRyxTQUFTLFlBQVksQ0FBQyxLQUF5QixFQUFFLEtBQWE7SUFDNUQsSUFBSSxDQUFDLEtBQUs7UUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQ3BDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ2hELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUN0RyxPQUFPLEVBQUUsS0FBSyxFQUFFLHdDQUF3QyxFQUFFLENBQUM7SUFDN0QsQ0FBQztJQUNELE9BQU8sRUFBRSxZQUFZLEVBQUUsR0FBRyxLQUFLLElBQUksSUFBSSxFQUFFLEVBQUUsQ0FBQztBQUM5QyxDQUFDO0FBRUQsU0FBUyxhQUFhLENBQUMsS0FBYTtJQUNsQyxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FB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