import { initEventLedger } from "./event-ledger.js";

const LEDGER_LIST_USAGE =
  "Usage: gittensory-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]";

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
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
  const options = { json: false, repoFullName: null, since: null, type: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--repo") {
      const repoArg = args[index + 1];
      if (!repoArg || repoArg.startsWith("-")) return { error: LEDGER_LIST_USAGE };
      const repo = parseRepoArg(repoArg, LEDGER_LIST_USAGE);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    if (token === "--since") {
      const sinceArg = args[index + 1];
      if (!sinceArg || sinceArg.startsWith("--")) return { error: LEDGER_LIST_USAGE };
      const parsedSince = parseSinceArg(sinceArg);
      if ("error" in parsedSince) return parsedSince;
      options.since = parsedSince.since;
      index += 1;
      continue;
    }
    if (token === "--type") {
      const type = args[index + 1];
      if (!type || type.startsWith("-")) return { error: LEDGER_LIST_USAGE };
      options.type = type.trim();
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: LEDGER_LIST_USAGE };
  return options;
}

export function filterLedgerEvents(events, options = {}) {
  if (!Array.isArray(events)) return [];
  const type = typeof options.type === "string" && options.type.trim() ? options.type.trim() : null;
  if (!type) return events;
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
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Project one ledger row to the public, metadata-only audit-feed shape — never returns payload_json. */
export function projectLedgerEventToAuditFeedEntry(entry) {
  const payload =
    entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {};
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
    if ("error" in repo) throw new Error(repo.error);
    filter.repoFullName = repo.repoFullName;
  }
  if (input.since !== undefined && input.since !== null) {
    const parsedSince = parseSinceArg(String(input.since));
    if ("error" in parsedSince) throw new Error(parsedSince.error);
    filter.since = parsedSince.since;
  }
  if (input.type !== undefined && input.type !== null) {
    const trimmed = String(input.type).trim();
    if (!trimmed) throw new Error("type must be a non-empty string.");
    filter.type = trimmed;
  }
  return filter;
}

/** Read-only audit feed shared by the MCP audit-feed tool (#5158). */
export function collectEventLedgerAuditFeed(eventLedger, filter = {}) {
  const events = filterLedgerEvents(
    eventLedger.readEvents({
      repoFullName: filter.repoFullName,
      since: filter.since,
    }),
    { type: filter.type },
  );
  return {
    ...(filter.repoFullName ? { repoFullName: filter.repoFullName } : {}),
    events: events.map(projectLedgerEventToAuditFeedEntry),
  };
}

function display(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderLedgerTable(events) {
  if (!Array.isArray(events) || events.length === 0) return "no event ledger entries";
  const header = [
    "seq".padStart(4),
    "type".padEnd(20),
    "repo".padEnd(24),
    "created-at".padEnd(24),
  ].join(" ");
  const lines = events.map((entry) =>
    [
      String(entry.seq).padStart(4),
      entry.type.padEnd(20),
      display(entry.repoFullName).padEnd(24),
      display(entry.createdAt).padEnd(24),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

function withEventLedger(options, run) {
  const ownsLedger = options.initEventLedger === undefined;
  const eventLedger = (options.initEventLedger ?? initEventLedger)();
  try {
    return run(eventLedger);
  } finally {
    if (ownsLedger) eventLedger.close();
  }
}

export function runLedgerList(args, options = {}) {
  const parsed = parseLedgerListArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withEventLedger(options, (eventLedger) => {
      const events = filterLedgerEvents(
        eventLedger.readEvents({
          repoFullName: parsed.repoFullName,
          since: parsed.since,
        }),
        { type: parsed.type },
      );
      if (parsed.json) {
        console.log(JSON.stringify({ events }, null, 2));
      } else {
        console.log(renderLedgerTable(events));
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runLedgerCli(subcommand, args, options = {}) {
  if (subcommand === "list") return runLedgerList(args, options);
  console.error(`Unknown ledger subcommand: ${subcommand ?? ""}. ${LEDGER_LIST_USAGE}`);
  return 2;
}
