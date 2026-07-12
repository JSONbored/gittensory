// Shared CLI error formatter (#4836). Every miner subcommand repeats the same parse-guard + try/catch boilerplate
// that logged a plain-text message and returned an exit code -- ignoring `--json` on exactly the failure path a
// monitoring wrapper needs structured output from. This centralizes that failure path so a `--json` run emits a
// parseable `{ error }` object instead, consistent with each command's JSON success-path shape.

/** True when raw argv requests `--json`. Read straight from argv so an error path can honor it even when it fires
 *  before a structured options object exists -- e.g. an arg-parse failure, where the parsed `json` flag was never
 *  produced. */
export function wantsJsonOutput(args) {
  return Array.isArray(args) && args.includes("--json");
}

/** Emit a CLI error respecting `--json`: a structured `{ error }` JSON object when requested, else the plain
 *  message. Always writes to stderr -- the same stream the plain error already used -- so a `--json` wrapper gets
 *  a parseable failure object on the channel it already reads for errors. The caller still returns its exit code. */
export function emitCliError(message, options = {}) {
  const text = typeof message === "string" ? message : String(message);
  if (options.json) {
    console.error(JSON.stringify({ error: text }));
  } else {
    console.error(text);
  }
}
