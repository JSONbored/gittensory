import type { AgentActionClass, AuditEventRecord, AutonomyLevel } from "../types";

// Whether the agent actually executes an action, only logs what it WOULD do, or is halted entirely (#776).
export type AgentActionMode = "paused" | "dry_run" | "live";

/**
 * The GLOBAL kill-switch — an operator emergency brake (env `AGENT_ACTIONS_PAUSED`) that halts ALL agent
 * actions across every repo, regardless of per-repo config. Same truthy-string idiom as the other env flags.
 */
export function isGlobalAgentPause(env: { AGENT_ACTIONS_PAUSED?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.AGENT_ACTIONS_PAUSED ?? "");
}

/**
 * THE single gate the action layer (#778) consults before executing any action, alongside resolveAutonomy.
 * Precedence (safest wins): a global OR per-repo pause halts everything (`paused`); else a per-repo dry-run
 * logs what would happen without executing (`dry_run`); else `live`. Deny-toward-safety. Pure.
 */
export function resolveAgentActionMode(input: { globalPaused: boolean; agentPaused?: boolean | null | undefined; agentDryRun?: boolean | null | undefined }): AgentActionMode {
  if (input.globalPaused || input.agentPaused === true) return "paused";
  if (input.agentDryRun === true) return "dry_run";
  return "live";
}

/** True only for `live` — the only mode that performs a real GitHub mutation. `paused` does nothing;
 *  `dry_run` records a shadow action but never mutates. */
export function agentActionModeExecutes(mode: AgentActionMode): boolean {
  return mode === "live";
}

/**
 * Build the structured audit record for an agent action (who / what / why / outcome / mode). The action
 * layer passes this to the existing recordAuditEvent so live actions AND dry-run shadows are both recorded
 * on one consistent event shape (#776 "extend the existing audit-event infra"). Pure.
 */
export function buildAgentActionAudit(input: {
  actionClass: AgentActionClass;
  autonomyLevel: AutonomyLevel;
  mode: AgentActionMode;
  outcome: AuditEventRecord["outcome"];
  repoFullName: string;
  targetKey?: string | null | undefined;
  actor?: string | null | undefined;
  reason?: string | null | undefined;
}): AuditEventRecord {
  return {
    eventType: `agent.action.${input.actionClass}`,
    actor: input.actor ?? null,
    targetKey: input.targetKey ?? input.repoFullName,
    outcome: input.outcome,
    detail: input.reason ?? null,
    metadata: {
      repoFullName: input.repoFullName,
      actionClass: input.actionClass,
      autonomyLevel: input.autonomyLevel,
      mode: input.mode,
    },
  };
}
