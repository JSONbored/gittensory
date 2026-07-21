/** `pr-outcomes` CLI command (#7658): the first AMS-side consumer of the hosted `GET /v1/contributors/:login/
 * pr-outcomes` endpoint (src/signals/contributor-pr-outcomes.ts). A thin composition layer -- argv parsing plus
 * a call into contributor-pr-outcomes-client.js, which owns the session-authed HTTP surface -- mirroring
 * tenant-cli.js's parse/run/report shape. Login defaults to the operator's OWN configured GitHub login (the one
 * `loopover-mcp login` recorded, then LOOPOVER_LOGIN / GITHUB_LOGIN), so an already-logged-in contributor never
 * retypes it; `--login` overrides. Merged-PR outcomes only, per the endpoint's scope. Server-supplied strings are
 * run through discover-cli.js's sanitizer before hitting the terminal (the endpoint returns public-safe
 * attribution, but a defensive CLI never trusts remote text with control/escape sequences). */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { resolveLoopoverSessionLogin } from "./github-token-resolution.js";
import { fetchContributorPrOutcomes } from "./contributor-pr-outcomes-client.js";
import type { ContributorPrOutcome, ContributorPrOutcomes } from "./contributor-pr-outcomes-client.js";
import { sanitizeDiscoverDisplayText } from "./discover-cli.js";

const PR_OUTCOMES_USAGE = "Usage: loopover-miner pr-outcomes [--login <github-login>] [--limit <1-100>] [--json]";

export type ParsedPrOutcomesArgs =
  | { login: string | null; limit: number | undefined; json: boolean }
  | { error: string };

export type RunPrOutcomesOptions = {
  /** Read for login/session resolution -- defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch, forwarded to the client; defaults to the real global fetch inside the client. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable client so tests drive the CLI without a real session/network. */
  fetchContributorPrOutcomes?: typeof fetchContributorPrOutcomes;
};

/** Parse `[--login <login>] [--limit <1-100>] [--json]`. Returns the options or `{ error }`. */
export function parsePrOutcomesArgs(args: string[]): ParsedPrOutcomesArgs {
  const options: { login: string | null; limit: number | undefined; json: boolean } = {
    login: null,
    limit: undefined,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--login") {
      const value = args[index + 1];
      const trimmed = value?.trim();
      if (!trimmed || value!.startsWith("-")) return { error: PR_OUTCOMES_USAGE };
      options.login = trimmed;
      index += 1;
      continue;
    }
    if (token === "--limit") {
      // Mirror the route's own guard (src/api/routes.ts): an integer 1..100, rejected locally so a bad value
      // never becomes a wasted round-trip that just returns the endpoint's 400.
      const raw = args[index + 1];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value < 1 || value > 100) {
        return { error: PR_OUTCOMES_USAGE };
      }
      options.limit = value;
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${token}` };
  }
  return options;
}

/** One outcome row as a single plain-text line; every server-supplied field is sanitized before display. */
function renderPrOutcomeRow(outcome: ContributorPrOutcome): string {
  const repo = sanitizeDiscoverDisplayText(outcome.repoFullName);
  const pr = typeof outcome.pullNumber === "number" ? `#${outcome.pullNumber}` : "#?";
  const recordedAt = sanitizeDiscoverDisplayText(outcome.recordedAt);
  const deeplink = sanitizeDiscoverDisplayText(outcome.deeplink);
  return `${repo}${pr}  merged  ${recordedAt}  ${deeplink}`;
}

/** Plain-text rendering: the payload summary, then one line per merged outcome (or a no-rows note). */
export function renderPrOutcomes(payload: ContributorPrOutcomes): string {
  const summary = sanitizeDiscoverDisplayText(payload.summary);
  const outcomes = Array.isArray(payload.outcomes) ? payload.outcomes : [];
  if (outcomes.length === 0) {
    return summary || "no merged PR outcomes";
  }
  return [summary, ...outcomes.map(renderPrOutcomeRow)].join("\n");
}

export async function runPrOutcomes(args: string[], options: RunPrOutcomesOptions = {}): Promise<number> {
  const parsed = parsePrOutcomesArgs(args);
  if ("error" in parsed) return reportCliFailure(argsWantJson(args), parsed.error);

  const env = options.env ?? process.env;
  const login = parsed.login ?? resolveLoopoverSessionLogin(env) ?? env.LOOPOVER_LOGIN ?? env.GITHUB_LOGIN ?? null;
  if (!login) {
    return reportCliFailure(
      parsed.json,
      "no login: pass --login <github-login>, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN",
    );
  }

  const fetchOutcomes = options.fetchContributorPrOutcomes ?? fetchContributorPrOutcomes;
  try {
    const payload = await fetchOutcomes(login, {
      env,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    });
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderPrOutcomes(payload));
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}
