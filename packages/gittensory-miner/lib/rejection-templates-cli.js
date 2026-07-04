import { REJECTION_REASONS, renderRejectionMessage } from "./rejection-templates.js";

const REJECTION_LIST_USAGE = "Usage: gittensory-miner rejection list [--json]";
const REJECTION_RENDER_USAGE =
  "Usage: gittensory-miner rejection render <reason> <owner/repo> <pr#> [--json]";

function parseJsonFlag(args) {
  const options = { json: false };
  const positional = [];

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  return { positional, ...options };
}

export function parseRejectionListArgs(args) {
  const options = { json: false };
  const positional = [];

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: REJECTION_LIST_USAGE };
  return options;
}

function parseRepoArg(value) {
  const trimmed = value?.trim();
  const [owner, repo, extra] = (trimmed ?? "").split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

function parsePrNumberArg(value) {
  const prNumber = Number(value);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    return { error: "pr# must be a positive integer." };
  }
  return { prNumber };
}

export function parseRejectionRenderArgs(args) {
  const parsed = parseJsonFlag(args);
  if ("error" in parsed) return parsed;
  if (parsed.positional.length !== 3) return { error: REJECTION_RENDER_USAGE };

  const reason = parsed.positional[0]?.trim();
  if (!reason || !REJECTION_REASONS.includes(reason)) {
    return {
      error: `Invalid reason: ${reason ?? ""}. Expected one of ${REJECTION_REASONS.join(", ")}.`,
    };
  }

  const repo = parseRepoArg(parsed.positional[1]);
  if ("error" in repo) return repo;

  const pr = parsePrNumberArg(parsed.positional[2]);
  if ("error" in pr) return pr;

  return {
    reason,
    repoFullName: repo.repoFullName,
    prNumber: pr.prNumber,
    json: parsed.json,
  };
}

export function renderRejectionReasonTable(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return "no rejection reasons";
  return reasons.join("\n");
}

export function runRejectionList(args) {
  const parsed = parseRejectionListArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  if (parsed.json) {
    console.log(JSON.stringify({ reasons: [...REJECTION_REASONS] }, null, 2));
  } else {
    console.log(renderRejectionReasonTable(REJECTION_REASONS));
  }
  return 0;
}

export function runRejectionRender(args) {
  const parsed = parseRejectionRenderArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    const message = renderRejectionMessage(parsed.reason, {
      repoFullName: parsed.repoFullName,
      prNumber: parsed.prNumber,
    });
    if (parsed.json) {
      console.log(
        JSON.stringify(
          {
            reason: parsed.reason,
            repoFullName: parsed.repoFullName,
            prNumber: parsed.prNumber,
            message,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(message);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function runRejectionCli(subcommand, args) {
  if (subcommand === "list") return runRejectionList(args);
  if (subcommand === "render") return runRejectionRender(args);
  console.error(`Unknown rejection subcommand: ${subcommand ?? ""}. ${REJECTION_LIST_USAGE}`);
  return 2;
}
