import { readFileSync } from "node:fs";

// Resolve `<NAME>_FILE` env vars (Docker/Swarm/Kubernetes secret mounts) into `<NAME>` at miner startup, so an
// operator can supply GITHUB_TOKEN (and coding-agent credentials) via a mounted file instead of a plaintext env
// var visible through `docker inspect`. Ported from the review stack's proven pattern (src/selfhost/
// load-file-secrets.ts, #4403) into the miner package (#5178). Call once, before any command reads the env.

// Docker Compose's OWN reserved `_FILE`-suffixed variables — never a gittensory secret-file convention, so they
// must never be dereferenced: `COMPOSE_FILE` is a colon-delimited list of compose paths (not a readable single
// file), and `COMPOSE_ENV_FILE` points at an operator's .env file, not a secret. A real credential is never
// named exactly one of these.
const COMPOSE_RESERVED_FILE_VARS = new Set([
  "COMPOSE_FILE",
  "COMPOSE_ENV_FILE",
]);

/**
 * For every `<NAME>_FILE` env var, read its file and set `<NAME>` to the trimmed contents — unless `<NAME>` is
 * already set explicitly (an explicit value always wins) or the var is a Compose-reserved name. An unreadable
 * file is logged and skipped rather than throwing, so one bad mount never crashes startup. `env`/`readFile` are
 * injectable purely for tests; every real caller uses the defaults, so this is byte-identical at runtime.
 * @param {Record<string, string | undefined>} [env]
 * @param {(path: string) => string} [readFile]
 * @returns {void}
 */
export function loadFileSecrets(
  env = process.env,
  readFile = (path) => readFileSync(path, "utf8"),
) {
  for (const key of Object.keys(env)) {
    if (
      !key.endsWith("_FILE") ||
      !env[key] ||
      COMPOSE_RESERVED_FILE_VARS.has(key)
    )
      continue;
    const target = key.slice(0, -"_FILE".length);
    // An explicit value wins — INCLUDING an explicit empty string. Test `!== undefined` (presence), not
    // truthiness: `GITHUB_TOKEN=` set alongside `GITHUB_TOKEN_FILE=…` is a deliberate empty value the file
    // must not silently overwrite. (A plain-truthiness check here would treat `''` as unset — the defect.)
    if (env[target] !== undefined) continue;
    try {
      env[target] = readFile(env[key]).trim();
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          event: "miner_secret_file_unreadable",
          var: key,
        }),
      );
    }
  }
}
