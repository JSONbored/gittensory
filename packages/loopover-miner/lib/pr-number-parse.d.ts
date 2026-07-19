/** `gh pr create` (local-write-tools.ts's `buildOpenPrSpec` -- no `--json` flag) prints the created PR's own
 *  URL to stdout on success; this is `gh`'s real, documented, stable CLI behavior, not an invented contract.
 *  Scoped to the exact target repo so an unrelated URL elsewhere in stdout/stderr noise can never match.
 */
export declare function parsePrNumberFromExecResult(execResult: {
    stdout?: string | undefined;
    code?: number | null | undefined;
    timedOut?: boolean | undefined;
} | null | undefined, repoFullName: string): number | null;
