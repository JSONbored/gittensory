import { recordAuditEvent } from "../db/repositories";
import { ensurePullRequestLabel } from "../github/labels";
import { closePullRequest, createIssueComment, createPullRequestReview, mergePullRequest } from "../github/pr-actions";
import { resolveAutonomy } from "../settings/autonomy";
import { buildAgentActionAudit, isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "../settings/agent-execution";
import type { PlannedAgentAction } from "../settings/agent-actions";
import type { AgentActionClass, AutonomyPolicy } from "../types";
import { errorMessage } from "../utils/json";

// The agent actor name on every audit record — the App acts on the maintainer's behalf per their configured
// autonomy (the config IS the authorization; there is no human commenter to authorize, unlike #824).
const AGENT_ACTOR = "gittensory";

// The PR-state action classes that require GitHub `pull_requests: write`. `label` mutates via the Issues API
// (`issues: write`, always held), so it is exempt from the write-permission readiness gate.
const PR_WRITE_CLASSES = new Set<AgentActionClass>(["request_changes", "approve", "merge", "close"]);

export type AgentActionExecutionContext = {
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha?: string | null | undefined;
  autonomy: AutonomyPolicy | null | undefined;
  agentPaused?: boolean | undefined;
  agentDryRun?: boolean | undefined;
  installationPermissions: Record<string, string> | null | undefined;
};

export type AgentActionOutcome = {
  actionClass: AgentActionClass;
  outcome: "completed" | "queued" | "denied" | "error" | "dry_run";
  detail: string;
};

/**
 * Execute (or dry-run, or stage for approval) a planned auto-maintain action set on one PR. Each action runs
 * through the SAME deny-toward-safety gate stack before any GitHub call:
 *   pause (#776 kill-switch) → approval (auto_with_approval → #779 queue) → write-permission (#775) → mode.
 * Only `live` mode performs a real mutation; `dry_run` records what it WOULD do. Every path writes one
 * `agent.action.<class>` audit record (#776). A failed mutation is recorded as `error`, never swallowed.
 */
export async function executeAgentMaintenanceActions(env: Env, ctx: AgentActionExecutionContext, planned: PlannedAgentAction[]): Promise<AgentActionOutcome[]> {
  const outcomes: AgentActionOutcome[] = [];
  const targetKey = `${ctx.repoFullName}#${ctx.pullNumber}`;
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env), agentPaused: ctx.agentPaused, agentDryRun: ctx.agentDryRun });

  for (const action of planned) {
    const autonomyLevel = resolveAutonomy(ctx.autonomy, action.actionClass);
    const audit = (outcome: AgentActionOutcome["outcome"], detail: string) => {
      const auditOutcome = outcome === "dry_run" ? "completed" : outcome;
      outcomes.push({ actionClass: action.actionClass, outcome, detail });
      return recordAuditEvent(
        env,
        buildAgentActionAudit({ actionClass: action.actionClass, autonomyLevel, mode, outcome: auditOutcome, repoFullName: ctx.repoFullName, targetKey, actor: AGENT_ACTOR, reason: detail }),
      );
    };

    // 1) Kill-switch (global or per-repo) halts everything.
    if (mode === "paused") {
      await audit("denied", "agent actions paused");
      continue;
    }
    // 2) auto_with_approval stages the action for a maintainer instead of executing it (#779 owns the queue).
    if (action.requiresApproval) {
      await audit("queued", `awaiting maintainer approval — ${action.reason}`);
      continue;
    }
    // 3) Write-permission readiness: a PR-write action needs `pull_requests: write` granted.
    if (PR_WRITE_CLASSES.has(action.actionClass) && resolveAgentPermissionReadiness({ autonomy: ctx.autonomy, installationPermissions: ctx.installationPermissions }) !== "ready") {
      await audit("denied", "pull_requests: write not granted — maintainer must re-consent");
      continue;
    }
    // 4) dry-run records the intent without touching GitHub.
    if (mode === "dry_run") {
      await audit("dry_run", `dry-run: would ${action.actionClass} — ${action.reason}`);
      continue;
    }
    // 5) live — perform the real mutation, recording success or the error.
    try {
      await performAction(env, ctx, action);
      await audit("completed", action.reason);
    } catch (error) {
      await audit("error", errorMessage(error));
    }
  }

  return outcomes;
}

async function performAction(env: Env, ctx: AgentActionExecutionContext, action: PlannedAgentAction): Promise<void> {
  switch (action.actionClass) {
    case "label":
      await ensurePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.label ?? "", { createMissingLabel: true });
      return;
    case "request_changes":
      await createPullRequestReview(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "REQUEST_CHANGES", action.reviewBody ?? "");
      return;
    case "approve":
      await createPullRequestReview(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "APPROVE", action.reviewBody ?? "");
      return;
    case "merge":
      await mergePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, { mergeMethod: action.mergeMethod ?? "squash", ...(ctx.headSha ? { sha: ctx.headSha } : {}) });
      return;
    case "close":
      if (action.closeComment) await createIssueComment(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.closeComment);
      await closePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber);
      return;
  }
}
