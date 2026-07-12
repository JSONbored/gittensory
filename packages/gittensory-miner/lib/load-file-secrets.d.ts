/**
 * Resolve `<NAME>_FILE` env vars (Docker/Kubernetes secret mounts) into `<NAME>` at miner startup. An explicit
 * `<NAME>` wins — including an explicit EMPTY value (presence is tested, not truthiness, so `GITHUB_TOKEN=` is
 * never clobbered by the file). Compose-reserved `_FILE` vars are ignored; an unreadable file is logged and
 * skipped, never thrown. `env`/`readFile` are injectable for tests; real callers use `process.env` + `readFileSync`.
 */
export function loadFileSecrets(
  env?: Record<string, string | undefined>,
  readFile?: (path: string) => string,
): void;
