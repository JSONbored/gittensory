// Agent-SDK `CodingAgentDriver` implementation (#4267): a second implementation of the driver interface
// (#4262), this one driving the coding agent in-process via the Claude Agent SDK's `query()` async-iterable
// loop rather than shelling out to a CLI binary (the CLI-subprocess sibling, #4266). Same
// `CodingAgentDriverTask`/`CodingAgentDriverResult` contract as that sibling, so a caller (the iterate-loop
// orchestrator, maintainer-only #2333) can swap between the two with no caller-side changes.
//
// `changedFiles` is derived from a `git status --porcelain` snapshot taken before and after the run (diffed),
// NOT from parsing the SDK's streamed `tool_use` blocks. This is deliberate: `guardCodingAgentDriverResult`
// (#4276) skips its lint-guard entirely when `changedFiles` is empty ("nothing to check"), so an incomplete
// extraction here would silently skip real checks on files the agent actually touched. A git-status diff
// catches every edit regardless of which tool made it (Edit, Write, or a Bash-run `sed`), where enumerating
// every builtin tool's input schema would not.
//
// `options.hooks` forwards verbatim into the SDK's own `query()` hooks option (e.g. `PreToolUse`) rather than
// being consumed or hidden here: maintainer-only #2343 ("PreToolUse-hook-enforced house rules") names this
// driver's SDK session as its intended hook attachment point, so that surface must stay reachable from outside
// this module, not fully encapsulated.

import { execFile } from "node:child_process";
import { query as claudeAgentSdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options as ClaudeAgentSdkOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildAllowlistedEnv, redactSecrets, SUBPROCESS_CLI_ENV_ALLOWLIST } from "../subprocess-env.js";
import type { CodingAgentDriver, CodingAgentDriverResult, CodingAgentDriverTask } from "./coding-agent-driver.js";

/** `SUBPROCESS_CLI_ENV_ALLOWLIST` plus the one credential the Agent SDK's underlying session needs. */
const AGENT_SDK_ENV_ALLOWLIST = [...SUBPROCESS_CLI_ENV_ALLOWLIST, "ANTHROPIC_API_KEY"] as const;

/** Test/injection seam for `query()` — only the async-iterable half of the SDK's real `Query` return type
 *  (which also carries ~15 control-plane methods like `interrupt`/`setPermissionMode` this driver never
 *  calls), so a test fake only has to be an async generator, not a full `Query` implementation. */
export type AgentSdkQueryFn = (params: {
  prompt: string;
  options?: ClaudeAgentSdkOptions;
}) => AsyncIterable<SDKMessage>;

/** Test/injection seam for the changed-files snapshot — real IO (spawns `git`) lives only in the default
 *  implementation, mirroring `LintGuardSpawnFn`'s injected-IO convention (#4276) so this module stays
 *  synchronous-IO-free in tests. */
export type ListChangedFilesFn = (cwd: string) => Promise<readonly string[]>;

export type CreateAgentSdkCodingAgentDriverOptions = {
  /** Parent env to allowlist-filter for the SDK subprocess; defaults to `process.env`. */
  env?: Record<string, string | undefined> | undefined;
  /** Forwarded verbatim into the SDK's `query()` `hooks` option — see module header. */
  hooks?: ClaudeAgentSdkOptions["hooks"] | undefined;
  query?: AgentSdkQueryFn | undefined;
  listChangedFiles?: ListChangedFilesFn | undefined;
};

/**
 * Pure parser for `git status --porcelain` (v1 format) output into a list of relative file paths. Each line is
 * a fixed 2-character status code, a space, then the path; a rename/copy line additionally has ` -> ` before
 * the new path, and only the new path is kept. Best-effort: this feeds a diff-against-a-before-snapshot, not a
 * security boundary, so unusual porcelain shapes (e.g. paths containing " -> ") are not specially escaped.
 */
