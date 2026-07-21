import { fetchContributorPrOutcomes } from "./contributor-pr-outcomes-client.js";
import type { ContributorPrOutcomes } from "./contributor-pr-outcomes-client.js";
export type ParsedPrOutcomesArgs = {
    login: string | null;
    limit: number | undefined;
    json: boolean;
} | {
    error: string;
};
export type RunPrOutcomesOptions = {
    /** Read for login/session resolution -- defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Injected fetch, forwarded to the client; defaults to the real global fetch inside the client. */
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    /** Injectable client so tests drive the CLI without a real session/network. */
    fetchContributorPrOutcomes?: typeof fetchContributorPrOutcomes;
};
/** Parse `[--login <login>] [--limit <1-100>] [--json]`. Returns the options or `{ error }`. */
export declare function parsePrOutcomesArgs(args: string[]): ParsedPrOutcomesArgs;
/** Plain-text rendering: the payload summary, then one line per merged outcome (or a no-rows note). */
export declare function renderPrOutcomes(payload: ContributorPrOutcomes): string;
export declare function runPrOutcomes(args: string[], options?: RunPrOutcomesOptions): Promise<number>;
