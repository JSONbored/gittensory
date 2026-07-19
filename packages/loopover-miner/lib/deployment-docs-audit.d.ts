/** Parsed claims a DEPLOYMENT.md makes about the miner's runtime surface. */
export type DeploymentDocsClaims = {
    envVars: string[];
    filePaths: string[];
    subcommands: string[];
};
/** Filesystem-independent view of the live source tree the parsed claims are checked against. */
export type DeploymentDocsReality = {
    hasEnvRead: (name: string) => boolean;
    /** The enumerable set of every real env-var read, so the reverse audit direction (#6601) can diff a real
     *  `LOOPOVER_MINER_*` read that DEPLOYMENT.md never documents, not just probe one documented name at a time. */
    envReads: Iterable<string>;
    pathExists: (relativePath: string) => boolean;
    isRegisteredCommand: (name: string) => boolean;
};
/** Result of cross-checking claims against reality: `ok` plus a message per stale claim. */
export type DeploymentDocsAuditResult = {
    ok: boolean;
    failures: string[];
};
/** Collect every LOOPOVER_MINER_* / MINER_* token that appears in `text` (doc prose/code or source). */
export declare function scanEnvVarTokens(text: string): Set<string>;
/** Sorted, de-duplicated env-var names DEPLOYMENT.md claims the miner honors. */
export declare function extractEnvVarClaims(markdown: string): string[];
/** Sorted, de-duplicated `loopover-miner <subcommand>` subcommands DEPLOYMENT.md documents. */
export declare function extractSubcommandClaims(markdown: string): string[];
/** True when a markdown link target is an on-disk repo path (not a URL, anchor, or runtime path). */
export declare function isRepoRelativePath(target: string): boolean;
/** Sorted, de-duplicated repo-relative file paths DEPLOYMENT.md links to (external issue links excluded).
 *  An in-file anchor fragment (`file.md#heading`) is stripped before the path is recorded -- the fragment
 *  names a heading inside the target file, not a filesystem entry, so checking it against `pathExists`
 *  verbatim would always fail even when the linked file (and heading) both genuinely exist. */
export declare function extractFilePathClaims(markdown: string): string[];
/** The set of top-level subcommands the miner CLI dispatches, parsed from its bin entry source. */
export declare function scanRegisteredCommands(binSource: string): Set<string>;
/**
 * Cross-check parsed DEPLOYMENT.md claims against reality. `reality` supplies three predicates so this
 * comparison stays pure and filesystem-independent: `hasEnvRead(name)` (a read of that env var exists
 * under packages/loopover-miner/**), `pathExists(relativePath)` (the doc-relative path is on disk),
 * and `isRegisteredCommand(name)` (the subcommand is dispatched by the CLI). Returns the drift findings,
 * each failure naming the specific stale claim rather than a generic mismatch.
 */
export declare function auditDeploymentDocs(claims: DeploymentDocsClaims, reality: DeploymentDocsReality): DeploymentDocsAuditResult;
/** Run the audit and throw a build-failing error naming every stale claim; returns the result when in sync. */
export declare function assertDeploymentDocsInSync(claims: DeploymentDocsClaims, reality: DeploymentDocsReality): DeploymentDocsAuditResult;
