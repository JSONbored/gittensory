export type LaptopInitResult = {
  stateDir: string;
  dbPath: string;
  created: boolean;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type GithubTokenVerification = {
  ok: boolean;
  login: string | null;
  scopes: string[];
  detail: string;
};

export function resolveLaptopStateDbPath(env?: Record<string, string | undefined>): string;

export function initLaptopState(env?: Record<string, string | undefined>): LaptopInitResult;

export function checkLaptopStateSqlite(env?: Record<string, string | undefined>): DoctorCheck;

export function findExecutableOnPath(name: string, env?: Record<string, string | undefined>): string | null;

export function checkDockerPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveDockerPath?: () => string | null;
}): DoctorCheck;

export function checkClaudeCliPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveClaudePath?: () => string | null;
}): DoctorCheck;

export function checkCodexCliPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveCodexPath?: () => string | null;
  resolveCodexAuthPath?: () => string;
}): DoctorCheck;

export function resolveCodexAuthPath(env?: Record<string, string | undefined>): string;

export function verifyGithubToken(options?: {
  githubToken?: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
}): Promise<GithubTokenVerification>;

/** The minimal input-stream surface `init --interactive`'s prompts actually use — deliberately narrower than
 *  `NodeJS.ReadableStream` so an injected test double doesn't have to implement the full stream contract
 *  (`pipe`/`read`/`unpipe`/etc.) it never calls. `setEncoding`/`setRawMode` are optional: real TTY stdin has
 *  both, a piped/injected stream may have neither. */
export type InteractiveInitInputStream = {
  on: (event: "data", listener: (chunk: string) => void) => unknown;
  removeListener: (event: "data", listener: (chunk: string) => void) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  setEncoding?: (encoding: string) => unknown;
  setRawMode?: (mode: boolean) => unknown;
};

export type InteractiveInitOutputStream = {
  write: (chunk: string) => unknown;
};

export type InteractiveInitStreams = {
  input?: InteractiveInitInputStream;
  output?: InteractiveInitOutputStream;
};

export type InteractiveInitWizardResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; error: string };

export function runInteractiveInitWizard(streams?: InteractiveInitStreams): Promise<InteractiveInitWizardResult>;

export function runInit(
  args?: string[],
  env?: Record<string, string | undefined>,
  streams?: InteractiveInitStreams,
): Promise<number>;
