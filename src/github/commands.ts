import { AGENT_COMMAND_COMMENT_MARKER } from "./comments";
import type { AgentRunBundle } from "../services/agent-orchestrator";
import type { GittensorContributorSnapshot, OfficialGittensorMinerDetection } from "../gittensor/api";
import type { GitHubIssuePayload, PullRequestRecord, RepositoryRecord } from "../types";

export type GittensoryMentionCommandName = "help" | "preflight" | "blockers" | "duplicate-check" | "miner-context" | "next-action";

export type GittensoryMentionCommand = {
  name: GittensoryMentionCommandName;
  raw: string;
};

const COMMANDS = new Set<GittensoryMentionCommandName>(["help", "preflight", "blockers", "duplicate-check", "miner-context", "next-action"]);
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function parseGittensoryMentionCommand(body: string | null | undefined): GittensoryMentionCommand | null {
  if (!body) return null;
  const match = body.match(/(?:^|\s)@gittensory(?:\s+([a-z-]+))?/i);
  if (!match) return null;
  const requested = (match[1]?.toLowerCase() || "help") as GittensoryMentionCommandName;
  const name = COMMANDS.has(requested) ? requested : "help";
  return { name, raw: match[0].trim() };
}

export function isMaintainerAssociation(association: string | null | undefined): boolean {
  return Boolean(association && MAINTAINER_ASSOCIATIONS.has(association));
}

export function isAuthorizedCommandActor(args: {
  commenterLogin?: string | null | undefined;
  commenterAssociation?: string | null | undefined;
  pullRequestAuthorLogin?: string | null | undefined;
  officialAuthorDetection?: OfficialGittensorMinerDetection | undefined;
}): { authorized: boolean; reason: string; actorKind: "maintainer" | "author" | "none" } {
  if (isMaintainerAssociation(args.commenterAssociation)) return { authorized: true, reason: "maintainer_invocation", actorKind: "maintainer" };
  if (!args.commenterLogin || !args.pullRequestAuthorLogin || args.commenterLogin.toLowerCase() !== args.pullRequestAuthorLogin.toLowerCase()) {
    return { authorized: false, reason: "not_maintainer_or_pr_author", actorKind: "none" };
  }
  if (!args.officialAuthorDetection || args.officialAuthorDetection.status === "unavailable") {
    return { authorized: false, reason: "miner_detection_unavailable", actorKind: "author" };
  }
  if (args.officialAuthorDetection.status !== "confirmed") {
    return { authorized: false, reason: "pr_author_not_confirmed_miner", actorKind: "author" };
  }
  return { authorized: true, reason: "confirmed_miner_pr_author", actorKind: "author" };
}

export function buildPublicAgentCommandComment(args: {
  command: GittensoryMentionCommand;
  repo: RepositoryRecord | null;
  issue: GitHubIssuePayload;
  pullRequest: PullRequestRecord | null;
  actorKind: "maintainer" | "author";
  officialMiner?: GittensorContributorSnapshot | null | undefined;
  bundle?: AgentRunBundle | null | undefined;
}): string {
  const repoFullName = args.repo?.fullName ?? args.pullRequest?.repoFullName ?? "this repository";
  const title = "Gittensory agent context";
  const sections =
    args.command.name === "help"
      ? helpSections()
      : args.command.name === "miner-context"
        ? minerContextSections(args.officialMiner)
        : actionSections(args.bundle);
  const body = [
    AGENT_COMMAND_COMMENT_MARKER,
    `### ${title}`,
    "",
    `Command: \`@gittensory ${args.command.name}\``,
    `Scope: ${repoFullName}#${args.issue.number}`,
    "",
    ...sections,
    "",
    "_Advisory context only. This public comment intentionally excludes private ranking, wallet, payout, and reviewability internals._",
  ].join("\n");
  return sanitizePublicComment(body);
}

function helpSections(): string[] {
  return [
    "**Commands**",
    "",
    "- `@gittensory help` shows this command list.",
    "- `@gittensory preflight` summarizes public PR hygiene.",
    "- `@gittensory blockers` explains public readiness blockers.",
    "- `@gittensory duplicate-check` summarizes duplicate/WIP caution.",
    "- `@gittensory miner-context` confirms public Gittensor miner context.",
    "- `@gittensory next-action` gives a public-safe next step.",
  ];
}

function minerContextSections(miner: GittensorContributorSnapshot | null | undefined): string[] {
  if (!miner) {
    return ["**Miner context**", "", "- Official miner context is unavailable for this public response."];
  }
  return [
    "**Miner context**",
    "",
    `- GitHub user \`${miner.githubUsername}\` is confirmed by the official Gittensor API.`,
    `- Registered-repo PRs observed by Gittensor: ${miner.totals.pullRequests}.`,
    `- Merged registered-repo PRs observed by Gittensor: ${miner.totals.mergedPullRequests}.`,
    "- Use MCP for private branch planning before adding more public review load.",
  ];
}

function actionSections(bundle: AgentRunBundle | null | undefined): string[] {
  const actions = bundle?.actions ?? [];
  if (bundle?.run.status === "needs_snapshot_refresh") {
    return ["**Next step**", "", "- Gittensory is refreshing the contributor decision snapshot. Try the command again shortly."];
  }
  if (actions.length === 0) {
    return ["**Next step**", "", "- No public-safe action is available from the current cached context."];
  }
  const top = actions[0]!;
  return [
    "**Recommended public-safe next step**",
    "",
    `- ${top.publicSafeSummary}`,
    ...(top.blockedBy.length > 0 ? ["", "**Public readiness blockers**", "", ...top.blockedBy.slice(0, 4).map((item) => `- ${sanitizePublicComment(item)}`)] : []),
    ...(top.rerunWhen ? ["", "**Rerun when**", "", `- ${sanitizePublicComment(top.rerunWhen)}`] : []),
  ];
}

export function sanitizePublicComment(value: string): string {
  return value
    .replace(/\b(raw trust score|trust score|wallet|hotkey|coldkey|seed phrase|mnemonic)\b/gi, "private context")
    .replace(/\b(estimated score|score estimate|reward estimate|payout|farming)\b/gi, "private context");
}
