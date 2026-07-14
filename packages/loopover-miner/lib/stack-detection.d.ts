/** Stack auto-detection (#4785). `detectRepoStack` inspects an already-cloned repo's manifest / lockfile / config
 * files and returns a structured stack description, or an explicit fail-closed result when the stack can't be
 * confidently identified (no guessing). */

/** Which manifest (and lockfile, when present) drove the detection. */
export type StackEvidence = {
  manifest: string;
  lockfile: string | null;
};

/** A confidently-detected stack. Command fields are `null` when the command can't be inferred without guessing. */
export type DetectedRepoStack = {
  detected: true;
  language: string;
  packageManager: string | null;
  buildCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  formatCommand: string | null;
  evidence: StackEvidence;
};

/** A repo whose stack could not be confidently identified. */
export type UndetectedRepoStack = {
  detected: false;
  reason: string;
};

export type RepoStackResult = DetectedRepoStack | UndetectedRepoStack;

export type DetectRepoStackOptions = {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
};

/** Manifests, in the precedence order detection tries them (first match wins). */
export const RECOGNIZED_MANIFESTS: readonly string[];

export function detectRepoStack(repoPath: string, options?: DetectRepoStackOptions): RepoStackResult;

export function renderStackSummary(stack: RepoStackResult): string;
