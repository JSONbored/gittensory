/** Shared CLI failure output (#5928): when `--json` is set, emit a parseable `{ ok: false, error }` object on
 *  stdout (matching each command's success-path JSON stream); otherwise log plain text to stderr. */
export declare function reportCliFailure(wantsJson: boolean, message: string, exitCode?: number): number;
/** True when argv includes `--json` or `--json=...` (used before a full parse result exists). */
export declare function argsWantJson(args: Array<string | undefined | null>): boolean;
/** Normalize a thrown value to a safe error string for CLI output. */
export declare function describeCliError(error: unknown): string;
