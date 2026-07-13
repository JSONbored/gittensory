import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { CODING_AGENT_DRIVER_CONFIG_ENV, CODING_AGENT_DRIVER_NAMES } from "@loopover/engine";

import { initLaptopState } from "./laptop-init.js";
import { runDoctor } from "./status.js";

// First-run onboarding wizard for `gittensory-miner init --interactive` (#5176). AMS only needs a PAT plus a
// coding-agent provider choice, so this is deliberately a lightweight credential-and-provider flow — NOT a port of
// ORB's OAuth/GitHub-App provisioning mechanics in `setup-wizard.ts`.
//
// Two hard boundaries this module keeps:
//  1. The collected `GITHUB_TOKEN` is NEVER echoed back — not while typing (masked input), and not in the summary
//     screen (see `summarizeCollectedEnv`, which substitutes a placeholder). It is only ever written to the `.env`.
//  2. NO network calls. The wizard writes a file and then re-runs the existing local `doctor` checks; it never
//     reaches out to GitHub. (Token *verification* is the separate, explicitly opt-in `init --verify-token` path.)
//
// All decision logic here is pure and IO is injected (`WizardIo`), so the whole flow is deterministically testable
// without a TTY; `createStdioWizardIo()` is the thin production adapter.

/** The starter env file written into the miner state dir. */
export const WIZARD_ENV_FILENAME = ".env";

/** Offered (skippable) default for the CLI wall-clock ceiling — `MINER_CODING_AGENT_TIMEOUT_MS` is a positive int. */
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Placeholder shown wherever a secret would otherwise be echoed. The real value never leaves the `.env`. */
export const MASKED_SECRET = "**** (hidden)";

/** Render the numbered provider menu from the engine's canonical driver list, so a new driver never needs a second
 *  hand-maintained list here. */
export function buildProviderMenu() {
  return CODING_AGENT_DRIVER_NAMES.map((name, index) => `  ${index + 1}) ${name}`);
}

/**
 * Resolve an operator's provider answer to a canonical driver name. Accepts either the menu number (`"2"`) or the
 * driver name itself (case/whitespace-insensitive, e.g. `" Claude-CLI "`). Returns `null` for anything else —
 * deny-by-default, mirroring `isConfiguredCodingAgentDriver`'s stance on unknown names.
 */
export function parseProviderChoice(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return CODING_AGENT_DRIVER_NAMES[index] ?? null;
  }
  const lowered = trimmed.toLowerCase();
  return CODING_AGENT_DRIVER_NAMES.find((name) => name === lowered) ?? null;
}

/**
 * The companion vars worth prompting for once a provider is chosen, derived from the engine's
 * `CODING_AGENT_DRIVER_CONFIG_ENV` map rather than a duplicated table — a provider that declares no model/timeout
 * key (`noop`, `agent-sdk`) correctly yields no prompts at all.
 */
export function companionPromptsFor(provider) {
  const config = CODING_AGENT_DRIVER_CONFIG_ENV[provider] ?? {};
  const prompts = [];
  if (config.model) {
    prompts.push({ envKey: config.model, label: "model override", defaultValue: "" });
  }
  if (config.timeoutMs) {
    prompts.push({ envKey: config.timeoutMs, label: "attempt timeout (ms)", defaultValue: String(DEFAULT_TIMEOUT_MS) });
  }
  return prompts;
}

/**
 * Normalize a timeout answer: blank keeps the offered default, and anything that is not a POSITIVE INTEGER is
 * rejected (returns `null`) rather than silently written — `configuredTimeoutMs` in the engine would ignore a
 * malformed value at runtime, so writing one would create a config that lies about what the driver will do.
 */
export function normalizeTimeoutMs(raw, defaultValue = DEFAULT_TIMEOUT_MS) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return defaultValue;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Quote an env value only when it would otherwise be ambiguous (whitespace, `#`, or quotes), so ordinary tokens
 *  and model names stay unquoted and diff-friendly. */
