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
    const payload = entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {};
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
        ...(filter.repoFullName !== undefined ? { repoFullName: filter.repoFullName } : {}),
        ...(filter.since !== undefined ? { since: filter.since } : {}),
    }), { ...(filter.type !== undefined ? { type: filter.type } : {}) });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZlbnQtbGVkZ2VyLWNsaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImV2ZW50LWxlZGdlci1jbGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRXBELE9BQU8sRUFBRSxZQUFZLEVBQUUsZ0JBQWdCLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUNsRixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUVyRCxNQUFNLGlCQUFpQixHQUNyQix1R0FBdUcsQ0FBQztBQWdCMUcsU0FBUyxZQUFZLENBQUMsS0FBeUIsRUFBRSxLQUFhO0lBQzVELElBQUksQ0FBQyxLQUFLO1FBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUNwQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDN0IsTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNoRCxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssS0FBSyxTQUFTLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDdEcsT0FBTyxFQUFFLEtBQUssRUFBRSx3Q0FBd0MsRUFBRSxDQUFDO0lBQzdELENBQUM7SUFDRCxPQUFPLEVBQUUsWUFBWSxFQUFFLEdBQUcsS0FBSyxJQUFJLElBQUksRUFBRSxFQUFFLENBQUM7QUFDOUMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLEtBQWE7SUFDbEMsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzVCLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUMxQyxPQUFPLEVBQUUsS0FBSyxFQUFFLGtEQUFrRCxFQUFFLENBQUM7SUFDdkUsQ0FBQztJQUNELE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQztBQUNuQixDQUFDO0FBRUQsTUFBTSxVQUFVLG1CQUFtQixDQUFDLElBQWM7SUFDaEQsTUFBTSxPQUFPLEdBQThGO1FBQ3pHLElBQUksRUFBRSxLQUFLO1FBQ1gsWUFBWSxFQUFFLElBQUk7UUFDbEIsS0FBSyxFQUFFLElBQUk7UUFDWCxJQUFJLEVBQUUsSUFBSTtLQUNYLENBQUM7SUFDRixNQUFNLFVBQVUsR0FBYSxFQUFFLENBQUM7SUFFaEMsS0FBSyxJQUFJLEtBQUssR0FBRyxDQUFDLEVBQUUsS0FBSyxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3BELE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUUsQ0FBQztRQUMzQixJQUFJLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN2QixPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztZQUNwQixTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDaEMsSUFBSSxDQUFDLE9BQU8sSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztnQkFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLGlCQUFpQixFQUFFLENBQUM7WUFDN0UsTUFBTSxJQUFJLEdBQUcsWUFBWSxDQUFDLE9BQU8sRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO1lBQ3RELElBQUksT0FBTyxJQUFJLElBQUk7Z0JBQUUsT0FBTyxJQUFJLENBQUM7WUFDakMsT0FBTyxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDO1lBQ3pDLEtBQUssSUFBSSxDQUFDLENBQUM7WUFDWCxTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDakMsSUFBSSxDQUFDLFFBQVEsSUFBSSxRQUFRLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQztnQkFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLGlCQUFpQixFQUFFLENBQUM7WUFDaEYsTUFBTSxXQUFXLEdBQUcsYUFBYSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1lBQzVDLElBQUksT0FBTyxJQUFJLFdBQVc7Z0JBQUUsT0FBTyxXQUFXLENBQUM7WUFDL0MsT0FBTyxDQUFDLEtBQUssR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDO1lBQ2xDLEtBQUssSUFBSSxDQUFDLENBQUM7WUFDWCxTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDN0IsSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztnQkFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLGlCQUFpQixFQUFFLENBQUM7WUFDdkUsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDM0IsS0FBSyxJQUFJLENBQUMsQ0FBQztZQUNYLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztZQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsbUJBQW1CLEtBQUssRUFBRSxFQUFFLENBQUM7UUFDeEUsVUFBVSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBRUQsSUFBSSxVQUFVLENBQUMsTUFBTSxHQUFHLENBQUM7UUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLGlCQUFpQixFQUFFLENBQUM7SUFDL0QsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQztBQUVELE1BQU0sVUFBVSxrQkFBa0IsQ0FDaEMsTUFBcUIsRUFDckIsVUFBb0MsRUFBRTtJQUV0QyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUN0QyxNQUFNLElBQUksR0FBRyxPQUFPLE9BQU8sQ0FBQyxJQUFJLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNsRyxJQUFJLENBQUMsSUFBSTtRQUFFLE9BQU8sTUFBTSxDQUFDO0lBQ3pCLE9BQU8sTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQztBQUN2RCxDQUFDO0FBRUQsd0VBQXdFO0FBQ3hFLE1BQU0sQ0FBQyxNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDbkQsV0FBVztJQUNYLGNBQWM7SUFDZCxTQUFTO0lBQ1QsT0FBTztJQUNQLFFBQVE7SUFDUixXQUFXO0NBQ0gsQ0FBQyxDQUFDO0FBRVosU0FBUyxzQkFBc0IsQ0FBQyxLQUFjO0lBQzVDLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixPQUFPLE9BQU8sSUFBSSxJQUFJLENBQUM7QUFDekIsQ0FBQztBQVdELHlHQUF5RztBQUN6RyxNQUFNLFVBQVUsa0NBQWtDLENBQUMsS0FBa0I7SUFDbkUsTUFBTSxPQUFPLEdBQ1gsS0FBSyxFQUFFLE9BQU8sSUFBSSxPQUFPLEtBQUssQ0FBQyxPQUFPLEtBQUssUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUM1RyxPQUFPO1FBQ0wsU0FBUyxFQUFFLEtBQUssQ0FBQyxJQUFJO1FBQ3JCLFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtRQUNoQyxPQUFPLEVBQUUsc0JBQXNCLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQztRQUNoRCxLQUFLLEVBQUUsc0JBQXNCLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQztRQUM1QyxNQUFNLEVBQUUsc0JBQXNCLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQztRQUM5QyxTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVM7S0FDM0IsQ0FBQztBQUNKLENBQUM7QUFjRCxpR0FBaUc7QUFDakcsTUFBTSxVQUFVLDJCQUEyQixDQUFDLFFBQWlDLEVBQUU7SUFDN0UsSUFBSSxLQUFLLEtBQUssSUFBSSxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDeEUsTUFBTSxJQUFJLEtBQUssQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQzlDLENBQUM7SUFDRCxNQUFNLE1BQU0sR0FBOEIsRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxDQUFDO0lBQzFGLElBQUksS0FBSyxDQUFDLFlBQVksS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLFlBQVksS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUNwRSxNQUFNLElBQUksR0FBRyxZQUFZLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUMsRUFBRSwwQ0FBMEMsQ0FBQyxDQUFDO1FBQ2xHLElBQUksT0FBTyxJQUFJLElBQUk7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqRCxNQUFNLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUM7SUFDMUMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLEtBQUssS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLEtBQUssS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUN0RCxNQUFNLFdBQVcsR0FBRyxhQUFhLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3ZELElBQUksT0FBTyxJQUFJLFdBQVc7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMvRCxNQUFNLENBQUMsS0FBSyxHQUFHLFdBQVcsQ0FBQyxLQUFLLENBQUM7SUFDbkMsQ0FBQztJQUNELElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUNwRCxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQzFDLElBQUksQ0FBQyxPQUFPO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxrQ0FBa0MsQ0FBQyxDQUFDO1FBQ2xFLE1BQU0sQ0FBQyxJQUFJLEdBQUcsT0FBTyxDQUFDO0lBQ3hCLENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDO0FBRUQsc0VBQXNFO0FBQ3RFLE1BQU0sVUFBVSwyQkFBMkIsQ0FDekMsV0FBd0IsRUFDeEIsU0FBd0YsRUFBRTtJQUUxRixNQUFNLE1BQU0sR0FBRyxrQkFBa0IsQ0FDL0IsV0FBVyxDQUFDLFVBQVUsQ0FBQztRQUNyQixHQUFHLENBQUMsTUFBTSxDQUFDLFlBQVksS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxFQUFFLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ25GLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7S0FDL0QsQ0FBQyxFQUNGLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQ2hFLENBQUM7SUFDRixPQUFPO1FBQ0wsR0FBRyxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEVBQUUsWUFBWSxFQUFFLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3JFLE1BQU0sRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLGtDQUFrQyxDQUFDO0tBQ3ZELENBQUM7QUFDSixDQUFDO0FBRUQsU0FBUyxPQUFPLENBQUMsS0FBYztJQUM3QixJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxPQUFPLEdBQUcsQ0FBQztJQUN0RCxPQUFPLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUN2QixDQUFDO0FBRUQsTUFBTSxVQUFVLGlCQUFpQixDQUFDLE1BQXFCO0lBQ3JELElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQztRQUFFLE9BQU8seUJBQXlCLENBQUM7SUFDcEYsTUFBTSxNQUFNLEdBQUc7UUFDYixLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztRQUNqQixNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUNqQixNQUFNLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUNqQixZQUFZLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztLQUN4QixDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNaLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUNqQztRQUNFLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztRQUM3QixLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDckIsT0FBTyxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3RDLE9BQU8sQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztLQUNwQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FDWixDQUFDO0lBQ0YsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN2QyxDQUFDO0FBRUQsTUFBTSwwQkFBMEIsR0FBRyxzQ0FBc0MsQ0FBQztBQUUxRSxnSEFBZ0g7QUFDaEgsK0VBQStFO0FBQy9FLGdIQUFnSDtBQUNoSCxNQUFNLGtCQUFrQixHQUFHLDZCQUE2QixDQUFDO0FBRXpELHVHQUF1RztBQUN2RyxTQUFTLGNBQWMsQ0FBQyxJQUFZO0lBQ2xDLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztBQUMzRCxDQUFDO0FBRUQ7NEZBQzRGO0FBQzVGLFNBQVMsZ0JBQWdCLENBQUMsS0FBYTtJQUNyQyxPQUFPLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztBQUNqRixDQUFDO0FBRUQ7Ozs7OztHQU1HO0FBQ0gsTUFBTSxVQUFVLHdCQUF3QixDQUFDLE1BQThCO0lBQ3JFLE1BQU0sV0FBVyxHQUFHLElBQUksR0FBRyxFQUFrQixDQUFDO0lBQzlDLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxFQUFFLENBQUM7UUFDM0IsV0FBVyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDdEUsQ0FBQztJQUNELE1BQU0sS0FBSyxHQUFHO1FBQ1osVUFBVSxrQkFBa0IsSUFBSSxjQUFjLENBQUMsNkRBQTZELENBQUMsRUFBRTtRQUMvRyxVQUFVLGtCQUFrQixVQUFVO0tBQ3ZDLENBQUM7SUFDRixLQUFLLE1BQU0sQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLFdBQVcsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ2hHLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxrQkFBa0IsVUFBVSxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQ2pGLENBQUM7SUFDRCxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO0FBQ2pDLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBSSxPQUE4QixFQUFFLEdBQW9DO0lBQzlGLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxlQUFlLEtBQUssU0FBUyxDQUFDO0lBQ3pELE1BQU0sV0FBVyxHQUFHLENBQUMsT0FBTyxDQUFDLGVBQWUsSUFBSSxlQUFlLENBQUMsRUFBRSxDQUFDO0lBQ25FLElBQUksQ0FBQztRQUNILE9BQU8sR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQzFCLENBQUM7WUFBUyxDQUFDO1FBQ1QsSUFBSSxVQUFVO1lBQUUsV0FBVyxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQ3RDLENBQUM7QUFDSCxDQUFDO0FBRUQsTUFBTSxVQUFVLGFBQWEsQ0FBQyxJQUFjLEVBQUUsVUFBaUMsRUFBRTtJQUMvRSxNQUFNLE1BQU0sR0FBRyxtQkFBbUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN6QyxJQUFJLE9BQU8sSUFBSSxNQUFNLEVBQUUsQ0FBQztRQUN0QixPQUFPLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUQsQ0FBQztJQUVELElBQUksQ0FBQztRQUNILE9BQU8sZUFBZSxDQUFDLE9BQU8sRUFBRSxDQUFDLFdBQVcsRUFBRSxFQUFFO1lBQzlDLE1BQU0sTUFBTSxHQUFHLGtCQUFrQixDQUMvQixXQUFXLENBQUMsVUFBVSxDQUFDO2dCQUNyQixZQUFZLEVBQUUsTUFBTSxDQUFDLFlBQVk7Z0JBQ2pDLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSzthQUNwQixDQUFDLEVBQ0YsRUFBRSxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksRUFBRSxDQUN0QixDQUFDO1lBQ0YsSUFBSSxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7Z0JBQ2hCLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ25ELENBQUM7aUJBQU0sQ0FBQztnQkFDTixPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7WUFDekMsQ0FBQztZQUNELE9BQU8sQ0FBQyxDQUFDO1FBQ1gsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE9BQU8sZ0JBQWdCLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ2hFLENBQUM7QUFDSCxDQUFDO0FBRUQsTUFBTSxVQUFVLGdCQUFnQixDQUFDLElBQWMsRUFBRSxVQUFpQyxFQUFFO0lBQ2xGLElBQUksSUFBSSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNwQixPQUFPLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSwwQkFBMEIsQ0FBQyxDQUFDO0lBQzFFLENBQUM7SUFFRCxJQUFJLENBQUM7UUFDSCxPQUFPLGVBQWUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxXQUFXLEVBQUUsRUFBRTtZQUM5Qyx5R0FBeUc7WUFDekcsc0ZBQXNGO1lBQ3RGLE9BQU8sQ0FBQyxHQUFHLENBQUMsd0JBQXdCLENBQUMsV0FBVyxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztZQUMxRSxPQUFPLENBQUMsQ0FBQztRQUNYLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLGdCQUFnQixDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7QUFDSCxDQUFDO0FBRUQsTUFBTSxVQUFVLFlBQVksQ0FBQyxVQUE4QixFQUFFLElBQWMsRUFBRSxVQUFpQyxFQUFFO0lBQzlHLElBQUksVUFBVSxLQUFLLE1BQU07UUFBRSxPQUFPLGFBQWEsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDL0QsSUFBSSxVQUFVLEtBQUssU0FBUztRQUFFLE9BQU8sZ0JBQWdCLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3JFLE9BQU8sZ0JBQWdCLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxFQUFFLDhCQUE4QixVQUFVLElBQUksRUFBRSxLQUFLLGlCQUFpQixFQUFFLENBQUMsQ0FBQztBQUN0SCxDQUFDIn0=