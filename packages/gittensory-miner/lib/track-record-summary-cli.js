import { readFileSync } from "node:fs";
import {
  computeTrackRecordSummary,
  renderTrackRecordSummaryMarkdown,
  resolveTrackRecordSummaryConfig,
} from "@jsonbored/gittensory-engine";

const TRACK_RECORD_RENDER_USAGE =
  "Usage: gittensory-miner track-record render --login <githubLogin> --outcomes <json|@file> [--incidents <json|@file>] [--config <json|@file>] [--now <iso>] [--json]";

function parseJsonInput(value, label) {
  if (value === undefined || value === null || value === "") {
    return { error: `Missing value for ${label}.` };
  }
  const raw = String(value);
  const payload = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return { value: JSON.parse(payload) };
  } catch {
    return { error: `${label} must be valid JSON.` };
  }
}

export function parseTrackRecordRenderArgs(args) {
  const options = {
    json: false,
    login: null,
    outcomes: null,
    incidents: [],
    config: null,
    now: null,
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--login") {
      const login = args[index + 1];
      if (!login || login.startsWith("-")) return { error: TRACK_RECORD_RENDER_USAGE };
      options.login = login.trim();
      index += 1;
      continue;
    }
    if (token === "--outcomes") {
      const parsed = parseJsonInput(args[index + 1], "--outcomes");
      if ("error" in parsed) return { error: parsed.error };
      if (!Array.isArray(parsed.value)) {
        return { error: "Outcomes must be a JSON array." };
      }
      options.outcomes = parsed.value;
      index += 1;
      continue;
    }
    if (token === "--incidents") {
      const parsed = parseJsonInput(args[index + 1], "--incidents");
      if ("error" in parsed) return { error: parsed.error };
      if (!Array.isArray(parsed.value)) {
        return { error: "Incidents must be a JSON array." };
      }
      options.incidents = parsed.value;
      index += 1;
      continue;
    }
    if (token === "--config") {
      const parsed = parseJsonInput(args[index + 1], "--config");
      if ("error" in parsed) return { error: parsed.error };
      options.config = parsed.value;
      index += 1;
      continue;
    }
    if (token === "--now") {
      const now = args[index + 1];
      if (!now || now.startsWith("-")) return { error: TRACK_RECORD_RENDER_USAGE };
      options.now = now.trim();
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: TRACK_RECORD_RENDER_USAGE };
  if (!options.login) return { error: TRACK_RECORD_RENDER_USAGE };
  if (!options.outcomes) return { error: TRACK_RECORD_RENDER_USAGE };
  return options;
}

export function runTrackRecordRender(args, options = {}) {
  const parsed = parseTrackRecordRenderArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const resolveConfig = options.resolveTrackRecordSummaryConfig ?? resolveTrackRecordSummaryConfig;
  const compute = options.computeTrackRecordSummary ?? computeTrackRecordSummary;
  const renderMarkdown = options.renderTrackRecordSummaryMarkdown ?? renderTrackRecordSummaryMarkdown;

  try {
    const config = resolveConfig(parsed.config ?? {});
    const summary = compute({
      login: parsed.login,
      now: parsed.now ?? undefined,
      config,
      outcomes: parsed.outcomes,
      incidents: parsed.incidents,
    });
    if (parsed.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(renderMarkdown(summary));
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runTrackRecordCli(subcommand, args, options = {}) {
  if (subcommand === "render") return runTrackRecordRender(args, options);
  console.error(`Unknown track-record subcommand: ${subcommand ?? ""}. ${TRACK_RECORD_RENDER_USAGE}`);
  return 2;
}
