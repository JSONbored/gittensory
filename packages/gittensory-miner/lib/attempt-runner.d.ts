import type {
  CodingAgentDriver,
  GovernorChokepointInput,
  GovernorDecision,
  IterateLoopInput,
  IterateLoopResult,
  LocalWriteActionSpec,
} from "@jsonbored/gittensory-engine";
import type { HarnessSubmissionDecision, HarnessSubmissionEventLedger } from "./harness-submission-trigger.js";
import type { SubmissionFreshnessClaimLedger, LiveIssueSnapshot, FreshnessAbortReason } from "./submission-freshness-check.js";

export const ATTEMPT_OUTCOMES: readonly ["abandon", "stale", "blocked", "governed", "submitted"];

export type AttemptGovernorContext = Omit<GovernorChokepointInput, "actionClass" | "repoFullName" | "nowMs" | "wouldBeAction">;

export type AttemptInput = {
  loopInput: IterateLoopInput;
  issueNumber: number;
  minerLogin: string;
  base: string;
  killSwitchScope: "global" | "repo" | "none";
  slopThreshold: "clean" | "low" | "elevated" | "high";
  submissionMode: "observe" | "enforce";
  maxConsecutiveGateBlocks?: number;
  draft?: boolean;
  governor: AttemptGovernorContext;
};

export type AttemptDeps = {
  driver: CodingAgentDriver;
  runSlopAssessment: (input: unknown) => unknown;
  appendAttemptLogEvent: (event: unknown) => void;
  claimLedger: SubmissionFreshnessClaimLedger;
  fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<LiveIssueSnapshot | null>;
  eventLedger: HarnessSubmissionEventLedger;
  /** Injected governor-ledger append (mirrors evaluateGovernorChokepointGate's own `options.append`); omitted
   *  falls back to that function's own default (the real default governor ledger). */
  governorLedgerAppend?: (event: unknown) => unknown;
  sessionStartMs?: number;
  nowMs: number;
  executeLocalWrite: (spec: LocalWriteActionSpec) => Promise<unknown>;
};

export type AttemptResult =
  | { outcome: "abandon"; loopResult: IterateLoopResult }
  | { outcome: "stale"; reason: FreshnessAbortReason; loopResult: IterateLoopResult }
  | { outcome: "blocked"; decision: HarnessSubmissionDecision; loopResult: IterateLoopResult }
  | { outcome: "governed"; decision: GovernorDecision; loopResult: IterateLoopResult }
  | { outcome: "submitted"; spec: LocalWriteActionSpec; execResult: unknown; loopResult: IterateLoopResult };

export function runMinerAttempt(input: AttemptInput, deps: AttemptDeps): Promise<AttemptResult>;