export function parseGitStatusPorcelain(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 3)
    .map((line) => {
      const rest = line.slice(3);
      const arrowIndex = rest.indexOf(" -> ");
      return arrowIndex === -1 ? rest : rest.slice(arrowIndex + 4);
    })
    .map((path) => path.trim())
    .filter(Boolean);
}

function defaultListChangedFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["status", "--porcelain"], { cwd }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(parseGitStatusPorcelain(stdout));
    });
  });
}

function isResultMessage(message: SDKMessage): message is Extract<SDKMessage, { type: "result" }> {
  return message.type === "result";
}

function isAssistantMessage(message: SDKMessage): message is Extract<SDKMessage, { type: "assistant" }> {
  return message.type === "assistant";
}

function isSuccessResult(
  message: Extract<SDKMessage, { type: "result" }>,
): message is Extract<SDKMessage, { type: "result"; subtype: "success" }> {
  return message.subtype === "success";
}

function extractAssistantText(message: Extract<SDKMessage, { type: "assistant" }>): string[] {
  const parts: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts;
}

function buildPrompt(task: CodingAgentDriverTask): string {
  return [
    task.instructions,
    "",
    `Read the acceptance criteria at ${task.acceptanceCriteriaPath} before making any changes, and stay scoped to ${task.workingDirectory}.`,
  ].join("\n");
}

/** Construct an Agent-SDK-backed `CodingAgentDriver`. See module header for the design rationale. */
export function createAgentSdkCodingAgentDriver(
  options: CreateAgentSdkCodingAgentDriverOptions = {},
): CodingAgentDriver {
  const runQuery = options.query ?? claudeAgentSdkQuery;
  const listChangedFiles = options.listChangedFiles ?? defaultListChangedFiles;

  return {
    async run(task: CodingAgentDriverTask): Promise<CodingAgentDriverResult> {
      const env = buildAllowlistedEnv(options.env ?? process.env, AGENT_SDK_ENV_ALLOWLIST);
      const before = new Set(await listChangedFiles(task.workingDirectory));
      const transcriptParts: string[] = [];
      let terminal: Extract<SDKMessage, { type: "result" }> | null = null;

      try {
        for await (const message of runQuery({
          prompt: buildPrompt(task),
          options: {
            cwd: task.workingDirectory,
            maxTurns: task.maxTurns,
            env,
            ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
          },
        })) {
          if (isAssistantMessage(message)) transcriptParts.push(...extractAssistantText(message));
          if (isResultMessage(message)) terminal = message;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "unknown error";
        return {
          ok: false,
          changedFiles: [],
          summary: "agent-sdk driver invocation failed",
          // Whatever transcript accumulated before the throw is real diagnostic material for a failed attempt
          // (mirrors src/selfhost/ai.ts's spawn wrapper resolving with partial stdout/stderr on a kill/timeout
          // rather than discarding it), so it is kept here rather than dropped.
          transcript: redactSecrets(transcriptParts.join("\n\n")),
          error: redactSecrets(messageText),
        };
      }

      const after = await listChangedFiles(task.workingDirectory);
      const changedFiles = after.filter((file) => !before.has(file));
      const transcript = redactSecrets(transcriptParts.join("\n\n"));

      if (!terminal) {
        return {
          ok: false,
          changedFiles,
          summary: "agent-sdk driver ended without a result message",
          transcript,
          error: "missing_result_message",
        };
      }

      if (isSuccessResult(terminal)) {
        return {
          ok: !terminal.is_error,
          changedFiles,
          summary: terminal.result,
          transcript,
          turnsUsed: terminal.num_turns,
        };
      }

      return {
        ok: false,
        changedFiles,
        summary: `agent-sdk driver ${terminal.subtype}`,
        transcript,
        turnsUsed: terminal.num_turns,
        error: redactSecrets(terminal.errors.join("; ") || terminal.subtype),
      };
    },
  };
}