export function formatEnvValue(value) {
  const raw = String(value);
  if (raw === "") return '""';
  if (/[\s#"']/.test(raw)) return `"${raw.replace(/(["\\])/g, "\\$1")}"`;
  return raw;
}

/** Render the starter `.env`. Deterministic: the timestamp is injected, never read from the clock here. */
export function renderEnvFile(values, now = new Date().toISOString()) {
  const lines = [
    "# Written by `gittensory-miner init --interactive`.",
    `# Generated: ${now}`,
    "# Contains a credential — keep it private (this file is written with 0600 permissions).",
    "",
  ];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}=${formatEnvValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The confirmation screen. Every key is shown so the operator can sanity-check what was written, EXCEPT secrets,
 * which are replaced by {@link MASKED_SECRET} — requirement 4: the token is never printed back, including here.
 */
export function summarizeCollectedEnv(values, secretKeys = ["GITHUB_TOKEN"]) {
  const secrets = new Set(secretKeys);
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `  ${key}=${secrets.has(key) ? MASKED_SECRET : value}`);
}

/** Write the starter env file with owner-only permissions — it holds a PAT, so it must never be world-readable. */
export function writeEnvFile(envPath, contents) {
  writeFileSync(envPath, contents, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return envPath;
}

/** Yes/no answer; anything other than an explicit yes is a no (safe default for a destructive overwrite). */
function isAffirmative(raw) {
  return /^(y|yes)$/i.test(typeof raw === "string" ? raw.trim() : "");
}

/**
 * Run the guided flow. `io` is injected so the whole wizard is testable without a TTY; `now` is injected so the
 * rendered file is deterministic. Returns the outcome rather than exiting, so the caller owns the process code.
 *
 * Returns `{ cancelled: true }` when the operator declines to overwrite an existing `.env`, or when a required
 * answer (token, provider) is not supplied — in every cancelled case NOTHING is written.
 */
export async function runInitWizard({ stateDir, io, env = process.env, now = new Date().toISOString() }) {
  const envPath = join(stateDir, WIZARD_ENV_FILENAME);

  if (existsSync(envPath)) {
    io.print(`A ${WIZARD_ENV_FILENAME} already exists at ${envPath}.`);
    const overwrite = await io.prompt("Overwrite it? [y/N]");
    if (!isAffirmative(overwrite)) {
      io.print("Left the existing file untouched.");
      return { cancelled: true, reason: "declined_overwrite", envPath };
    }
  }

  io.print("");
  io.print("This wizard collects a GitHub token and a coding-agent provider, then re-runs `doctor`.");
  io.print("Nothing is sent anywhere — the values are written locally and checked locally.");
  io.print("");

  // Masked: the PAT must never be echoed while typing (requirement 2).
  const token = (await io.promptMasked("GitHub token (input hidden)")).trim();
  if (!token) {
    io.print("No token entered — nothing was written.");
    return { cancelled: true, reason: "missing_token", envPath };
  }

  io.print("");
  io.print("Coding-agent provider:");
  for (const line of buildProviderMenu()) io.print(line);
  const provider = parseProviderChoice(await io.prompt("Choose a provider (number or name)"));
  if (!provider) {
    io.print("No valid provider chosen — nothing was written.");
    return { cancelled: true, reason: "invalid_provider", envPath };
  }

  const values = { GITHUB_TOKEN: token, MINER_CODING_AGENT_PROVIDER: provider };

  for (const prompt of companionPromptsFor(provider)) {
    const suffix = prompt.defaultValue ? ` [${prompt.defaultValue}]` : " [skip]";
    const answer = await io.prompt(`${prompt.label}${suffix}`);
    if (prompt.envKey.endsWith("_TIMEOUT_MS")) {
      const timeout = normalizeTimeoutMs(answer, Number(prompt.defaultValue) || DEFAULT_TIMEOUT_MS);
      if (timeout === null) {
        io.print(`  not a positive whole number — leaving ${prompt.envKey} unset (the driver default applies).`);
        continue;
      }
      values[prompt.envKey] = String(timeout);
      continue;
    }
    const trimmed = answer.trim();
    if (trimmed) values[prompt.envKey] = trimmed;
  }

  writeEnvFile(envPath, renderEnvFile(values, now));

  io.print("");
  io.print(`Wrote ${envPath} (0600):`);
  for (const line of summarizeCollectedEnv(values)) io.print(line);

  return { cancelled: false, envPath, values, env };
}

/**
 * `gittensory-miner init --interactive`. Deliberately lives HERE rather than inside `runInit`: `status.js` already
 * imports `laptop-init.js`, so pulling `runDoctor` into `laptop-init.js` would close an import cycle. Keeping the
 * interactive path in this leaf module means `runInit` is not touched at all — so the default, non-interactive
 * (CI) invocation stays byte-for-byte identical by construction, not merely by careful editing.
 *
 * `io` is injectable so the whole command is testable without a TTY. Exit codes: 0 when the wizard completes and
 * `doctor` passes (or the operator declines to overwrite an existing file — their choice, not a failure), the
 * doctor's own code when it fails, and 1 when a required answer was never supplied.
 */
export async function runInteractiveInit(args = [], env = process.env, io = createStdioWizardIo()) {
  const state = initLaptopState(env);
  io.print(`initialized ${state.stateDir}`);
  io.print(`sqlite: ${state.dbPath}${state.created ? "" : " (already existed)"}`);

  try {
    const outcome = await runInitWizard({ stateDir: state.stateDir, io, env });
    if (outcome.cancelled) {
      // Declining the overwrite is a deliberate operator choice, not an error; a missing token / bad provider means
      // the wizard never produced a usable config, which is.
      return outcome.reason === "declined_overwrite" ? 0 : 1;
    }
    io.print("");
    io.print("Re-running doctor with the new configuration:");
    // Layer the just-collected values over `env` so doctor reports on the file that was WRITTEN, without making the
    // operator restart their shell to pick the new `.env` up.
    return runDoctor([], { ...env, ...outcome.values }, process.cwd());
  } finally {
    io.close?.();
  }
}

/**
 * Production stdio adapter. `promptMasked` suppresses readline's echo for the duration of the answer so the PAT
 * never reaches the terminal (or a scrollback buffer / screen-share).
 */
export function createStdioWizardIo(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, output, terminal: true });
  return {
    print(line) {
      output.write(`${line}\n`);
    },
    async prompt(question) {
      return rl.question(`${question} `);
    },
    async promptMasked(question) {
      output.write(`${question} `);
      const restore = rl._writeToOutput;
      // Swallow every echoed keystroke while the secret is being typed.
      rl._writeToOutput = () => {};
      try {
        return await rl.question("");
      } finally {
        rl._writeToOutput = restore;
        output.write("\n");
      }
    },
    close() {
      rl.close();
    },
  };
}
