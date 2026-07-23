// Hosted-container entry point for AMS (#7182, part of the #7173 ORB+AMS hosting control-plane). Self-host
// stays exactly as it is today (the plain `loopover-miner` CLI, unmodified) -- this is an ADDITIONAL entry
// point the hosted Cloudflare Container invokes instead, wired up by bin/loopover-miner-hosted.ts. Runs
// #7177's already-built health server (ams-health-server.ts) for the brief window a cron-woken container is
// up, then dispatches to exactly ONE existing unattended-cycle command
// (docs/unattended-scheduling.md's `discover`/`manage poll`, plus `attempt`) reused in-process -- these
// functions already return the miner's own 0=success/2=failure exit-code contract unmodified; this file adds
// no new exit-code vocabulary, it only wraps the health server's lifecycle around one of them. Also resolves
// this tenant's #8202/#8246 bootstrap credential once per wake (tenant-credential-resolution.ts) -- best-effort,
// purely to prove that mechanism is wired for AMS; no cycle command reads the result today.
import type { Server } from "node:http";
import { access } from "node:fs/promises";
import { runAttempt } from "./attempt-cli.js";
import { runDiscover } from "./discover-cli.js";
import { runManagePoll } from "./manage-poll.js";
import { resolveMinerStateDir } from "./status.js";
import { resolveTenantSecret } from "./tenant-credential-resolution.js";
import { startAmsHealthServer, type ReadinessProbe } from "./ams-health-server.js";

/** The one-shot cycle commands a hosted tenant can be woken to run -- deliberately NOT `loop` (the
 *  self-scheduling continuous mode, semantically incompatible with "wake, run one cycle, sleep") and NOT
 *  any strictly-local command (`status`/`doctor`/etc, which never make sense as a hosted wake reason). */
export const HOSTED_CYCLE_COMMANDS = {
  discover: runDiscover,
  "manage-poll": runManagePoll,
  attempt: runAttempt,
} satisfies Record<string, (args: string[]) => Promise<number>>;

export type HostedCycleCommand = keyof typeof HOSTED_CYCLE_COMMANDS;

export function isHostedCycleCommand(value: string): value is HostedCycleCommand {
  return Object.hasOwn(HOSTED_CYCLE_COMMANDS, value);
}

/** Reachability probe for the health server's `/ready`: the miner's local state directory (SQLite ledgers/
 *  queue) must exist and be accessible, or this tenant's container can't do real work regardless of what
 *  cycle it's asked to run. */
function stateDirProbe(env: Record<string, string | undefined>): ReadinessProbe {
  return {
    name: "state_dir",
    check: async () => {
      try {
        await access(resolveMinerStateDir(env));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type RunHostedEntryOptions = {
  env?: Record<string, string | undefined>;
  port?: number;
};

/** Starts the health server, runs exactly one cycle command to completion, stops the health server, and
 *  returns the cycle's own exit code unmodified. `cycleName` not matching a known command is itself a
 *  failure (returns 2 -- a misconfigured wake is exactly the kind of thing #7182's alerting contract must
 *  surface, not swallow). */
export async function runHostedEntry(cliArgs: string[], options: RunHostedEntryOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const [cycleName, ...cycleArgs] = cliArgs;

  if (!cycleName || !isHostedCycleCommand(cycleName)) {
    console.error(JSON.stringify({ event: "ams_hosted_entry_unknown_cycle", cycleName: cycleName ?? null, known: Object.keys(HOSTED_CYCLE_COMMANDS) }));
    return 2;
  }

  // #8246: best-effort, resolved once per wake -- proves the #8202 bootstrap-secret mechanism is wired for AMS
  // too. No consumer exists for the resolved value yet (this package has no Postgres-backed store today), so
  // this never blocks or fails the actual cycle dispatch below.
  const tenantSecret = await resolveTenantSecret(env);
  console.log(JSON.stringify({ event: "ams_hosted_entry_tenant_secret_resolved", resolved: tenantSecret !== null, secretType: tenantSecret?.secretType ?? null }));

  let server: Server | undefined;
  try {
    server = await startAmsHealthServer({ port: options.port ?? 8080, probes: [stateDirProbe(env)] });
    return await HOSTED_CYCLE_COMMANDS[cycleName](cycleArgs);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
}
