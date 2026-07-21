/** One post-merge outcome row, mirroring the endpoint's `ContributorPrOutcome` (public-safe attribution only;
 *  no reward/wallet fields). Re-declared here because src/signals is the Worker app, not an importable package. */
export type ContributorPrOutcome = {
    repoFullName: string;
    pullNumber: number | null;
    outcome: "merged";
    attribution: string;
    deeplink: string;
    recordedAt: string;
};
/** The endpoint's `ContributorPrOutcomes` payload shape. */
export type ContributorPrOutcomes = {
    login: string;
    count: number;
    summary: string;
    outcomes: ContributorPrOutcome[];
};
export type ContributorPrOutcomesClientOptions = {
    env?: NodeJS.ProcessEnv;
    /** Always called as `fetchImpl(url, init)` with a plain string URL -- narrower than `typeof fetch` on
     *  purpose, since that's the only shape this module ever actually calls it with. */
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    /** Forwarded as the endpoint's `?limit=` (an integer 1..100 per the route); omitted when undefined. */
    limit?: number;
    requestTimeoutMs?: number;
};
/**
 * Fetch a contributor's hosted post-merge PR outcomes. Throws a clear Error on any failure: no logged-in session
 * (run `loopover-mcp login`), unreachable host, non-2xx status, or a non-JSON/non-object body.
 */
export declare function fetchContributorPrOutcomes(login: string, options?: ContributorPrOutcomesClientOptions): Promise<ContributorPrOutcomes>;
