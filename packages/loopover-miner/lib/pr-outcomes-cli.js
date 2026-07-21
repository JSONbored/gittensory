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
import { sanitizeDiscoverDisplayText } from "./discover-cli.js";
const PR_OUTCOMES_USAGE = "Usage: loopover-miner pr-outcomes [--login <github-login>] [--limit <1-100>] [--json]";
/** Parse `[--login <login>] [--limit <1-100>] [--json]`. Returns the options or `{ error }`. */
export function parsePrOutcomesArgs(args) {
    const options = {
        login: null,
        limit: undefined,
        json: false,
    };
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--login") {
            const value = args[index + 1];
            const trimmed = value?.trim();
            if (!trimmed || value.startsWith("-"))
                return { error: PR_OUTCOMES_USAGE };
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
function renderPrOutcomeRow(outcome) {
    const repo = sanitizeDiscoverDisplayText(outcome.repoFullName);
    const pr = typeof outcome.pullNumber === "number" ? `#${outcome.pullNumber}` : "#?";
    const recordedAt = sanitizeDiscoverDisplayText(outcome.recordedAt);
    const deeplink = sanitizeDiscoverDisplayText(outcome.deeplink);
    return `${repo}${pr}  merged  ${recordedAt}  ${deeplink}`;
}
/** Plain-text rendering: the payload summary, then one line per merged outcome (or a no-rows note). */
export function renderPrOutcomes(payload) {
    const summary = sanitizeDiscoverDisplayText(payload.summary);
    const outcomes = Array.isArray(payload.outcomes) ? payload.outcomes : [];
    if (outcomes.length === 0) {
        return summary || "no merged PR outcomes";
    }
    return [summary, ...outcomes.map(renderPrOutcomeRow)].join("\n");
}
export async function runPrOutcomes(args, options = {}) {
    const parsed = parsePrOutcomesArgs(args);
    if ("error" in parsed)
        return reportCliFailure(argsWantJson(args), parsed.error);
    const env = options.env ?? process.env;
    const login = parsed.login ?? resolveLoopoverSessionLogin(env) ?? env.LOOPOVER_LOGIN ?? env.GITHUB_LOGIN ?? null;
    if (!login) {
        return reportCliFailure(parsed.json, "no login: pass --login <github-login>, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN");
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
        }
        else {
            console.log(renderPrOutcomes(payload));
        }
        return 0;
    }
    catch (error) {
        return reportCliFailure(parsed.json, describeCliError(error));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItb3V0Y29tZXMtY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHItb3V0Y29tZXMtY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OytGQU8rRjtBQUMvRixPQUFPLEVBQUUsWUFBWSxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEYsT0FBTyxFQUFFLDJCQUEyQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFDM0UsT0FBTyxFQUFFLDBCQUEwQixFQUFFLE1BQU0scUNBQXFDLENBQUM7QUFFakYsT0FBTyxFQUFFLDJCQUEyQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFaEUsTUFBTSxpQkFBaUIsR0FBRyx1RkFBdUYsQ0FBQztBQWVsSCxnR0FBZ0c7QUFDaEcsTUFBTSxVQUFVLG1CQUFtQixDQUFDLElBQWM7SUFDaEQsTUFBTSxPQUFPLEdBQXVFO1FBQ2xGLEtBQUssRUFBRSxJQUFJO1FBQ1gsS0FBSyxFQUFFLFNBQVM7UUFDaEIsSUFBSSxFQUFFLEtBQUs7S0FDWixDQUFDO0lBQ0YsS0FBSyxJQUFJLEtBQUssR0FBRyxDQUFDLEVBQUUsS0FBSyxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3BELE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUUsQ0FBQztRQUMzQixJQUFJLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN2QixPQUFPLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztZQUNwQixTQUFTO1FBQ1gsQ0FBQztRQUNELElBQUksS0FBSyxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ3hCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7WUFDOUIsTUFBTSxPQUFPLEdBQUcsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDO1lBQzlCLElBQUksQ0FBQyxPQUFPLElBQUks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