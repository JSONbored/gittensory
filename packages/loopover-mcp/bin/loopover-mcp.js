#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildFeasibilityVerdict, buildPrTextLint, buildGateDispositions, buildPublicPrBodyDraft } from "@loopover/engine";
// #6149: the miner write-tools are PURE local-execution spec builders (loopover never performs the write);
// registering them locally is just importing the same engine builders the remote server uses.
import { buildApplyLabelsSpec, buildClosePrSpec, buildCreateBranchSpec, buildDeleteBranchSpec, buildFileIssueSpec, buildFollowUpIssueSpec, buildOpenPrSpec, buildPostEligibilityCommentSpec, buildTestGenSpec, } from "@loopover/engine";
// #6269: the same manifest-validation builder the remote server uses, so `loopover_validate_config`
// can validate a `.loopover.yml` in-process instead of round-tripping to the API.
import { buildFocusManifestValidation } from "@loopover/engine";
// #6150: the same deterministic token-score computation the remote server's loopover_run_local_scorer
// wraps, so it works fully offline here too.
import { computeLocalScorerTokens } from "@loopover/engine";
import { buildSlopAssessment, SLOP_RUBRIC_MARKDOWN } from "@loopover/engine/signals/slop";
// #6749: the same pure builder the remote MCP tool + /v1/lint/test-evidence both call.
import { buildTestEvidenceReport } from "@loopover/engine/signals/test-evidence";
// #6754: the same pure evaluator the remote MCP tool + /v1/loop/evaluate-escalation both call.
import { evaluateEscalation } from "@loopover/engine";
// #6752: the same pure composer the remote MCP tool + /v1/loop/results-payload both call.
import { buildResultsPayload } from "@loopover/engine";
// #6753: the same pure composer the remote MCP tool + /v1/loop/progress-snapshot both call.
import { buildProgressSnapshot } from "@loopover/engine";
// #6755: the same pure bridge the remote MCP tool + /v1/loop/intake-idea both call.
import { validateIdeaSubmission, buildTaskGraph, buildClaimPlan } from "@loopover/engine";
import { z } from "zod";
import { buildBranchAnalysisPayload, collectLocalDiff, collectLocalBranchMetadata, probeLocalScorer, referenceScorePreviewExample, resolveScorePreviewCommand, resolveWorkspaceCwd, sanitizeLocalScorerStatus, setupGuidanceForLocalScorer, isTestFile } from "../lib/local-branch.js";
import { formatTable } from "../lib/format-table.js";
import { argsWantJson, describeCliError, reportCliFailure } from "../lib/cli-error.js";
import { redactKnownLocalPaths, redactLocalPath } from "../lib/redact-local-path.js";
// Aliased: this file's own recordStdioToolTelemetry is the chokepoint that calls it, and the two names sitting
// side by side unaliased would read as the same function (#6238).
import { recordMcpToolCall as recordLocalMcpToolCall } from "../lib/telemetry.js";
// Read name/version from this package's own package.json (always present in any install --
// global, npx, or local -- npm ships it regardless of the "files" allowlist) instead of hand-synced
// literals, so a release bump never has a second place to forget.
const ownPackageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const defaultApiUrl = "https://api.loopover.ai";
const legacyDefaultApiUrls = new Set([
    "https://gittensory-api.zeronode.workers.dev",
    "https://gittensory-api.aethereal.dev",
]);
const packageName = ownPackageJson.name;
const packageVersion = ownPackageJson.version;
const npmRegistryUrl = (process.env.LOOPOVER_NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const upgradeCommand = `npm install -g ${packageName}@latest`;
const npxFallbackCommand = `npx ${packageName}@latest <command>`;
const compatibilityPath = "/v1/mcp/compatibility";
const findingTaxonomyPath = "/v1/mcp/finding-taxonomy";
const enrichmentAnalyzersPath = "/v1/mcp/enrichment-analyzers";
const currentApiVersion = "0.1.0";
const decisionPackCacheSchemaVersion = 1;
const decisionPackCacheMaxEntries = 25;
const decisionPackCacheMaxBytes = 512 * 1024;
const cliTextFileMaxBytes = 1024 * 1024;
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const cliArgs = process.argv.slice(2);
const defaultProfileName = "default";
// Single source of truth for shell-completion: top-level command -> its subcommands (if any).
const CLI_COMMAND_SPEC = {
    login: [],
    logout: [],
    whoami: [],
    config: [],
    status: [],
    changelog: [],
    completion: [],
    version: [],
    tools: ["search"],
    doctor: [],
    telemetry: ["enable", "disable", "status"],
    "init-client": [],
    "decision-pack": [],
    "repo-decision": [],
    "contributor-profile": [],
    "monitor-open-prs": [],
    "pr-outcomes": [],
    "explain-review-risk": [],
    notifications: [],
    "notifications-read": [],
    watch: ["list", "add", "remove"],
    "analyze-branch": [],
    preflight: [],
    "review-pr": [],
    "lint-pr-text": [],
    "validate-config": [],
    "slop-risk": [],
    "improvement-potential": [],
    "issue-slop": [],
    profile: ["list", "create", "switch", "remove"],
    cache: ["status", "clear", "list"],
    agent: ["plan", "status", "explain", "packet"],
    maintain: ["status", "queue", "propose", "approve", "reject", "pause", "resume", "set-level", "precision", "outcome-calibration", "onboarding-pack", "audit-feed", "automation-state", "refresh-docs", "generate-issue-drafts"],
};
const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"];
const AGENT_PROFILE_IDS = ["miner-planner", "miner-auto-dev", "maintainer-triage", "repo-owner-intake"];
// #784 maintain set-level — the autonomy dial's action classes + levels.
//
// Both are hand-synced literals, not imports: this file resolves @loopover/engine through the PUBLISHED package
// (`^3.0.0`), whose export map exposes only `.` + a few `./scoring/*`/`./signals/*` subpaths — neither surfaces
// AUTONOMY_LEVELS, so importing the canonical list would mean widening the engine's public API (#6153). The
// drift this invites is real and has bitten once already, so test/unit/mcp-cli-maintain.test.ts pins LEVELS
// against the live enum and fails the moment the two disagree.
//
// LEVELS mirrors AUTONOMY_LEVELS (src/settings/autonomy.ts -> packages/loopover-engine/src/settings/autonomy.ts)
// exactly. #6153: it carried "suggest"/"propose" for the whole life of #4620, which dropped them server-side --
// PUT /settings validates against the live enum (src/api/routes.ts), so every value this list accepted but the
// server didn't turned an immediate, clear client-side error into a confusing 400 from the API.
//
// ACTION_CLASSES is deliberately NOT the engine's full AGENT_ACTION_CLASSES: it is the operator-settable subset
// the maintain surface exposes, and src/mcp/server.ts's MAINTAIN_AUTONOMY_ACTION_CLASSES mirrors these six on
// purpose. Do not "sync" it to the engine list.
const MAINTAIN_ACTION_CLASSES = ["review", "request_changes", "approve", "merge", "close", "label"];
const MAINTAIN_AUTONOMY_LEVELS = ["observe", "auto_with_approval", "auto"];
// #6744: the loopover_propose_action / POST .../agent/pending-actions action-class enum. A superset of
// MAINTAIN_ACTION_CLASSES (adds review_state_label) — kept separate so `maintain propose` accepts exactly what the
// route + MCP tool accept, while set-level keeps its own autonomy-configurable subset above.
const PROPOSE_ACTION_CLASSES = ["review", "request_changes", "approve", "merge", "close", "label", "review_state_label"];
// #6150 — plan-DAG step tracking for loopover_build_plan/loopover_plan_status/loopover_record_step_result.
// Hand-duplicated from src/services/plan-dag.ts (packages/loopover-engine/src/services/plan-dag.ts is NOT
// where it lives -- this module was never extracted to @loopover/engine, so there is nothing to import from
// the published package's export map), same rationale as MAINTAIN_ACTION_CLASSES/AUTONOMY_LEVELS above: this
// file resolves @loopover/engine through the published package, whose export map does not surface it.
// PURE + stateless (no DB, no repo/network access) -- the harness performs each step's real work and calls
// loopover_record_step_result to report it back; this only advances the in-memory state machine the caller
// passes in and gets back on every call.
const DEFAULT_PLAN_MAX_ATTEMPTS = 1;
function buildPlanDag(steps) {
    return {
        steps: steps.map((step) => ({
            id: step.id,
            title: step.title,
            ...(step.actionClass !== undefined ? { actionClass: step.actionClass } : {}),
            dependsOn: [...new Set((step.dependsOn ?? []).filter((dep) => dep !== step.id))],
            status: "pending",
            attempts: 0,
            maxAttempts: Math.min(10, Math.max(1, Math.trunc(step.maxAttempts ?? DEFAULT_PLAN_MAX_ATTEMPTS))),
        })),
    };
}
function validatePlanDag(plan) {
    const errors = [];
    const ids = plan.steps.map((step) => step.id);
    const idSet = new Set(ids);
    if (idSet.size !== ids.length)
        errors.push("duplicate step ids");
    for (const step of plan.steps) {
        for (const dep of step.dependsOn) {
            if (!idSet.has(dep))
                errors.push(`step ${step.id} depends on unknown step ${dep}`);
        }
    }
    const color = new Map();
    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    const hasCycle = (id) => {
        color.set(id, 1);
        for (const dep of byId.get(id)?.dependsOn ?? []) {
            const depColor = color.get(dep) ?? 0;
            if (depColor === 1)
                return true;
            if (depColor === 0 && byId.has(dep) && hasCycle(dep))
                return true;
        }
        color.set(id, 2);
        return false;
    };
    for (const step of plan.steps) {
        if ((color.get(step.id) ?? 0) === 0 && hasCycle(step.id)) {
            errors.push("plan has a dependency cycle");
            break;
        }
    }
    return { valid: errors.length === 0, errors };
}
const isPlanStepDone = (status) => status === "completed" || status === "skipped";
function nextReadySteps(plan) {
    const statusById = new Map(plan.steps.map((step) => [step.id, step.status]));
    return plan.steps.filter((step) => step.status === "pending" && step.dependsOn.every((dep) => isPlanStepDone(statusById.get(dep) ?? "pending")));
}
function mapPlanStep(plan, stepId, update) {
    return { steps: plan.steps.map((step) => (step.id === stepId ? update(step) : step)) };
}
function applyStepResult(plan, stepId, result) {
    return mapPlanStep(plan, stepId, (step) => {
        if (isPlanStepDone(step.status) || step.status === "failed")
            return step;
        if (result.outcome === "completed")
            return { ...step, status: "completed", lastError: null };
        if (result.outcome === "skipped")
            return { ...step, status: "skipped", lastError: null };
        const attempts = step.attempts + 1;
        const exhausted = attempts >= step.maxAttempts;
        return { ...step, attempts, status: exhausted ? "failed" : "pending", lastError: result.error ?? "step failed" };
    });
}
function planProgress(plan) {
    const count = (status) => plan.steps.filter((step) => step.status === status).length;
    const completed = count("completed");
    const skipped = count("skipped");
    const failed = count("failed");
    const running = count("running");
    const pending = count("pending");
    const total = plan.steps.length;
    let status;
    if (total > 0 && completed + skipped === total)
        status = "completed";
    else if (failed > 0)
        status = "failed";
    else if (running > 0)
        status = "running";
    else if (pending > 0 && nextReadySteps(plan).length === 0)
        status = "blocked";
    else
        status = "pending";
    return { total, completed, failed, running, pending, skipped, status };
}
function planView(plan) {
    return {
        plan,
        progress: planProgress(plan),
        readySteps: nextReadySteps(plan).map((step) => ({ id: step.id, title: step.title })),
        validation: validatePlanDag(plan),
    };
}
const AGENT_PROFILES = {
    "miner-planner": {
        id: "miner-planner",
        title: "Miner planner",
        audience: "contributors choosing and preparing Gittensor OSS work",
        purpose: "Plan cleanup-first work, run branch preflight, explain blockers, and prepare public-safe PR packets.",
        recommendedPrompts: ["loopover_miner_select_issue", "loopover_miner_branch_preflight", "loopover_miner_cleanup_first", "loopover_miner_draft_pr_packet"],
        recommendedTools: ["loopover_agent_plan_next_work", "loopover_preflight_current_branch", "loopover_agent_prepare_pr_packet"],
        boundaries: [
            "Human-approved only: plan, explain, draft, and prepare packets; do not open PRs, post comments, label, close, merge, or publish public GitHub output.",
            "Use public-safe summaries for copyable text and keep authenticated decision-pack context out of public GitHub text.",
            "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
        ],
        whenNotToUse: "Do not use this profile to chase compensation, predict public scores, or automate submissions without maintainer review.",
    },
    "miner-auto-dev": {
        id: "miner-auto-dev",
        title: "Miner auto-dev",
        audience: "miners running a local harness (Claude Code/Codex/Cursor) for reward-aware, gate-throttled OSS auto-development",
        purpose: "Drive a plan→implement→push loop: pick reward-optimal work, plan it as a step DAG, let YOUR harness implement it locally, and push via local write-tools — always behind the LoopOver gate and the anti-slop throttle.",
        recommendedPrompts: ["loopover_miner_select_issue", "loopover_miner_cleanup_first", "loopover_miner_draft_pr_packet"],
        recommendedTools: [
            "loopover_agent_plan_next_work",
            "loopover_run_local_scorer",
            "loopover_build_plan",
            "loopover_plan_status",
            "loopover_record_step_result",
            "loopover_preflight_current_branch",
            "loopover_preview_local_pr_score",
            "loopover_check_slop_risk",
            "loopover_predict_gate",
            "loopover_agent_prepare_pr_packet",
            "loopover_create_branch",
            "loopover_open_pr",
            "loopover_file_issue",
            "loopover_apply_labels",
            "loopover_post_eligibility_comment",
            "loopover_delete_branch",
        ],
        drivingLoop: [
            "Select: pull plan-next-work to pick the highest reward-optimal action. Respect your open-PR budget, credibility floor, and time-decay — skip work that would exceed your open-PR gate or chase low-credibility submissions.",
            "Plan: build a step DAG (loopover_build_plan) for the chosen work and advance it with loopover_record_step_result as each step completes; loopover_plan_status gives the next ready steps and lets you resume.",
            "Implement: for a code step, run loopover_create_branch, let YOUR harness write the change locally, then run your validation suite.",
            "Gate-check: run loopover_run_local_scorer + loopover_check_slop_risk + loopover_preflight_current_branch (and loopover_predict_gate) to confirm the change is substantive, slop-free, and gate-ready. If it trips slop or fails preflight, fix it locally or skip the step — never push it.",
            "Push: only once the gate is satisfied, call the local write-tools (open_pr / file_issue / apply_labels / post_eligibility_comment) and run the returned command with YOUR own credentials. LoopOver supplies the content and the gate; it never performs the write and never sees your source.",
        ],
        boundaries: [
            "Reward-aware throttle: respect the open-PR gate, your credibility floor, and time-decay — never push work that fails preflight, trips the anti-slop check, or exceeds your open-PR budget.",
            "Local execution: every GitHub write is run by YOUR harness with YOUR credentials via a write-tool's returned command. LoopOver supplies content + gates only; it never performs the write and never receives your source contents.",
            "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or upload local source contents.",
        ],
        whenNotToUse: "Do not use this profile to bypass the gate, mass-open PRs, farm low-credibility submissions, or push changes that fail preflight or trip the anti-slop check.",
    },
    "maintainer-triage": {
        id: "maintainer-triage",
        title: "Maintainer queue triage",
        audience: "maintainers preparing low-noise queue and PR review context",
        purpose: "Summarize queue risk, prepare review notes, and draft public guidance for human review.",
        recommendedPrompts: ["loopover_maintainer_queue_triage", "loopover_maintainer_review_prep", "loopover_maintainer_public_guidance"],
        recommendedTools: ["loopover_get_repo_context", "loopover_get_burden_forecast", "loopover_preflight_pr", "loopover_get_skipped_pr_audit"],
        boundaries: [
            "Human-approved only: prepare summaries and draft guidance; do not post comments, label, close, merge, or edit contributor work.",
            "Keep private review context, raw trust context, and authenticated-only evidence out of public snippets.",
            "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
        ],
        whenNotToUse: "Do not use this profile as an autonomous maintainer bot or for public ranking, public scoring, or compensation claims.",
    },
    "repo-owner-intake": {
        id: "repo-owner-intake",
        title: "Repo-owner intake",
        audience: "repository owners preparing intake readiness and onboarding plans",
        purpose: "Review registration readiness, focus manifests, docs/onboarding gaps, and manual setup actions.",
        recommendedPrompts: ["loopover_repo_owner_intake_readiness", "loopover_repo_owner_focus_manifest_review", "loopover_repo_owner_onboarding_pack"],
        recommendedTools: ["loopover_get_repo_context", "loopover_get_issue_quality", "loopover_get_registration_readiness", "loopover_get_config_recommendation"],
        boundaries: [
            "Human-approved only: review, explain, and draft setup plans; do not push config, label issues, post comments, close issues, or publish public output.",
            "Separate public readiness guidance from private maintainer or authenticated owner context.",
            "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
        ],
        whenNotToUse: "Do not use this profile to bypass owner approval, auto-register repositories, or publish policy changes automatically.",
    },
};
const configPath = process.env.LOOPOVER_CONFIG_PATH ??
    (process.env.LOOPOVER_CONFIG_DIR
        ? join(process.env.LOOPOVER_CONFIG_DIR, "config.json")
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "loopover", "config.json"));
const cacheDir = process.env.LOOPOVER_CACHE_DIR ?? join(dirname(configPath), "cache");
const decisionPackCacheDir = join(cacheDir, "decision-packs");
const config = loadConfig();
const requestedProfileName = cliOptionValue(cliArgs, "profile") ?? process.env.LOOPOVER_PROFILE;
const activeProfileName = selectProfileName(config, requestedProfileName);
const activeProfile = config.profiles?.[activeProfileName] ?? {};
const configuredApiUrl = typeof activeProfile.apiUrl === "string" ? activeProfile.apiUrl.replace(/\/+$/, "") : typeof config.apiUrl === "string" ? config.apiUrl.replace(/\/+$/, "") : undefined;
const apiUrl = (process.env.LOOPOVER_API_URL ?? (configuredApiUrl && !legacyDefaultApiUrls.has(configuredApiUrl) ? configuredApiUrl : defaultApiUrl)).replace(/\/+$/, "");
const ownerRepoShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
};
const skippedPrAuditShape = {
    repoFullName: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(64).optional(),
    since: z.string().trim().min(1).max(64).optional(),
    limit: z.number().int().positive().optional(),
};
const ownerRepoPullShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
};
// #6736: the remote loopover_get_bounty_advisory tool's input shape (src/mcp/server.ts's bountyShape) --
// a single cached-bounty id, GET /v1/bounties/:id/advisory.
const bountyAdvisoryShape = {
    id: z.string().min(1),
};
// #6619: same PR coordinates plus the OPTIONAL author login. Omitted, it resolves from the local session /
// LOOPOVER_LOGIN / GITHUB_LOGIN, so an already-logged-in contributor never has to retype their own login.
const prAiReviewFindingsShape = {
    ...ownerRepoPullShape,
    login: z.string().min(1).optional(),
};
// #6149 write-tool input shapes -- mirror src/mcp/server.ts's remote shapes (same bounds) so the local
// server validates identically. The builders (buildOpenPrSpec, ...) are the same @loopover/engine functions.
const WRITE_TOOL_REPO_FULL_NAME_MAX = 200;
const WRITE_TOOL_BRANCH_REF_MAX = 200;
const WRITE_TOOL_TITLE_MAX = 400;
const WRITE_TOOL_BODY_MAX = 60000;
const WRITE_TOOL_BRANCH_MAX = 255;
// Mirrors @loopover/engine/signals/test-evidence's TEST_FRAMEWORKS (the detectTestConvention framework set),
// so a caller cannot request a test-gen spec for a framework the detector could never produce -- same guard the
// remote server's testGenShape uses.
const TEST_FRAMEWORKS = ["vitest", "jest", "pytest", "go-test", "rspec", "cargo-test"];
const writeToolRepoFullName = z.string().min(3).max(WRITE_TOOL_REPO_FULL_NAME_MAX);
const openPrShape = {
    repoFullName: writeToolRepoFullName,
    base: z.string().min(1).max(WRITE_TOOL_BRANCH_REF_MAX),
    head: z.string().min(1).max(WRITE_TOOL_BRANCH_REF_MAX),
    title: z.string().min(1).max(WRITE_TOOL_TITLE_MAX),
    body: z.string().max(WRITE_TOOL_BODY_MAX),
    draft: z.boolean().optional(),
};
const fileIssueShape = {
    repoFullName: writeToolRepoFullName,
    title: z.string().min(1).max(WRITE_TOOL_TITLE_MAX),
    body: z.string().max(WRITE_TOOL_BODY_MAX),
    labels: z.array(z.string().min(1).max(100)).max(20).optional(),
};
const applyLabelsShape = {
    repoFullName: writeToolRepoFullName,
    number: z.number().int().positive(),
    labels: z.array(z.string().min(1).max(100)).min(1).max(20),
};
const closePrShape = {
    repoFullName: writeToolRepoFullName,
    number: z.number().int().positive(),
    comment: z.string().max(WRITE_TOOL_BODY_MAX).optional(),
};
const postEligibilityCommentShape = {
    repoFullName: writeToolRepoFullName,
    number: z.number().int().positive(),
    body: z.string().min(1).max(WRITE_TOOL_BODY_MAX),
};
const createBranchShape = {
    branch: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX),
    base: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX).optional(),
};
const deleteBranchShape = {
    branch: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX),
    remote: z.boolean().optional(),
};
const testGenShape = {
    repoFullName: writeToolRepoFullName,
    targetFiles: z.array(z.string().min(1).max(500)).min(1).max(50),
    framework: z.enum(TEST_FRAMEWORKS),
    testDir: z.string().min(1).max(255).optional(),
    criteria: z.array(z.string().min(1).max(300)).max(20).optional(),
};
const followUpIssueShape = {
    repoFullName: writeToolRepoFullName,
    path: z.string().min(1).max(500),
    line: z.number().int().positive().optional(),
    finding: z.string().min(1).max(WRITE_TOOL_BODY_MAX),
    label: z.string().min(1).max(100).optional(),
};
const loginShape = {
    login: z.string().min(1),
};
const loginRepoShape = {
    login: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
};
const validateLinkedIssueShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
    plannedChange: z
        .object({
        title: z.string().min(1).optional(),
        changedFiles: z.array(z.string()).optional(),
        contributorLogin: z.string().min(1).optional(),
    })
        .optional(),
};
const checkBeforeStartShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive().optional(),
    title: z.string().min(1).optional(),
    plannedPaths: z.array(z.string()).optional(),
};
const feasibilityGateShape = {
    claimStatus: z.enum(["unclaimed", "claimed", "solved", "unknown"]),
    duplicateClusterRisk: z.enum(["none", "low", "medium", "high"]),
    issueStatus: z.enum(["ready", "needs_proof", "hold", "do_not_use", "duplicate", "invalid", "missing"]),
    found: z.boolean().optional(),
    // Optional: when both are supplied AND a local loopover-miner install's claim ledger is present (#5157), claimStatus is
    // read from that ledger instead of trusting this caller-supplied value. Omitting either falls back to
    // today's caller-supplied-string behavior unchanged.
    repoFullName: z.string().min(1).optional(),
    issueNumber: z.number().int().positive().optional(),
};
/**
 * Read-only lookup of the caller's own claim status from a local loopover-miner install's claim ledger
 * (#5157), so `loopover_feasibility_gate` isn't purely trusting a caller-supplied `claimStatus` string.
 * Returns `null` (fall back to the caller-supplied value unchanged) only when there is genuinely nothing to
 * look up: no repo/issue supplied, no local install detected (the ledger DB file doesn't exist -- checked
 * via `existsSync` BEFORE opening anything), or the sibling `@loopover/miner` package isn't
 * resolvable at all (a standalone loopover-mcp install with no miner alongside it). When the ledger DB
 * file DOES exist (a real local install IS present) but reading it fails -- corrupt, locked, permission
 * denied -- this returns `"unknown"` rather than silently falling back to a caller-supplied string that
 * ground-truth data (which we know exists but can't currently read) might contradict; `"unknown"` is an
 * existing, honest claimStatus value the calculator already understands, not a guess.
 *
 * Uses `openClaimLedgerReadOnly` (not `openClaimLedger`), which opens the DB file in SQLite's own `readonly`
 * mode -- a DRIVER-ENFORCED guarantee, not just a by-convention one. `openClaimLedger` always runs
 * `CREATE TABLE IF NOT EXISTS` plus a schema-version stamp on open, which IS a write even against a file
 * that merely exists but is empty/uninitialized; this tool never calls that, `recordClaim`,
 * `releaseClaim`, or `expireClaim` -- it never gains any ability to block, cancel, or override a claim or
 * attempt; real claim-conflict authority stays entirely with #4848's maintainer-only path.
 */
async function resolveLedgerClaimStatus(repoFullName, issueNumber) {
    if (!repoFullName || !issueNumber)
        return null;
    let claimLedgerModule;
    try {
        claimLedgerModule = await import("@loopover/miner/lib/claim-ledger.js");
    }
    catch {
        /* v8 ignore next -- loopover-miner genuinely unresolvable (not installed alongside loopover-mcp); not
           reproducible in this monorepo's workspace-hoisted test environment, where the sibling package always
           resolves */
        return null;
    }
    const { resolveClaimLedgerDbPath, openClaimLedgerReadOnly } = claimLedgerModule;
    const dbPath = resolveClaimLedgerDbPath();
    if (!existsSync(dbPath))
        return null;
    try {
        const ledger = openClaimLedgerReadOnly(dbPath);
        try {
            const activeClaims = ledger.listActiveClaims(repoFullName);
            return activeClaims.some((claim) => claim.issueNumber === issueNumber) ? "claimed" : "unclaimed";
        }
        finally {
            ledger.close();
        }
    }
    catch {
        // The ledger DB file exists (a real local install IS present) but reading it failed -- corrupt, locked,
        // a permission error, or not actually a claim-ledger database. Never silently trust a caller-supplied
        // string that could contradict ground truth we know exists but can't currently read; "unknown" surfaces
        // that honestly instead of guessing.
        return "unknown";
    }
}
const findOpportunitiesShape = {
    targets: z
        .array(z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
    }))
        .optional(),
    searchQuery: z.string().min(1).max(500).optional(),
    goalSpec: z
        .object({
        lane: z.string().min(1).optional(),
        minRankScore: z.number().min(0).max(100).optional(),
        languages: z.array(z.string()).optional(),
    })
        .optional(),
    limit: z.number().int().min(1).max(50).optional(),
};
const issueRagShape = {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    topK: z.number().int().min(1).max(12).optional(),
};
const lintPrTextShape = {
    commitMessages: z.array(z.string()).max(50).optional(),
    prBody: z.string().optional(),
    linkedIssue: z.number().int().positive().optional(),
};
const validateConfigShape = {
    content: z.string().max(256 * 1024),
    source: z.enum(["repo_file", "api_record", "none"]).optional(),
};
// #6754: mirrors evaluateEscalationShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and
// the REST route all accept an identical payload.
const evaluateEscalationShape = {
    runStatus: z.enum(["running", "converged", "abandoned", "error"]),
    healthStatus: z.enum(["healthy", "degraded", "critical"]).optional(),
    customerFlagged: z.boolean().optional(),
    killRequested: z.boolean().optional(),
};
// #6755: mirrors intakeIdeaShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and the REST
// route all accept an identical payload. Deliberately loose -- validateIdeaSubmission owns the real checks.
const intakeIdeaShape = {
    id: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    targetRepo: z.string().optional(),
    constraints: z.array(z.string()).max(50).optional(),
    acceptanceHints: z.array(z.string()).max(50).optional(),
    priority: z.string().optional(),
    decomposition: z
        .array(z.object({ key: z.string(), title: z.string(), body: z.string(), dependsOn: z.array(z.string()).max(50).optional() }))
        .max(50)
        .optional(),
};
// #6752: mirrors buildResultsPayloadShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and
// the REST route all accept an identical payload.
const resultsPayloadShape = {
    repoFullName: z.string().min(1),
    prNumber: z.number().int().nullable().optional(),
    title: z.string(),
    changedFiles: z
        .array(z.object({ path: z.string(), additions: z.number().int().optional(), deletions: z.number().int().optional() }))
        .max(5000)
        .optional(),
    status: z.enum(["open", "merged", "closed"]).optional(),
};
// #6753: mirrors buildProgressSnapshotShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and
// the REST route all accept an identical payload.
const buildProgressSnapshotShape = {
    iteration: z.number().int(),
    maxIterations: z.number().int().nullable().optional(),
    phase: z.enum(["queued", "claiming", "coding", "reviewing", "submitting", "done"]),
    status: z.enum(["running", "converged", "abandoned", "error"]),
    recentActivity: z
        .array(z.object({ step: z.string(), detail: z.string().optional(), at: z.string().optional() }))
        .max(1000)
        .optional(),
};
// #6749: mirrors checkTestEvidenceShape in src/mcp/server.ts VERBATIM (same bounds, same optionality).
const checkTestEvidenceShape = {
    changedPaths: z.array(z.string().min(1).max(400)).max(2000),
    testFiles: z.array(z.string().min(1).max(400)).max(2000).optional(),
    tests: z.array(z.string().max(400)).max(2000).optional(),
};
// #6750: mirrors suggestBoundaryTestsShape in src/mcp/server.ts VERBATIM.
const suggestBoundaryTestsShape = {
    changedFiles: z.array(z.object({ path: z.string().min(1).max(400) }).strict()).max(500),
    boundaryTouches: z
        .array(z.object({ path: z.string().min(1).max(400), kind: z.enum(["array_index_bounds", "null_or_undefined_branch", "empty_collection_check"]) }).strict())
        .max(20)
        .optional(),
    tests: z.array(z.string().max(400)).max(2000).optional(),
    testFiles: z.array(z.string().max(400)).max(2000).optional(),
};
// #6751: mirrors simulateOpenPrPressureShape in src/mcp/server.ts VERBATIM. The bin cannot import from src/
// (package boundary), so this copy is the one place parity is by convention rather than construction — the
// route parses with the tool's own exported shape, and mcp-cli-open-pr-pressure-tool.test.ts pins that a
// payload this shape accepts is one the route accepts too.
const simulateOpenPrPressureCount = z.number().int().min(0).max(1000000);
const simulateOpenPrPressureShape = {
    repoFullName: z.string().min(3).max(200),
    generatedAt: z.string().min(1).max(100),
    queueHealth: z
        .object({
        repoFullName: z.string().min(3).max(200),
        generatedAt: z.string().min(1).max(100),
        burdenScore: z.number().finite(),
        level: z.enum(["low", "medium", "high", "critical"]),
        summary: z.string().max(1000),
        signals: z
            .object({
            openIssues: simulateOpenPrPressureCount,
            openPullRequests: simulateOpenPrPressureCount,
            unlinkedPullRequests: simulateOpenPrPressureCount,
            stalePullRequests: simulateOpenPrPressureCount,
            draftPullRequests: simulateOpenPrPressureCount,
            maintainerAuthoredPullRequests: simulateOpenPrPressureCount,
            collisionClusters: simulateOpenPrPressureCount,
            ageBuckets: z
                .object({ under7Days: simulateOpenPrPressureCount, days7To30: simulateOpenPrPressureCount, over30Days: simulateOpenPrPressureCount })
                .passthrough(),
            likelyReviewablePullRequests: simulateOpenPrPressureCount,
            cachedOpenPullRequests: simulateOpenPrPressureCount.optional(),
            likelyReviewablePullRequestsSource: z.enum(["cache", "sampled_cache", "authoritative"]).optional(),
        })
            .passthrough(),
        findings: z.array(z.unknown()).max(100),
    })
        .passthrough()
        .nullable(),
    roleContext: z.object({ maintainerLane: z.boolean() }).passthrough(),
    contributorOpenPrCount: simulateOpenPrPressureCount.optional(),
};
const checkSlopRiskShape = {
    changedFiles: z
        .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
        .max(2000)
        .optional(),
    description: z.string().max(20000).optional(),
    tests: z.array(z.string().max(400)).max(2000).optional(),
    testFiles: z.array(z.string().max(400)).max(2000).optional(),
};
const checkIssueSlopShape = {
    title: z.string().max(500).optional(),
    body: z.string().max(40000).optional(),
};
// #6150 — loopover_run_local_scorer's input, mirroring the remote server's changedFileSchema/validationEntrySchema.
const localScorerChangedFileShape = z
    .object({
    path: z.string().min(1).max(400),
    previousPath: z.string().min(1).max(400).optional(),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
    binary: z.boolean().optional(),
})
    .strict();
const localScorerValidationShape = z
    .object({
    command: z.string().min(1).max(400),
    status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
    summary: z.string().max(2000).optional(),
    durationMs: z.number().int().min(0).optional(),
    exitCode: z.number().int().min(0).optional(),
})
    .strict();
const runLocalScorerShape = {
    changedFiles: z.array(localScorerChangedFileShape).min(1).max(500),
    validation: z.array(localScorerValidationShape).max(50).optional(),
};
// #6150 — loopover_build_plan/loopover_plan_status/loopover_record_step_result's input, mirroring the remote
// server's rawPlanStepSchema/planStepSchema/planDagSchema (src/mcp/server.ts).
const rawPlanStepShape = z
    .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
})
    .strict();
const planStepShape = z
    .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50),
    status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(1).max(10),
    lastError: z.string().max(2000).nullable().optional(),
})
    .strict();
const planDagShape = z.object({ steps: z.array(planStepShape).max(100) }).strict();
const buildPlanShape = { steps: z.array(rawPlanStepShape).min(1).max(100) };
const planStatusShape = { plan: planDagShape };
const recordStepResultShape = {
    plan: planDagShape,
    stepId: z.string().min(1).max(100),
    outcome: z.enum(["completed", "failed", "skipped"]),
    error: z.string().max(2000).optional(),
};
// #6150 — loopover_predict_gate's input, mirroring the remote server's predictGateShape. Metadata-only (no
// git/workspace context needed): predicts the gate outcome for a PLANNED PR before any local code exists, the
// same use case loopover_preflight_pr already serves for lane/duplicate/linked-issue checks.
const predictGateShape = {
    login: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    title: z.string().min(1),
    body: z.string().max(40000).optional(),
    labels: z.array(z.string()).max(50).optional(),
    linkedIssues: z.array(z.number().int().positive()).max(50).optional(),
    changedPaths: z.array(z.string().min(1).max(400)).max(500).optional(),
};
const preflightShape = {
    repoFullName: z.string().min(3),
    contributorLogin: z.string().min(1).optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    changedFiles: z.array(z.string()).optional(),
    linkedIssues: z.array(z.number().int().positive()).optional(),
    tests: z.array(z.string()).optional(),
    authorAssociation: z.string().optional(),
};
const localDiffShape = {
    repoFullName: z.string().min(3),
    cwd: z.string().optional(),
    baseRef: z.string().default("HEAD"),
    contributorLogin: z.string().min(1).optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    linkedIssues: z.array(z.number().int().positive()).optional(),
    tests: z.array(z.string()).optional(),
    authorAssociation: z.string().optional(),
    commitMessage: z.string().optional(),
};
const branchEligibilityShape = {
    status: z.enum(["eligible", "ineligible", "unknown"]),
    source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
    reason: z.string().optional(),
    checkedAt: z.string().optional(),
    stale: z.boolean().optional(),
};
const localScoreShape = {
    ...localDiffShape,
    targetKey: z.string().optional(),
    sourceTokenScore: z.number().min(0).optional(),
    totalTokenScore: z.number().min(0).optional(),
    sourceLines: z.number().min(0).optional(),
    linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
    openPrCount: z.number().int().min(0).optional(),
    credibility: z.number().min(0).max(1).optional(),
    changesRequestedCount: z.number().int().min(0).optional(),
    pendingMergedPrCount: z.number().int().min(0).optional(),
    pendingClosedPrCount: z.number().int().min(0).optional(),
    approvedPrCount: z.number().int().min(0).optional(),
    expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
    projectedCredibility: z.number().min(0).max(1).optional(),
    scenarioNotes: z.array(z.string()).optional(),
    branchEligibility: z.object(branchEligibilityShape).strict().optional(),
    scorePreviewCommand: z.string().optional(),
};
const variantsShape = {
    variants: z.array(z.object(localScoreShape)).min(1).max(10),
};
const currentBranchShape = {
    login: z.string().min(1),
    cwd: z.string().optional(),
    repoFullName: z.string().min(3).optional(),
    baseRef: z.string().optional(),
    headRef: z.string().optional(),
    branchName: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    linkedIssues: z.array(z.number().int().positive()).optional(),
    pendingMergedPrCount: z.number().int().min(0).optional(),
    pendingClosedPrCount: z.number().int().min(0).optional(),
    approvedPrCount: z.number().int().min(0).optional(),
    expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
    projectedCredibility: z.number().min(0).max(1).optional(),
    scenarioNotes: z.array(z.string()).optional(),
    branchEligibility: z.object(branchEligibilityShape).strict().optional(),
    validation: z
        .array(z.object({
        command: z.string().min(1),
        status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
        summary: z.string().optional(),
        durationMs: z.number().int().min(0).optional(),
        exitCode: z.number().int().min(0).optional(),
    }))
        .optional(),
    scorePreviewCommand: z.string().optional(),
};
const currentBranchVariantsShape = {
    variants: z.array(z.object(currentBranchShape)).min(1).max(10),
};
const agentPlanShape = {
    login: z.string().min(1),
    objective: z.string().optional(),
    repoFullName: z.string().min(3).optional(),
};
const agentRunShape = {
    objective: z.string().min(1),
    actorLogin: z.string().min(1),
    targetRepoFullName: z.string().min(3).optional(),
    targetPullNumber: z.number().int().positive().optional(),
    targetIssueNumber: z.number().int().positive().optional(),
};
const agentRunIdShape = {
    runId: z.string().min(1),
};
// #6152 maintain-surface tools. Each shape mirrors its already-shipped remote counterpart in src/mcp/server.ts
// (listPendingActionsShape, decidePendingActionShape, setAgentPausedShape, setActionAutonomyShape,
// ownerRepoWindowShape) so the same call works against either server. The `decision` verb is accept|reject --
// the approval-queue route's own vocabulary (#779) -- rather than the maintain CLI's approve|reject, because a
// tool caller is talking to the route, not to the CLI's surface.
//
// One deliberate divergence: the remote's listPendingActionsShape takes an optional `status`, which it can honour
// because it queries the approval-queue store directly. This server reaches the queue only through
// GET /v1/repos/:owner/:repo/agent/pending-actions, which takes no query parameters and hardcodes status
// "pending" (src/api/routes.ts). Offering a `status` here would let a caller ask for "rejected", get the pending
// list, and be told it succeeded -- so it is left out of the schema and the description names the queue as the
// pending one. An agent picks its arguments from the published schema, so a filter that isn't there is one it
// won't ask for; a key sent anyway is dropped by the MCP layer before this handler and never reaches the URL.
const listPendingActionsShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
};
const decidePendingActionShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    id: z.string().min(1),
    decision: z.enum(["accept", "reject"]),
};
const setAgentPausedShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    paused: z.boolean(),
};
// Reuses the CLI's own constants, so `maintain set-level`'s validation and this tool's schema can never disagree
// about what the server accepts.
const setActionAutonomyShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    action: z.enum(MAINTAIN_ACTION_CLASSES),
    level: z.enum(MAINTAIN_AUTONOMY_LEVELS),
};
const gatePrecisionShape = {
    owner: z.string().min(1),
    repo: z.string().min(1),
    windowDays: z.number().int().positive().optional(),
};
// Single source of truth for stdio tool name + one-line description (#2233).
// Registration and `loopover-mcp tools` both read this list.
const STDIO_TOOL_DESCRIPTORS = [
    {
        name: "loopover_get_repo_context",
        category: "maintainer",
        description: "Return the LoopOver repo-context bundle for a repo — registration state, recommended contribution lane, queue health, duplicate-PR collisions, and config quality — from the private LoopOver API. Takes owner and repo.",
    },
    {
        name: "loopover_get_pr_reviewability",
        category: "review",
        description: "Return the reviewability report for an open PR: how ready it is to review/merge, the blocking or advisory signals against it, and its lane/duplicate/linked-issue context. Metadata-only, no GitHub writes.",
    },
    {
        name: "loopover_get_pr_ai_review_findings",
        category: "review",
        description: "Return a submitted pull request's real AI-review inline findings as structured JSON (category, path, severity, line, body) — the same categorization the PR comment uses. Post-submission only; self-scoped to your own PRs. Metadata-only, no GitHub writes.",
    },
    {
        name: "loopover_get_maintainer_noise",
        category: "maintainer",
        description: "Return the maintainer queue-noise triage report for a repo: a noise score/level, the specific noise sources to clear first, and recommended maintainer actions. Maintainer-authenticated; advisory only.",
    },
    {
        name: "loopover_preflight_pr",
        category: "discovery",
        description: "Preflight planned PR metadata against lane, duplicate, linked issue, test, and queue signals.",
    },
    {
        name: "loopover_explain_review_risk",
        category: "review",
        description: "Explain review risk for a planned PR using preflight, lane, duplicate, and role context.",
    },
    {
        name: "loopover_validate_linked_issue",
        category: "discovery",
        description: "Report whether linking an issue will actually earn the standard linked-issue scoring multiplier for a planned PR — open, valid, single-owner, solvable by this PR — with the blocking reason if not. The raw multiplier value stays private.",
    },
    {
        name: "loopover_check_before_start",
        category: "discovery",
        description: "Before writing any code, check whether an issue is already claimed or solved, whether a duplicate cluster is forming, and whether it is a valid target. Returns a go/raise/avoid recommendation with public-safe reasons from cached metadata.",
    },
    {
        name: "loopover_find_opportunities",
        category: "discovery",
        description: "Cross-repo discovery: find high-fit contribution opportunities across registered Gittensor repos. Returns a ranked, public-safe list filtered by your MinerGoalSpec (lane, min rank score, languages). Metadata-only, no GitHub writes.",
    },
    {
        name: "loopover_retrieve_issue_context",
        category: "discovery",
        description: "Repo-scoped issue-centric RAG retrieval for the miner analyze phase. Returns related file paths and retrieval scores from issue title/body/labels — metadata only, never source text.",
    },
    {
        name: "loopover_lint_pr_text",
        category: "review",
        description: "Lint a commit message + PR body against the gittensor traceability/no-issue-rationale and Conventional Commit rubric before submitting. Returns a deterministic verdict (strong/adequate/weak) plus specific public-safe fixes. Computed in-process; no source upload and no API round-trip.",
    },
    {
        name: "loopover_validate_config",
        category: "utility",
        description: "Parse and validate a .loopover.yml manifest string using the same focus-manifest parser as the server. Returns normalized config fields, parse warnings, and an ok/warn/error status. Computed in-process; no source upload and no API round-trip. Metadata-only, no GitHub writes.",
    },
    {
        name: "loopover_check_slop_risk",
        category: "review",
        description: "Assess the deterministic slop risk of a planned change from local diff metadata (paths + line counts) + the PR description — an agent-native, source-free quality self-check. Returns slopRisk (0-100), band, findings, and the rubric. Computed in-process; no repo data and no API round-trip.",
    },
    {
        name: "loopover_simulate_open_pr_pressure",
        category: "discovery",
        description: "Rank what-if scenarios for easing a repo's open-PR pressure from already-computed queue-health metadata — deterministic, public-safe, and read-only. Needs no repo access and performs no GitHub writes.",
    },
    {
        name: "loopover_suggest_boundary_tests",
        category: "review",
        description: "Boundary-safe test-generation suggestion: evaluate locally precomputed boundary-touch metadata (path + pattern kind only; no patch/source text) with no test evidence in the diff, and return a LOCAL-execution action spec (criteria/hints only — never generated test code) for your OWN agent to scaffold tests with. Advisory-only; never blocks, never writes.",
    },
    {
        name: "loopover_check_test_evidence",
        category: "review",
        description: "Classify whether a planned change's changed files carry enough test evidence, from path metadata alone (no source uploaded) — an agent-native coverage-gap self-check before opening a PR. Returns a coverage band (strong/adequate/weak/absent) plus actionable guidance. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_evaluate_escalation",
        category: "agent",
        description: "Decide whether a rented loop needs a human, and what action to take, from an already-computed run outcome, health tier, and operator/customer signals — the deterministic support/escalation-path logic. Source-free; returns shouldEscalate + action (none/notify/human_review/stop) + severity + reasons. It decides; the caller wires the action. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_build_results_payload",
        category: "agent",
        description: "Package a completed loop iteration into the customer-facing result (#4801): a PR link, a plain-language summary, and a bounded diff preview, from already-computed iteration metadata. Deterministic and source-free — it formats the result, it does not fetch, open, or deliver anything. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_build_progress_snapshot",
        category: "agent",
        description: "Build a near-real-time progress snapshot for a running rented loop (#4800): phase, status, iteration/percent-complete, and a bounded recent-activity tail, from already-computed loop state. Deterministic and source-free; a customer surface pushes it on change rather than polling on a fixed interval. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_intake_idea",
        category: "agent",
        description: "Turn a freeform renter idea into a strict, claimable task-graph (spec #4779) and score it against the same feasibility gate the loop runs on. Deterministic and source-free: validates the submission, assembles constituent issues (an optional caller-supplied decomposition, else a single-issue baseline), and returns the graph plus its go/raise/avoid verdict. A malformed or empty submission returns an actionable error list, not a silent failure. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_plan_idea_claims",
        category: "agent",
        description: "Route a freeform idea through the intake bridge into a claim/code/submit-loop plan (#4799): validates the submission, builds the scored task-graph, and returns which constituent issues the loop can claim now vs. defer vs. skip — dependency-ordered so a prerequisite is always claimed before its dependents. Deterministic and source-free; it decides what to claim, it does not claim or run anything. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_check_issue_slop",
        category: "review",
        description: "Assess the deterministic slop risk of an issue from its title + body alone (no repo data) — flags clearly low-effort issues (empty body, an unfilled template) for triage. Returns slopRisk (0-100), band, findings, and the rubric. Advisory-only.",
    },
    // #6150 — the miner-auto-dev profile's plan-DAG + local-scorer + gate-prediction tools, previously listed in
    // recommendedTools below but never actually registered.
    {
        name: "loopover_run_local_scorer",
        category: "branch",
        description: "Compute deterministic source/test/non-code token scores from local changed-file metadata + validation results — no repo/contributor access, reveals nothing beyond a computation on the caller's own diff stats. Pass the result as the localScorer field of loopover_preview_local_pr_score or the analyze tools to score this branch in external_command mode. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_build_plan",
        category: "agent",
        description: "Build a normalized step DAG (dependencies, retry limits) from a raw list of steps and validate it for cycles/unknown dependencies. Returns the plan, its progress, the currently-ready steps, and validation. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_plan_status",
        category: "agent",
        description: "Return a plan's current progress, the next ready steps, and validation status. Takes the plan object returned by loopover_build_plan or a prior loopover_record_step_result call. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_record_step_result",
        category: "agent",
        description: "Record the outcome (completed/failed/skipped) of a plan step the harness just ran and return the updated plan. A failed step retries (back to pending) until its maxAttempts is exhausted. Computed in-process; no API round-trip.",
    },
    {
        name: "loopover_predict_gate",
        category: "review",
        description: "Predict the LoopOver gate outcome for a planned PR before any local code exists — the same advisory + gate evaluation the maintainer pipeline runs, using only the repo's public .loopover.yml policy. Takes login, owner, repo, title, and optional body/labels/linkedIssues/changedPaths. Metadata-only, no source upload.",
    },
    {
        name: "loopover_explain_gate_disposition",
        category: "review",
        description: "Explain WHY the LoopOver gate would pass or block a planned PR: the itemized per-rule dispositions (which specific gate rules block vs advise, and why) behind loopover_predict_gate's verdict. Read-only reasoning surface from the repo's PUBLIC .loopover.yml only — no merge/close decision. Self-scoped to the authenticated login.",
    },
    {
        name: "loopover_preflight_local_diff",
        category: "branch",
        description: "Inspect local git diff metadata and run LoopOver preflight without uploading source contents.",
    },
    {
        name: "loopover_get_registry_changes",
        category: "utility",
        description: "Return the latest cached report of changes to the Gittensor repo registry — repositories added, removed, or re-registered upstream. Read-only; takes no parameters.",
    },
    {
        name: "loopover_get_upstream_drift",
        category: "utility",
        description: "Return the latest cached Gittensor upstream ruleset drift status (stale/drift warnings) for MCP planning.",
    },
    {
        name: "loopover_get_bounty_advisory",
        category: "discovery",
        description: "Return the lifecycle, funding, and consensus-risk context for a cached Gittensor bounty by id, from the public LoopOver API.",
    },
    {
        name: "loopover_get_label_audit",
        category: "maintainer",
        description: "Return the repo's label-policy audit (configured-vs-live labels, missing configured labels, suspicious status/source-style labels, and trusted-label-pipeline readiness) from the private LoopOver API.",
    },
    {
        name: "loopover_get_maintainer_lane",
        category: "maintainer",
        description: "Return the repo's maintainer-lane triage report (the lane recommendation alongside the configured maintainer cut, queue health, config quality, and contributor-intake health) from the private LoopOver API. Advisory only.",
    },
    {
        name: "loopover_get_burden_forecast",
        category: "maintainer",
        description: "Return the repo's cached maintainer burden forecast (projected review load, queue-growth risk, and stale-PR signals) with a freshness marker, from the private LoopOver API.",
    },
    {
        name: "loopover_get_repo_outcome_patterns",
        category: "maintainer",
        description: "Return cached or freshly-computed per-repo accepted/rejected PR outcome patterns: what maintainers actually merge or close, separated from maintainer-lane activity, with a freshness marker and explicit evidence-completeness.",
    },
    {
        name: "loopover_preview_local_pr_score",
        category: "branch",
        description: "Inspect local diff metadata and request a private LoopOver scoring preview. No source contents are uploaded.",
    },
    {
        name: "loopover_explain_score_breakdown",
        category: "review",
        description: "Explain a private score preview multiplier-by-multiplier with plain-English levers and the highest-impact improvement.",
    },
    {
        name: "loopover_get_eligibility_plan",
        category: "discovery",
        description: "Derive a structured eligibility plan from local score-preview metadata: whether the branch/PR is eligible now, public-safe blockers, and cleanup paths. Advisory dry-run only — no GitHub writes.",
    },
    {
        name: "loopover_get_decision_pack",
        category: "discovery",
        description: "Return the private decision pack for a contributor: the ranked repos and issues to work on next, with per-repo go/raise/avoid guidance. Takes login (the contributor's GitHub username).",
    },
    {
        name: "loopover_explain_repo_decision",
        category: "discovery",
        description: "Return the go/raise/avoid decision for one specific contributor-and-repo pair, drawn from that contributor's decision pack — narrower than loopover_get_decision_pack, which returns the whole pack. Takes login (GitHub username), owner, and repo.",
    },
    {
        name: "loopover_monitor_open_prs",
        category: "discovery",
        description: "Inspect a contributor's open PRs on registered repos, classify queue state, and return public-safe next-step packets from cached metadata.",
    },
    {
        name: "loopover_pr_outcome",
        category: "review",
        description: "Return a contributor's own post-merge outcome records — for each merged PR, a public-safe attribution of what it did for their standing on the repo. Self-scoped: only the authenticated login's outcomes.",
    },
    {
        name: "loopover_compare_pr_variants",
        category: "branch",
        description: "Compare private LoopOver scoring previews across local/metadata variants.",
    },
    {
        name: "loopover_local_status",
        category: "utility",
        description: "Return local LoopOver MCP status, inferred git repo metadata, and privacy defaults.",
    },
    {
        name: "loopover_preflight_current_branch",
        category: "branch",
        description: "Analyze the current git branch and return PR readiness. Sends metadata only.",
    },
    {
        name: "loopover_review_pr_before_push",
        category: "branch",
        description: "Run a single composed pre-PR review of the current branch: preflight (lane/duplicate/linked-issue/test/queue fit), slop-risk, and PR-text lint, merged into one report with an overall pass/warn/fail status. Thin composition of the existing checks — does not reimplement any of them. Sends metadata only, no source upload.",
    },
    {
        name: "loopover_preview_current_branch_score",
        category: "branch",
        description: "Analyze the current git branch and return private scoreability context. Sends metadata only.",
    },
    {
        name: "loopover_rank_local_next_actions",
        category: "branch",
        description: "Analyze the current git branch and rank local next actions by private reward/risk and review friction.",
    },
    {
        name: "loopover_explain_local_blockers",
        category: "branch",
        description: "Analyze the current git branch and explain private scoreability, lane, and review blockers.",
    },
    {
        name: "loopover_remediation_plan",
        category: "branch",
        description: "Analyze the current git branch and return an ordered public-safe remediation checklist with rerun conditions.",
    },
    {
        name: "loopover_prepare_pr_packet",
        category: "branch",
        description: "Analyze the current git branch and return a public-safe PR packet. Sends metadata only.",
    },
    {
        name: "loopover_draft_pr_body",
        category: "branch",
        description: "Draft a public-safe, copy/paste PR body from local branch metadata (changed files, tests run, linked issue, duplicate/WIP caution, branch freshness, next steps). Private scoreability/reward/trust context is excluded; source contents are not uploaded. Optional format=markdown returns the rendered body as the primary payload.",
    },
    {
        name: "loopover_compare_local_variants",
        category: "branch",
        description: "Compare current-branch metadata variants without uploading source contents.",
    },
    {
        name: "loopover_agent_plan_next_work",
        category: "agent",
        description: "Run the deterministic LoopOver planner for a contributor and return the single recommended next unit of work (repo, issue, and action). Planning only — does not queue or start a run. Takes login (GitHub username); optional objective and repoFullName narrow the result.",
    },
    {
        name: "loopover_agent_start_run",
        category: "agent",
        description: "Queue a new LoopOver automated-agent run for a contributor. Copilot mode only: it proposes and records work but takes no GitHub actions on its own. Takes objective (what to accomplish) and actorLogin (the contributor's GitHub username); returns the new run's id and status.",
    },
    {
        name: "loopover_agent_get_run",
        category: "agent",
        description: "Fetch a previously queued LoopOver agent run by its id, including current status and planned actions. Takes runId (the id returned by loopover_agent_start_run).",
    },
    {
        name: "loopover_agent_explain_next_action",
        category: "agent",
        description: "Explain the next deterministic action and blocker context for a GitHub login.",
    },
    {
        name: "loopover_agent_prepare_pr_packet",
        category: "branch",
        description: "Prepare a public-safe PR packet from current branch metadata. Sends metadata only.",
    },
    {
        name: "loopover_local_status_structured",
        category: "utility",
        description: "Return local LoopOver MCP status with a validated structured output schema.",
    },
    {
        name: "loopover_feasibility_gate",
        category: "discovery",
        description: "Pure local go/raise/avoid feasibility verdict from claim status, duplicate-cluster risk, and issue quality/lifecycle status — the same discriminants the analyze-phase feasibility gate branches on. When repoFullName/issueNumber are supplied and a local loopover-miner install's claim ledger is present, claimStatus is read from that ledger instead of the caller-supplied value; otherwise falls back to the caller-supplied claimStatus unchanged. Advisory-only — never blocks, cancels, or overrides a claim or attempt; real claim-conflict resolution authority stays with the maintainer-only path. No API round-trip.",
    },
    {
        name: "loopover_get_issue_quality",
        category: "maintainer",
        description: "Return the cached or freshly-computed issue-quality report for a repo, ranking which open issues are actionable, need proof, are stale/duplicate-prone, or already solved.",
    },
    {
        name: "loopover_get_registration_readiness",
        category: "maintainer",
        description: "Preview-only registration-readiness report for a repository: what's missing/present before/after registering with LoopOver (direct-PR and issue-discovery lane readiness, label policy, maintainer-cut readiness, queue health, docs, and the GitHub App install state). Advisory only, not a registration action.",
    },
    {
        name: "loopover_get_config_recommendation",
        category: "maintainer",
        description: "Return recommended .loopover.yml additions for a repository, derived from the repo's live, currently-active configured behavior (the raw dashboard/API-configured settings, not a yml-merged view — so the recommendation never compares itself against an override that already exists). Advisory only, not a write action.",
    },
    {
        name: "loopover_get_skipped_pr_audit",
        category: "maintainer",
        description: "Return the skipped-PR audit trail: pull requests LoopOver's automated reviewer intentionally stayed quiet on, each with a reason code and a remediation hint. Optionally filter by repoFullName, reason, or since. Maintainer-authenticated; read-only measurement, not a moderation or override action.",
    },
    // #6152 — the maintain CLI's REST surface, exposed as tools so an agent can drive it without shelling out.
    // Categories mirror the remote server's MCP_TOOL_CATEGORIES entries for the same names, so a caller sees one
    // consistent grouping across both surfaces.
    {
        name: "loopover_list_pending_actions",
        category: "agent",
        description: "List the agent actions currently staged and awaiting a decision in a repo's approval queue, so a maintainer can review what is pending. Returns the pending queue only — the same list as `loopover-mcp maintain queue`. Maintainer access required.",
    },
    {
        name: "loopover_decide_pending_action",
        category: "agent",
        description: "Accept (execute) or reject a staged approval-queue action by id. Accept runs it through the live executor gates; reject cancels it. Scoped to this repo, same as `loopover-mcp maintain approve|reject <id>`. Maintainer access required.",
    },
    {
        name: "loopover_set_agent_paused",
        category: "agent",
        description: "Pause or resume ALL agent actions on a repo (the kill-switch toggle), same as `loopover-mcp maintain pause|resume`. Maintainer access required.",
    },
    {
        name: "loopover_set_action_autonomy",
        category: "agent",
        description: "Set the autonomy level for one action class via a read-merge-write, so the other classes are left untouched. Same as `loopover-mcp maintain set-level <action> <level>`. Maintainer access required.",
    },
    {
        name: "loopover_get_gate_precision",
        category: "maintainer",
        description: "Return per-gate-type false-positive precision for a repo's recorded gate blocks — blocked / blocked-then-merged counts and false-positive rates with low-sample guards. Optionally bounded by windowDays. Maintainer-authenticated; measurement only.",
    },
    {
        name: "loopover_open_pr",
        category: "agent",
        description: "Build a LOCAL-execution spec to open a pull request from your branch (run it with your own gh creds; loopover never performs the write).",
    },
    {
        name: "loopover_file_issue",
        category: "agent",
        description: "Build a LOCAL-execution spec to file an issue (run it with your own gh creds; loopover never performs the write).",
    },
    {
        name: "loopover_apply_labels",
        category: "agent",
        description: "Build a LOCAL-execution spec to add labels to an issue or PR (run it with your own gh creds; loopover never performs the write).",
    },
    {
        name: "loopover_post_eligibility_comment",
        category: "agent",
        description: "Build a LOCAL-execution spec to post an eligibility/context comment on an issue or PR (run it with your own gh creds; loopover never performs the write).",
    },
    {
        name: "loopover_create_branch",
        category: "agent",
        description: "Build a LOCAL-execution spec to create a branch (run it locally; loopover never performs the write).",
    },
    {
        name: "loopover_delete_branch",
        category: "agent",
        description: "Build a LOCAL-execution spec to delete a branch (run it locally; loopover never performs the write).",
    },
    {
        name: "loopover_generate_tests",
        category: "agent",
        description: "Build a LOCAL-execution spec describing WHAT boundary-safe test cases should exist for the given target files, using the repo's detected framework/convention. LoopOver supplies the criteria; your OWN agent scaffolds and runs the actual test files locally -- no source code is uploaded and loopover never performs the write.",
    },
    {
        name: "loopover_file_follow_up_issue",
        category: "agent",
        description: "Build a LOCAL-execution spec to file a follow-up issue for a review finding a maintainer wants TRACKED rather than blocked on this PR. Composes a bounded, public-safe title/body from the finding (run it with your own gh creds; loopover never performs the write).",
    },
    {
        name: "loopover_close_pr",
        category: "agent",
        description: "Build a LOCAL-execution spec to close a pull request, optionally with a comment (run it with your own gh creds; loopover never performs the write).",
    },
];
// #6301 — coarse tool categories for grouping `loopover-mcp tools` output. Ordered
// contributor-facing surfaces first, operator ones last; the `label` is the human-readable header.
// Every STDIO_TOOL_DESCRIPTORS entry carries a `category` id drawn from this list (asserted in tests).
const STDIO_TOOL_CATEGORIES = [
    { id: "discovery", label: "Discovery & planning" },
    { id: "branch", label: "Local branch & PR prep" },
    { id: "review", label: "Review & gate prediction" },
    { id: "agent", label: "Agent automation" },
    { id: "maintainer", label: "Maintainer & repo owner" },
    { id: "utility", label: "Registry, config & status" },
];
function stdioToolDescription(name) {
    const tool = STDIO_TOOL_DESCRIPTORS.find((entry) => entry.name === name);
    if (!tool)
        throw new Error(`Unknown stdio tool descriptor: ${name}`);
    return tool.description;
}
if (cliArgs[0] && cliArgs[0] !== "--stdio") {
    try {
        const exitCode = await runCli(cliArgs);
        process.exit(typeof exitCode === "number" ? exitCode : 0);
    }
    catch (error) {
        process.exit(reportCliFailure(argsWantJson(cliArgs), describeCliError(error), 1));
    }
}
const server = new McpServer({
    name: "loopover-local",
    version: packageVersion,
});
// #4777: register a stdio tool under its loopover_ name. Thin wrapper kept so all 37 call sites
// stay uniform with the rest of this file's registration style.
// Single chokepoint for the #6228 PostHog tool-call telemetry (#6238): every registerStdioTool-registered tool
// routes through here exactly once per invocation, whether it returns or throws. Pure observability -- a
// telemetry failure must never reach the tool caller, so this keeps a defensive try/catch on top of
// recordMcpToolCall's own never-throw guarantee (#6236), mirroring recordMcpToolTelemetry on the remote side
// (#6237).
//
// Reads the opt-in flag HERE, at module scope, on purpose: registerStdioTool's second parameter is the TOOL's
// config and shadows the module-level `config` this resolves from, so a read inside that function would silently
// see the wrong object and never fire.
function recordStdioToolTelemetry(tool, ok, durationMs) {
    try {
        recordLocalMcpToolCall({ telemetryEnabled: telemetryState().enabled }, { tool, callerType: "local", ok, durationMs });
    }
    catch {
        // Telemetry must never affect the tool response (#6238).
    }
}
function registerStdioTool(name, config, handler) {
    server.registerTool(name, config, async (...args) => {
        const startedAt = Date.now();
        try {
            const result = await handler(...args);
            // Mirror the remote's caller-visible outcome (`response.status < 400`): a handler that reports failure by
            // returning an error result is not a success, even though it never threw.
            recordStdioToolTelemetry(name, result?.isError !== true, Date.now() - startedAt);
            return result;
        }
        catch (error) {
            recordStdioToolTelemetry(name, false, Date.now() - startedAt);
            throw error;
        }
    });
}
registerStdioTool("loopover_get_repo_context", {
    description: stdioToolDescription("loopover_get_repo_context"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver repo intelligence.", await apiGet(`${prefix}/intelligence`));
});
registerStdioTool("loopover_get_pr_reviewability", {
    description: stdioToolDescription("loopover_get_pr_reviewability"),
    inputSchema: ownerRepoPullShape,
}, async ({ owner, repo, number }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver PR reviewability.", await apiGet(`${prefix}/pulls/${number}/reviewability`));
});
// #6619: CLI mirror of the remote server's loopover_get_pr_ai_review_findings. The route is the single source
// of truth (it delegates to the same loadPrAiReviewFindings the MCP server uses); this tool only resolves the
// author login and proxies. Self-scoped: the route's requireContributorAccess rejects another login's PR.
registerStdioTool("loopover_get_pr_ai_review_findings", {
    description: stdioToolDescription("loopover_get_pr_ai_review_findings"),
    inputSchema: prAiReviewFindingsShape,
}, async ({ owner, repo, number, login }) => {
    const authorLogin = login ?? activeProfile.session?.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!authorLogin)
        throw new Error("No GitHub login: pass `login`, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN.");
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver PR AI-review findings.", await apiGet(`${prefix}/pulls/${number}/ai-review-findings?login=${encodeURIComponent(authorLogin)}`));
});
registerStdioTool("loopover_get_maintainer_noise", {
    description: stdioToolDescription("loopover_get_maintainer_noise"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver maintainer noise report.", await apiGet(`${prefix}/maintainer-noise`));
});
registerStdioTool("loopover_get_issue_quality", {
    description: stdioToolDescription("loopover_get_issue_quality"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver issue-quality report.", await apiGet(`${prefix}/issue-quality`));
});
registerStdioTool("loopover_get_registration_readiness", {
    description: stdioToolDescription("loopover_get_registration_readiness"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver registration-readiness report.", await apiGet(`${prefix}/registration-readiness`));
});
registerStdioTool("loopover_get_config_recommendation", {
    description: stdioToolDescription("loopover_get_config_recommendation"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver config recommendation.", await apiGet(`${prefix}/gittensor-config-recommendation`));
});
registerStdioTool("loopover_get_skipped_pr_audit", {
    description: stdioToolDescription("loopover_get_skipped_pr_audit"),
    inputSchema: skippedPrAuditShape,
}, async ({ repoFullName, reason, since, limit }) => {
    const query = new URLSearchParams();
    if (repoFullName)
        query.set("repoFullName", repoFullName);
    if (reason)
        query.set("reason", reason);
    if (since)
        query.set("since", since);
    if (limit != null)
        query.set("limit", String(limit));
    const qs = query.toString();
    return toolResult("LoopOver skipped-PR audit trail.", await apiGet(`/v1/app/skipped-pr-audit${qs ? `?${qs}` : ""}`));
});
registerStdioTool("loopover_preflight_pr", {
    description: stdioToolDescription("loopover_preflight_pr"),
    inputSchema: preflightShape,
}, async (input) => toolResult("LoopOver PR preflight.", await apiPost("/v1/preflight/pr", input)));
// #6980: CLI stdio mirror of loopover_explain_review_risk — proxies POST /v1/preflight/review-risk.
registerStdioTool("loopover_explain_review_risk", {
    description: stdioToolDescription("loopover_explain_review_risk"),
    inputSchema: preflightShape,
}, async (input) => {
    const payload = await apiPost("/v1/preflight/review-risk", input);
    return toolResult(payload.summary ?? `LoopOver review-risk explanation for ${input.repoFullName}.`, payload);
});
registerStdioTool("loopover_validate_linked_issue", {
    description: stdioToolDescription("loopover_validate_linked_issue"),
    inputSchema: validateLinkedIssueShape,
}, async ({ owner, repo, issueNumber, plannedChange }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const body = { issueNumber, ...(plannedChange ? { plannedChange } : {}) };
    return toolResult("LoopOver linked-issue validation.", await apiPost(`${prefix}/validate-linked-issue`, body));
});
registerStdioTool("loopover_check_before_start", {
    description: stdioToolDescription("loopover_check_before_start"),
    inputSchema: checkBeforeStartShape,
}, async ({ owner, repo, issueNumber, title, plannedPaths }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const body = {
        ...(issueNumber != null ? { issueNumber } : {}),
        ...(title ? { title } : {}),
        ...(plannedPaths ? { plannedPaths } : {}),
    };
    return toolResult("LoopOver pre-start check.", await apiPost(`${prefix}/check-before-start`, body));
});
registerStdioTool("loopover_find_opportunities", {
    description: stdioToolDescription("loopover_find_opportunities"),
    inputSchema: findOpportunitiesShape,
}, async ({ targets, searchQuery, goalSpec, limit }) => {
    const body = {
        ...(targets && targets.length > 0 ? { targets } : {}),
        ...(searchQuery ? { searchQuery } : {}),
        ...(goalSpec ? { goalSpec } : {}),
        ...(limit != null ? { limit } : {}),
    };
    return toolResult("LoopOver cross-repo opportunities.", await apiPost("/v1/opportunities/find", body));
});
registerStdioTool("loopover_retrieve_issue_context", {
    description: stdioToolDescription("loopover_retrieve_issue_context"),
    inputSchema: issueRagShape,
}, async ({ owner, repo, title, body, labels, topK }) => {
    const payload = {
        owner,
        repo,
        title,
        ...(body ? { body } : {}),
        ...(labels && labels.length > 0 ? { labels } : {}),
        ...(topK != null ? { topK } : {}),
    };
    return toolResult("LoopOver issue-centric RAG context.", await apiPost("/v1/issue-rag/retrieve", payload));
});
// Computed in-process from @loopover/engine (#6268) — matches the remote server's own buildPrTextLint
// call (src/mcp/server.ts) with no API round-trip, so PR-text lint works fully offline.
registerStdioTool("loopover_lint_pr_text", {
    description: stdioToolDescription("loopover_lint_pr_text"),
    inputSchema: lintPrTextShape,
}, (input) => toolResult("LoopOver PR-text lint.", buildPrTextLint(input)));
// #6269: computed in-process via the extracted engine builder -- no API round-trip, works fully offline.
registerStdioTool("loopover_validate_config", {
    description: stdioToolDescription("loopover_validate_config"),
    inputSchema: validateConfigShape,
}, (input) => toolResult("LoopOver manifest validation.", buildFocusManifestValidation(input)));
// Computed in-process from @loopover/engine (#6267) — matches the remote server's own buildSlopAssessment
// call (src/mcp/server.ts) and the /v1/lint/slop-risk route's `{ ...assessment, rubric }` shape with no API
// round-trip, so slop-risk self-checks work fully offline.
registerStdioTool("loopover_check_slop_risk", {
    description: stdioToolDescription("loopover_check_slop_risk"),
    inputSchema: checkSlopRiskShape,
}, (input) => toolResult("LoopOver slop-risk self-check.", { ...buildSlopAssessment(input), rubric: SLOP_RUBRIC_MARKDOWN }));
// #6751: CLI mirror of the remote server's loopover_simulate_open_pr_pressure. Proxies rather than computing
// in-process (like the boundary-tests mirror, #6750): simulateOpenPrPressure lives app-side in
// src/services/open-pr-pressure-scenarios.ts, not in @loopover/engine, so POST /v1/lint/open-pr-pressure stays
// the single source of truth for the ranking.
registerStdioTool("loopover_simulate_open_pr_pressure", {
    description: stdioToolDescription("loopover_simulate_open_pr_pressure"),
    inputSchema: simulateOpenPrPressureShape,
}, async (input) => toolResult("LoopOver open-PR pressure simulation.", await apiPost("/v1/lint/open-pr-pressure", input)));
// #6750: CLI mirror of the remote server's loopover_suggest_boundary_tests. Unlike its check_slop_risk sibling
// this one PROXIES rather than computing in-process: the builders live app-side (src/signals/
// boundary-test-generation.ts, which depends on the app's AdvisoryFinding type), not in @loopover/engine, so
// POST /v1/lint/boundary-tests stays the single source of truth for the filtering + finding/spec logic.
registerStdioTool("loopover_suggest_boundary_tests", {
    description: stdioToolDescription("loopover_suggest_boundary_tests"),
    inputSchema: suggestBoundaryTestsShape,
}, async (input) => toolResult("LoopOver boundary-test suggestion.", await apiPost("/v1/lint/boundary-tests", input)));
// Computed in-process from @loopover/engine (#6749) — the same buildTestEvidenceReport the remote server
// (src/mcp/server.ts) and the /v1/lint/test-evidence route both call, so all three surfaces return a
// byte-identical verdict and coverage self-checks work fully offline.
registerStdioTool("loopover_check_test_evidence", {
    description: stdioToolDescription("loopover_check_test_evidence"),
    inputSchema: checkTestEvidenceShape,
}, (input) => toolResult("LoopOver test-evidence check.", buildTestEvidenceReport(input)));
// Computed in-process from @loopover/engine (#6754) — the same pure evaluateEscalation the remote server
// (src/mcp/server.ts) and the /v1/loop/evaluate-escalation route both call, so all three surfaces return a
// byte-identical decision for identical input, and escalation checks work fully offline.
registerStdioTool("loopover_evaluate_escalation", {
    description: stdioToolDescription("loopover_evaluate_escalation"),
    inputSchema: evaluateEscalationShape,
}, (input) => toolResult("LoopOver escalation decision.", evaluateEscalation(input)));
// Computed in-process from @loopover/engine (#6752) — the same pure buildResultsPayload the remote server
// (src/mcp/server.ts) and the /v1/loop/results-payload route both call, so all three surfaces return an
// identical payload for identical input, and results composition works fully offline.
registerStdioTool("loopover_build_results_payload", {
    description: stdioToolDescription("loopover_build_results_payload"),
    inputSchema: resultsPayloadShape,
}, (input) => toolResult("LoopOver loop results payload.", buildResultsPayload(input)));
// Computed in-process from @loopover/engine (#6753) — the same pure buildProgressSnapshot the remote server
// (src/mcp/server.ts) and the /v1/loop/progress-snapshot route both call, so all three surfaces return an
// identical snapshot for identical input, and progress composition works fully offline.
registerStdioTool("loopover_build_progress_snapshot", {
    description: stdioToolDescription("loopover_build_progress_snapshot"),
    inputSchema: buildProgressSnapshotShape,
}, (input) => toolResult("LoopOver loop progress snapshot.", buildProgressSnapshot(input)));
// Computed in-process from @loopover/engine (#6755) — the same pure validateIdeaSubmission/buildTaskGraph the
// remote server (src/mcp/server.ts) and the /v1/loop/intake-idea route both call, reproducing the tool's
// handler exactly so all three surfaces return an identical payload for identical input, fully offline.
registerStdioTool("loopover_intake_idea", {
    description: stdioToolDescription("loopover_intake_idea"),
    inputSchema: intakeIdeaShape,
}, (input) => {
    const validated = validateIdeaSubmission(input);
    if (!validated.ok)
        return toolResult(`Invalid idea submission: ${validated.errors.join(", ")}.`, { ok: false, errors: validated.errors });
    const taskGraph = buildTaskGraph(validated.idea, input.decomposition);
    return toolResult(`Task-graph verdict: ${taskGraph.rubric.verdict} across ${taskGraph.issues.length} issue(s).`, {
        ok: true,
        verdict: taskGraph.rubric.verdict,
        taskGraph,
    });
});
// Computed in-process from @loopover/engine (#6756) — the same pure validateIdeaSubmission/buildTaskGraph/
// buildClaimPlan the remote server (src/mcp/server.ts) and the /v1/loop/plan-idea-claims route both call,
// reproducing the tool's handler exactly so all three surfaces return an identical payload for identical
// input, fully offline.
registerStdioTool("loopover_plan_idea_claims", {
    description: stdioToolDescription("loopover_plan_idea_claims"),
    inputSchema: intakeIdeaShape,
}, (input) => {
    const validated = validateIdeaSubmission(input);
    if (!validated.ok)
        return toolResult(`Invalid idea submission: ${validated.errors.join(", ")}.`, { ok: false, errors: validated.errors });
    const graph = buildTaskGraph(validated.idea, input.decomposition);
    const claimPlan = buildClaimPlan(graph, validated.idea.targetRepo);
    return toolResult(`Claim plan: ${claimPlan.claimable.length} claimable, ${claimPlan.deferred.length} deferred, ${claimPlan.skipped.length} skipped.`, { ok: true, verdict: claimPlan.graphVerdict, claimPlan });
});
registerStdioTool("loopover_check_issue_slop", {
    description: stdioToolDescription("loopover_check_issue_slop"),
    inputSchema: checkIssueSlopShape,
}, async (input) => toolResult("LoopOver issue-slop self-check.", await apiPost("/v1/lint/issue-slop", input)));
// Computed in-process from @loopover/engine (#6150) — matches the remote server's own
// computeLocalScorerTokens call (src/mcp/server.ts) with no API round-trip, so token scoring works fully
// offline.
registerStdioTool("loopover_run_local_scorer", {
    description: stdioToolDescription("loopover_run_local_scorer"),
    inputSchema: runLocalScorerShape,
}, (input) => toolResult("LoopOver local token scores.", computeLocalScorerTokens(input)));
// Computed in-process (#6150) — matches the remote server's own buildPlanDag call (src/mcp/server.ts)
// with no API round-trip; the plan-DAG logic itself is hand-duplicated above (see its own comment).
registerStdioTool("loopover_build_plan", {
    description: stdioToolDescription("loopover_build_plan"),
    inputSchema: buildPlanShape,
}, (input) => toolResult("LoopOver plan built.", planView(buildPlanDag(input.steps))));
registerStdioTool("loopover_plan_status", {
    description: stdioToolDescription("loopover_plan_status"),
    inputSchema: planStatusShape,
}, (input) => toolResult("LoopOver plan status.", planView(input.plan)));
registerStdioTool("loopover_record_step_result", {
    description: stdioToolDescription("loopover_record_step_result"),
    inputSchema: recordStepResultShape,
}, (input) => toolResult("LoopOver plan step result recorded.", planView(applyStepResult(input.plan, input.stepId, { outcome: input.outcome, ...(input.error !== undefined ? { error: input.error } : {}) }))));
// Metadata-only proxy to the same route the branch-analysis tools already use (#6150) — that route computes
// predictedGate via buildPredictedGateVerdict (the identical logic the remote loopover_predict_gate tool
// uses) and returns it as a top-level field; no local git/workspace context is needed for this shape.
registerStdioTool("loopover_predict_gate", {
    description: stdioToolDescription("loopover_predict_gate"),
    inputSchema: predictGateShape,
}, async (input) => {
    const body = {
        login: input.login,
        repoFullName: `${input.owner}/${input.repo}`,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.linkedIssues !== undefined ? { linkedIssues: input.linkedIssues } : {}),
        ...(input.changedPaths !== undefined ? { changedFiles: input.changedPaths.map((path) => ({ path })) } : {}),
    };
    const result = await apiPost("/v1/local/branch-analysis", body);
    return toolResult(`LoopOver predicted gate for ${input.owner}/${input.repo}.`, result.predictedGate);
});
// #6740: CLI stdio mirror of loopover_explain_gate_disposition — same branch-analysis fetch as predict_gate,
// then the shared pure buildGateDispositions reshaper (now exported from @loopover/engine) runs locally.
registerStdioTool("loopover_explain_gate_disposition", {
    description: stdioToolDescription("loopover_explain_gate_disposition"),
    inputSchema: predictGateShape,
}, async (input) => {
    const body = {
        login: input.login,
        repoFullName: `${input.owner}/${input.repo}`,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        ...(input.linkedIssues !== undefined ? { linkedIssues: input.linkedIssues } : {}),
        ...(input.changedPaths !== undefined ? { changedFiles: input.changedPaths.map((path) => ({ path })) } : {}),
    };
    const result = await apiPost("/v1/local/branch-analysis", body);
    const verdict = result.predictedGate;
    const dispositions = buildGateDispositions(verdict ?? { blockers: [], warnings: [] });
    const blocking = dispositions.filter((disposition) => disposition.status === "block").length;
    return toolResult(`Gate disposition for ${input.owner}/${input.repo} under the ${verdict?.pack ?? "unknown"} pack: ${verdict?.conclusion ?? "unknown"} — ${blocking} blocking rule(s), ${dispositions.length - blocking} advisory.`, { conclusion: verdict?.conclusion, pack: verdict?.pack, dispositions });
});
registerStdioTool("loopover_preflight_local_diff", {
    description: stdioToolDescription("loopover_preflight_local_diff"),
    inputSchema: localDiffShape,
}, async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const diff = collectLocalDiff(workspaceInput.cwd, input.baseRef, workspaceInput.workspaceRoots);
    const body = {
        repoFullName: input.repoFullName,
        contributorLogin: input.contributorLogin,
        title: input.title ?? diff.title,
        body: input.body,
        labels: input.labels,
        linkedIssues: input.linkedIssues,
        tests: input.tests,
        authorAssociation: input.authorAssociation,
        commitMessage: input.commitMessage ?? diff.commitMessage,
        changedFiles: diff.changedFiles,
        testFiles: diff.testFiles,
        changedLineCount: diff.changedLineCount,
    };
    return toolResult("LoopOver local diff preflight.", await apiPost("/v1/preflight/local-diff", body));
});
registerStdioTool("loopover_get_registry_changes", {
    description: stdioToolDescription("loopover_get_registry_changes"),
    inputSchema: {},
}, async () => toolResult("LoopOver registry changes.", await apiGet("/v1/registry/changes")));
// #6736: CLI mirror of the public loopover_get_bounty_advisory tool. Proxies the same unauthenticated
// GET /v1/bounties/:id/advisory the remote tool wraps -- no owner/repo, just the cached-bounty id.
registerStdioTool("loopover_get_bounty_advisory", {
    description: stdioToolDescription("loopover_get_bounty_advisory"),
    inputSchema: bountyAdvisoryShape,
}, async ({ id }) => toolResult("LoopOver bounty advisory.", await apiGet(`/v1/bounties/${encodeURIComponent(id)}/advisory`)));
registerStdioTool("loopover_get_upstream_drift", {
    description: stdioToolDescription("loopover_get_upstream_drift"),
    inputSchema: {},
}, async () => toolResult("LoopOver upstream drift status.", await apiGet("/v1/upstream/drift")));
registerStdioTool("loopover_get_label_audit", {
    description: stdioToolDescription("loopover_get_label_audit"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const intelligence = await apiGet(`${prefix}/intelligence`);
    return toolResult("LoopOver label audit.", {
        repoFullName: intelligence?.repoFullName ?? `${owner}/${repo}`,
        generatedAt: intelligence?.generatedAt,
        labelAudit: intelligence?.labelAudit ?? null,
    });
});
// #6739: CLI mirror of the remote server's loopover_get_maintainer_lane. maintainerLane ships in the same
// buildRepoIntelligenceResponse payload the sibling loopover_get_label_audit already GETs, so this is a thin
// extraction over that identical route rather than a new fetch shape.
registerStdioTool("loopover_get_maintainer_lane", {
    description: stdioToolDescription("loopover_get_maintainer_lane"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const intelligence = await apiGet(`${prefix}/intelligence`);
    return toolResult("LoopOver maintainer lane.", {
        repoFullName: intelligence?.repoFullName ?? `${owner}/${repo}`,
        generatedAt: intelligence?.generatedAt,
        maintainerLane: intelligence?.maintainerLane ?? null,
    });
});
registerStdioTool("loopover_get_burden_forecast", {
    description: stdioToolDescription("loopover_get_burden_forecast"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const intelligence = await apiGet(`${prefix}/intelligence`);
    return toolResult("LoopOver burden forecast.", {
        repoFullName: intelligence?.repoFullName ?? `${owner}/${repo}`,
        generatedAt: intelligence?.generatedAt,
        burdenForecast: intelligence?.burdenForecast ?? null,
        burdenForecastFreshness: intelligence?.burdenForecastFreshness ?? null,
    });
});
// #6734: CLI stdio mirror of loopover_get_repo_outcome_patterns — thin GET proxy of the already-public
// /v1/repos/:owner/:repo/outcome-patterns route (same ownerRepoShape + apiGet pattern as maintainer_noise).
registerStdioTool("loopover_get_repo_outcome_patterns", {
    description: stdioToolDescription("loopover_get_repo_outcome_patterns"),
    inputSchema: ownerRepoShape,
}, async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver repo outcome patterns.", await apiGet(`${prefix}/outcome-patterns`));
});
registerStdioTool("loopover_preview_local_pr_score", {
    description: stdioToolDescription("loopover_preview_local_pr_score"),
    inputSchema: localScoreShape,
}, async (input) => toolResult("LoopOver private local PR scoring preview.", await previewLocalScore(await withClientWorkspaceRoots(input))));
// Shared by loopover_explain_score_breakdown and loopover_get_eligibility_plan (#6621): both resolve the same
// local branch/diff metadata into the /v1/scoring request body — only the endpoint they POST it to differs, so
// the assembly lives here once rather than in two drifting copies.
function buildLocalScoreRequestBody(workspaceInput, contributorLogin) {
    const workspace = resolveWorkspaceCwd(workspaceInput);
    const diff = collectLocalDiff(workspace.cwd, workspaceInput.baseRef, workspaceInput.workspaceRoots);
    const branchPayload = buildBranchAnalysisPayload({
        ...workspaceInput,
        login: contributorLogin,
        cwd: workspace.cwd,
        repoFullName: workspaceInput.repoFullName,
        baseRef: workspaceInput.baseRef,
    });
    const upstreamPreview = branchPayload.localScorerStatus;
    const estimatedSourceLines = workspaceInput.sourceLines ?? Math.max(1, diff.changedLineCount - diff.testFiles.length);
    return {
        repoFullName: workspaceInput.repoFullName,
        targetType: "local_diff",
        targetKey: workspaceInput.targetKey ?? localDiffTargetKey(branchPayload, workspaceInput.baseRef),
        contributorLogin,
        labels: workspaceInput.labels,
        linkedIssueMode: workspaceInput.linkedIssueMode,
        sourceTokenScore: workspaceInput.sourceTokenScore ?? estimatedSourceLines,
        sourceLines: estimatedSourceLines,
        totalTokenScore: workspaceInput.totalTokenScore ?? diff.changedLineCount,
        testTokenScore: diff.testFiles.length,
        openPrCount: workspaceInput.openPrCount,
        credibility: workspaceInput.credibility,
        changesRequestedCount: workspaceInput.changesRequestedCount,
        pendingMergedPrCount: workspaceInput.pendingMergedPrCount,
        pendingClosedPrCount: workspaceInput.pendingClosedPrCount,
        approvedPrCount: workspaceInput.approvedPrCount,
        expectedOpenPrCountAfterMerge: workspaceInput.expectedOpenPrCountAfterMerge,
        projectedCredibility: workspaceInput.projectedCredibility,
        scenarioNotes: workspaceInput.scenarioNotes,
        branchEligibility: workspaceInput.branchEligibility,
        metadataOnly: !upstreamPreview.ok,
    };
}
registerStdioTool("loopover_explain_score_breakdown", {
    description: stdioToolDescription("loopover_explain_score_breakdown"),
    inputSchema: localScoreShape,
}, async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const contributorLogin = workspaceInput.contributorLogin ?? activeProfile.session?.login;
    if (!contributorLogin)
        throw new Error("contributorLogin is required for score breakdown.");
    const body = buildLocalScoreRequestBody(workspaceInput, contributorLogin);
    return toolResult("LoopOver private score breakdown.", await apiPost("/v1/scoring/explain-breakdown", body));
});
registerStdioTool("loopover_get_eligibility_plan", {
    description: stdioToolDescription("loopover_get_eligibility_plan"),
    inputSchema: localScoreShape,
}, async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const contributorLogin = workspaceInput.contributorLogin ?? activeProfile.session?.login;
    if (!contributorLogin)
        throw new Error("contributorLogin is required for the eligibility plan.");
    const body = buildLocalScoreRequestBody(workspaceInput, contributorLogin);
    return toolResult("LoopOver private eligibility plan.", await apiPost("/v1/scoring/eligibility-plan", body));
});
registerStdioTool("loopover_get_decision_pack", {
    description: stdioToolDescription("loopover_get_decision_pack"),
    inputSchema: loginShape,
}, async ({ login }) => {
    const payload = await getDecisionPackWithCache(login);
    return toolResult(decisionPackToolSummary(login, payload), payload);
});
registerStdioTool("loopover_explain_repo_decision", {
    description: stdioToolDescription("loopover_explain_repo_decision"),
    inputSchema: loginRepoShape,
}, async ({ login, owner, repo }) => {
    const payload = await getRepoDecisionWithCache(login, owner, repo);
    return toolResult(repoDecisionToolSummary(login, `${owner}/${repo}`, payload), payload);
});
registerStdioTool("loopover_monitor_open_prs", {
    description: stdioToolDescription("loopover_monitor_open_prs"),
    inputSchema: loginShape,
}, async ({ login }) => {
    const payload = await getOpenPrMonitor(login);
    return toolResult(openPrMonitorToolSummary(login, payload), payload);
});
registerStdioTool("loopover_pr_outcome", {
    description: stdioToolDescription("loopover_pr_outcome"),
    inputSchema: {
        login: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
    },
}, async ({ login, limit }) => {
    const payload = await getPrOutcomes(login, limit);
    return toolResult(prOutcomesToolSummary(login, payload), payload);
});
registerStdioTool("loopover_compare_pr_variants", {
    description: stdioToolDescription("loopover_compare_pr_variants"),
    inputSchema: variantsShape,
}, async ({ variants }) => {
    const roots = await clientWorkspaceRoots();
    const previews = [];
    for (const variant of variants)
        previews.push(await previewLocalScore(withWorkspaceRoots({ ...variant, targetKey: variant.targetKey ?? `variant:${previews.length + 1}` }, roots)));
    previews.sort((left, right) => Number(right?.remotePreview?.result?.effectiveEstimatedScore ?? right?.remotePreview?.result?.scoreEstimate?.estimatedMergedScore ?? 0) - Number(left?.remotePreview?.result?.effectiveEstimatedScore ?? left?.remotePreview?.result?.scoreEstimate?.estimatedMergedScore ?? 0));
    return toolResult("LoopOver PR variant comparison.", { variants: previews });
});
registerStdioTool("loopover_local_status", {
    description: stdioToolDescription("loopover_local_status"),
    inputSchema: {
        cwd: z.string().optional(),
        baseRef: z.string().optional(),
        repoFullName: z.string().min(3).optional(),
    },
}, async (input) => {
    let git = null;
    const workspaceInput = await withClientWorkspaceRoots(input);
    try {
        git = collectLocalBranchMetadata({ cwd: workspaceInput.cwd, baseRef: input.baseRef, repoFullName: input.repoFullName, login: "local", workspaceRoots: workspaceInput.workspaceRoots });
    }
    catch (error) {
        git = { error: error instanceof Error ? error.message : "local_status_failed" };
    }
    return toolResult("LoopOver local MCP status.", {
        apiUrl,
        package: {
            name: packageName,
            version: packageVersion,
        },
        hasToken: Boolean(getApiToken()),
        profile: profilePublicState(activeProfileName),
        authLogin: activeProfile.session?.login ?? null,
        sessionExpiresAt: activeProfile.session?.expiresAt ?? null,
        sourceUploadDefault: false,
        sourceUploadSupported: false,
        workspaceRoots: workspaceRootStatus(workspaceInput.workspaceRoots),
        git,
    });
});
registerStdioTool("loopover_preflight_current_branch", {
    description: stdioToolDescription("loopover_preflight_current_branch"),
    inputSchema: currentBranchShape,
}, async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver current-branch preflight.", {
        local: result.local,
        preflight: result.analysis.preflight,
        prPacket: result.analysis.prPacket,
        workspaceIntelligence: publicSafeWorkspaceIntelligence(result.analysis.workspaceIntelligence),
    });
});
registerStdioTool("loopover_review_pr_before_push", {
    description: stdioToolDescription("loopover_review_pr_before_push"),
    inputSchema: currentBranchShape,
}, async (input) => toolResult("LoopOver pre-PR review.", await reviewLocalPr(await withClientWorkspaceRoots(input))));
registerStdioTool("loopover_preview_current_branch_score", {
    description: stdioToolDescription("loopover_preview_current_branch_score"),
    inputSchema: currentBranchShape,
}, async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver current-branch private score preview.", {
        local: result.local,
        scorePreview: result.analysis.scorePreview,
        scenarioScorePreview: result.analysis.scenarioScorePreview,
        scoreBlockers: result.analysis.scoreBlockers,
        recommendedRerunCondition: result.analysis.recommendedRerunCondition,
    });
});
registerStdioTool("loopover_rank_local_next_actions", {
    description: stdioToolDescription("loopover_rank_local_next_actions"),
    inputSchema: currentBranchShape,
}, async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver local next-action ranking.", { local: result.local, nextActions: result.analysis.nextActions, rewardRisk: result.analysis.rewardRisk, recommendedRerunCondition: result.analysis.recommendedRerunCondition });
});
registerStdioTool("loopover_explain_local_blockers", {
    description: stdioToolDescription("loopover_explain_local_blockers"),
    inputSchema: currentBranchShape,
}, async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver local blocker explanation.", {
        local: result.local,
        scoreBlockers: result.analysis.scoreBlockers,
        branchQualityBlockers: result.analysis.branchQualityBlockers,
        accountStateBlockers: result.analysis.accountStateBlockers,
        baseFreshness: result.analysis.baseFreshness,
        localFindings: result.analysis.localFindings,
        recommendedRerunCondition: result.analysis.recommendedRerunCondition,
    });
});
registerStdioTool("loopover_remediation_plan", {
    description: stdioToolDescription("loopover_remediation_plan"),
    inputSchema: currentBranchShape,
}, async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const payload = buildBranchAnalysisPayload({ ...workspaceInput, cwd: resolveWorkspaceCwd(workspaceInput).cwd });
    const { localScorerStatus: _localScorerStatus, ...body } = payload;
    return toolResult("LoopOver remediation plan.", await apiPost("/v1/local/remediation-plan", body));
});
registerStdioTool("loopover_prepare_pr_packet", {
    description: stdioToolDescription("loopover_prepare_pr_packet"),
    inputSchema: currentBranchShape,
}, async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver public-safe PR packet.", { local: result.local, prPacket: result.analysis.prPacket });
});
// #6741: CLI stdio mirror of loopover_draft_pr_body — same analyzeCurrentBranch fetch as prepare_pr_packet,
// then the shared pure buildPublicPrBodyDraft (now exported from @loopover/engine) runs locally.
const draftPrBodyShape = {
    ...currentBranchShape,
    format: z.enum(["json", "markdown"]).optional(),
};
registerStdioTool("loopover_draft_pr_body", {
    description: stdioToolDescription("loopover_draft_pr_body"),
    inputSchema: draftPrBodyShape,
}, async (input) => {
    const { format, ...branchInput } = input;
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(branchInput));
    const draft = buildPublicPrBodyDraft(result.analysis);
    if (format === "markdown") {
        return toolResult(`Public-safe PR body draft for ${draft.repoFullName} (markdown).\n\n${draft.markdown}`, {
            markdown: draft.markdown,
            title: draft.title,
            repoFullName: draft.repoFullName,
            sourceUploadDisabled: true,
        });
    }
    return toolResult(`Public-safe PR body draft for ${draft.repoFullName} (metadata only; internal analysis context omitted).\n\n${draft.markdown}`, draft);
});
registerStdioTool("loopover_compare_local_variants", {
    description: stdioToolDescription("loopover_compare_local_variants"),
    inputSchema: currentBranchVariantsShape,
}, async ({ variants }) => {
    const roots = await clientWorkspaceRoots();
    const analyses = [];
    for (const variant of variants)
        analyses.push(await analyzeCurrentBranch(withWorkspaceRoots(variant, roots)));
    analyses.sort((left, right) => Number(right.analysis.nextActions?.[0]?.priorityScore ?? 0) - Number(left.analysis.nextActions?.[0]?.priorityScore ?? 0) ||
        Number(right.analysis.scorePreview?.effectiveEstimatedScore ?? right.analysis.scorePreview?.scoreEstimate?.estimatedMergedScore ?? 0) - Number(left.analysis.scorePreview?.effectiveEstimatedScore ?? left.analysis.scorePreview?.scoreEstimate?.estimatedMergedScore ?? 0));
    return toolResult("LoopOver local variant comparison.", {
        variants: analyses.map((entry) => ({
            local: entry.local,
            preflightStatus: entry.analysis.preflight.status,
            scoreBlockers: entry.analysis.scoreBlockers,
            topAction: entry.analysis.nextActions?.[0] ?? null,
            prPacket: entry.analysis.prPacket,
        })),
    });
});
registerStdioTool("loopover_agent_plan_next_work", {
    description: stdioToolDescription("loopover_agent_plan_next_work"),
    inputSchema: agentPlanShape,
}, async (input) => toolResult(`LoopOver base-agent plan for ${input.login}.`, await apiPost("/v1/agent/plan-next-work", input)));
registerStdioTool("loopover_agent_start_run", {
    description: stdioToolDescription("loopover_agent_start_run"),
    inputSchema: agentRunShape,
}, async (input) => toolResult(`Queued LoopOver base-agent run for ${input.actorLogin}.`, await apiPost("/v1/agent/runs", {
    objective: input.objective,
    actorLogin: input.actorLogin,
    surface: "mcp",
    target: stripUndefined({
        repoFullName: input.targetRepoFullName,
        pullNumber: input.targetPullNumber,
        issueNumber: input.targetIssueNumber,
    }),
})));
registerStdioTool("loopover_agent_get_run", {
    description: stdioToolDescription("loopover_agent_get_run"),
    inputSchema: agentRunIdShape,
}, async ({ runId }) => toolResult(`LoopOver base-agent run ${runId}.`, await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`)));
registerStdioTool("loopover_agent_explain_next_action", {
    description: stdioToolDescription("loopover_agent_explain_next_action"),
    inputSchema: agentPlanShape,
}, async (input) => {
    const result = await apiPost("/v1/agent/explain-blockers", input);
    return toolResult(`LoopOver base-agent next-action explanation for ${input.login}.`, {
        ...result,
        topAction: result.actions?.[0] ?? null,
    });
});
registerStdioTool("loopover_agent_prepare_pr_packet", {
    description: stdioToolDescription("loopover_agent_prepare_pr_packet"),
    inputSchema: currentBranchShape,
}, async (input) => toolResult("LoopOver base-agent public-safe PR packet.", await agentPreparePrPacket(await withClientWorkspaceRoots(input))));
// ── Output schemas for structured tool responses (#291) ──────────────────────
const repoContextOutputSchema = {
    type: "object",
    properties: {
        repoFullName: { type: "string" },
        lane: { type: "string" },
        primaryLanguage: { type: ["string", "null"] },
        openIssueCount: { type: "number" },
        openPrCount: { type: "number" },
    },
    additionalProperties: true,
};
const preflightOutputSchema = {
    type: "object",
    properties: {
        status: { type: "string", enum: ["pass", "warn", "fail", "unknown"] },
        signals: { type: "array", items: { type: "object" } },
        summary: { type: "string" },
    },
    additionalProperties: true,
};
const decisionPackOutputSchema = {
    type: "object",
    properties: {
        login: { type: "string" },
        decisions: { type: "array", items: { type: "object" } },
        cachedAt: { type: ["string", "null"] },
    },
    additionalProperties: true,
};
const localStatusOutputSchema = {
    type: "object",
    properties: {
        apiUrl: { type: "string" },
        package: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } }, additionalProperties: true },
        hasToken: { type: "boolean" },
        profile: { type: "object", additionalProperties: true },
        authLogin: { type: ["string", "null"] },
        sessionExpiresAt: { type: ["string", "null"] },
        sourceUploadDefault: { type: "boolean" },
        sourceUploadSupported: { type: "boolean" },
        git: { type: "object", additionalProperties: true },
    },
    additionalProperties: true,
};
const agentPlanOutputSchema = {
    type: "object",
    properties: {
        login: { type: "string" },
        actions: { type: "array", items: { type: "object" } },
        topAction: { type: ["object", "null"] },
    },
    additionalProperties: true,
};
// Attach outputSchema to key tools via registerTool with zod output schemas.
// All other tools continue to return unschematized text+structured content.
registerStdioTool("loopover_local_status_structured", {
    description: stdioToolDescription("loopover_local_status_structured"),
    inputSchema: {
        cwd: z.string().optional(),
        baseRef: z.string().optional(),
        repoFullName: z.string().min(3).optional(),
    },
    outputSchema: z.object({
        apiUrl: z.string(),
        package: z.object({ name: z.string(), version: z.string() }),
        hasToken: z.boolean(),
        profile: z.record(z.string(), z.unknown()),
        authLogin: z.string().nullable(),
        sessionExpiresAt: z.string().nullable(),
        sourceUploadDefault: z.boolean(),
        sourceUploadSupported: z.boolean(),
        git: z.record(z.string(), z.unknown()),
    }),
}, async (input) => {
    let git = null;
    const workspaceInput = await withClientWorkspaceRoots(input);
    try {
        git = collectLocalBranchMetadata({ cwd: workspaceInput.cwd, baseRef: input.baseRef, repoFullName: input.repoFullName, login: "local", workspaceRoots: workspaceInput.workspaceRoots });
    }
    catch (error) {
        git = { error: error instanceof Error ? error.message : "local_status_failed" };
    }
    const data = {
        apiUrl,
        package: { name: packageName, version: packageVersion },
        hasToken: Boolean(getApiToken()),
        profile: profilePublicState(activeProfileName),
        authLogin: activeProfile.session?.login ?? null,
        sessionExpiresAt: activeProfile.session?.expiresAt ?? null,
        sourceUploadDefault: false,
        sourceUploadSupported: false,
        git: git ?? {},
    };
    return { content: [{ type: "text", text: `LoopOver local MCP status.\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
});
registerStdioTool("loopover_feasibility_gate", {
    description: stdioToolDescription("loopover_feasibility_gate"),
    inputSchema: feasibilityGateShape,
}, async ({ claimStatus, duplicateClusterRisk, issueStatus, found, repoFullName, issueNumber }) => {
    const ledgerClaimStatus = await resolveLedgerClaimStatus(repoFullName, issueNumber);
    return toolResult("LoopOver feasibility gate.", buildFeasibilityVerdict({ claimStatus: ledgerClaimStatus ?? claimStatus, duplicateClusterRisk, issueStatus, found }));
});
// ── #6152 maintain surface: the REST calls maintainCli already makes, exposed as tools ───────────────────────
//
// These five mirror remote tools that have existed since #6087 but were never registered locally, so an agent on
// the stdio server had to shell out to the `maintain` CLI to reach them. Each one calls the same endpoint its
// CLI subcommand calls, through the same apiGet/apiPost/apiFetch client (auth, timeouts, and error shaping come
// from there) -- no new HTTP paths, and no behaviour the CLI doesn't already have.
/** `/v1/repos/:owner/:repo` for a tool's owner+repo input, matching maintainCli's own repoBase. */
function toolRepoBase(owner, repo) {
    return `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
registerStdioTool("loopover_list_pending_actions", {
    description: stdioToolDescription("loopover_list_pending_actions"),
    inputSchema: listPendingActionsShape,
}, async ({ owner, repo }) => {
    const payload = await apiGet(`${toolRepoBase(owner, repo)}/agent/pending-actions`);
    return toolResult(`Agent approval queue for ${owner}/${repo}: ${(payload.pendingActions ?? []).length} pending.`, payload);
});
registerStdioTool("loopover_decide_pending_action", {
    description: stdioToolDescription("loopover_decide_pending_action"),
    inputSchema: decidePendingActionShape,
}, async ({ owner, repo, id, decision }) => {
    const payload = await apiPost(`${toolRepoBase(owner, repo)}/agent/pending-actions/${encodeURIComponent(id)}/${decision}`, {});
    return toolResult(`${decision === "accept" ? "Accepted" : "Rejected"} ${id}: ${payload.status ?? "ok"}.`, payload);
});
registerStdioTool("loopover_set_agent_paused", {
    description: stdioToolDescription("loopover_set_agent_paused"),
    inputSchema: setAgentPausedShape,
}, async ({ owner, repo, paused }) => {
    const payload = await apiFetch(`${toolRepoBase(owner, repo)}/settings`, { method: "PUT", body: JSON.stringify({ agentPaused: paused }) });
    return toolResult(`Agent actions ${paused ? "paused" : "resumed"} for ${owner}/${repo}.`, payload);
});
registerStdioTool("loopover_set_action_autonomy", {
    description: stdioToolDescription("loopover_set_action_autonomy"),
    inputSchema: setActionAutonomyShape,
}, async ({ owner, repo, action, level }) => {
    // Read-merge-write, exactly as `maintain set-level` does it: PUT /settings replaces the whole autonomy map,
    // so sending only this class would silently clear every other one.
    const base = toolRepoBase(owner, repo);
    const current = await apiGet(`${base}/settings`);
    const autonomy = { ...(current.autonomy ?? {}), [action]: level };
    const payload = await apiFetch(`${base}/settings`, { method: "PUT", body: JSON.stringify({ autonomy }) });
    return toolResult(`Set ${action} autonomy to ${level} for ${owner}/${repo}.`, payload);
});
registerStdioTool("loopover_get_gate_precision", {
    description: stdioToolDescription("loopover_get_gate_precision"),
    inputSchema: gatePrecisionShape,
}, async ({ owner, repo, windowDays }) => {
    // The schema already rejects a non-positive windowDays, so an omitted window is the only way to full history
    // -- matching the route's own behaviour when ?windowDays is absent.
    const query = windowDays ? `?windowDays=${encodeURIComponent(windowDays)}` : "";
    const payload = await apiGet(`${toolRepoBase(owner, repo)}/gate-precision${query}`);
    return toolResult(`Gate precision for ${owner}/${repo}.`, payload);
});
// ── Write-tools (#6149): pure LOCAL-execution spec builders. loopover NEVER performs the write -- each tool
// returns a spec the caller runs with its OWN gh creds. Brings the local stdio server to parity with the
// miner-auto-dev profile's recommendedTools, using the same @loopover/engine builders as the remote server.
function localWriteSpecResult(spec) {
    return toolResult(`${spec.action}: ${spec.description} ${spec.boundary}`, spec);
}
registerStdioTool("loopover_open_pr", {
    description: stdioToolDescription("loopover_open_pr"),
    inputSchema: openPrShape,
}, (input) => localWriteSpecResult(buildOpenPrSpec(input)));
registerStdioTool("loopover_file_issue", {
    description: stdioToolDescription("loopover_file_issue"),
    inputSchema: fileIssueShape,
}, (input) => localWriteSpecResult(buildFileIssueSpec(input)));
registerStdioTool("loopover_apply_labels", {
    description: stdioToolDescription("loopover_apply_labels"),
    inputSchema: applyLabelsShape,
}, (input) => localWriteSpecResult(buildApplyLabelsSpec(input)));
registerStdioTool("loopover_post_eligibility_comment", {
    description: stdioToolDescription("loopover_post_eligibility_comment"),
    inputSchema: postEligibilityCommentShape,
}, (input) => localWriteSpecResult(buildPostEligibilityCommentSpec(input)));
registerStdioTool("loopover_create_branch", {
    description: stdioToolDescription("loopover_create_branch"),
    inputSchema: createBranchShape,
}, (input) => localWriteSpecResult(buildCreateBranchSpec(input)));
registerStdioTool("loopover_delete_branch", {
    description: stdioToolDescription("loopover_delete_branch"),
    inputSchema: deleteBranchShape,
}, (input) => localWriteSpecResult(buildDeleteBranchSpec(input)));
registerStdioTool("loopover_generate_tests", {
    description: stdioToolDescription("loopover_generate_tests"),
    inputSchema: testGenShape,
}, (input) => localWriteSpecResult(buildTestGenSpec(input)));
registerStdioTool("loopover_file_follow_up_issue", {
    description: stdioToolDescription("loopover_file_follow_up_issue"),
    inputSchema: followUpIssueShape,
}, (input) => localWriteSpecResult(buildFollowUpIssueSpec(input)));
registerStdioTool("loopover_close_pr", {
    description: stdioToolDescription("loopover_close_pr"),
    inputSchema: closePrShape,
}, (input) => localWriteSpecResult(buildClosePrSpec(input)));
// ── Resources: decision-pack, doctor, compatibility, changelog (#292) ─────────
server.registerResource("loopover_changelog", "loopover://changelog", {
    title: "LoopOver MCP Changelog",
    description: "Current CHANGELOG.md for the installed loopover-mcp package.",
    mimeType: "text/markdown",
}, async () => {
    let text;
    try {
        text = readFileSync(changelogPath, "utf8");
    }
    catch {
        text = "Changelog not available.";
    }
    return { contents: [{ uri: "loopover://changelog", mimeType: "text/markdown", text }] };
});
server.registerResource("loopover_compatibility", "loopover://compatibility", {
    title: "LoopOver API Compatibility",
    description: "Current API compatibility state: version, supported methods, and any deprecation notices.",
    mimeType: "application/json",
}, async () => {
    let data;
    try {
        data = await apiGet(compatibilityPath);
    }
    catch {
        data = { status: "unavailable", currentApiVersion, packageVersion };
    }
    return { contents: [{ uri: "loopover://compatibility", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
});
// #6620: mirror the two remote static-document MCP resources over the local stdio server, proxying the new
// unauthenticated REST routes the same way loopover_compatibility proxies /v1/mcp/compatibility. Reuse the exact
// URIs the remote server registers.
server.registerResource("loopover_finding_taxonomy", "loopover://finding-taxonomy", {
    title: "LoopOver Finding Taxonomy",
    description: "Static taxonomy of AI-review finding categories and the severity ladder.",
    mimeType: "application/json",
}, async () => {
    let data;
    try {
        data = await apiGet(findingTaxonomyPath);
    }
    catch {
        data = { status: "unavailable" };
    }
    return { contents: [{ uri: "loopover://finding-taxonomy", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
});
server.registerResource("loopover_enrichment_analyzers", "loopover://enrichment-analyzers", {
    title: "LoopOver Enrichment Analyzers",
    description: "Static taxonomy of REES enrichment analyzers: names, categories, and cost classes.",
    mimeType: "application/json",
}, async () => {
    let data;
    try {
        data = await apiGet(enrichmentAnalyzersPath);
    }
    catch {
        data = { status: "unavailable" };
    }
    return { contents: [{ uri: "loopover://enrichment-analyzers", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
});
server.registerResource("loopover_decision_pack", new ResourceTemplate("loopover://decision-packs/{login}", { list: undefined }), {
    title: "LoopOver Decision Pack",
    description: "Cached private contributor decision pack for a GitHub login. Requires authentication.",
    mimeType: "application/json",
}, async (uri, { login }) => {
    const payload = await getDecisionPackWithCache(String(login));
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
});
// ── Miner planning prompts (#293) ─────────────────────────────────────────────
server.registerPrompt("loopover_miner_select_issue", {
    title: "Select Next Issue to Work On",
    description: "Guide a contributor through selecting the best open issue to work on next, using LoopOver lane and duplicate signals. Advisory only — no GitHub writes.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
        login: z.string().min(1).describe("GitHub login of the contributor."),
    },
}, ({ repoFullName, login }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver miner planning assistant for ${login} working on ${repoFullName}.`,
                    "",
                    "Your job is to help the contributor select the best open issue to work on next.",
                    "Use the loopover_get_repo_context and loopover_agent_plan_next_work tools to fetch lane and queue signals.",
                    "",
                    "Guidelines:",
                    "- Prefer issues that match the repo lane (feature, bug, docs, test, refactor, chore).",
                    "- Avoid issues with existing open PRs unless the contributor owns one of them.",
                    "- Flag duplicate or stale work before the contributor invests time.",
                    "- Summarize the top 3 candidate issues with a short rationale for each.",
                    "- Do not open, comment on, label, close, or modify any GitHub issue or PR.",
                    "- Do not predict reward amounts, payout estimates, or public scoreability rankings.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_miner_draft_pr_packet", {
    title: "Draft PR Packet for Current Branch",
    description: "Guide a contributor through preparing a public-safe PR packet for the current branch. Advisory only — no GitHub writes.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
        login: z.string().min(1).describe("GitHub login of the contributor."),
    },
}, ({ repoFullName, login }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver miner planning assistant for ${login} working on ${repoFullName}.`,
                    "",
                    "Your job is to help the contributor prepare a public-safe PR packet for their current branch.",
                    "Use loopover_preflight_current_branch or loopover_prepare_pr_packet to gather branch signals.",
                    "",
                    "Guidelines:",
                    "- Draft a title, description, and label suggestions based on the diff metadata.",
                    "- Flag any preflight warnings (duplicate work, missing linked issue, test coverage gaps).",
                    "- Keep the draft public-safe: no private scoreability data, no raw trust scores.",
                    "- Present the draft for the contributor to review and edit before opening a PR.",
                    "- Do not open, comment on, label, close, or merge any GitHub PR.",
                    "- Do not predict reward amounts or publish scoring predictions.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_miner_branch_preflight", {
    title: "Branch Preflight Check",
    description: "Run a preflight check on the current branch and summarize blockers for the contributor. Advisory only.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
        login: z.string().min(1).describe("GitHub login of the contributor."),
    },
}, ({ repoFullName, login }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver miner planning assistant for ${login} working on ${repoFullName}.`,
                    "",
                    "Your job is to run a branch preflight check and explain any blockers clearly.",
                    "Use loopover_explain_local_blockers and loopover_preflight_current_branch to fetch signals.",
                    "",
                    "Guidelines:",
                    "- List each blocker with a plain-language explanation and suggested remediation.",
                    "- Distinguish between hard blockers (will prevent merge) and soft warnings (worth fixing).",
                    "- Do not open, comment on, label, close, or merge any GitHub PR.",
                    "- Do not expose private scoreability details or raw trust scores in public-facing text.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_miner_cleanup_first", {
    title: "Cleanup-First Planning",
    description: "Help a contributor identify stale or low-value open PRs to close before opening new work. Advisory only.",
    argsSchema: {
        login: z.string().min(1).describe("GitHub login of the contributor."),
    },
}, ({ login }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver miner planning assistant for ${login}.`,
                    "",
                    "Your job is to help the contributor identify stale or low-value open PRs to close or supersede before opening new work.",
                    "Use loopover_get_decision_pack to fetch the contributor decision pack.",
                    "",
                    "Guidelines:",
                    "- List open PRs that are stale, duplicate, or conflicting with newer work.",
                    "- Suggest which to close, which to rebase, and which to keep open.",
                    "- Summarize the expected queue pressure impact of each decision.",
                    "- Do not close, comment on, label, or merge any GitHub PR autonomously.",
                    "- Do not predict reward amounts, payout estimates, or public scoring outcomes.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
// ── Maintainer and repo-owner workflow prompts (#294) ─────────────────────────
server.registerPrompt("loopover_maintainer_queue_triage", {
    title: "Maintainer Queue Triage",
    description: "Guide a maintainer through triaging the open PR queue using LoopOver signals. Advisory only — no GitHub writes.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
}, ({ repoFullName }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver maintainer assistant for ${repoFullName}.`,
                    "",
                    "Your job is to help the maintainer triage the open PR queue.",
                    "Use loopover_get_repo_context to fetch current lane and queue signals.",
                    "",
                    "Guidelines:",
                    "- Group PRs by: ready to review, needs changes, stale, duplicate.",
                    "- Flag PRs with missing linked issues, failing checks, or low-quality diffs.",
                    "- Suggest a review order based on lane fit and contributor history.",
                    "- Prepare review notes and questions for the maintainer to post manually.",
                    "- Do not post comments, approve, request changes, label, close, or merge any PR autonomously.",
                    "- Do not expose private scoreability details, raw trust scores, or private reviewer context.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_maintainer_review_prep", {
    title: "Maintainer Review Preparation",
    description: "Prepare a structured review packet for a specific PR. Advisory only — no GitHub writes.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
        pullNumber: z.string().min(1).describe("PR number to prepare a review for."),
    },
}, ({ repoFullName, pullNumber }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver maintainer assistant for ${repoFullName}.`,
                    "",
                    `Your job is to prepare a structured review packet for PR #${pullNumber}.`,
                    "Use loopover_preflight_pr or loopover_explain_repo_decision to fetch relevant signals.",
                    "",
                    "Guidelines:",
                    "- Summarize the PR scope, changed files, and linked issue (if any).",
                    "- List preflight signals: lane fit, duplicate risk, test coverage, queue pressure.",
                    "- Draft review questions or change requests for the maintainer to post manually.",
                    "- Keep all output public-safe: no private scoreability data or raw trust scores.",
                    "- Do not post review comments, approve, request changes, label, close, or merge the PR.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_maintainer_public_guidance", {
    title: "Maintainer Public Guidance Draft",
    description: "Draft low-noise, public-safe guidance for a contributor based on their PR. Advisory only — no GitHub writes.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
        contributorLogin: z.string().min(1).describe("GitHub login of the contributor."),
    },
}, ({ repoFullName, contributorLogin }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver maintainer assistant for ${repoFullName}.`,
                    "",
                    `Your job is to draft low-noise, public-safe guidance for contributor ${contributorLogin}.`,
                    "Use loopover_get_repo_context for lane context.",
                    "",
                    "Guidelines:",
                    "- Draft a short, encouraging, actionable comment the maintainer can post manually.",
                    "- Focus on what the contributor should change, not on scoring or reward prediction.",
                    "- Keep the tone neutral and constructive — no compensation language.",
                    "- Do not mention trust scores, hotkeys, coldkeys, wallet addresses, reward estimates, or private reviewability.",
                    "- Do not post the comment autonomously — present it for the maintainer to review and post.",
                    "- Do not close, label, merge, or modify the PR autonomously.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_repo_owner_intake_readiness", {
    title: "Repo Owner Intake Readiness",
    description: "Guide a repo owner through assessing contributor intake readiness using LoopOver signals. Advisory only.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
}, ({ repoFullName }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver repo-owner assistant for ${repoFullName}.`,
                    "",
                    "Your job is to help the repo owner assess contributor intake readiness.",
                    "Use loopover_get_repo_context to fetch lane and queue signals.",
                    "",
                    "Guidelines:",
                    "- Summarize current lane health: open issue count, PR queue pressure, merge rate.",
                    "- Flag gaps in the CONTRIBUTING.md, issue templates, or lane focus manifest.",
                    "- Recommend intake improvements the repo owner can make manually.",
                    "- Do not autonomously edit repo files, post comments, or open/close issues or PRs.",
                    "- Do not expose private scoreability data or raw trust scores publicly.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_repo_owner_focus_manifest_review", {
    title: "Repo Owner Focus Manifest Review",
    description: "Help a repo owner review and improve their focus manifest using LoopOver policy signals. Advisory only.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
}, ({ repoFullName }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver repo-owner assistant for ${repoFullName}.`,
                    "",
                    "Your job is to help the repo owner review and improve their LoopOver focus manifest.",
                    "Use loopover_get_repo_context to fetch current policy and lane signals.",
                    "",
                    "Guidelines:",
                    "- Identify gaps or inconsistencies in the focus manifest.",
                    "- Suggest improvements to label policy, contribution lanes, and readiness criteria.",
                    "- Draft an updated manifest section for the repo owner to review and apply manually.",
                    "- Do not autonomously push changes to the repo or open PRs.",
                    "- Do not expose private scoreability data or raw trust scores.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("loopover_repo_owner_onboarding_pack", {
    title: "Repo Owner Onboarding Pack Planning",
    description: "Help a repo owner plan and draft an onboarding pack for new contributors. Advisory only.",
    argsSchema: {
        repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
}, ({ repoFullName }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `You are a LoopOver repo-owner assistant for ${repoFullName}.`,
                    "",
                    "Your job is to help the repo owner plan and draft an onboarding pack for new contributors.",
                    "Use loopover_get_repo_context to fetch lane and policy signals.",
                    "",
                    "Guidelines:",
                    "- Draft an onboarding overview: repo purpose, contribution lanes, good-first-issue guidance.",
                    "- Suggest CONTRIBUTING.md sections, issue templates, and label conventions to add or improve.",
                    "- Keep all content public-safe: no private scoreability, raw trust, or reward prediction.",
                    "- Present the draft for the repo owner to review and apply manually.",
                    "- Do not autonomously push changes, open PRs, or post comments.",
                    "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
                ].join("\n"),
            },
        },
    ],
}));
await server.connect(new StdioServerTransport());
async function withClientWorkspaceRoots(input) {
    return withWorkspaceRoots(input, await clientWorkspaceRoots());
}
function withWorkspaceRoots(input, roots) {
    return roots.length > 0 ? { ...input, workspaceRoots: roots } : input;
}
async function clientWorkspaceRoots() {
    if (!server.server.getClientCapabilities()?.roots)
        return [];
    try {
        const result = await server.server.listRoots(undefined, { timeout: 1000 });
        return Array.isArray(result.roots) ? result.roots : [];
    }
    catch {
        return [];
    }
}
function workspaceRootStatus(roots) {
    const count = Array.isArray(roots) ? roots.length : 0;
    return {
        available: count > 0,
        count,
        pathsIncluded: false,
    };
}
function printMaintainHelp() {
    process.stdout.write([
        "Usage: loopover-mcp maintain <subcommand> --repo owner/repo",
        "",
        "Maintainer controls for the agent auto-maintain layer (requires maintainer access; run `loopover-mcp login`).",
        "",
        "Subcommands:",
        "  status                       List the agent approval queue (auto_with_approval actions awaiting a decision).",
        "  queue                        List pending actions (id, kind, target) for approve/reject. Alias: pending.",
        "  propose <class> <pull-num>   Stage a new auto_with_approval action for a maintainer to approve later.",
        `                               classes: ${PROPOSE_ACTION_CLASSES.join(", ")}`,
        "                               opts: --reason, --label, --review-body, --merge-method, --close-comment.",
        "  approve <id>                 Approve a staged action -> execute it.",
        "  reject <id>                  Reject a staged action -> cancel it.",
        "  pause                        Pause ALL agent actions on the repo (kill-switch).",
        "  resume                       Resume agent actions on the repo.",
        "  set-level <action> <level>   Set the autonomy level for one action class.",
        `                               actions: ${MAINTAIN_ACTION_CLASSES.join(", ")}`,
        `                               levels:  ${MAINTAIN_AUTONOMY_LEVELS.join(", ")}`,
        "  precision [--window-days N]  Show gate false-positive telemetry (blocked-then-merged per gate type).",
        "  outcome-calibration          Show slop-band merge rates and recommendation-outcome calibration.",
        "             [--window-days N]  Bound the recommendation window (default: full history).",
        "  onboarding-pack [--refresh]  Preview the repo's contributor onboarding pack.",
        "  audit-feed [--since ISO]     Show the agent audit feed (who did what, when).",
        "             [--limit N]       Cap the events returned (1-200).",
        "             [--pull N]        Scope the feed to one pull request.",
        "  automation-state             Show the derived agent automation state (mode, readiness, pending).",
        "  refresh-docs                 Open (or find the already-open) the AGENTS.md/CLAUDE.md generation PR.",
        "  generate-issue-drafts        Preview contributor issue drafts (dry-run). Never creates without --create.",
        "             [--create]        Actually open the drafted issues (requires repo write access).",
        "             [--limit N]       Cap the drafts generated (1-20, default 5).",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
// #784 maintainer CLI controls — thin proxies over the agent approval-queue API (#779) and the maintainer
// settings kill-switch (#130). The API enforces maintainer authorization; the CLI never decides locally.
async function maintainCli(args) {
    const subcommand = args[0];
    if (!subcommand || subcommand === "--help" || subcommand === "help")
        return printMaintainHelp();
    const positional = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const options = parseOptions(args.slice(1));
    const repoFullName = options.repo;
    if (!repoFullName || !repoFullName.includes("/"))
        throw new Error("Pass --repo owner/repo.");
    const [owner, repo] = repoFullName.split("/", 2);
    const repoBase = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const queueBase = `${repoBase}/agent/pending-actions`;
    const emit = (payload, line) => {
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(`${line}\n`);
    };
    if (subcommand === "status") {
        const payload = await apiGet(queueBase);
        const actions = payload.pendingActions ?? [];
        // #6261: every field here is the API's. `emit` sends this string to the terminal only on the plain-text path
        // (--json re-serializes `payload` instead), so sanitizing the composed line costs the JSON contract nothing.
        emit(payload, [
            `Agent approval queue for ${repoFullName}: ${actions.length} pending.`,
            ...actions.map((action) => `- ${sanitizePlainTextTerminalOutput(action.id)}  ${sanitizePlainTextTerminalOutput(action.actionClass)} on #${sanitizePlainTextTerminalOutput(action.pullNumber)}  ${sanitizePlainTextTerminalOutput(action.reason ?? "")}`),
        ].join("\n"));
        return;
    }
    // #2236 — explicit queue listing so maintainers can discover ids for approve/reject (alias: pending).
    if (subcommand === "queue" || subcommand === "pending") {
        const payload = await apiGet(queueBase);
        const actions = payload.pendingActions ?? [];
        emit(payload, [
            `Pending agent actions for ${repoFullName}: ${actions.length}.`,
            ...actions.map((action) => {
                // #6261: sanitize each field as it is read, so the fallback chains can't smuggle an escape in through
                // whichever branch happens to win (`kind` alone has three sources).
                const kind = sanitizePlainTextTerminalOutput(action.actionClass ?? action.kind ?? "unknown");
                const target = action.pullNumber != null ? `#${sanitizePlainTextTerminalOutput(action.pullNumber)}` : sanitizePlainTextTerminalOutput(action.target ?? "—");
                const summary = sanitizePlainTextTerminalOutput(action.reason ?? action.summary ?? "");
                return `- ${sanitizePlainTextTerminalOutput(action.id)}  ${kind}  ${target}${summary ? `  ${summary}` : ""}`;
            }),
        ].join("\n"));
        return;
    }
    if (subcommand === "approve" || subcommand === "reject") {
        if (!positional)
            throw new Error(`Pass the pending-action id: loopover-mcp maintain ${subcommand} <id> --repo owner/repo.`);
        // The approval-queue route's decision verb is accept|reject (#779); the CLI exposes approve|reject.
        const decision = subcommand === "approve" ? "accept" : "reject";
        const payload = await apiPost(`${queueBase}/${encodeURIComponent(positional)}/${decision}`, {});
        emit(payload, `${subcommand === "approve" ? "Accepted" : "Rejected"} ${positional}: ${payload.status ?? "ok"}${payload.executionOutcome ? ` (${payload.executionOutcome})` : ""}.`);
        return;
    }
    if (subcommand === "propose") {
        const actionClass = positional;
        const pullArg = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
        if (!actionClass || !pullArg) {
            throw new Error("Usage: loopover-mcp maintain propose <action-class> <pull-number> --repo owner/repo [--reason ...] [--label ...] [--review-body ...] [--merge-method merge|squash|rebase] [--close-comment ...].");
        }
        if (!PROPOSE_ACTION_CLASSES.includes(actionClass))
            throw new Error(`Unknown action class: ${actionClass}. Use ${PROPOSE_ACTION_CLASSES.join(", ")}.`);
        const pullNumber = Number(pullArg);
        if (!Number.isInteger(pullNumber) || pullNumber <= 0)
            throw new Error(`Invalid pull number: ${pullArg}. Pass a positive integer.`);
        const payload = await apiPost(queueBase, stripUndefined({ pullNumber, actionClass, reason: options.reason, label: options.label, reviewBody: options.reviewBody, mergeMethod: options.mergeMethod, closeComment: options.closeComment }));
        const action = payload.action ?? {};
        emit(payload, `${payload.created ? "Staged" : "Already staged"} ${sanitizePlainTextTerminalOutput(action.actionClass ?? actionClass)} on ${repoFullName}#${pullNumber} (${sanitizePlainTextTerminalOutput(action.status ?? "pending")}), id ${sanitizePlainTextTerminalOutput(action.id ?? "?")}.`);
        return;
    }
    if (subcommand === "pause" || subcommand === "resume") {
        const payload = await apiFetch(`${repoBase}/settings`, { method: "PUT", body: JSON.stringify({ agentPaused: subcommand === "pause" }) });
        emit(payload, `Agent actions ${subcommand === "pause" ? "paused" : "resumed"} for ${repoFullName}.`);
        return;
    }
    if (subcommand === "set-level") {
        const action = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
        const level = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
        if (!action || !level)
            throw new Error("Usage: loopover-mcp maintain set-level <action> <level> --repo owner/repo.");
        if (!MAINTAIN_ACTION_CLASSES.includes(action))
            throw new Error(`Unknown action: ${action}. Use ${MAINTAIN_ACTION_CLASSES.join(", ")}.`);
        if (!MAINTAIN_AUTONOMY_LEVELS.includes(level))
            throw new Error(`Unknown level: ${level}. Use ${MAINTAIN_AUTONOMY_LEVELS.join(", ")}.`);
        // Read-merge-write so one class is updated without clearing the others.
        const current = await apiGet(`${repoBase}/settings`);
        const autonomy = { ...(current.autonomy ?? {}), [action]: level };
        const payload = await apiFetch(`${repoBase}/settings`, { method: "PUT", body: JSON.stringify({ autonomy }) });
        emit(payload, `Set ${action} autonomy to ${level} for ${repoFullName}.`);
        return;
    }
    if (subcommand === "precision") {
        // #554 gate false-positive telemetry: read-only measurement of blocked-then-merged PRs per gate type.
        // The API enforces maintainer authorization; the CLI never decides locally. Optional --window-days bounds
        // the block ledger the same way the route's ?windowDays query does (a non-positive value falls through to
        // full history server-side).
        const windowDays = Number(options.windowDays);
        const query = windowDays > 0 ? `?windowDays=${encodeURIComponent(windowDays)}` : "";
        const payload = await apiGet(`${repoBase}/gate-precision${query}`);
        const overall = payload.overall ?? {};
        const window = payload.windowDays ? `last ${payload.windowDays}d` : "all history";
        const rate = (value) => (value === null || value === undefined ? "n/a (below sample)" : `${Math.round(value * 100)}%`);
        const lines = [
            `Gate precision for ${repoFullName} (${window}): ${overall.blocked ?? 0} blocked, ${overall.blockedThenMerged ?? 0} blocked-then-merged, false-positive rate ${rate(overall.falsePositiveRate)}.`,
            ...(payload.perGateType ?? []).map((type) => `- ${type.gateType}: ${type.blocked} blocked, ${type.blockedThenMerged} merged anyway${type.falsePositiveRate === null ? "" : ` (${Math.round(type.falsePositiveRate * 100)}% FP)`}`),
            ...(payload.signals ?? []),
        ];
        emit(payload, lines.join("\n"));
        return;
    }
    if (subcommand === "outcome-calibration") {
        // #6735 outcome calibration: read-only measurement of whether higher-slop bands merge less often and how
        // agent recommendations panned out. Same --window-days handling the sibling precision command uses (a
        // non-positive value omits ?windowDays, so the server reports full history).
        const windowDays = Number(options.windowDays);
        const query = windowDays > 0 ? `?windowDays=${encodeURIComponent(windowDays)}` : "";
        const payload = await apiGet(`${repoBase}/outcome-calibration${query}`);
        const window = payload.windowDays ? `last ${payload.windowDays}d` : "all history";
        const recommendations = payload.recommendations ?? {};
        const rate = (value) => (value === null || value === undefined ? "n/a (below sample)" : `${Math.round(value * 100)}%`);
        const lines = [
            `Outcome calibration for ${repoFullName} (${window}): recommendations ${recommendations.positive ?? 0} positive, ${recommendations.negative ?? 0} negative, ${recommendations.pending ?? 0} pending (positive rate ${rate(recommendations.positiveRate)}).`,
            ...(payload.slop ?? []).map((band) => `- ${band.band}: ${rate(band.mergeRate)} merge rate over ${band.sampleSize ?? 0} PR(s) (${band.merged ?? 0} merged, ${band.closed ?? 0} closed)`),
            ...(payload.signals ?? []),
        ];
        emit(payload, lines.join("\n"));
        return;
    }
    if (subcommand === "onboarding-pack") {
        // #6738: session-authenticated mirror of GET /onboarding-pack/preview (and the remote
        // loopover_get_repo_onboarding_pack tool). Bare `--refresh` becomes options.refresh === true via
        // parseOptions; omit the query otherwise so the default matches the precision-style GET pattern
        // (server treats only the exact string "true" as a refresh).
        const query = options.refresh === true ? "?refresh=true" : "";
        const payload = await apiGet(`${repoBase}/onboarding-pack/preview${query}`);
        emit(payload, [
            `LoopOver onboarding pack preview for ${repoFullName} (preview-only, not published).`,
            sanitizePlainTextTerminalOutput(JSON.stringify(payload.preview ?? payload, null, 2)),
        ].join("\n"));
        return;
    }
    if (subcommand === "audit-feed") {
        // #6733: read-only mirror of GET {repoBase}/agent/audit-feed (the same surface the remote
        // loopover_get_agent_audit_feed tool exposes). The API enforces maintainer authorization and validates
        // every query param -- `since` must be ISO-8601, `limit` 1..200, `pull` a positive integer -- so the CLI
        // forwards them verbatim rather than re-deciding locally, and a bad value surfaces as the API's own 400
        // detail. Omitted flags are omitted from the query entirely, so the route applies its own defaults.
        const query = new URLSearchParams();
        if (options.since !== undefined)
            query.set("since", String(options.since));
        if (options.limit !== undefined)
            query.set("limit", String(options.limit));
        if (options.pull !== undefined)
            query.set("pull", String(options.pull));
        const payload = await apiGet(`${repoBase}/agent/audit-feed${query.size > 0 ? `?${query}` : ""}`);
        const events = payload.events ?? [];
        // `pullNumber` is echoed by the route only on the ?pull= branch, so the scope line reports what was asked for.
        const scope = payload.pullNumber ? `${repoFullName}#${payload.pullNumber}` : repoFullName;
        emit(payload, [
            `Agent audit feed for ${scope}: ${events.length} event${events.length === 1 ? "" : "s"}.`,
            // `detail` is the one free-form field here; sanitized on the plain-text path like onboarding-pack's
            // dump above (--json re-serializes `payload` untouched, so the JSON contract is unaffected).
            ...events.map((event) => sanitizePlainTextTerminalOutput([event.createdAt, event.eventType, event.actor, event.outcome, event.detail].filter(Boolean).join("  "))),
        ].join("\n"));
        return;
    }
    if (subcommand === "automation-state") {
        // #6742: read-side counterpart to the write-side pause/resume/set-level above. Mirrors GET {repoBase}/
        // automation-state (and the loopover_get_automation_state MCP tool) — the DERIVED mode/permissionReadiness/
        // acting-classes/pending-count view the raw settings row omits. Read-only; the API enforces maintainer auth.
        const payload = await apiGet(`${repoBase}/automation-state`);
        const acting = payload.actingActionClasses ?? [];
        emit(payload, [
            `Agent automation for ${repoFullName}: mode=${payload.mode}, ${acting.length} acting class(es), ${payload.pendingActionCount ?? 0} pending approval(s).`,
            `  permission readiness: ${payload.permissionReadiness}`,
            `  auto-maintain: ${payload.autoMaintain ?? "unset"}${payload.agentDryRun ? " (dry-run)" : ""}`,
            acting.length > 0 ? `  acting classes: ${acting.join(", ")}` : "  acting classes: none",
        ].join("\n"));
        return;
    }
    if (subcommand === "refresh-docs") {
        // #6743: REST mirror of the loopover_refresh_repo_docs MCP tool -- only ever opens a PR (never merges,
        // closes, or commits directly), so a single synchronous POST with no body is the whole contract.
        const payload = await apiPost(`${repoBase}/repo-docs/refresh`, {});
        const line = payload.opened
            ? `${payload.reused ? "Found the already-open" : "Opened a new"} repo-doc pull request for ${repoFullName}: ${sanitizePlainTextTerminalOutput(payload.url)}`
            : `No repo-doc pull request opened for ${repoFullName}: ${sanitizePlainTextTerminalOutput(payload.reason)}`;
        emit(payload, line);
        return;
    }
    if (subcommand === "generate-issue-drafts") {
        // #6757: session-authenticated mirror of POST {repoBase}/contributor-issue-drafts/generate (and the remote
        // loopover_generate_contributor_issue_drafts tool). Dry-run BY DEFAULT — only a bare `--create` opts into
        // the write path, and it is forwarded as {create:true, dryRun:false}, the exact shape the route's
        // explicit_create_requires_dry_run_false guard demands. A plain `generate-issue-drafts` can never create.
        const create = options.create === true;
        const parsedLimit = Number(options.limit);
        const body = { create, dryRun: !create, ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}) };
        const payload = await apiPost(`${repoBase}/contributor-issue-drafts/generate`, body);
        const mode = payload.dryRun ? "dry-run" : "create";
        const lines = [
            `Contributor issue drafts for ${repoFullName} (${mode}): ${payload.proposed ?? 0} proposed, ${payload.created ?? 0} created, ${payload.skippedDuplicate ?? 0} duplicate, ${payload.skippedDeclined ?? 0} declined, ${payload.skippedUnsafe ?? 0} unsafe, ${payload.skippedCreateFailed ?? 0} create-failed.`,
            // draft.title/body are generated from untrusted repo issue data, so the plain-text path is sanitized (#6261).
            ...(payload.drafts ?? []).map((draft) => {
                const ref = draft.issue ? ` -> #${draft.issue.number} ${draft.issue.url}` : "";
                return `- [${sanitizePlainTextTerminalOutput(draft.status)}] ${sanitizePlainTextTerminalOutput(draft.title)}${sanitizePlainTextTerminalOutput(ref)}`;
            }),
        ];
        emit(payload, lines.join("\n"));
        return;
    }
    throw new Error(`Unknown maintain subcommand: ${subcommand}. Use status | queue | propose <action-class> <pull-number> | approve <id> | reject <id> | pause | resume | set-level <action> <level> | precision | outcome-calibration | onboarding-pack | audit-feed | automation-state | refresh-docs | generate-issue-drafts.`);
}
async function runCli(args) {
    const command = args[0];
    if (command === "--help" || command === "help")
        return printHelp();
    if (command === "--version" || command === "-v" || command === "version")
        return printVersion(parseOptions(args.slice(1)));
    if (command === "completion")
        return completionCommand(args.slice(1));
    if (command === "tools")
        return toolsCommand(args.slice(1));
    if (command === "agent")
        return runAgentCli(args.slice(1));
    if (command === "cache")
        return runCacheCli(args.slice(1));
    if (command === "maintain")
        return maintainCli(args.slice(1));
    if (command === "telemetry")
        return telemetryCommand(args.slice(1));
    const options = parseOptions(args.slice(1));
    if (command === "login")
        return login(options);
    if (command === "logout")
        return logout(options);
    if (command === "profile" || command === "profiles")
        return profileCommand(args.slice(1));
    if (command === "whoami")
        return whoami(options);
    if (command === "config")
        return configCommand(options);
    if (command === "status")
        return status(options);
    if (command === "changelog")
        return changelog(options);
    if (command === "doctor")
        return doctor(options);
    if (command === "init-client")
        return initClient(options);
    if (command === "lint-pr-text")
        return lintPrTextCli(args.slice(1));
    if (command === "validate-config")
        return validateConfigCli(args.slice(1));
    if (command === "slop-risk")
        return slopRiskCli(args.slice(1));
    if (command === "improvement-potential")
        return improvementPotentialCli(args.slice(1));
    if (command === "issue-slop")
        return issueSlopCli(args.slice(1));
    if (command === "decision-pack")
        return decisionPackCli(options);
    if (command === "repo-decision")
        return repoDecisionCli(options);
    if (command === "contributor-profile")
        return contributorProfileCli(options);
    if (command === "monitor-open-prs")
        return monitorOpenPrsCli(options);
    if (command === "pr-outcomes")
        return prOutcomesCli(options);
    if (command === "explain-review-risk")
        return explainReviewRiskCli(options);
    if (command === "notifications")
        return notificationsCli(options);
    if (command === "notifications-read")
        return notificationsReadCli(options);
    if (command === "watch")
        return watchCli(args.slice(1));
    if (command === "review-pr")
        return reviewPrCli(options);
    if (command !== "analyze-branch" && command !== "preflight") {
        const suggestion = suggestCommand(command);
        throw new Error(`Unknown command: ${command}.${suggestion ? ` Did you mean \`${suggestion}\`?` : ""} Run \`loopover-mcp --help\` to list commands.`);
    }
    // Match every other subcommand: honor --help before requiring --login / hitting git+network (#6256).
    if (options.help === true)
        return printHelp();
    const contributorLogin = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!contributorLogin)
        throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    const result = await analyzeCurrentBranch({
        login: contributorLogin,
        cwd: options.cwd,
        repoFullName: options.repo,
        baseRef: options.base,
        title: options.title,
        body: options.body,
        labels: options.label,
        linkedIssues: options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
        pendingMergedPrCount: optionalInteger(options.pendingMergedPrs),
        pendingClosedPrCount: optionalInteger(options.pendingClosedPrs),
        approvedPrCount: optionalInteger(options.approvedPrs),
        expectedOpenPrCountAfterMerge: optionalInteger(options.expectedOpenPrs),
        projectedCredibility: optionalNumber(options.projectedCredibility),
        scenarioNotes: options.scenarioNote,
        branchEligibility: branchEligibilityFromOptions(options),
        validation: validationFromOptions(options),
        scorePreviewCommand: options.scorePreviewCommand,
    });
    const payload = command === "preflight"
        ? { local: result.local, preflight: result.analysis.preflight, prPacket: result.analysis.prPacket, workspaceIntelligence: publicSafeWorkspaceIntelligence(result.analysis.workspaceIntelligence) }
        : result;
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    if (options.format === "table") {
        writeBranchAnalysisTable(result, command);
        return;
    }
    writeBranchAnalysisCli(result, command);
}
// Render the report-shaped branch analysis (next actions, plus score blockers for analyze-branch) as
// aligned monospace tables when `--format table` is passed. Default and `--json` output are untouched.
function writeBranchAnalysisTable(result, command) {
    const analysis = result.analysis;
    const actionRows = (analysis.nextActions ?? []).map((action) => ({
        action: action.actionKind ?? "—",
        priority: action.priorityScore === undefined || action.priorityScore === null ? "—" : String(action.priorityScore),
        why: (action.whyThisHelps ?? []).join("; ") || "—",
    }));
    process.stdout.write(`${formatTable({ headers: [{ key: "action", label: "Action" }, { key: "priority", label: "Priority", align: "right" }, { key: "why", label: "Why this helps" }], rows: actionRows })}\n`);
    if (command === "analyze-branch" && analysis.scoreBlockers?.length) {
        process.stdout.write("\n");
        process.stdout.write(`${formatTable({ headers: [{ key: "blocker", label: "Score blocker" }], rows: analysis.scoreBlockers.map((blocker) => ({ blocker })) })}\n`);
    }
}
function printReviewPrHelp() {
    process.stdout.write([
        "Usage: loopover-mcp review-pr --login <github-login> [--repo owner/repo] [--base origin/main] [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]",
        "",
        "Compose the existing preflight + slop-risk + PR-text-lint checks into ONE pre-PR review report,",
        "so a contributor's own local agent can see everything the loopover gate would flag before ever opening a PR.",
        "Mirrors the loopover_review_pr_before_push MCP tool. Thin composition only — does not reimplement any check. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function reviewPrCli(options) {
    if (options.help === true)
        return printReviewPrHelp();
    const contributorLogin = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!contributorLogin)
        throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    let prBody = options.body;
    if (options.bodyFile)
        prBody = readCliTextFile(options.bodyFile, "Body");
    const commitMessages = Array.isArray(options.commit) ? options.commit : options.commit ? [options.commit] : undefined;
    const linkedIssue = parsePositiveIntegerOption(options.linkedIssue, "--linked-issue");
    const payload = await reviewLocalPr({
        login: contributorLogin,
        cwd: options.cwd,
        repoFullName: options.repo,
        baseRef: options.base,
        title: options.title,
        body: prBody,
        labels: options.label,
        commitMessages,
        linkedIssues: linkedIssue !== undefined ? [linkedIssue] : options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
    });
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`Pre-PR review: ${payload.overallStatus}\n`);
    for (const section of payload.sections)
        process.stdout.write(`- ${section.name}: ${section.status}\n`);
    process.stdout.write(`Preflight: ${payload.preflight.status}\n`);
    if (payload.slopRisk)
        process.stdout.write(`Slop risk: ${payload.slopRisk.band}\n`);
    else if (payload.slopRiskError)
        process.stdout.write(`Slop risk: unavailable (${payload.slopRiskError})\n`);
    if (payload.prTextLint)
        process.stdout.write(`PR text lint: ${payload.prTextLint.verdict} (score ${payload.prTextLint.score})\n`);
    else if (payload.prTextLintError)
        process.stdout.write(`PR text lint: unavailable (${payload.prTextLintError})\n`);
}
// Opens, type-checks, and reads the file through ONE file descriptor rather than a separate
// stat-then-read pair: a check-then-read on a path string leaves a race window where a symlink or
// special file (FIFO, device) can be swapped in between the two calls, letting the earlier
// isFile()/size validation apply to a different, unvalidated file than the one actually read.
// O_NOFOLLOW makes a symlinked path fail to open outright instead of silently following it.
function readCliTextFile(path, label) {
    let fd;
    try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    catch (error) {
        if (error && error.code === "ENOENT")
            throw new Error(`${label} file not found: ${path}`);
        if (error && (error.code === "ELOOP" || error.code === "EMLINK"))
            throw new Error(`${label} file must be a regular file: ${path}`);
        throw error;
    }
    try {
        const stats = fstatSync(fd);
        if (!stats.isFile())
            throw new Error(`${label} file must be a regular file: ${path}`);
        if (stats.size > cliTextFileMaxBytes)
            throw new Error(`${label} file is too large: ${path} (max ${cliTextFileMaxBytes} bytes)`);
        // Bound the READ itself rather than trusting stats.size alone: a regular file can grow between fstatSync
        // and the read below (the fd is the same, but nothing stops another process from appending to the file
        // in between), so read at most cliTextFileMaxBytes + 1 bytes directly from the descriptor and fail if that
        // cap is exceeded, instead of handing the now-possibly-stale size to an unbounded readFileSync.
        const buffer = Buffer.alloc(cliTextFileMaxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const n = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
            if (n === 0)
                break;
            bytesRead += n;
        }
        if (bytesRead > cliTextFileMaxBytes)
            throw new Error(`${label} file is too large: ${path} (max ${cliTextFileMaxBytes} bytes)`);
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    finally {
        closeSync(fd);
    }
}
function printLintPrTextHelp() {
    process.stdout.write([
        "Usage: loopover-mcp lint-pr-text [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]",
        "",
        "Lint a commit message and PR body against the LoopOver traceability and Conventional Commit rubric.",
        "Mirrors the loopover_lint_pr_text MCP tool and POST /v1/lint/pr-text. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function lintPrTextCli(args) {
    if (!args.length || args[0] === "--help" || args[0] === "help")
        return printLintPrTextHelp();
    const options = parseOptions(args);
    const commitMessages = Array.isArray(options.commit) ? options.commit : options.commit ? [options.commit] : undefined;
    let prBody = options.body;
    if (options.bodyFile) {
        prBody = readCliTextFile(options.bodyFile, "Body");
    }
    const linkedIssue = parsePositiveIntegerOption(options.linkedIssue, "--linked-issue");
    const payload = await apiPost("/v1/lint/pr-text", {
        ...(commitMessages?.length ? { commitMessages } : {}),
        ...(prBody !== undefined ? { prBody } : {}),
        ...(linkedIssue !== undefined ? { linkedIssue } : {}),
    });
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`PR text lint: ${payload.verdict} (score ${payload.score})\n`);
    process.stdout.write(`${payload.summary}\n`);
    for (const fix of payload.fixes ?? [])
        process.stdout.write(`- ${fix}\n`);
}
// Strip ANSI escapes + control characters from text this CLI prints as plain text. Rule (#6261): every value that
// reaches a terminal from a source the user does not control -- an API response, or free text the API echoed back
// from a third-party issue/PR -- goes through this first. Otherwise a hostile string can repaint the screen,
// rewrite earlier lines, or fake a success next to a real failure, since the terminal cannot tell our text from
// the payload's.
//
// Two things deliberately do NOT go through it:
//   - `--json` output. JSON.stringify escapes U+001B (and the rest of U+0000-U+001F) as a \u001b literal, so an escape
//     sequence cannot survive into the printed document -- and sanitizing there would corrupt the machine-readable
//     contract callers parse.
//   - Our own literals, and values the user themself passed in (--login, --repo). Those are already the user's,
//     and the CLI prints no colour of its own -- there is no intentional ANSI in this file to preserve.
function sanitizePlainTextTerminalOutput(value) {
    return String(value)
        .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|[@-_])/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
function printValidateConfigHelp() {
    process.stdout.write([
        "Usage: loopover-mcp validate-config --file <path> [--source repo_file|api_record|none] [--json]",
        "",
        "Validate a .loopover.yml manifest before pushing.",
        "Mirrors the loopover_validate_config MCP tool and POST /v1/validate/focus-manifest. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function validateConfigCli(args) {
    if (!args.length || args[0] === "--help" || args[0] === "help")
        return printValidateConfigHelp();
    const options = parseOptions(args);
    if (!options.file)
        throw new Error("Pass --file <path> to the manifest to validate.");
    const content = readCliTextFile(options.file, "Manifest");
    const source = options.source;
    if (source !== undefined && !["repo_file", "api_record", "none"].includes(String(source))) {
        throw new Error("--source must be one of: repo_file, api_record, none");
    }
    const payload = await apiPost("/v1/validate/focus-manifest", {
        content,
        ...(source !== undefined ? { source } : {}),
    });
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`Manifest validation: ${payload.status}\n`);
    process.stdout.write(`present=${payload.present}\n`);
    for (const warning of payload.warnings ?? [])
        process.stdout.write(`- ${sanitizePlainTextTerminalOutput(warning)}\n`);
}
function printSlopRiskHelp() {
    process.stdout.write([
        "Usage: loopover-mcp slop-risk [--description <text>] [--description-file <path>] [--changed-file <path[:additions:deletions]>]... [--test <command>]... [--test-file <path>]... [--json]",
        "",
        "Assess deterministic slop risk from local diff metadata and a PR description.",
        "Mirrors the loopover_check_slop_risk MCP tool and POST /v1/lint/slop-risk. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
function stringArrayOption(value) {
    if (!value)
        return [];
    return Array.isArray(value) ? value : [value];
}
function parseChangedFileSpec(raw) {
    const [path, additions, deletions] = String(raw).split(":");
    if (!path)
        throw new Error(`Invalid --changed-file value: ${raw}`);
    const entry = { path };
    if (additions !== undefined && additions !== "") {
        const parsedAdditions = Number(additions);
        if (!Number.isInteger(parsedAdditions) || parsedAdditions < 0)
            throw new Error(`Invalid additions in --changed-file: ${raw}`);
        entry.additions = parsedAdditions;
    }
    if (deletions !== undefined && deletions !== "") {
        const parsedDeletions = Number(deletions);
        if (!Number.isInteger(parsedDeletions) || parsedDeletions < 0)
            throw new Error(`Invalid deletions in --changed-file: ${raw}`);
        entry.deletions = parsedDeletions;
    }
    return entry;
}
async function slopRiskCli(args) {
    if (!args.length || args[0] === "--help" || args[0] === "help")
        return printSlopRiskHelp();
    const options = parseOptions(args);
    let description = options.description ?? options.body;
    const descriptionFile = options.descriptionFile ?? options.bodyFile;
    if (descriptionFile) {
        description = readCliTextFile(descriptionFile, "Description");
    }
    const changedFiles = stringArrayOption(options.changedFile).map(parseChangedFileSpec);
    const tests = stringArrayOption(options.test);
    const testFiles = stringArrayOption(options.testFile);
    const payload = await apiPost("/v1/lint/slop-risk", {
        ...(changedFiles.length ? { changedFiles } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tests.length ? { tests } : {}),
        ...(testFiles.length ? { testFiles } : {}),
    });
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    // #6990: the route now returns band + findings only (no numeric score/rubric), matching the MCP tool's
    // blunting; print the band alone so the CLI can't leak the exact score the REST surface no longer sends.
    process.stdout.write(`Slop risk: ${sanitizePlainTextTerminalOutput(payload.band)}\n`);
    for (const finding of payload.findings ?? [])
        process.stdout.write(`- ${sanitizePlainTextTerminalOutput(finding.title)}: ${sanitizePlainTextTerminalOutput(finding.detail)}\n`);
}
function printImprovementPotentialHelp() {
    process.stdout.write([
        "Usage: loopover-mcp improvement-potential [--changed-file <path[:additions:deletions]>]... [--test <command>]... [--test-file <path>]... [--patch-coverage-delta <percent>] [--json]",
        "",
        "Assess deterministic structural-improvement potential from local diff metadata.",
        "Mirrors the loopover_check_improvement_potential MCP tool and POST /v1/lint/improvement-potential. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function improvementPotentialCli(args) {
    // #6748: shell CLI mirror of loopover_check_improvement_potential, matching slopRiskCli's HTTP-proxy pattern
    // (the pure builder lives in src/signals/improvement.ts, not yet an @loopover/engine export for in-process use).
    if (!args.length || args[0] === "--help" || args[0] === "help")
        return printImprovementPotentialHelp();
    const options = parseOptions(args);
    const changedFiles = stringArrayOption(options.changedFile).map(parseChangedFileSpec);
    const tests = stringArrayOption(options.test);
    const testFiles = stringArrayOption(options.testFile);
    let patchCoverageDeltaPercent;
    if (options.patchCoverageDelta !== undefined) {
        patchCoverageDeltaPercent = Number(options.patchCoverageDelta);
        if (!Number.isFinite(patchCoverageDeltaPercent)) {
            throw new Error("--patch-coverage-delta must be a finite number");
        }
    }
    const payload = await apiPost("/v1/lint/improvement-potential", {
        ...(changedFiles.length ? { changedFiles } : {}),
        ...(tests.length ? { tests } : {}),
        ...(testFiles.length ? { testFiles } : {}),
        ...(patchCoverageDeltaPercent !== undefined ? { patchCoverageDeltaPercent } : {}),
    });
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`Improvement potential: ${sanitizePlainTextTerminalOutput(payload.improvementScore)} (${sanitizePlainTextTerminalOutput(payload.band)})\n`);
    for (const finding of payload.findings ?? [])
        process.stdout.write(`- ${sanitizePlainTextTerminalOutput(finding.title)}: ${sanitizePlainTextTerminalOutput(finding.detail)}\n`);
}
function printIssueSlopHelp() {
    process.stdout.write([
        "Usage: loopover-mcp issue-slop [--title <text>] [--body <text>] [--body-file <path>] [--json]",
        "",
        "Assess deterministic issue slop risk from an issue title and body alone.",
        "Mirrors the loopover_check_issue_slop MCP tool and POST /v1/lint/issue-slop. Advisory only; no source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function issueSlopCli(args) {
    if (!args.length || args[0] === "--help" || args[0] === "help")
        return printIssueSlopHelp();
    const options = parseOptions(args);
    let body = normalizeOptionalStringOption(options.body);
    if (options.bodyFile) {
        body = readCliTextFile(options.bodyFile, "Body");
    }
    const title = normalizeOptionalStringOption(options.title);
    const payload = await apiPost("/v1/lint/issue-slop", {
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
    });
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    // #6990: band + findings only, matching the route's blunting (no numeric score/rubric leaked through the CLI).
    process.stdout.write(`Issue slop risk: ${sanitizePlainTextTerminalOutput(payload.band)}\n`);
    for (const finding of payload.findings ?? [])
        process.stdout.write(`- ${sanitizePlainTextTerminalOutput(finding.title)}: ${sanitizePlainTextTerminalOutput(finding.detail)}\n`);
}
function printDecisionPackHelp() {
    process.stdout.write([
        "Usage: loopover-mcp decision-pack --login <github-login> [--json]",
        "",
        "Fetch the cached (or freshly built) contributor decision pack for a GitHub login.",
        "Mirrors the loopover_get_decision_pack MCP tool and GET /v1/contributors/{login}/decision-pack. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
function printContributorProfileHelp() {
    process.stdout.write([
        "Usage: loopover-mcp contributor-profile --login <github-login> [--json]",
        "",
        "Fetch the contributor profile for a GitHub login.",
        "Mirrors the loopover_get_contributor_profile MCP tool and GET /v1/contributors/{login}/profile. No source upload.",
        "",
        "Login resolves from --login, the active session, LOOPOVER_LOGIN, then GITHUB_LOGIN.",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
// #6737: CLI mirror of the loopover_get_contributor_profile MCP tool and GET /v1/contributors/{login}/profile
// (requireContributorAccess-gated -- the same gate decision-pack/repo-decision already satisfy). Login resolves
// from --login / the active session / LOOPOVER_LOGIN / GITHUB_LOGIN, exactly like the sibling contributor
// commands, so an already-logged-in contributor never retypes their own login. Named `contributor-profile`
// because the top-level `profile` command already manages MCP client profiles.
async function contributorProfileCli(options) {
    if (options.help === true)
        return printContributorProfileHelp();
    const login = options.login ?? activeProfile.session?.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login>, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN.");
    const payload = await apiGet(`/v1/contributors/${encodeURIComponent(login)}/profile`);
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
        return;
    }
    process.stdout.write(`LoopOver contributor profile for ${login}.
`);
    if (payload.summary)
        process.stdout.write(`${sanitizePlainTextTerminalOutput(payload.summary)}
`);
}
async function decisionPackCli(options) {
    if (options.help === true)
        return printDecisionPackHelp();
    const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    const payload = await getDecisionPackWithCache(login);
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    // #6261: decisionPackToolSummary is left alone -- verified, not assumed. It interpolates `login` (the user's own
    // --login/env value) and `payload.freshness`, and freshness only ever reaches the string inside an equality guard
    // against the literals "stale"/"rebuilding", so the API cannot route text of its own choosing through it.
    process.stdout.write(`${decisionPackToolSummary(login, payload)}\n`);
    if (payload.summary)
        process.stdout.write(`${sanitizePlainTextTerminalOutput(payload.summary)}\n`);
    if (payload.cache?.rerunGuidance)
        process.stdout.write(`Rerun when: ${sanitizePlainTextTerminalOutput(payload.cache.rerunGuidance)}\n`);
}
function printMonitorOpenPrsHelp() {
    process.stdout.write([
        "Usage: loopover-mcp monitor-open-prs --login <github-login> [--json]",
        "",
        "Review your open PRs across registered repos: queue classification and next steps per PR.",
        "Mirrors the loopover_monitor_open_prs MCP tool and GET /v1/contributors/{login}/open-pr-monitor. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function monitorOpenPrsCli(options) {
    if (options.help === true)
        return printMonitorOpenPrsHelp();
    const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    const payload = await getOpenPrMonitor(login);
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    // #6261: every value below is the API's to choose -- the summary/guidance it composes, and PR titles it echoes
    // back from third-party repos -- so all of it is sanitized before it reaches the terminal. `login` is the user's
    // own --login/env value and needs no sanitizing, but it only reaches stdout via the literal fallback branch.
    process.stdout.write(`${sanitizePlainTextTerminalOutput(openPrMonitorToolSummary(login, payload))}\n`);
    for (const line of payload?.guidance ?? [])
        process.stdout.write(`${sanitizePlainTextTerminalOutput(line)}\n`);
    for (const pr of payload?.pullRequests ?? []) {
        const heading = `${pr.repoFullName}#${pr.number} [${pr.classification}] ${pr.title}`;
        process.stdout.write(`${sanitizePlainTextTerminalOutput(heading)}\n`);
        for (const step of pr.nextSteps ?? [])
            process.stdout.write(`  - ${sanitizePlainTextTerminalOutput(step)}\n`);
    }
}
function printPrOutcomesHelp() {
    process.stdout.write([
        "Usage: loopover-mcp pr-outcomes --login <github-login> [--limit N] [--json]",
        "",
        "List your post-merge PR outcome history (public-safe attribution per merged PR).",
        "Mirrors the loopover_pr_outcome MCP tool and GET /v1/contributors/{login}/pr-outcomes. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function prOutcomesCli(options) {
    if (options.help === true)
        return printPrOutcomesHelp();
    const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    const limitRaw = options.limit;
    let limit;
    if (limitRaw !== undefined && limitRaw !== true) {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
            throw new Error("Pass --limit as an integer between 1 and 100.");
        }
        limit = parsed;
    }
    const payload = await getPrOutcomes(login, limit);
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${sanitizePlainTextTerminalOutput(prOutcomesToolSummary(login, payload))}\n`);
    for (const outcome of payload?.outcomes ?? []) {
        const heading = `${outcome.repoFullName}#${outcome.pullNumber ?? "?"} [${outcome.outcome}]`;
        process.stdout.write(`${sanitizePlainTextTerminalOutput(heading)}\n`);
        if (outcome.attribution)
            process.stdout.write(`  ${sanitizePlainTextTerminalOutput(outcome.attribution)}\n`);
    }
}
function printExplainReviewRiskHelp() {
    process.stdout.write([
        "Usage: loopover-mcp explain-review-risk --repo owner/repo --title <text> [--login <github-login>] [--body <text>] [--json]",
        "",
        "Explain review risk for a planned PR (preflight + optional role context + recommendation).",
        "Mirrors the loopover_explain_review_risk MCP tool and POST /v1/preflight/review-risk. No source upload.",
        "",
        "Pass --repo or --repoFullName, --title, and optionally --login as contributorLogin.",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function explainReviewRiskCli(options) {
    if (options.help === true)
        return printExplainReviewRiskHelp();
    const repoFullName = options.repoFullName ?? options.repo;
    if (!repoFullName || !String(repoFullName).includes("/"))
        throw new Error("Pass --repo owner/repo or --repoFullName owner/repo.");
    if (!options.title)
        throw new Error("Pass --title <text>.");
    const contributorLogin = options.login ?? options.contributorLogin;
    const labels = Array.isArray(options.label) ? options.label : options.label ? [options.label] : undefined;
    const changedFiles = Array.isArray(options.changedFile) ? options.changedFile : options.changedFile ? [options.changedFile] : undefined;
    const linkedIssues = Array.isArray(options.issue)
        ? options.issue.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : options.issue
            ? [Number(options.issue)].filter((value) => Number.isInteger(value) && value > 0)
            : undefined;
    const tests = Array.isArray(options.test) ? options.test : options.test ? [options.test] : undefined;
    const payload = await apiPost("/v1/preflight/review-risk", stripUndefined({
        repoFullName,
        title: options.title,
        contributorLogin,
        body: options.body,
        labels,
        changedFiles,
        linkedIssues: linkedIssues && linkedIssues.length > 0 ? linkedIssues : undefined,
        tests,
        authorAssociation: options.authorAssociation,
    }));
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${sanitizePlainTextTerminalOutput(payload.summary ?? `LoopOver review-risk explanation for ${repoFullName}.`)}\n`);
    if (payload.recommendation)
        process.stdout.write(`Recommendation: ${sanitizePlainTextTerminalOutput(payload.recommendation)}\n`);
    if (payload.preflight?.status)
        process.stdout.write(`Preflight status: ${sanitizePlainTextTerminalOutput(payload.preflight.status)}\n`);
}
function printNotificationsHelp() {
    process.stdout.write([
        "Usage: loopover-mcp notifications --login <github-login> [--json]",
        "",
        "Your own badge notification feed (newest first) with an unread count, self-scoped.",
        "Mirrors the loopover_list_notifications MCP tool and GET /v1/contributors/{login}/notifications. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
// #6745: CLI mirror of loopover_list_notifications. Login resolves from --login / the active session /
// LOOPOVER_LOGIN / GITHUB_LOGIN, like the sibling contributor commands.
async function notificationsCli(options) {
    if (options.help === true)
        return printNotificationsHelp();
    const login = options.login ?? activeProfile.session?.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login>, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN.");
    const payload = await getNotifications(login);
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`LoopOver notifications for ${login}: ${payload.unreadCount} unread.\n`);
    for (const item of payload.notifications ?? []) {
        // `login` is the user's own value; the API chooses the title text, so it is sanitized before the terminal.
        const flag = item.status === "delivered" ? "*" : " ";
        process.stdout.write(`${sanitizePlainTextTerminalOutput(`${flag} ${item.repoFullName}#${item.pullNumber} ${item.title}`)}\n`);
    }
}
// #6746: contributor-scoped mirror of the loopover_watch_issues MCP tool and the /v1/contributors/{login}/watches
// route family. The MCP tool's action enum maps to subcommands here: list=GET, add=POST, remove=DELETE.
async function watchCli(args) {
    const subcommand = args[0];
    if (!subcommand || subcommand === "--help" || subcommand === "help")
        return printWatchHelp();
    const positional = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const options = parseOptions(args.slice(1));
    const login = options.login ?? activeProfile.session?.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login>, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN.");
    const base = `/v1/contributors/${encodeURIComponent(login)}/watches`;
    // The API chooses `changed` / repo / label text, so the plain-text path is sanitized (#6261); `login` is the
    // user's own value.
    const render = (payload) => [
        `Watching ${(payload.watching ?? []).length} repo(s) for ${login}${payload.changed ? ` (${sanitizePlainTextTerminalOutput(payload.changed)})` : ""}.`,
        ...(payload.watching ?? []).map((watch) => {
            const labels = (watch.labels ?? []).length > 0 ? ` [${watch.labels.map(sanitizePlainTextTerminalOutput).join(", ")}]` : "";
            return `- ${sanitizePlainTextTerminalOutput(watch.repoFullName)}${labels}`;
        }),
    ].join("\n");
    const emit = (payload) => {
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(`${render(payload)}\n`);
    };
    if (subcommand === "list") {
        emit(await apiGet(base));
        return;
    }
    if (subcommand === "add" || subcommand === "remove") {
        if (!positional || !positional.includes("/")) {
            throw new Error(`Pass the repo: loopover-mcp watch ${subcommand} <owner/repo>.`);
        }
        if (subcommand === "add") {
            const labels = typeof options.labels === "string" ? options.labels.split(",").map((label) => label.trim()).filter(Boolean) : [];
            emit(await apiPost(base, { repoFullName: positional, ...(labels.length > 0 ? { labels } : {}) }));
        }
        else {
            emit(await apiDelete(base, { repoFullName: positional }));
        }
        return;
    }
    throw new Error(`Unknown watch subcommand: ${subcommand}. Use list | add <owner/repo> [--labels a,b] | remove <owner/repo>.`);
}
function printWatchHelp() {
    process.stdout.write([
        "Usage: loopover-mcp watch <list|add|remove> [owner/repo] [--labels a,b] [--login <github-login>] [--json]",
        "",
        "Manage your issue-watch subscriptions (mirrors the loopover_watch_issues MCP tool and the",
        "/v1/contributors/{login}/watches routes):",
        "  list                         Show the repos you are watching.",
        "  add <owner/repo> [--labels]  Watch a repo for new grabbable issues (optional comma-separated label filter).",
        "  remove <owner/repo>          Stop watching a repo.",
        "",
        "Login resolves from --login, the active session, LOOPOVER_LOGIN, then GITHUB_LOGIN.",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
function printNotificationsReadHelp() {
    process.stdout.write([
        "Usage: loopover-mcp notifications-read --login <github-login> [--id <delivery-id>]... [--json]",
        "",
        "Mark your delivered notifications read. With no --id, marks all of them.",
        "Mirrors the loopover_mark_notifications_read MCP tool and POST /v1/contributors/{login}/notifications/read.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
// #6745: CLI mirror of loopover_mark_notifications_read. Repeated --id flags collect into an ids array; omitting
// them marks every delivered notification read (mirrors the route's absent-body behavior).
async function notificationsReadCli(options) {
    if (options.help === true)
        return printNotificationsReadHelp();
    const login = options.login ?? activeProfile.session?.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login>, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN.");
    const ids = Array.isArray(options.id) ? options.id : options.id ? [options.id] : undefined;
    const payload = await postMarkNotificationsRead(login, ids);
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`Marked ${payload.marked} LoopOver notification(s) read for ${login}.\n`);
}
function printRepoDecisionHelp() {
    process.stdout.write([
        "Usage: loopover-mcp repo-decision --login <github-login> --repo owner/repo [--json]",
        "",
        "Fetch the cached (or freshly built) repo decision for a GitHub login and repo.",
        "Mirrors the loopover_explain_repo_decision MCP tool. No source upload.",
        "",
        "Pass --json for machine-readable output.",
    ].join("\n") + "\n");
}
async function repoDecisionCli(options) {
    if (options.help === true)
        return printRepoDecisionHelp();
    const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login)
        throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    const repoFullName = options.repo;
    if (!repoFullName || !repoFullName.includes("/"))
        throw new Error("Pass --repo owner/repo.");
    const [owner, repo] = repoFullName.split("/", 2);
    const payload = await getRepoDecisionWithCache(login, owner, repo);
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    // #6261: repoDecisionToolSummary is left alone for the same reason -- it interpolates only `login` and
    // `repoFullName`, both of which the user typed on their own command line. No payload text reaches it.
    process.stdout.write(`${repoDecisionToolSummary(login, repoFullName, payload)}\n`);
    const actions = payload.decision?.nextActions ?? payload.decision?.publicNextActions ?? [];
    for (const action of actions.slice(0, 3))
        process.stdout.write(`- ${sanitizePlainTextTerminalOutput(action)}\n`);
    if (payload.cache?.rerunGuidance)
        process.stdout.write(`Rerun when: ${sanitizePlainTextTerminalOutput(payload.cache.rerunGuidance)}\n`);
}
function runCacheCli(args) {
    const subcommand = args[0] ?? "help";
    if (subcommand === "--help" || subcommand === "help")
        return printCacheHelp();
    const options = parseOptions(args.slice(1));
    if (subcommand === "clear") {
        const payload = clearDecisionPackCache();
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(`Cleared ${payload.removed} decision-pack cache entr${payload.removed === 1 ? "y" : "ies"}.\n`);
        return;
    }
    if (subcommand === "status") {
        const payload = inspectDecisionPackCache();
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(`Decision-pack cache: ${payload.entries} entr${payload.entries === 1 ? "y" : "ies"}.\n`);
        return;
    }
    if (subcommand === "list" || subcommand === "ls") {
        const payload = listDecisionPackCache();
        if (emitList(options, payload.entries, payload))
            return;
        if (payload.count === 0)
            process.stdout.write("Decision-pack cache is empty.\n");
        else
            for (const entry of payload.entries)
                process.stdout.write(`- ${entry.login ?? "unknown"} (cached ${entry.cachedAt ?? "unknown"}, ${entry.bytes} bytes)\n`);
        return;
    }
    throw new Error(`Unknown cache command: ${subcommand}`);
}
async function runAgentCli(args) {
    const subcommand = args[0] ?? "help";
    if (subcommand === "--help" || subcommand === "help")
        return printAgentHelp();
    const options = parseOptions(args.slice(1));
    if (subcommand === "plan") {
        const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
        if (!login)
            throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
        const payload = await apiPost("/v1/agent/plan-next-work", stripUndefined({ login, repoFullName: options.repo, objective: options.objective, surface: "mcp" }));
        return outputAgentPayload(payload, options, `LoopOver agent plan: ${payload.summary ?? payload.run?.status ?? "ready"}`);
    }
    if (subcommand === "status") {
        const runId = args[1] && !args[1].startsWith("--") ? args[1] : options.runId;
        if (!runId)
            throw new Error("Usage: loopover-mcp agent status <run-id>");
        const payload = await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`);
        return outputAgentPayload(payload, options, `LoopOver agent run ${runId}: ${payload.run?.status ?? "unknown"}`);
    }
    if (subcommand === "explain") {
        const runId = args[1] && !args[1].startsWith("--") ? args[1] : options.runId;
        if (!runId)
            throw new Error("Usage: loopover-mcp agent explain <run-id>");
        const payload = await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`);
        const topAction = payload.actions?.[0] ?? null;
        return outputAgentPayload({ ...payload, topAction }, options, topAction ? `Top action: ${topAction.recommendation}` : "No top action is available yet.");
    }
    if (subcommand === "packet") {
        const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
        if (!login)
            throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
        const payload = await agentPreparePrPacket({
            login,
            cwd: options.cwd,
            repoFullName: options.repo,
            baseRef: options.base,
            title: options.title,
            body: options.body,
            labels: options.label,
            linkedIssues: options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
            pendingMergedPrCount: optionalInteger(options.pendingMergedPrs),
            pendingClosedPrCount: optionalInteger(options.pendingClosedPrs),
            approvedPrCount: optionalInteger(options.approvedPrs),
            expectedOpenPrCountAfterMerge: optionalInteger(options.expectedOpenPrs),
            projectedCredibility: optionalNumber(options.projectedCredibility),
            scenarioNotes: options.scenarioNote,
            branchEligibility: branchEligibilityFromOptions(options),
            validation: validationFromOptions(options),
            scorePreviewCommand: options.scorePreviewCommand,
        });
        return outputAgentPayload(payload, options, "LoopOver public-safe PR packet prepared.");
    }
    throw new Error(`Unknown agent command: ${subcommand}`);
}
function outputAgentPayload(payload, options, summary) {
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    const packetMarkdown = payload?.prPacket?.markdown ?? payload?.actions?.find((action) => action?.actionType === "prepare_pr_packet")?.payload?.prPacket?.markdown;
    if (typeof packetMarkdown === "string" && packetMarkdown.trim()) {
        const safeMarkdown = requirePublicSafePacketMarkdown(packetMarkdown);
        return process.stdout.write(safeMarkdown.endsWith("\n") ? safeMarkdown : `${safeMarkdown}\n`);
    }
    process.stdout.write(`${summary}\n`);
    if (payload.summary && payload.summary !== summary)
        process.stdout.write(`${payload.summary}\n`);
    if (payload.recommendedRerunCondition)
        process.stdout.write(`Rerun when: ${payload.recommendedRerunCondition}\n`);
    const actions = payload.actions ?? payload.nextActions ?? [];
    for (const action of actions.slice(0, 3)) {
        const label = action.actionType ?? action.actionKind ?? action.recommendation ?? "action";
        const detail = action.recommendation ?? action.actionKind ?? action.summary ?? label;
        process.stdout.write(`- ${label}: ${detail}\n`);
        if (action.explanationCard) {
            process.stdout.write(`  why now: ${action.explanationCard.whyNow}\n`);
            process.stdout.write(`  impact: ${action.explanationCard.expectedImpact}\n`);
            process.stdout.write(`  rerun: ${action.explanationCard.rerunWhen}\n`);
        }
        else if (action.rerunWhen) {
            process.stdout.write(`  rerun: ${action.rerunWhen}\n`);
        }
    }
}
function writeBranchAnalysisCli(result, command) {
    const analysis = result.analysis;
    const intelligence = command === "preflight" ? publicSafeWorkspaceIntelligence(analysis.workspaceIntelligence) : analysis.workspaceIntelligence;
    process.stdout.write(`${analysis.summary}\n`);
    process.stdout.write(`Top action: ${analysis.nextActions?.[0]?.actionKind ?? "none"}\n`);
    if (analysis.nextActions?.[0]?.whyThisHelps?.length) {
        process.stdout.write("Why this helps:\n");
        for (const line of analysis.nextActions[0].whyThisHelps.slice(0, 3))
            process.stdout.write(`- ${line}\n`);
    }
    if (intelligence)
        writeWorkspaceIntelligenceCli(intelligence);
    if (command === "analyze-branch" && analysis.scoreBlockers?.length) {
        process.stdout.write("Score blockers:\n");
        for (const blocker of analysis.scoreBlockers.slice(0, 5))
            process.stdout.write(`- ${blocker}\n`);
    }
    process.stdout.write(`Preflight: ${analysis.preflight.status}\n`);
    process.stdout.write(`Source upload: disabled\n`);
    if (result.local?.localScorerStatus?.ok === false) {
        process.stdout.write(`Local scorer: ${result.local.localScorerStatus.code ?? "metadata_only"}\n`);
        for (const line of result.local.setupGuidance ?? setupGuidanceForLocalScorer(result.local.localScorerStatus)) {
            process.stdout.write(`- ${line}\n`);
        }
    }
}
function writeWorkspaceIntelligenceCli(intelligence) {
    process.stdout.write(`Workspace intelligence v${intelligence.version}:\n`);
    const files = intelligence.changedFiles;
    process.stdout.write(`- Changed files: ${files.total} (${files.binary} binary, ${files.deleted} deleted, ${files.renamed} renamed)\n`);
    process.stdout.write(`- Test evidence: ${intelligence.testEvidence.level}\n`);
    if (intelligence.branch.pendingCommitCount > 0) {
        process.stdout.write(`- Pending commits ahead of base: ${intelligence.branch.pendingCommitCount}\n`);
    }
    if (intelligence.baseFreshness.status !== "fresh") {
        process.stdout.write(`- Base freshness: ${intelligence.baseFreshness.status}\n`);
        for (const warning of intelligence.baseFreshness.warnings.slice(0, 2))
            process.stdout.write(`  ${warning}\n`);
    }
    if (intelligence.blockers.branchQuality.length) {
        process.stdout.write("- Branch-quality blockers:\n");
        for (const blocker of intelligence.blockers.branchQuality.slice(0, 4))
            process.stdout.write(`  - ${blocker}\n`);
    }
    if (intelligence.blockers.accountState.length) {
        process.stdout.write("- Account/queue blockers:\n");
        for (const blocker of intelligence.blockers.accountState.slice(0, 4))
            process.stdout.write(`  - ${blocker}\n`);
    }
    if (intelligence.ciStatusHints.length) {
        process.stdout.write("- CI hints:\n");
        for (const hint of intelligence.ciStatusHints.slice(0, 3))
            process.stdout.write(`  - ${hint}\n`);
    }
    process.stdout.write(`- Rerun when: ${intelligence.rerunWhen}\n`);
}
function publicSafeWorkspaceIntelligence(intelligence) {
    if (!intelligence)
        return intelligence;
    return {
        ...intelligence,
        blockers: {
            ...intelligence.blockers,
            accountState: [],
        },
        rerunWhen: publicSafeRerunWhen(intelligence),
    };
}
function publicSafeRerunWhen(intelligence) {
    if (intelligence.baseFreshness?.status === "stale" || intelligence.baseFreshness?.status === "possibly_stale") {
        return "Run `git fetch origin` and rerun; current diff size may be inflated by stale base state.";
    }
    if (intelligence.blockers?.branchQuality?.length) {
        return "Rerun after fixing branch-quality blockers or adding explicit validation/linked-context evidence.";
    }
    return "Rerun after any branch, base, or PR state changes before opening/submitting.";
}
function requirePublicSafePacketMarkdown(markdown) {
    const unsafeLine = markdown.split(/\r?\n/).find((line) => isUnsafePublicPacketText(line));
    if (unsafeLine)
        throw new Error("Refusing to print unsafe public packet markdown from the server.");
    return markdown;
}
function isUnsafePublicPacketText(value) {
    return /\b(reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:[\\/]Users[\\/]/i.test(value);
}
function printVersion(options) {
    const payload = { name: packageName, version: packageVersion, apiVersion: currentApiVersion, node: process.version };
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${packageName}/${packageVersion} (api ${currentApiVersion}, node ${process.version})\n`);
}
function toolsCommand(args) {
    const subcommand = args[0];
    if (subcommand === "search")
        return toolsSearchCommand(args.slice(1));
    const options = parseOptions(args);
    const tools = STDIO_TOOL_DESCRIPTORS.map(({ name, category, description }) => ({ name, category, description }));
    // Group tools by category in the canonical order; any category with no tools is omitted, and a tool
    // whose category is unknown falls into a trailing "Other" bucket so nothing is silently dropped.
    const knownIds = new Set(STDIO_TOOL_CATEGORIES.map((entry) => entry.id));
    const groups = [
        ...STDIO_TOOL_CATEGORIES.map((entry) => ({ ...entry, tools: tools.filter((tool) => tool.category === entry.id) })),
        { id: "other", label: "Other", tools: tools.filter((tool) => !knownIds.has(tool.category)) },
    ].filter((group) => group.tools.length > 0);
    if (options.json) {
        const payload = {
            count: tools.length,
            categories: groups.map((group) => ({ id: group.id, label: group.label, count: group.tools.length })),
            tools,
        };
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    const nameWidth = tools.reduce((width, tool) => Math.max(width, tool.name.length), 0);
    groups.forEach((group, index) => {
        if (index > 0)
            process.stdout.write("\n");
        process.stdout.write(`${group.label} (${group.tools.length})\n`);
        for (const tool of group.tools) {
            process.stdout.write(`  ${tool.name.padEnd(nameWidth)}  ${tool.description}\n`);
        }
    });
}
// `tools search <query>` — fuzzy discovery across the ~150-tool combined surface (#6300). Matches the
// query against each registered tool's name AND description (not name-only), so "stake" surfaces
// get_subnet_stake_quote even though "stake" is only in its description. Reuses this CLI's existing
// levenshteinDistance for typo tolerance rather than pulling in a fuzzy-match dependency.
function toolsSearchCommand(args) {
    const options = parseOptions(args);
    const query = args.find((arg) => !arg.startsWith("--"));
    if (!query)
        throw new Error("Usage: loopover-mcp tools search <query> [--json]");
    const tools = searchTools(query);
    const payload = { query, count: tools.length, tools };
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    if (tools.length === 0) {
        process.stdout.write(`No tools match "${query}".\n`);
        return;
    }
    printToolRows(tools);
}
function printToolRows(tools) {
    const nameWidth = tools.reduce((width, tool) => Math.max(width, tool.name.length), 0);
    for (const tool of tools) {
        process.stdout.write(`${tool.name.padEnd(nameWidth)}  ${tool.description}\n`);
    }
}
// Rank registered tools by how well they match the query, best first. A substring hit on the name beats
// a substring hit on the description, which beats a typo-tolerant (Levenshtein) hit on any name/description
// token; tools that match none of these are dropped. Ties break alphabetically for a stable listing.
function searchTools(query) {
    const needle = query.toLowerCase();
    const scored = [];
    for (const { name, description } of STDIO_TOOL_DESCRIPTORS) {
        const score = scoreToolMatch(needle, name.toLowerCase(), description.toLowerCase());
        if (score !== null)
            scored.push({ name, description, score });
    }
    scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return scored.map(({ name, description }) => ({ name, description }));
}
function scoreToolMatch(needle, name, description) {
    if (name.includes(needle))
        return 0;
    if (description.includes(needle))
        return 1;
    // Typo tolerance: compare the query to each name/description token, allowing a small edit distance that
    // scales with the query length (a longer query tolerates more typos, a very short one stays exact-ish).
    const budget = Math.max(1, Math.floor(needle.length / 4));
    let best = Infinity;
    for (const token of `${name} ${description}`.split(/[^a-z0-9]+/)) {
        if (!token)
            continue;
        const distance = levenshteinDistance(needle, token);
        if (distance < best)
            best = distance;
    }
    return best <= budget ? 2 + best : null;
}
function completionCommand(args) {
    const shell = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    const options = parseOptions(args.filter((arg) => arg.startsWith("--")));
    if (!shell)
        throw new Error(`Usage: loopover-mcp completion <${COMPLETION_SHELLS.join("|")}> [--json]`);
    if (!COMPLETION_SHELLS.includes(shell))
        throw new Error(`Unsupported shell: ${shell}. Supported shells: ${COMPLETION_SHELLS.join(", ")}.`);
    const script = buildCompletionScript(shell);
    if (options.json) {
        process.stdout.write(`${JSON.stringify({ shell, script }, null, 2)}\n`);
        return;
    }
    process.stdout.write(`${script}\n`);
}
function buildCompletionScript(shell) {
    const topLevel = [...Object.keys(CLI_COMMAND_SPEC), "help"];
    const withSubcommands = Object.entries(CLI_COMMAND_SPEC).filter(([, subcommands]) => subcommands.length > 0);
    if (shell === "bash")
        return buildBashCompletion(topLevel, withSubcommands);
    if (shell === "zsh")
        return buildZshCompletion(topLevel, withSubcommands);
    if (shell === "fish")
        return buildFishCompletion(topLevel, withSubcommands);
    return buildPowershellCompletion(topLevel, withSubcommands);
}
// Suggest the closest known command for a typo, so an unknown command can offer a "did you mean".
// Only suggests within a small edit-distance budget that scales with input length, so unrelated
// input gets no (misleading) suggestion.
function suggestCommand(input) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of Object.keys(CLI_COMMAND_SPEC)) {
        const distance = levenshteinDistance(input, candidate);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
        }
    }
    const budget = Math.max(2, Math.floor(input.length / 3));
    return best !== null && bestDistance > 0 && bestDistance <= budget ? best : null;
}
function levenshteinDistance(a, b) {
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
        }
        previous = current;
    }
    return previous[b.length];
}
function buildBashCompletion(topLevel, withSubcommands) {
    const subcommandCases = withSubcommands
        .map(([command, subcommands]) => `      ${command}) COMPREPLY=( $(compgen -W "${subcommands.join(" ")}" -- "$cur") ); return 0;;`)
        .join("\n");
    return `# loopover-mcp bash completion. Add to ~/.bashrc:
#   source <(loopover-mcp completion bash)
_loopover_mcp() {
  local cur prev cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword=\$COMP_CWORD
  local commands="${topLevel.join(" ")}"
  if [ "\$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\$commands --help --version" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
${subcommandCases}
      *) COMPREPLY=( $(compgen -W "--json --format --login --repo --profile --agent-profile --base --cwd" -- "$cur") ); return 0;;
  esac
}
complete -F _loopover_mcp loopover-mcp`;
}
function buildZshCompletion(topLevel, withSubcommands) {
    const subcommandCases = withSubcommands
        .map(([command, subcommands]) => `      ${command}) _values 'subcommand' ${subcommands.join(" ")} ;;`)
        .join("\n");
    return `#compdef loopover-mcp
# loopover-mcp zsh completion. Add to your fpath, or:
#   source <(loopover-mcp completion zsh)
_loopover_mcp() {
  local -a commands
  commands=(${topLevel.join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case $words[2] in
${subcommandCases}
  esac
}
_loopover_mcp "$@"`;
}
function buildFishCompletion(topLevel, withSubcommands) {
    const topLevelLines = topLevel
        .map((command) => `complete -c loopover-mcp -n __fish_use_subcommand -a ${command} -d 'loopover-mcp command'`)
        .join("\n");
    const subcommandLines = withSubcommands
        .map(([command, subcommands]) => `complete -c loopover-mcp -n '__fish_seen_subcommand_from ${command}' -a '${subcommands.join(" ")}'`)
        .join("\n");
    return `# loopover-mcp fish completion. Save to:
#   ~/.config/fish/completions/loopover-mcp.fish
${topLevelLines}
${subcommandLines}`;
}
function buildPowershellCompletion(topLevel, withSubcommands) {
    const commandList = topLevel.map((command) => `'${command}'`).join(", ");
    const subcommandEntries = withSubcommands
        .map(([command, subcommands]) => `    '${command}' = @(${subcommands.map((subcommand) => `'${subcommand}'`).join(", ")})`)
        .join("\n");
    return `# loopover-mcp PowerShell completion. Add to your $PROFILE:
#   loopover-mcp completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName loopover-mcp -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${commandList})
  $subcommands = @{
${subcommandEntries}
  }
  $elements = $commandAst.CommandElements
  if ($elements.Count -le 2) {
    $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    return
  }
  $sub = $subcommands[[string]$elements[1].Value]
  if ($sub) {
    $sub | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  }
}`;
}
function printHelp() {
    process.stdout.write(`Usage:
  loopover-mcp --stdio
  loopover-mcp version [--json]
  loopover-mcp tools [--json]
  loopover-mcp tools search <query> [--json]
  loopover-mcp completion bash|zsh|fish|powershell [--json]
  loopover-mcp login [--profile name] [--github-token <token>] [--json]
  loopover-mcp logout [--profile name] [--all] [--json]
  loopover-mcp whoami [--profile name] [--json]
  loopover-mcp config [--profile name] [--json]
  loopover-mcp status [--profile name] [--json]
  loopover-mcp telemetry enable|disable|status [--json]
  loopover-mcp profile list|create|switch|remove [name] [--json]
  loopover-mcp changelog [--json]
  loopover-mcp doctor [--profile name] [--cwd path] [--exit-code] [--json]
  loopover-mcp cache status|list|clear [--json]
  loopover-mcp init-client --print codex|claude|cursor|mcp|vscode [--agent-profile miner-planner|maintainer-triage|repo-owner-intake] [--json]
  loopover-mcp maintain status|queue|approve|reject|pause|resume|set-level|precision|outcome-calibration|onboarding-pack|audit-feed|automation-state|refresh-docs|generate-issue-drafts --repo owner/repo [--json] (see \`loopover-mcp maintain --help\`)
  loopover-mcp decision-pack --login <github-login> [--json]
  loopover-mcp repo-decision --login <github-login> --repo owner/repo [--json]
  loopover-mcp contributor-profile [--login <github-login>] [--json]
  loopover-mcp monitor-open-prs --login <github-login> [--json]
  loopover-mcp pr-outcomes --login <github-login> [--limit N] [--json]
  loopover-mcp explain-review-risk --repo owner/repo --title <text> [--login <github-login>] [--body <text>] [--json]
  loopover-mcp notifications --login <github-login> [--json]
  loopover-mcp notifications-read --login <github-login> [--id <delivery-id>]... [--json]
  loopover-mcp watch <list|add|remove> [owner/repo] [--labels a,b] [--login <github-login>] [--json]
  loopover-mcp analyze-branch --login <github-login> [--repo owner/repo] [--base origin/main] [--branch-eligibility eligible|ineligible|unknown] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--scenario-note "..."] [--validation "passed|npm test|summary"] [--format table] [--json]
  loopover-mcp preflight --login <github-login> [--repo owner/repo] [--base origin/main] [--branch-eligibility eligible|ineligible|unknown] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--validation "passed|npm test|summary"] [--format table] [--json]
  loopover-mcp review-pr --login <github-login> [--repo owner/repo] [--base origin/main] [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]
  loopover-mcp lint-pr-text [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]
  loopover-mcp validate-config --file <path> [--source repo_file|api_record|none] [--json]
  loopover-mcp slop-risk [--description <text>] [--description-file <path>] [--changed-file <path[:additions:deletions]>]... [--test <command>]... [--test-file <path>]... [--json]
  loopover-mcp improvement-potential [--changed-file <path[:additions:deletions]>]... [--test <command>]... [--test-file <path>]... [--patch-coverage-delta <percent>] [--json]
  loopover-mcp issue-slop [--title <text>] [--body <text>] [--body-file <path>] [--json]
  loopover-mcp agent plan --login <github-login> [--repo owner/repo] [--json]
  loopover-mcp agent status <run-id> [--json]
  loopover-mcp agent explain <run-id> [--json]
  loopover-mcp agent packet --login <github-login> [--repo owner/repo] [--base origin/main] [--json]

  Environment:
  LOOPOVER_API_URL
  LOOPOVER_PROFILE
  LOOPOVER_CONFIG_PATH or LOOPOVER_CONFIG_DIR
  LOOPOVER_API_TOKEN, LOOPOVER_MCP_TOKEN, LOOPOVER_TOKEN, or a session from loopover-mcp login
  LOOPOVER_LOGIN or GITHUB_LOGIN (default --login for analyze-branch, preflight, review-pr, decision-pack, repo-decision, monitor-open-prs, pr-outcomes, notifications, notifications-read, and agent plan/packet)
  GITHUB_TOKEN for non-interactive login bootstrap
  GITTENSOR_SCORE_PREVIEW_CMD
  GITTENSOR_ROOT
  GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS
  LOOPOVER_UPLOAD_SOURCE=false
`);
}
function printCacheHelp() {
    process.stdout.write(`Usage:
  loopover-mcp cache status [--json]
  loopover-mcp cache list [--json | --format ndjson]
  loopover-mcp cache clear [--json]

Decision-pack cache entries are local-only stale fallbacks for temporary API/network outages.
Source upload remains disabled.
`);
}
function printAgentHelp() {
    process.stdout.write(`Usage:
  loopover-mcp agent plan --login <github-login> [--repo owner/repo] [--objective "..."] [--json]
  loopover-mcp agent status <run-id> [--json]
  loopover-mcp agent explain <run-id> [--json]
  loopover-mcp agent packet --login <github-login> [--repo owner/repo] [--base origin/main] [--validation "passed|command|summary"] [--json]

The agent is copilot-only: it ranks, explains, and drafts public-safe packets. It does not edit code, open PRs, or post comments from the local MCP wrapper.
Source upload remains disabled.
  `);
}
function printProfileHelp() {
    process.stdout.write(`Usage:
  loopover-mcp profile list [--json | --format ndjson]
  loopover-mcp profile create <name> [--json]
  loopover-mcp profile switch <name> [--json]
  loopover-mcp profile remove <name> [--json]

Use --profile <name> or LOOPOVER_PROFILE to run login, logout, whoami, status, doctor, and MCP API calls with a named local session.
`);
}
function parseOptions(args) {
    const options = {};
    const repeatable = new Set(["label", "issue", "id", "commit", "changedFile", "test", "testFile", "validation", "validationCommand", "validationStatus", "validationSummary", "validationDuration", "scenarioNote"]);
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--json") {
            options.json = true;
            continue;
        }
        if (!arg?.startsWith("--")) {
            // A bare `help` positional means the same thing as `--help` (#6257): the option-consuming commands
            // (decision-pack/repo-decision/review-pr) only check `options.help === true`, so without this a
            // dashless `loopover-mcp decision-pack help` fell through to a confusing "Pass --login…" error instead
            // of printing usage — while the raw-args commands (lint-pr-text etc.) already special-cased it. A `help`
            // consumed as a `--key value` value is skipped via `index += 1` below, so only a STANDALONE `help` here.
            if (arg === "help")
                options.help = true;
            continue;
        }
        // Support the inline `--key=value` form (e.g. `--format=table`) alongside the space-separated
        // `--key value` form; splitting here keeps every existing space-separated option unchanged (#2231).
        const equals = arg.indexOf("=");
        if (equals !== -1) {
            const inlineKey = camel(arg.slice(2, equals));
            const inlineValue = arg.slice(equals + 1);
            if (repeatable.has(inlineKey))
                options[inlineKey] = [...(options[inlineKey] ?? []), inlineValue];
            else
                options[inlineKey] = inlineValue;
            continue;
        }
        const key = camel(arg.slice(2));
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
            options[key] = true;
            continue;
        }
        index += 1;
        if (repeatable.has(key))
            options[key] = [...(options[key] ?? []), value];
        else
            options[key] = value;
    }
    return options;
}
// Shared machine-readable output for list-shaped commands. `--format ndjson` streams one JSON object per
// array element per line (for piping into jq/log processors); `--json` (or `--format json`) keeps the
// existing pretty object. Returns true when it emitted a machine-readable format, so the caller skips the
// human view. Each record ends in "\n" and Node flushes stdout on exit, so piped output is not truncated.
function emitList(options, items, pretty) {
    if (options.format === "ndjson") {
        for (const item of items)
            process.stdout.write(`${JSON.stringify(item)}\n`);
        return true;
    }
    if (options.json || options.format === "json") {
        process.stdout.write(`${JSON.stringify(pretty, null, 2)}\n`);
        return true;
    }
    return false;
}
async function login(options) {
    const profileName = selectedProfileName(options);
    const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
    const session = githubToken ? await apiFetch("/v1/auth/github/session", { method: "POST", body: JSON.stringify({ githubToken }) }, { auth: false }) : await loginWithDeviceFlow();
    const nextConfig = upsertProfile(config, profileName, {
        apiUrl,
        session: {
            token: session.token,
            login: session.login,
            expiresAt: session.expiresAt,
            scopes: session.scopes ?? [],
        },
    });
    saveConfig(nextConfig);
    const payload = { status: "authenticated", profile: profileName, login: session.login, apiUrl, expiresAt: session.expiresAt };
    if (options.json)
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else
        process.stdout.write(`Authenticated profile ${profileName} as ${session.login}. Session expires ${session.expiresAt}.\n`);
}
async function loginWithDeviceFlow() {
    const start = await apiFetch("/v1/auth/github/device/start", { method: "POST", body: "{}" }, { auth: false });
    process.stderr.write(`Open ${start.verificationUri} and enter code ${start.userCode}.\n`);
    const deadline = Date.now() + Number(start.expiresIn ?? 900) * 1000;
    let intervalMs = Math.max(5, Number(start.interval ?? 5)) * 1000;
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        let result;
        try {
            result = await apiFetch("/v1/auth/github/device/poll", { method: "POST", body: JSON.stringify({ deviceCode: start.deviceCode }) }, { auth: false });
        }
        catch (error) {
            // A transient 429 from our own rate limiter (#6792) is not a GitHub-reported device-flow status --
            // back off using the server's Retry-After and keep polling within the deadline, the same posture
            // already applied to GitHub's own "slow_down" status below, instead of aborting the whole attempt.
            if (error?.status === 429) {
                const retryAfterSeconds = Number(/retry-after=(\d+)s/.exec(error.message)?.[1]);
                intervalMs = Math.max(intervalMs, (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 5) * 1000);
                continue;
            }
            throw error;
        }
        if (result.token)
            return result;
        if (result.status === "slow_down")
            intervalMs += 5000;
        if (result.status && result.status !== "authorization_pending" && result.status !== "slow_down")
            throw new Error(`GitHub OAuth failed: ${result.status}`);
    }
    throw new Error("GitHub OAuth device flow expired.");
}
async function logout(options) {
    const profileName = selectedProfileName(options);
    const all = options.all === true;
    const envToken = getEnvApiToken();
    const tokens = all
        ? [envToken, ...profileSessions(config).map((entry) => entry.session.token)].filter(Boolean)
        : [envToken ?? configuredProfileToken(profileName)].filter(Boolean);
    const remote = [];
    for (const token of [...new Set(tokens)]) {
        try {
            remote.push(await apiFetch("/v1/auth/logout", { method: "POST", body: "{}" }, { token }));
        }
        catch (error) {
            remote.push({ error: sanitizeDiagnosticText(error instanceof Error ? error.message : "logout_failed") });
        }
    }
    const nextConfig = all ? clearAllProfileSessions(config) : clearProfileSession(config, profileName);
    if (hasPersistedConfigState(nextConfig))
        saveConfig(nextConfig);
    else if (existsSync(configPath))
        rmSync(configPath, { force: true });
    const decisionPackCache = clearDecisionPackCache();
    const payload = { status: "logged_out", profile: all ? "all" : profileName, apiUrl, remote: remote.length > 0 ? remote : null, decisionPackCache };
    if (options.json)
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else
        process.stdout.write(all ? "Logged out all profiles.\n" : `Logged out profile ${profileName}.\n`);
}
// Local MCP usage telemetry is opt-in and defaults OFF (#6239, per #6228's privacy decision): a
// self-hoster must explicitly enable it before anything is measured. The opt-in is a single top-level
// `telemetryEnabled` flag persisted in the same config file `login` uses, so the choice survives across
// CLI invocations; `status`, `doctor`, and `config` all report the current state.
function telemetryCommand(args) {
    const subcommand = args[0] ?? "status";
    const options = parseOptions(args.slice(1));
    if (subcommand === "--help" || subcommand === "help")
        return printTelemetryHelp();
    if (subcommand === "enable" || subcommand === "disable") {
        const enabled = subcommand === "enable";
        const nextConfig = setTelemetryEnabled(config, enabled);
        // Mirror login/logout persistence: keep the file when any durable state remains, otherwise remove it
        // so disabling telemetry on an otherwise-empty config leaves no stray file behind.
        if (hasPersistedConfigState(nextConfig))
            saveConfig(nextConfig);
        else if (existsSync(configPath))
            rmSync(configPath, { force: true });
        const payload = { status: enabled ? "telemetry_enabled" : "telemetry_disabled", telemetry: telemetryState(nextConfig) };
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(enabled ? "Local MCP usage telemetry enabled.\n" : "Local MCP usage telemetry disabled.\n");
        return;
    }
    if (subcommand === "status") {
        const telemetry = telemetryState(config);
        if (options.json)
            process.stdout.write(`${JSON.stringify({ telemetry }, null, 2)}\n`);
        else
            process.stdout.write(`Telemetry: ${telemetry.enabled ? "enabled (opt-in)" : "disabled (default)"}\n`);
        return;
    }
    throw new Error(`Unknown telemetry command: ${subcommand}. Use enable | disable | status.`);
}
function printTelemetryHelp() {
    process.stdout.write(`Usage:
  loopover-mcp telemetry status [--json]
  loopover-mcp telemetry enable [--json]
  loopover-mcp telemetry disable [--json]

Local MCP usage telemetry is opt-in and defaults OFF. Enabling it persists a top-level telemetryEnabled
flag in the same config file \`loopover-mcp login\` uses, so the choice survives across CLI invocations.
\`status\`, \`doctor\`, and \`config\` report the current opt-in state.
`);
}
function profileCommand(args) {
    const subcommand = args[0] ?? "list";
    const options = parseOptions(args.slice(1));
    if (subcommand === "--help" || subcommand === "help")
        return printProfileHelp();
    if (subcommand === "list" || subcommand === "ls") {
        const profiles = profileList(config);
        const payload = { activeProfile: activeProfileName, profiles };
        if (emitList(options, profiles, payload))
            return;
        process.stdout.write(`Active profile: ${activeProfileName}\n`);
        for (const profile of profiles) {
            process.stdout.write(`- ${profile.name}${profile.active ? " (active)" : ""}: ${profile.login ?? "not authenticated"}\n`);
        }
        return;
    }
    const rawName = args[1] && !args[1].startsWith("--") ? args[1] : options.name ?? options.profile;
    if (!rawName)
        throw new Error(`Usage: loopover-mcp profile ${subcommand} <name>`);
    const profileName = normalizeProfileName(rawName);
    if (subcommand === "create") {
        const nextConfig = ensureProfile(config, profileName, { activate: true });
        saveConfig(nextConfig);
        const payload = { status: "created", activeProfile: profileName, profile: profilePublicState(profileName, nextConfig) };
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(`Created and selected profile ${profileName}.\n`);
        return;
    }
    if (subcommand === "switch" || subcommand === "use") {
        if (!config.profiles?.[profileName])
            throw new Error(`Profile ${profileName} does not exist. Run \`loopover-mcp profile create ${profileName}\` or \`loopover-mcp login --profile ${profileName}\`.`);
        const nextConfig = setActiveProfile(config, profileName);
        saveConfig(nextConfig);
        const payload = { status: "switched", activeProfile: profileName, profile: profilePublicState(profileName, nextConfig) };
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(`Selected profile ${profileName}.\n`);
        return;
    }
    if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
        const nextConfig = removeProfile(config, profileName);
        if (hasPersistedConfigState(nextConfig))
            saveConfig(nextConfig);
        else if (existsSync(configPath))
            rmSync(configPath, { force: true });
        const payload = { status: "removed", removedProfile: profileName, activeProfile: nextConfig.activeProfile ?? defaultProfileName };
        if (options.json)
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        else
            process.stdout.write(`Removed profile ${profileName}.\n`);
        return;
    }
    throw new Error(`Unknown profile command: ${subcommand}`);
}
async function whoami(options) {
    const payload = { ...(await apiGet("/v1/auth/session")), profile: activeProfileName };
    if (options.json)
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else
        process.stdout.write(activeProfileName === defaultProfileName ? `${payload.login}\n` : `${payload.login} (profile ${activeProfileName})\n`);
}
async function status(options) {
    let auth = { status: getApiToken() ? "token_configured" : "unauthenticated" };
    let health = null;
    if (getApiToken()) {
        try {
            auth = await apiGet("/v1/auth/session");
        }
        catch (error) {
            auth = { status: "token_configured", session: "unverified", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "status_failed") };
        }
    }
    try {
        health = await apiFetch("/health", { method: "GET" }, { auth: false, timeoutMs: 5000 });
    }
    catch (error) {
        health = { status: "unreachable", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "health_check_failed") };
    }
    const compatibility = await inspectApiCompatibility(health);
    const pkg = await inspectInstallVersion(compatibilityLatestRecommendedVersion(compatibility.report) ?? compatibilityLatestRecommendedVersion(health));
    const apiCompatibility = compatibility.evaluation;
    const decisionPackCache = inspectDecisionPackCache();
    const payload = {
        apiUrl,
        package: pkg,
        apiCompatibility,
        compatibility: compatibility.report,
        api: health,
        auth,
        profile: profilePublicState(activeProfileName),
        config: { configured: existsSync(configPath), activeProfile: activeProfileName, profileCount: profileList(config).length },
        decisionPackCache,
        sourceUploadDefault: false,
        sourceUploadSupported: false,
        telemetry: telemetryState(),
    };
    if (options.json)
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
        process.stdout.write(`${packageName}: ${packageVersion}${pkg.latestVersion ? ` (latest ${pkg.latestVersion})` : ""}\n`);
        process.stdout.write(`API: ${apiUrl}\n`);
        process.stdout.write(`Profile: ${activeProfileName}\n`);
        process.stdout.write(`API health: ${health?.status ?? "unknown"}\n`);
        process.stdout.write(`Auth: ${auth.status}${auth.login ? ` (${auth.login})` : ""}\n`);
        process.stdout.write(`Decision-pack cache: ${decisionPackCache.entries} entr${decisionPackCache.entries === 1 ? "y" : "ies"}\n`);
        process.stdout.write("Source upload: disabled\n");
        process.stdout.write(`Telemetry: ${payload.telemetry.enabled ? "enabled (opt-in)" : "disabled (default)"}\n`);
        if (pkg.state === "stale") {
            process.stdout.write(`Update available: ${packageVersion} -> ${pkg.latestVersion}. Upgrade with:\n  ${pkg.upgradeCommand}\n`);
            process.stdout.write(`Or run without installing:\n  ${pkg.npxFallback}\n`);
        }
        else if (pkg.state === "unavailable") {
            process.stdout.write("Version check: npm registry was unavailable; skipping update check.\n");
        }
        if (apiCompatibility.status === "incompatible") {
            process.stdout.write(`API requires at least ${packageName}@${apiCompatibility.minVersion}. Upgrade with:\n  ${apiCompatibility.upgradeCommand}\n`);
        }
        else if (apiCompatibility.status === "compatible") {
            process.stdout.write(`API compatibility: compatible (minimum ${packageName}@${apiCompatibility.minVersion}).\n`);
        }
        else if (apiCompatibility.status === "unavailable") {
            process.stdout.write(`API compatibility: unavailable (${apiCompatibility.reason ?? "unknown"}).\n`);
        }
        else if (apiCompatibility.status === "unknown") {
            // Mirror doctor()'s unknown arm (#6263): an unparseable minimum version must still surface in human output.
            process.stdout.write(`API reported an unsupported minimum client version (${apiCompatibility.minVersion}).\n`);
        }
    }
}
async function changelog(options) {
    const text = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n\nNo packaged changelog was found.\n";
    const payload = {
        package: {
            name: packageName,
            version: packageVersion,
        },
        changelog: text,
    };
    if (options.json)
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}
async function doctor(options) {
    const checks = [];
    const add = (name, statusValue, detail, remediation) => checks.push(stripUndefined({
        name,
        status: statusValue,
        detail: sanitizeDiagnosticText(detail, [options.cwd]),
        remediation: sanitizeDiagnosticText(remediation, [options.cwd]),
    }));
    let authLogin = options.login ?? activeProfile.session?.login;
    let repoFullName = typeof options.repo === "string" ? options.repo : undefined;
    let health = null;
    try {
        health = await apiFetch("/health", { method: "GET" }, { auth: false });
        add("api_health", health.status === "ok" ? "pass" : "warn", `API responded from ${apiUrl}.`);
    }
    catch (error) {
        health = { status: "unreachable" };
        add("api_health", "fail", error instanceof Error ? error.message : "health_check_failed", "Check LOOPOVER_API_URL or network access.");
    }
    const compatibility = await inspectApiCompatibility(health);
    const pkg = await inspectInstallVersion(compatibilityLatestRecommendedVersion(compatibility.report) ?? compatibilityLatestRecommendedVersion(health));
    if (pkg.state === "stale") {
        add("version", "warn", `Installed ${packageVersion} is behind npm latest ${pkg.latestVersion}.`, `${pkg.upgradeCommand} (no-install fallback: ${pkg.npxFallback})`);
    }
    else if (pkg.state === "unavailable") {
        add("version", "warn", "Could not reach the npm registry to check for updates.", `Retry when online, or run the no-install fallback: ${npxFallbackCommand}`);
    }
    else if (pkg.state === "unknown") {
        add("version", "warn", `Could not compare local ${packageVersion} against npm latest ${pkg.latestVersion ?? "unknown"}.`);
    }
    else if (pkg.state === "ahead") {
        add("version", "pass", `Installed ${packageVersion} is ahead of npm latest ${pkg.latestVersion}.`);
    }
    else if (pkg.state === "skipped") {
        add("version", "pass", "npm version check was skipped (LOOPOVER_SKIP_NPM_VERSION_CHECK).");
    }
    else {
        add("version", "pass", `Installed ${packageVersion} matches npm latest ${pkg.latestVersion}.`);
    }
    const apiCompatibility = compatibility.evaluation;
    if (apiCompatibility.status === "incompatible") {
        add("api_compatibility", "fail", `API requires at least ${packageName}@${apiCompatibility.minVersion}; local is ${packageVersion}.`, apiCompatibility.upgradeCommand);
    }
    else if (apiCompatibility.status === "compatible") {
        add("api_compatibility", "pass", `Local ${packageVersion} meets the API minimum ${apiCompatibility.minVersion}.`);
    }
    else if (apiCompatibility.reason === "api_unreachable") {
        add("api_compatibility", "warn", "API compatibility check was unavailable because API health was unreachable.");
    }
    else if (apiCompatibility.reason === "compatibility_endpoint_unavailable") {
        add("api_compatibility", "warn", "API compatibility endpoint was unavailable; compatibility could not be confirmed.");
    }
    else if (apiCompatibility.status === "unknown") {
        add("api_compatibility", "warn", `API reported an unsupported minimum client version (${apiCompatibility.minVersion}).`);
    }
    else {
        add("api_compatibility", "pass", "API did not report a minimum client version; compatibility check skipped.");
    }
    const token = getApiToken();
    if (!token) {
        add("auth", "fail", `No LoopOver API/session token is configured for profile ${activeProfileName}.`, `Run \`loopover-mcp login --profile ${activeProfileName}\`.`);
    }
    else {
        try {
            const session = await apiGet("/v1/auth/session");
            authLogin = session.login ?? authLogin;
            add("auth", "pass", `Profile ${activeProfileName} authenticated as ${session.login}; session expires ${session.expiresAt}.`);
        }
        catch (error) {
            add("auth", "warn", `A token is configured for profile ${activeProfileName} but no user session was verified: ${error instanceof Error ? error.message : "session_check_failed"}.`, "If this is a static beta token, this can be expected. Otherwise run `loopover-mcp login`.");
        }
    }
    if (/^(1|true|yes)$/i.test(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false")) {
        add("source_upload", "fail", "LOOPOVER_UPLOAD_SOURCE is enabled.", "Unset LOOPOVER_UPLOAD_SOURCE. Source upload is unsupported in v1.");
    }
    else {
        add("source_upload", "pass", "Source upload is disabled and unsupported in v1.");
    }
    // Either telemetry stance is a valid, deliberate choice, so this is always a pass — it just makes the
    // current opt-in visible (and points at the toggle) rather than gating the checklist.
    const telemetry = telemetryState();
    add("telemetry", "pass", telemetry.enabled ? "Local MCP usage telemetry is enabled (opt-in)." : "Local MCP usage telemetry is disabled (default).", telemetry.enabled ? "Run `loopover-mcp telemetry disable` to opt back out." : "Run `loopover-mcp telemetry enable` to opt in.");
    const decisionPackCache = inspectDecisionPackCache();
    add("decision_pack_cache", "pass", `Local stale fallback cache has ${decisionPackCache.entries} entr${decisionPackCache.entries === 1 ? "y" : "ies"} and is bounded at ${decisionPackCache.maxEntries}.`, "Run `loopover-mcp cache clear` to remove local stale fallback data.");
    try {
        const metadata = collectLocalBranchMetadata({
            cwd: options.cwd ?? process.cwd(),
            baseRef: options.base,
            repoFullName: options.repo,
            login: options.login ?? activeProfile.session?.login ?? "local",
        });
        repoFullName = metadata.repoFullName ?? repoFullName;
        add("git_metadata", "pass", `${metadata.repoFullName} on ${metadata.branchName}; ${metadata.changedFiles.length} changed file(s).`);
    }
    catch (error) {
        add("git_metadata", "warn", error instanceof Error ? error.message : "git_metadata_failed", "Run from a git repo or pass --repo owner/repo.");
    }
    const commandPath = findExecutable("loopover-mcp");
    if (commandPath)
        add("client_path", "pass", "loopover-mcp is visible on PATH.");
    else
        add("client_path", "warn", "loopover-mcp was not found on PATH.", "Use an absolute command path in your MCP client config.");
    const scorerCommand = resolveScorePreviewCommand();
    if (!scorerCommand) {
        add("local_scorer", "warn", "GITTENSOR_SCORE_PREVIEW_CMD is not configured; branch analysis will fall back to metadata-only scoring.", `Example: export GITTENSOR_SCORE_PREVIEW_CMD="${referenceScorePreviewExample("metadata")}"`);
    }
    else {
        const probe = probeLocalScorer(scorerCommand);
        if (probe.ok) {
            add("local_scorer", "pass", `Configured scorer responded in ${probe.durationMs ?? 0}ms.`);
        }
        else {
            const remediation = setupGuidanceForLocalScorer(probe).slice(1).join(" ");
            add("local_scorer", "warn", `Configured scorer failed (${probe.code ?? "scorer_failed"}): ${probe.reason}`, remediation || "Run loopover-mcp doctor --json for structured diagnostics.");
        }
    }
    if (process.env.GITTENSOR_ROOT) {
        add("gittensor_root", "pass", "GITTENSOR_ROOT is configured.");
    }
    else if (scorerCommand?.includes("gittensor-score-preview.py")) {
        add("gittensor_root", "warn", "Python gittensor scorer is configured but GITTENSOR_ROOT is unset.", "Set GITTENSOR_ROOT to a local entrius/gittensor checkout.");
    }
    const statusValue = doctorStatus(checks);
    const checklist = buildDoctorChecklist(checks, {
        status: statusValue,
        profileName: activeProfileName,
        login: authLogin,
        repoFullName,
    });
    const nextCommand = checklist.find((group) => group.id === "next_command")?.nextCommand;
    const payload = {
        status: statusValue,
        apiUrl,
        profile: profilePublicState(activeProfileName),
        config: { configured: existsSync(configPath), activeProfile: activeProfileName, profileCount: profileList(config).length },
        decisionPackCache,
        sourceUploadSupported: false,
        telemetry,
        checklist,
        nextCommand,
        checks,
    };
    if (options.json)
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
        process.stdout.write(`LoopOver doctor: ${payload.status}\n`);
        process.stdout.write(`Profile: ${activeProfileName}\n`);
        for (const group of checklist) {
            process.stdout.write(`\n${group.title}: ${group.status}\n`);
            if (group.id === "next_command") {
                process.stdout.write(`- ${group.detail}\n`);
                if (group.nextCommand?.command)
                    process.stdout.write(`  ${group.nextCommand.command}\n`);
                continue;
            }
            // #6261: a check's `detail` is the one field here that carries text this CLI didn't write -- an API error
            // message, an npm-registry error, a compatibility report's `error`. Some of those already pass through
            // sanitizeDiagnosticText, but that redacts tokens and local paths; it is indifferent to escape sequences. So
            // the terminal pass belongs here at the print boundary, where it covers every check source at once.
            for (const check of group.checks ?? []) {
                process.stdout.write(`- ${sanitizePlainTextTerminalOutput(check.status)}: ${sanitizePlainTextTerminalOutput(check.name)} - ${sanitizePlainTextTerminalOutput(check.detail)}\n`);
                if (check.remediation)
                    process.stdout.write(`  ${sanitizePlainTextTerminalOutput(check.remediation)}\n`);
            }
        }
    }
    // Opt-in: let `doctor` gate CI/pre-commit by exiting non-zero when a check fails. The default
    // stays exit 0 so existing scripts that ignore the exit code keep working.
    return options.exitCode && payload.status === "needs_attention" ? 1 : 0;
}
function doctorStatus(checks) {
    if (checks.some((check) => check.status === "fail"))
        return "needs_attention";
    if (checks.some((check) => check.status === "warn"))
        return "warnings";
    return "ok";
}
function buildDoctorChecklist(checks, context) {
    const byName = new Map(checks.map((check) => [check.name, check]));
    const groups = doctorChecklistGroups().map((group) => {
        const groupChecks = group.checks.map((name) => byName.get(name)).filter(Boolean);
        return stripUndefined({
            id: group.id,
            title: group.title,
            status: checklistStatus(groupChecks),
            checks: groupChecks,
        });
    });
    const nextCommand = doctorNextCommand(byName, context);
    return [
        ...groups,
        stripUndefined({
            id: "next_command",
            title: "Next command",
            status: context.status === "needs_attention" ? "fail" : context.status === "warnings" ? "warn" : "pass",
            detail: nextCommand.reason,
            nextCommand,
        }),
    ];
}
function doctorChecklistGroups() {
    return [
        { id: "auth", title: "Auth", checks: ["auth"] },
        { id: "api_compatibility", title: "API compatibility", checks: ["api_health", "version", "api_compatibility"] },
        { id: "local_repo_readiness", title: "Local repo readiness", checks: ["git_metadata", "client_path"] },
        { id: "scorer_availability", title: "Scorer availability", checks: ["local_scorer", "gittensor_root"] },
        { id: "output_safety", title: "Output safety", checks: ["source_upload", "decision_pack_cache", "telemetry"] },
    ];
}
function checklistStatus(checks) {
    if (checks.some((check) => check.status === "fail"))
        return "fail";
    if (checks.some((check) => check.status === "warn"))
        return "warn";
    return "pass";
}
function doctorNextCommand(byName, context) {
    const sourceUpload = byName.get("source_upload");
    if (sourceUpload?.status === "fail") {
        return {
            command: "unset LOOPOVER_UPLOAD_SOURCE",
            reason: "Disable source upload first; the local MCP wrapper only sends metadata.",
        };
    }
    const apiCompatibility = byName.get("api_compatibility");
    if (apiCompatibility?.status === "fail") {
        return {
            command: apiCompatibility.remediation ?? upgradeCommand,
            reason: "Upgrade the MCP package before relying on API-backed commands.",
        };
    }
    const auth = byName.get("auth");
    if (auth?.status === "fail") {
        return {
            command: `loopover-mcp login --profile ${shellArg(context.profileName ?? "default")}`,
            reason: "Authenticate the active profile so doctor, plan, preflight, and packet commands can call the API.",
        };
    }
    const apiHealth = byName.get("api_health");
    if (apiHealth?.status === "fail") {
        return {
            command: "loopover-mcp status --json",
            reason: "Check API reachability before running planner or preflight commands.",
        };
    }
    const version = byName.get("version");
    if (version?.status === "warn" && version.remediation?.includes("npm install")) {
        return {
            command: upgradeCommand,
            reason: "Update the MCP package so local behavior matches the current API.",
        };
    }
    const gitMetadata = byName.get("git_metadata");
    if (gitMetadata?.status === "warn") {
        return {
            command: "loopover-mcp doctor --repo owner/repo --json",
            reason: "Run doctor from a git checkout or pass the repository explicitly.",
        };
    }
    const localScorer = byName.get("local_scorer");
    if (localScorer?.status === "warn" && localScorer.remediation) {
        const scorerSetupCommand = localScorer.remediation.startsWith("Example: ") ? localScorer.remediation.replace(/^Example:\s*/, "") : "loopover-mcp doctor --json";
        return {
            command: scorerSetupCommand,
            reason: "Configure the optional local scorer for richer private branch analysis.",
        };
    }
    return {
        command: `loopover-mcp review-pr --login ${shellArg(context.login ?? "<github-login>")} --repo ${shellArg(context.repoFullName ?? "owner/repo")} --json`,
        reason: "Run the composed pre-PR review (preflight + slop-risk + PR-text lint) next; source upload remains disabled.",
    };
}
function shellArg(value) {
    const text = String(value ?? "");
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text))
        return text;
    return `'${text.replace(/'/g, `'"'"'`)}'`;
}
function initClient(options) {
    const client = String(options.print ?? options.client ?? "").toLowerCase();
    if (!client)
        throw new Error("Pass --print codex, --print claude, --print cursor, --print mcp, or --print vscode.");
    const command = options.command ?? "loopover-mcp";
    const snippet = clientSnippet(client, command);
    const agentProfile = resolveAgentProfile(options.agentProfile);
    const payload = {
        client,
        command,
        args: ["--stdio"],
        snippet,
        agentProfile,
        notes: [
            "Run `loopover-mcp login` before starting the MCP client.",
            "Use an absolute command path if the client does not inherit your shell PATH.",
            "This command prints config only; it does not edit client files.",
            ...(agentProfile
                ? [
                    agentProfile.drivingLoop
                        ? `Use the ${agentProfile.title} profile instructions as the agent system/developer prompt. Every GitHub write runs LOCALLY via your harness with your own credentials, only after the LoopOver gate + anti-slop check pass — LoopOver never performs the write.`
                        : `Use the ${agentProfile.title} profile instructions as the agent system/developer prompt; keep all GitHub writes human-approved.`,
                ]
                : []),
        ],
    };
    if (options.json)
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else
        process.stdout.write(agentProfile ? `${snippet}\n\n${formatAgentProfile(agentProfile)}\n` : `${snippet}\n`);
}
function resolveAgentProfile(profileId) {
    if (!profileId)
        return null;
    const id = String(profileId).trim().toLowerCase();
    if (!Object.hasOwn(AGENT_PROFILES, id))
        throw new Error(`Unsupported agent profile: ${profileId}. Use ${AGENT_PROFILE_IDS.join(", ")}.`);
    return AGENT_PROFILES[id];
}
function formatAgentProfile(profile) {
    return [
        `# LoopOver agent profile: ${profile.title}`,
        `Audience: ${profile.audience}`,
        `Purpose: ${profile.purpose}`,
        "",
        "Recommended MCP prompts:",
        ...profile.recommendedPrompts.map((name) => `- ${name}`),
        "",
        "Recommended MCP tools:",
        ...profile.recommendedTools.map((name) => `- ${name}`),
        ...(profile.drivingLoop ? ["", "Driving loop (plan → implement → push, gate-throttled):", ...profile.drivingLoop.map((step, index) => `${index + 1}. ${step}`)] : []),
        "",
        "Safety boundaries:",
        ...profile.boundaries.map((boundary) => `- ${boundary}`),
        "",
        `When not to use: ${profile.whenNotToUse}`,
    ].join("\n");
}
function getApiToken() {
    return getEnvApiToken() ?? configuredProfileToken(activeProfileName);
}
function getEnvApiToken() {
    // Precedence matches the documented order (README, printHelp, the missing-auth error, and the
    // sanitizer list): the MCP-specific token wins over the generic LOOPOVER_TOKEN, which previously
    // took priority here and contradicted every other reference to this order.
    return process.env.LOOPOVER_API_TOKEN ?? process.env.LOOPOVER_MCP_TOKEN ?? process.env.LOOPOVER_TOKEN;
}
function selectedProfileName(options = {}) {
    return normalizeProfileName(options.profile ?? activeProfileName);
}
function configuredProfileToken(profileName, currentConfig = config) {
    return currentConfig.profiles?.[profileName]?.session?.token;
}
function profileSessions(currentConfig = config) {
    return Object.entries(currentConfig.profiles ?? {})
        .flatMap(([name, profile]) => (profile?.session?.token ? [{ name, session: profile.session }] : []));
}
function profilePublicState(profileName, currentConfig = config) {
    const profile = currentConfig.profiles?.[profileName];
    const hasEnvToken = Boolean(getEnvApiToken());
    return {
        name: profileName,
        active: profileName === (currentConfig.activeProfile ?? defaultProfileName),
        configured: Boolean(profile),
        authenticated: Boolean(profile?.session?.token),
        login: profile?.session?.login ?? null,
        expiresAt: profile?.session?.expiresAt ?? null,
        tokenSource: hasEnvToken ? "environment" : profile?.session?.token ? "profile" : "none",
        apiUrl: profile?.apiUrl ?? currentConfig.apiUrl ?? null,
    };
}
function profileList(currentConfig = config) {
    const names = new Set([defaultProfileName, currentConfig.activeProfile ?? defaultProfileName, ...Object.keys(currentConfig.profiles ?? {})]);
    return [...names].sort((left, right) => (left === currentConfig.activeProfile ? -1 : right === currentConfig.activeProfile ? 1 : left.localeCompare(right))).map((name) => profilePublicState(name, currentConfig));
}
function selectProfileName(currentConfig, requestedName) {
    const requested = requestedName ? normalizeProfileName(requestedName) : undefined;
    if (requested)
        return requested;
    const configured = currentConfig?.activeProfile ? normalizeProfileName(currentConfig.activeProfile) : defaultProfileName;
    if (currentConfig?.profiles?.[configured])
        return configured;
    return currentConfig?.profiles?.[defaultProfileName] || configured === defaultProfileName ? defaultProfileName : configured;
}
function resolvedApiUrlSource() {
    if (process.env.LOOPOVER_API_URL)
        return "environment";
    const profileApiUrl = typeof activeProfile.apiUrl === "string" ? activeProfile.apiUrl.replace(/\/+$/, "") : undefined;
    if (profileApiUrl && !legacyDefaultApiUrls.has(profileApiUrl))
        return "profile";
    const globalApiUrl = typeof config.apiUrl === "string" ? config.apiUrl.replace(/\/+$/, "") : undefined;
    if (globalApiUrl && !legacyDefaultApiUrls.has(globalApiUrl))
        return "config";
    return "default";
}
function resolvedConfigPathSource() {
    if (process.env.LOOPOVER_CONFIG_PATH)
        return "LOOPOVER_CONFIG_PATH";
    if (process.env.LOOPOVER_CONFIG_DIR)
        return "LOOPOVER_CONFIG_DIR";
    if (process.env.XDG_CONFIG_HOME)
        return "XDG_CONFIG_HOME";
    return "default";
}
function resolvedTokenSource() {
    if (getEnvApiToken())
        return "environment";
    if (configuredProfileToken(activeProfileName))
        return "profile";
    return "none";
}
function sourceUploadState() {
    const enabled = /^(1|true|yes)$/i.test(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false");
    return {
        default: false,
        enabled,
        source: enabled ? "LOOPOVER_UPLOAD_SOURCE" : "default",
        supported: false,
    };
}
// Resolve the current local telemetry opt-in from persisted config. The flag is top-level (not
// per-profile) and defaults to disabled when absent, so an unconfigured install reports opt-out.
function telemetryState(currentConfig = config) {
    return {
        enabled: currentConfig.telemetryEnabled === true,
        default: false,
    };
}
// Report the resolved effective configuration and where each value came from, without leaking
// local absolute paths or token values. Distinct from `status` (health/version), `doctor`
// (diagnostic checks), and `whoami` (session identity): this answers "what config is in effect
// and which source supplied it?".
function configCommand(options) {
    const payload = {
        apiUrl,
        apiUrlSource: resolvedApiUrlSource(),
        activeProfile: activeProfileName,
        profileCount: profileList(config).length,
        configured: existsSync(configPath),
        configPathSource: resolvedConfigPathSource(),
        cacheDirSource: process.env.LOOPOVER_CACHE_DIR ? "LOOPOVER_CACHE_DIR" : "default",
        tokenConfigured: Boolean(getApiToken()),
        tokenSource: resolvedTokenSource(),
        sourceUpload: sourceUploadState(),
        telemetry: telemetryState(),
        profile: profilePublicState(activeProfileName),
    };
    if (options.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    process.stdout.write(`API URL: ${payload.apiUrl} (${payload.apiUrlSource})\n`);
    process.stdout.write(`Active profile: ${payload.activeProfile} (${payload.profileCount} configured)\n`);
    process.stdout.write(`Config file: ${payload.configured ? "present" : "absent"} (location: ${payload.configPathSource})\n`);
    process.stdout.write(`Cache dir: ${payload.cacheDirSource}\n`);
    process.stdout.write(`Token: ${payload.tokenConfigured ? `configured (${payload.tokenSource})` : "not configured"}\n`);
    process.stdout.write(payload.sourceUpload.enabled
        ? `Source upload: enabled via ${payload.sourceUpload.source} (unsupported; unset LOOPOVER_UPLOAD_SOURCE)\n`
        : "Source upload: disabled (unsupported)\n");
    process.stdout.write(`Telemetry: ${payload.telemetry.enabled ? "enabled (opt-in)" : "disabled (default)"}\n`);
}
function normalizeProfileName(value) {
    const name = String(value ?? defaultProfileName).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name))
        throw new Error("Profile names must be 1-64 characters and use letters, numbers, dots, dashes, or underscores.");
    return name;
}
function cliOptionValue(args, optionName) {
    const dashed = `--${optionName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === dashed) {
            const next = args[index + 1];
            return next && !next.startsWith("--") ? next : undefined;
        }
        if (value?.startsWith(`${dashed}=`))
            return value.slice(dashed.length + 1);
    }
    return undefined;
}
function upsertProfile(currentConfig, profileName, patch) {
    const now = new Date().toISOString();
    const existing = currentConfig.profiles?.[profileName] ?? {};
    const profiles = {
        ...(currentConfig.profiles ?? {}),
        [profileName]: stripUndefined({
            ...existing,
            apiUrl: patch.apiUrl ?? existing.apiUrl,
            session: patch.session ?? existing.session,
            createdAt: existing.createdAt ?? now,
            updatedAt: now,
        }),
    };
    return normalizeConfig({ ...currentConfig, apiUrl: patch.apiUrl ?? currentConfig.apiUrl, activeProfile: profileName, profiles });
}
function ensureProfile(currentConfig, profileName, options = {}) {
    const existing = currentConfig.profiles?.[profileName];
    const nextConfig = existing ? currentConfig : upsertProfile(currentConfig, profileName, {});
    return options.activate ? setActiveProfile(nextConfig, profileName) : nextConfig;
}
function setActiveProfile(currentConfig, profileName) {
    return normalizeConfig({ ...currentConfig, activeProfile: profileName });
}
function clearProfileSession(currentConfig, profileName) {
    const existing = currentConfig.profiles?.[profileName];
    if (!existing)
        return currentConfig;
    const profiles = {
        ...(currentConfig.profiles ?? {}),
        [profileName]: stripUndefined({ ...existing, session: undefined, updatedAt: new Date().toISOString() }),
    };
    return normalizeConfig({ ...currentConfig, profiles });
}
function clearAllProfileSessions(currentConfig) {
    const profiles = Object.fromEntries(Object.entries(currentConfig.profiles ?? {}).map(([name, profile]) => [name, stripUndefined({ ...profile, session: undefined, updatedAt: new Date().toISOString() })]));
    return normalizeConfig({ ...currentConfig, profiles });
}
function removeProfile(currentConfig, profileName) {
    const profiles = { ...(currentConfig.profiles ?? {}) };
    delete profiles[profileName];
    const remaining = Object.keys(profiles);
    const activeProfile = currentConfig.activeProfile === profileName ? (profiles[defaultProfileName] ? defaultProfileName : remaining[0] ?? defaultProfileName) : currentConfig.activeProfile;
    const session = profileName === defaultProfileName ? undefined : currentConfig.session;
    return normalizeConfig({ ...currentConfig, activeProfile, profiles, session });
}
function setTelemetryEnabled(currentConfig, enabled) {
    // normalizeConfig coerces this to a strict boolean and strips it when not exactly `true`, so disabling
    // removes the key entirely (default = absent) rather than persisting `telemetryEnabled: false`.
    return normalizeConfig({ ...currentConfig, telemetryEnabled: enabled === true ? true : undefined });
}
function hasPersistedConfigState(currentConfig) {
    return Boolean(currentConfig.apiUrl || currentConfig.telemetryEnabled === true || Object.keys(currentConfig.profiles ?? {}).length > 0);
}
function validationFromOptions(options) {
    const direct = (options.validation ?? []).map(parseValidationEntry);
    const commands = options.validationCommand ?? [];
    const statuses = options.validationStatus ?? [];
    const summaries = options.validationSummary ?? [];
    const durations = options.validationDuration ?? [];
    const expanded = commands.map((command, index) => validationEntry({
        command,
        statusText: statuses[index],
        summaryText: summaries[index],
        durationText: durations[index],
    }));
    return [...direct, ...expanded].filter((entry) => typeof entry.command === "string" && entry.command.length > 0);
}
function parseValidationEntry(entry) {
    const parts = String(entry ?? "").split("|").map((part) => part.trim());
    const explicitStatus = normalizeValidationStatus(parts[0]);
    const command = explicitStatus ? parts[1] : parts[0];
    const rest = explicitStatus ? parts.slice(2) : parts.slice(1);
    const inferredStatusText = !explicitStatus && isValidationStatusLike(rest[0]) ? rest[0] : undefined;
    const detailParts = inferredStatusText ? rest.slice(1) : rest;
    const durationMs = parseDurationMs(detailParts[0]);
    const summaryParts = durationMs !== undefined ? detailParts.slice(1) : detailParts;
    return validationEntry({
        command,
        statusText: explicitStatus ?? inferredStatusText,
        summaryText: summaryParts.join("|"),
        durationMs,
    });
}
function validationEntry({ command, statusText, summaryText, durationText, durationMs }) {
    const statusSource = nonEmptyString(statusText);
    const summarySource = statusSource ? undefined : nonEmptyString(summaryText);
    const exitCode = inferValidationExitCode(statusSource, { allowBareCode: true, allowGenericStatus: true }) ??
        inferValidationExitCode(summarySource, { allowBareCode: false, allowGenericStatus: false });
    const status = normalizeValidationStatus(statusSource) ??
        normalizeSummaryValidationStatus(summarySource) ??
        (exitCode !== undefined ? (exitCode === 0 ? "passed" : "failed") : "not_run");
    return stripUndefined({
        command: sanitizeValidationText(command, 160),
        status,
        summary: sanitizeValidationText(summaryText),
        durationMs: durationMs ?? parseDurationMs(durationText),
        exitCode,
    });
}
function optionalInteger(value) {
    if (value === undefined || value === true)
        return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
function parsePositiveIntegerOption(value, flagName) {
    if (value === undefined)
        return undefined;
    const parsed = optionalInteger(value);
    if (parsed === undefined || parsed <= 0)
        throw new Error(`Pass ${flagName} as a positive integer.`);
    return parsed;
}
function normalizeOptionalStringOption(value) {
    if (value === undefined)
        return undefined;
    if (value === true)
        return "";
    if (typeof value === "string")
        return value;
    throw new Error("Expected a string flag value.");
}
function optionalNumber(value) {
    if (value === undefined || value === true)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function isValidationStatus(value) {
    return Boolean(normalizeValidationStatus(value));
}
function normalizeValidationStatus(value) {
    const text = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
    if (["passed", "pass", "success", "ok", "exit_0", "0"].includes(text))
        return "passed";
    if (["failed", "fail", "failure", "error", "nonzero", "non_zero"].includes(text) || /^exit_[1-9]\d*$/.test(text) || /^[1-9]\d*$/.test(text))
        return "failed";
    if (["not_run", "notrun", "not_ran", "pending"].includes(text))
        return "not_run";
    if (["skipped", "skip"].includes(text))
        return "skipped";
    if (["focused", "focus"].includes(text))
        return "focused";
    if (["unknown", "unclear"].includes(text))
        return "unknown";
    return undefined;
}
function isValidationStatusLike(value) {
    return Boolean(normalizeValidationStatus(value) ??
        inferValidationExitCode(value, { allowBareCode: true, allowGenericStatus: true }));
}
function inferValidationExitCode(value, options = {}) {
    const text = String(value ?? "").trim().toLowerCase();
    const allowBareCode = options.allowBareCode === true;
    const allowGenericStatus = options.allowGenericStatus === true;
    if (allowBareCode && /^\d{1,3}$/.test(text))
        return Number(text);
    const processExitPattern = /\b(?:exit(?:ed)?(?:\s+(?:code|status))?|exitcode|process\s+(?:exit(?:ed)?|status|code)|command\s+(?:exit(?:ed)?|status|code)|shell\s+(?:exit(?:ed)?|status|code))[\s:_-]*(\d{1,3})\b/;
    const genericStatusPattern = /^(?:status|code)[\s:_-]*(\d{1,3})\b/;
    const match = text.match(processExitPattern) ?? (allowGenericStatus ? text.match(genericStatusPattern) : null);
    if (match)
        return Number(match[1]);
    if (!allowBareCode && /^\d{1,3}$/.test(text))
        return undefined;
    const status = normalizeValidationStatus(text);
    if (status === "passed" || status === "focused")
        return 0;
    if (status === "failed")
        return 1;
    return undefined;
}
function normalizeSummaryValidationStatus(value) {
    const text = nonEmptyString(value);
    if (!text || /^\d{1,3}$/.test(text))
        return undefined;
    return normalizeValidationStatus(text);
}
function nonEmptyString(value) {
    const text = String(value ?? "").trim();
    return text ? text : undefined;
}
function parseDurationMs(value) {
    const text = String(value ?? "").trim().toLowerCase();
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins)?$/);
    if (!match)
        return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount))
        return undefined;
    const unit = match[2] ?? "ms";
    const multiplier = unit.startsWith("m") && unit !== "ms" ? 60000 : unit.startsWith("s") ? 1000 : 1;
    return Math.round(amount * multiplier);
}
function sanitizeValidationText(value, maxLength = 240) {
    const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
    if (!text)
        return undefined;
    const redacted = redactPrivateValidationMetrics(redactLocalPath(text));
    return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 3)}...`;
}
function redactPrivateValidationMetrics(text) {
    return text.replace(/\b(?:wallet|hotkey|coldkey|mnemonic|raw[-_\s]?trust|private[-_\s]?reviewability|trust[-_\s]?score)\b(?:\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"'`,;)]+))?/gi, "[redacted]");
}
function clientSnippet(client, command) {
    if (client === "codex")
        return `[mcp_servers.loopover]\ncommand = ${JSON.stringify(command)}\nargs = ["--stdio"]`;
    if (client === "claude" || client === "cursor" || client === "mcp") {
        return JSON.stringify({
            mcpServers: {
                loopover: {
                    command,
                    args: ["--stdio"],
                },
            },
        }, null, 2);
    }
    // VS Code's native MCP support uses a `servers` map with an explicit transport type, not the
    // `mcpServers` shape the other JSON hosts use, so it needs its own snippet (see .vscode/mcp.json).
    if (client === "vscode") {
        return JSON.stringify({
            servers: {
                loopover: {
                    type: "stdio",
                    command,
                    args: ["--stdio"],
                },
            },
        }, null, 2);
    }
    throw new Error(`Unsupported client: ${client}. Use codex, claude, cursor, mcp, or vscode.`);
}
async function getDecisionPackWithCache(login) {
    try {
        const payload = await apiGet(`/v1/contributors/${encodeURIComponent(login)}/decision-pack`);
        if (isCacheableDecisionPack(payload, login))
            writeDecisionPackCache(login, payload);
        return payload;
    }
    catch (error) {
        if (!isDecisionPackCacheFallbackEligible(error))
            throw error;
        const cached = readDecisionPackCache(login);
        if (!cached)
            throw error;
        return staleDecisionPackFromCache(cached, error);
    }
}
async function getRepoDecisionWithCache(login, owner, repo) {
    const repoFullName = `${owner}/${repo}`;
    try {
        return await apiGet(`/v1/contributors/${encodeURIComponent(login)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/decision`);
    }
    catch (error) {
        if (!isDecisionPackCacheFallbackEligible(error))
            throw error;
        const cached = readDecisionPackCache(login);
        if (!cached)
            throw error;
        return repoDecisionFromCachedPack(cached, repoFullName, error);
    }
}
function decisionPackToolSummary(login, payload) {
    if (payload?.source === "local_cache")
        return `LoopOver decision pack for ${login} (stale local cache).`;
    if (payload?.freshness === "stale" || payload?.freshness === "rebuilding")
        return `LoopOver decision pack for ${login} (${payload.freshness}).`;
    return `LoopOver decision pack for ${login}.`;
}
function repoDecisionToolSummary(login, repoFullName, payload) {
    if (payload?.source === "local_cache")
        return `LoopOver repo decision for ${login} in ${repoFullName} (stale local cache).`;
    return `LoopOver repo decision for ${login} in ${repoFullName}.`;
}
function getOpenPrMonitor(login) {
    return apiGet(`/v1/contributors/${encodeURIComponent(login)}/open-pr-monitor`);
}
function getPrOutcomes(login, limit) {
    const query = new URLSearchParams();
    if (limit != null)
        query.set("limit", String(limit));
    const suffix = query.size > 0 ? `?${query}` : "";
    return apiGet(`/v1/contributors/${encodeURIComponent(login)}/pr-outcomes${suffix}`);
}
// #6745: contributor notification feed + mark-read. `postMarkNotificationsRead` sends no ids to mark all
// delivered notifications read, mirroring markNotificationsReadShape's optional ids.
function getNotifications(login) {
    return apiGet(`/v1/contributors/${encodeURIComponent(login)}/notifications`);
}
function postMarkNotificationsRead(login, ids) {
    return apiPost(`/v1/contributors/${encodeURIComponent(login)}/notifications/read`, ids ? { ids } : {});
}
// Mirror the API's own `summary` when it sends one, so the CLI and the loopover_monitor_open_prs MCP
// tool (which returns monitor.summary verbatim) never drift into two different sentences for one payload.
function openPrMonitorToolSummary(login, payload) {
    const summary = typeof payload?.summary === "string" ? payload.summary.trim() : "";
    if (summary)
        return summary;
    return `LoopOver open-PR monitor for ${login}.`;
}
function prOutcomesToolSummary(login, payload) {
    const summary = typeof payload?.summary === "string" ? payload.summary.trim() : "";
    if (summary)
        return summary;
    return `LoopOver post-merge outcomes for ${login}.`;
}
function isCacheableDecisionPack(payload, login) {
    return payload?.status === "ready" && typeof payload.login === "string" && payload.login.toLowerCase() === login.toLowerCase();
}
function decisionPackAuthCacheKey() {
    const token = getApiToken();
    if (!token)
        return null;
    return createHash("sha256").update(token).digest("base64url");
}
function decisionPackCachePath(login, authCacheKey = decisionPackAuthCacheKey()) {
    if (!authCacheKey)
        return null;
    const key = Buffer.from(`${apiUrl}\0${currentApiVersion}\0${login.toLowerCase()}\0${authCacheKey}`).toString("base64url");
    return join(decisionPackCacheDir, `${key}.json`);
}
function writeDecisionPackCache(login, payload) {
    const authCacheKey = decisionPackAuthCacheKey();
    if (!authCacheKey)
        return { status: "skipped", reason: "missing_auth" };
    const cachedAt = new Date().toISOString();
    const sanitizedPayload = sanitizeDecisionPackForCache(payload);
    const entry = {
        schemaVersion: decisionPackCacheSchemaVersion,
        apiVersion: typeof payload.apiVersion === "string" ? payload.apiVersion : currentApiVersion,
        packageVersion,
        apiUrl,
        authCacheKey,
        login: login.toLowerCase(),
        cachedAt,
        payload: sanitizedPayload,
    };
    if (entry.apiVersion !== currentApiVersion)
        return { status: "skipped", reason: "api_version_mismatch" };
    const serialized = `${JSON.stringify(entry, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > decisionPackCacheMaxBytes)
        return { status: "skipped", reason: "too_large" };
    mkdirSync(decisionPackCacheDir, { recursive: true, mode: 0o700 });
    const path = decisionPackCachePath(login, authCacheKey);
    if (!path)
        return { status: "skipped", reason: "missing_auth" };
    writeFileSync(path, serialized, { mode: 0o600 });
    pruneDecisionPackCache();
    return { status: "stored", cachedAt };
}
function readDecisionPackCache(login) {
    const authCacheKey = decisionPackAuthCacheKey();
    const path = decisionPackCachePath(login, authCacheKey);
    if (!path || !existsSync(path))
        return null;
    try {
        const entry = JSON.parse(readFileSync(path, "utf8"));
        if (!isCompatibleDecisionPackCacheEntry(entry, login, authCacheKey))
            return null;
        return entry;
    }
    catch {
        return null;
    }
}
function isCompatibleDecisionPackCacheEntry(entry, login, authCacheKey = decisionPackAuthCacheKey()) {
    return (entry &&
        typeof entry === "object" &&
        entry.schemaVersion === decisionPackCacheSchemaVersion &&
        entry.apiVersion === currentApiVersion &&
        entry.apiUrl === apiUrl &&
        typeof entry.authCacheKey === "string" &&
        entry.authCacheKey === authCacheKey &&
        typeof entry.cachedAt === "string" &&
        typeof entry.login === "string" &&
        entry.login.toLowerCase() === login.toLowerCase() &&
        isCacheableDecisionPack(entry.payload, login));
}
function staleDecisionPackFromCache(entry, error) {
    const payload = entry.payload;
    return stripUndefined({
        ...payload,
        source: "local_cache",
        stale: true,
        freshness: "stale",
        rebuildEnqueued: false,
        cachedAt: entry.cachedAt,
        cache: cacheFallbackMetadata(entry, error),
    });
}
function repoDecisionFromCachedPack(entry, repoFullName, error) {
    const pack = staleDecisionPackFromCache(entry, error);
    const decision = cachedRepoDecision(pack, repoFullName);
    return stripUndefined({
        status: decision ? "ready" : "not_found",
        login: pack.login,
        repoFullName,
        generatedAt: pack.generatedAt,
        source: "local_cache",
        stale: true,
        freshness: "stale",
        cachedAt: entry.cachedAt,
        decision,
        dataQuality: pack.dataQuality,
        cache: cacheFallbackMetadata(entry, error),
    });
}
function cachedRepoDecision(pack, repoFullName) {
    const key = repoFullName.toLowerCase();
    return pack.repoDecisions?.find((decision) => String(decision?.repoFullName ?? "").toLowerCase() === key) ?? null;
}
function cacheFallbackMetadata(entry, error) {
    return {
        source: "local_cache",
        stale: true,
        cachedAt: entry.cachedAt,
        apiVersion: entry.apiVersion,
        schemaVersion: entry.schemaVersion,
        reason: "api_unavailable",
        detail: sanitizeDiagnosticText(error instanceof Error ? error.message : "api_unavailable"),
        rerunGuidance: "Retry when LoopOver API access is restored; cached guidance may be stale.",
        clearCommand: "loopover-mcp cache clear",
    };
}
function isDecisionPackCacheFallbackEligible(error) {
    const status = error?.status;
    if (typeof status !== "number")
        return true;
    return status === 429 || status >= 500;
}
function sanitizeDecisionPackForCache(value) {
    if (Array.isArray(value))
        return value.map((entry) => sanitizeDecisionPackForCache(entry));
    if (typeof value === "string")
        return sanitizeCacheString(value);
    if (!value || typeof value !== "object")
        return value;
    const sanitized = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
        if (isForbiddenCacheKey(entryKey))
            continue;
        sanitized[entryKey] = sanitizeDecisionPackForCache(entryValue);
    }
    return sanitized;
}
function isForbiddenCacheKey(key) {
    return /^(?:authorization|token|accessToken|apiToken|githubToken|wallet|hotkey|coldkey|mnemonic|privateKey|private_key|sourceContent|sourceContents|fileContent|fileContents|rawSource|rawSourceContent|content|contents|diff|patch|rawDiff|localPath|absolutePath)$/i.test(key);
}
function sanitizeCacheString(value) {
    return redactPrivateValidationMetrics(redactLocalPath(sanitizeDiagnosticText(value)));
}
function decisionPackCacheFiles() {
    if (!existsSync(decisionPackCacheDir))
        return [];
    return readdirSync(decisionPackCacheDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
        const path = join(decisionPackCacheDir, name);
        try {
            const stats = statSync(path);
            return { path, mtimeMs: stats.mtimeMs, size: stats.size };
        }
        catch {
            return null;
        }
    })
        .filter((entry) => entry !== null);
}
function pruneDecisionPackCache() {
    const files = decisionPackCacheFiles().sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const file of files.slice(decisionPackCacheMaxEntries))
        rmSync(file.path, { force: true });
}
function clearDecisionPackCache() {
    const removed = decisionPackCacheFiles().length;
    rmSync(decisionPackCacheDir, { recursive: true, force: true });
    return {
        status: "cleared",
        removed,
        cache: {
            source: "local_cache",
            maxEntries: decisionPackCacheMaxEntries,
            clearCommand: "loopover-mcp cache clear",
        },
    };
}
function inspectDecisionPackCache() {
    const files = decisionPackCacheFiles();
    const bytes = files.reduce((sum, file) => sum + file.size, 0);
    return {
        status: "ok",
        entries: files.length,
        bytes,
        maxEntries: decisionPackCacheMaxEntries,
        schemaVersion: decisionPackCacheSchemaVersion,
        apiVersion: currentApiVersion,
        clearCommand: "loopover-mcp cache clear",
    };
}
// Per-entry view of the offline decision-pack cache, newest first. Surfaces only safe metadata
// (login, when it was cached, the API/package version, size) — never the auth-cache key (a token
// hash) or the cached payload — so it stays consistent with the cache's local-only redaction.
function listDecisionPackCache() {
    const files = decisionPackCacheFiles().sort((left, right) => right.mtimeMs - left.mtimeMs);
    const entries = files.map((file) => {
        try {
            const entry = JSON.parse(readFileSync(file.path, "utf8"));
            return {
                login: typeof entry.login === "string" ? entry.login : null,
                cachedAt: typeof entry.cachedAt === "string" ? entry.cachedAt : null,
                apiVersion: typeof entry.apiVersion === "string" ? entry.apiVersion : null,
                packageVersion: typeof entry.packageVersion === "string" ? entry.packageVersion : null,
                bytes: file.size,
            };
        }
        catch {
            return { login: null, cachedAt: null, apiVersion: null, packageVersion: null, bytes: file.size, corrupt: true };
        }
    });
    return {
        status: "ok",
        count: entries.length,
        maxEntries: decisionPackCacheMaxEntries,
        clearCommand: "loopover-mcp cache clear",
        entries,
    };
}
function findExecutable(name) {
    for (const directory of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        const candidate = join(directory, name);
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
function sanitizeDiagnosticText(value, extraPaths = []) {
    return redactKnownLocalPaths(value, {
        tokens: [
            process.env.LOOPOVER_API_TOKEN,
            process.env.LOOPOVER_MCP_TOKEN,
            process.env.LOOPOVER_TOKEN,
            config.session?.token,
            ...profileSessions(config).map((entry) => entry.session.token),
        ],
        paths: [configPath, process.env.LOOPOVER_CONFIG_PATH, process.env.LOOPOVER_CONFIG_DIR, process.cwd(), homedir(), ...extraPaths],
    });
}
function loadConfig() {
    if (!existsSync(configPath))
        return {};
    try {
        return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
    }
    catch {
        return {};
    }
}
function saveConfig(nextConfig) {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, `${JSON.stringify(configForPersistence(nextConfig), null, 2)}\n`, { mode: 0o600 });
}
function normalizeConfig(rawConfig) {
    const raw = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
    const profiles = {};
    const rawProfiles = raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : {};
    for (const [rawName, rawProfile] of Object.entries(rawProfiles)) {
        try {
            const name = normalizeProfileName(rawName);
            const profile = normalizeProfile(rawProfile);
            if (profile)
                profiles[name] = profile;
        }
        catch {
            // Ignore malformed profile names in local config instead of leaking paths or tokens.
        }
    }
    if (raw.session?.token && !profiles[defaultProfileName]) {
        profiles[defaultProfileName] = normalizeProfile({
            apiUrl: raw.apiUrl,
            session: raw.session,
        });
    }
    let activeProfile = defaultProfileName;
    try {
        activeProfile = selectProfileName({ ...raw, profiles }, raw.activeProfile);
    }
    catch {
        activeProfile = defaultProfileName;
    }
    return stripUndefined({
        ...raw,
        activeProfile,
        profiles,
        session: profiles[defaultProfileName]?.session,
        // Opt-in telemetry flag (#6239): only a literal `true` counts as enabled, so a malformed or legacy
        // value in the config file falls back to the privacy-preserving default (absent = disabled).
        telemetryEnabled: raw.telemetryEnabled === true ? true : undefined,
    });
}
function normalizeProfile(rawProfile) {
    const raw = rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile) ? rawProfile : {};
    const session = normalizeSession(raw.session);
    return stripUndefined({
        apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl.replace(/\/+$/, "") : undefined,
        session,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    });
}
function normalizeSession(rawSession) {
    const raw = rawSession && typeof rawSession === "object" && !Array.isArray(rawSession) ? rawSession : {};
    if (typeof raw.token !== "string" || raw.token.length === 0)
        return undefined;
    return stripUndefined({
        token: raw.token,
        login: typeof raw.login === "string" ? raw.login : undefined,
        expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : undefined,
        scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope) => typeof scope === "string") : [],
    });
}
function configForPersistence(nextConfig) {
    const normalized = normalizeConfig(nextConfig);
    return stripUndefined({
        apiUrl: normalized.apiUrl,
        activeProfile: normalized.activeProfile,
        profiles: normalized.profiles,
        session: normalized.profiles?.[defaultProfileName]?.session,
        telemetryEnabled: normalized.telemetryEnabled,
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function apiGet(path) {
    return apiFetch(path, { method: "GET" });
}
async function apiPost(path, body) {
    return apiFetch(path, { method: "POST", body: JSON.stringify(body) });
}
async function apiDelete(path, body) {
    return apiFetch(path, { method: "DELETE", body: JSON.stringify(body) });
}
async function apiFetch(path, init, options = {}) {
    const token = options.token ?? getApiToken();
    if (options.auth !== false && !token) {
        const error = new Error("Run `loopover-mcp login`, or set LOOPOVER_API_TOKEN, LOOPOVER_MCP_TOKEN, or LOOPOVER_TOKEN before starting the MCP wrapper.");
        error.status = 401;
        error.code = "missing_auth";
        throw error;
    }
    const controller = new AbortController();
    const timeoutMs = Number(process.env.LOOPOVER_API_TIMEOUT_MS ?? options.timeoutMs ?? 30000);
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);
    const response = await fetch(`${apiUrl}${path}`, {
        ...init,
        signal: init?.signal ?? controller.signal,
        headers: {
            ...(token && options.auth !== false ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/json",
            accept: "application/json",
            "x-loopover-mcp-package": packageName,
            "x-loopover-mcp-version": packageVersion,
            "x-loopover-mcp-client": "loopover-mcp-cli",
        },
    }).finally(() => clearTimeout(timeout));
    const text = await response.text();
    let payload = {};
    if (text) {
        try {
            payload = JSON.parse(text);
        }
        catch (error) {
            if (response.ok)
                throw error;
            payload = { error: "non_json_response", body: text.slice(0, 500) };
        }
    }
    if (!response.ok) {
        const retry = response.headers.get("retry-after");
        const error = new Error(`LoopOver API ${response.status}${retry ? ` retry-after=${retry}s` : ""}: ${JSON.stringify(payload).slice(0, 500)}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}
async function fetchLatestPackageVersion() {
    if (/^(1|true|yes)$/i.test(process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK ?? "false"))
        return { status: "skipped" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${npmRegistryUrl}/@loopover%2fmcp/latest`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
    }).finally(() => clearTimeout(timeout));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.version !== "string")
        throw new Error("npm_latest_version_unavailable");
    return { status: "ok", version: payload.version };
}
function parseSemver(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? "").trim());
    if (!match)
        return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}
// Compares two dot-separated semver prerelease strings per the semver spec:
// numeric identifiers compare numerically, others lexically, numeric < non-numeric,
// and a shorter set of identifiers has lower precedence when all earlier ones match.
//
// Numeric identifiers are compared as decimal strings, not via Number(), which loses precision beyond
// Number.MAX_SAFE_INTEGER (2^53-1): two distinct digit strings past that width can round to the SAME float,
// making Number(leftId) !== Number(rightId) wrongly report them as equal (mirrors the same fix already applied
// to compareMcpSemver's comparePrerelease in src/services/mcp-compatibility.ts, #3049). With no leading zeros
// (semver's own numeric-identifier rule), a longer digit string is the larger number, and equal-length strings
// compare lexicographically.
function comparePrerelease(a, b) {
    const left = a.split(".");
    const right = b.split(".");
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const leftId = left[index];
        const rightId = right[index];
        if (leftId === undefined)
            return -1;
        if (rightId === undefined)
            return 1;
        const leftNumeric = /^\d+$/.test(leftId);
        const rightNumeric = /^\d+$/.test(rightId);
        if (leftNumeric && rightNumeric) {
            if (leftId.length !== rightId.length)
                return leftId.length < rightId.length ? -1 : 1;
            if (leftId !== rightId)
                return leftId < rightId ? -1 : 1;
        }
        else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        }
        else if (leftId !== rightId) {
            return leftId < rightId ? -1 : 1;
        }
    }
    return 0;
}
// Returns -1 if a < b, 1 if a > b, 0 if equal, or null when either side is unparseable.
function compareSemver(a, b) {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right)
        return null;
    for (const part of ["major", "minor", "patch"]) {
        if (left[part] !== right[part])
            return left[part] < right[part] ? -1 : 1;
    }
    if (left.prerelease === right.prerelease)
        return 0;
    // A release version has higher precedence than any prerelease of the same core.
    if (left.prerelease === null)
        return 1;
    if (right.prerelease === null)
        return -1;
    return comparePrerelease(left.prerelease, right.prerelease);
}
// Maps a raw npm-latest lookup into a single install state. `comparison` is the result of
// compareSemver(local, latest): negative means local is behind (stale), positive means ahead.
function classifyVersionState(latestStatus, latestVersion, comparison) {
    if (latestStatus === "skipped")
        return "skipped";
    if (!latestVersion)
        return "unavailable";
    if (comparison === null)
        return "unknown";
    if (comparison < 0)
        return "stale";
    if (comparison > 0)
        return "ahead";
    return "current";
}
// Shared by `status` and `doctor`: compares the local install against npm latest and
// produces deterministic upgrade guidance. Never throws and never returns sensitive data.
async function inspectInstallVersion(apiRecommendedVersion) {
    let latest;
    try {
        latest = await fetchLatestPackageVersion();
    }
    catch (error) {
        latest = { status: "unavailable", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "npm_version_check_failed") };
    }
    if (latest.status === "unavailable" && typeof apiRecommendedVersion === "string" && apiRecommendedVersion.length > 0) {
        latest = { status: "api", version: apiRecommendedVersion };
    }
    const latestVersion = typeof latest.version === "string" ? latest.version : null;
    const comparison = latestVersion ? compareSemver(packageVersion, latestVersion) : null;
    const state = classifyVersionState(latest.status, latestVersion, comparison);
    const stale = state === "stale";
    return stripUndefined({
        name: packageName,
        version: packageVersion,
        latestVersion,
        latestStatus: latest.status ?? "ok",
        state,
        updateAvailable: stale,
        upgradeCommand: stale ? upgradeCommand : undefined,
        npxFallback: stale ? npxFallbackCommand : undefined,
        detail: latest.error,
    });
}
async function inspectApiCompatibility(health) {
    try {
        const report = await apiFetch(compatibilityPath, { method: "GET" }, { auth: false, timeoutMs: 5000 });
        return { report, evaluation: evaluateApiCompatibility(report, "compatibility_endpoint") };
    }
    catch (error) {
        const report = {
            status: "unavailable",
            reason: "compatibility_endpoint_unavailable",
            error: sanitizeDiagnosticText(error instanceof Error ? error.message : "compatibility_check_failed"),
        };
        const fallback = evaluateApiCompatibility(health, "health");
        return {
            report,
            evaluation: fallback.reason === "not_reported" ? evaluateApiCompatibility(report, "compatibility_endpoint") : fallback,
        };
    }
}
// Prefer the first-class compatibility endpoint, but keep supporting older APIs that only
// advertise `minMcpVersion`/`minClientVersion` on /health.
function evaluateApiCompatibility(report, source) {
    if (!report || report.status === "unreachable")
        return { status: "unavailable", reason: "api_unreachable", source };
    if (report.status === "unavailable") {
        return stripUndefined({ status: "unavailable", reason: report.reason ?? "compatibility_unavailable", source, detail: report.error });
    }
    const minVersion = compatibilityMinimumVersion(report);
    if (!minVersion)
        return { status: "unavailable", reason: "not_reported", source };
    const comparison = compareSemver(packageVersion, minVersion);
    const latestRecommendedVersion = compatibilityLatestRecommendedVersion(report);
    const apiVersion = typeof report.apiVersion === "string" ? report.apiVersion : undefined;
    const warnings = Array.isArray(report.compatibilityWarnings) ? report.compatibilityWarnings : Array.isArray(report.warnings) ? report.warnings : [];
    const breakingChanges = Array.isArray(report.breakingChanges) ? report.breakingChanges : [];
    if (comparison === null)
        return stripUndefined({ status: "unknown", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges });
    if (comparison < 0)
        return stripUndefined({ status: "incompatible", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges, upgradeCommand });
    return stripUndefined({ status: "compatible", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges });
}
function compatibilityMinimumVersion(report) {
    if (typeof report?.mcp?.minimumSupportedVersion === "string")
        return report.mcp.minimumSupportedVersion;
    if (typeof report?.minimumSupportedMcpVersion === "string")
        return report.minimumSupportedMcpVersion;
    if (typeof report?.minMcpVersion === "string")
        return report.minMcpVersion;
    if (typeof report?.minClientVersion === "string")
        return report.minClientVersion;
    return null;
}
function compatibilityLatestRecommendedVersion(report) {
    if (typeof report?.mcp?.latestRecommendedVersion === "string")
        return report.mcp.latestRecommendedVersion;
    if (typeof report?.mcp?.latestPackageVersion === "string")
        return report.mcp.latestPackageVersion;
    if (typeof report?.latestRecommendedMcpVersion === "string")
        return report.latestRecommendedMcpVersion;
    if (typeof report?.latestPackageVersion === "string")
        return report.latestPackageVersion;
    return null;
}
async function analyzeCurrentBranch(input) {
    const workspace = resolveWorkspaceCwd(input);
    const payload = buildBranchAnalysisPayload({ ...input, cwd: workspace.cwd });
    const { localScorerStatus, ...body } = payload;
    const analysis = await apiPost("/v1/local/branch-analysis", body);
    return {
        local: {
            sourceUpload: false,
            workspaceRoots: {
                available: workspace.rootsAvailable,
                count: workspace.rootCount,
                cwdInsideRoot: workspace.rootsAvailable ? true : undefined,
                pathsIncluded: false,
            },
            repoFullName: body.repoFullName,
            baseRef: body.baseRef,
            headRef: body.headRef,
            branchName: body.branchName,
            baseSha: body.baseSha,
            headSha: body.headSha,
            mergeBaseSha: body.mergeBaseSha,
            remoteTrackingSha: body.remoteTrackingSha,
            changedFileCount: body.changedFiles?.length ?? 0,
            testFileCount: body.changedFiles?.filter((file) => isTestFile(file.path)).length ?? 0,
            passedValidationCount: body.validation?.filter((entry) => entry.status === "passed").length ?? 0,
            localScorerStatus: sanitizeLocalScorerStatus(localScorerStatus),
            setupGuidance: setupGuidanceForLocalScorer(localScorerStatus),
        },
        analysis,
    };
}
async function agentPreparePrPacket(input) {
    const workspace = resolveWorkspaceCwd(input);
    const payload = buildBranchAnalysisPayload({ ...input, cwd: workspace.cwd });
    const { localScorerStatus: _localScorerStatus, ...body } = payload;
    return apiPost("/v1/agent/prepare-pr-packet", body);
}
// #1968 review-pr: a thin composition of the existing preflight + slop-risk + lint-pr-text checks
// into one report, so a contributor's own local agent can see everything the gate would flag before
// ever opening a PR. Reuses analyzeCurrentBranch (preflight) and collectLocalDiff (the same diff
// metadata previewLocalScore already sends) rather than reimplementing any check. Each sub-check is
// isolated with its own try/catch: one flaky endpoint degrades that section to a `failed` status with
// a public-safe reason instead of hiding the sections that did succeed.
async function reviewLocalPr(input) {
    const result = await analyzeCurrentBranch(input);
    const workspace = resolveWorkspaceCwd(input);
    const diff = collectLocalDiff(workspace.cwd, input.baseRef, input.workspaceRoots);
    const commitMessages = input.commitMessages?.length ? input.commitMessages : undefined;
    const prBody = input.body;
    const linkedIssue = input.linkedIssues?.[0];
    const slopRisk = await runReviewCheck(() => apiPost("/v1/lint/slop-risk", {
        changedFiles: diff.changedFiles.map((path) => ({ path })),
        description: prBody,
        testFiles: diff.testFiles,
    }));
    const prTextLint = await runReviewCheck(() => apiPost("/v1/lint/pr-text", {
        ...(commitMessages ? { commitMessages } : {}),
        ...(prBody !== undefined ? { prBody } : {}),
        ...(linkedIssue !== undefined ? { linkedIssue } : {}),
    }));
    const sections = [
        { name: "preflight", status: preflightSectionStatus(result.analysis.preflight?.status) },
        { name: "slop_risk", status: slopRisk.ok ? slopRiskSectionStatus(slopRisk.value) : "fail" },
        { name: "pr_text_lint", status: prTextLint.ok ? prTextLintSectionStatus(prTextLint.value) : "fail" },
    ];
    return {
        local: result.local,
        preflight: result.analysis.preflight,
        prPacket: result.analysis.prPacket,
        workspaceIntelligence: publicSafeWorkspaceIntelligence(result.analysis.workspaceIntelligence),
        slopRisk: slopRisk.ok ? slopRisk.value : undefined,
        slopRiskError: slopRisk.ok ? undefined : slopRisk.reason,
        prTextLint: prTextLint.ok ? prTextLint.value : undefined,
        prTextLintError: prTextLint.ok ? undefined : prTextLint.reason,
        overallStatus: reviewOverallStatus(sections),
        sections,
    };
}
async function runReviewCheck(run) {
    try {
        return { ok: true, value: await run() };
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "review_check_failed" };
    }
}
function preflightSectionStatus(status) {
    if (status === "hold")
        return "fail";
    if (status === "needs_work")
        return "warn";
    return "pass";
}
function slopRiskSectionStatus(value) {
    if (value?.band === "high" || value?.band === "elevated")
        return "warn";
    return "pass";
}
function prTextLintSectionStatus(value) {
    if (value?.verdict === "weak")
        return "warn";
    return "pass";
}
function reviewOverallStatus(sections) {
    if (sections.some((section) => section.status === "fail"))
        return "fail";
    if (sections.some((section) => section.status === "warn"))
        return "warn";
    return "pass";
}
async function previewLocalScore(input) {
    const workspace = resolveWorkspaceCwd(input);
    const cwd = workspace.cwd;
    const diff = collectLocalDiff(cwd, input.baseRef, input.workspaceRoots);
    const branchPayload = buildBranchAnalysisPayload({ ...input, login: input.contributorLogin ?? "local", cwd, repoFullName: input.repoFullName, baseRef: input.baseRef });
    const upstreamPreview = branchPayload.localScorerStatus;
    const estimatedSourceLines = input.sourceLines ?? Math.max(1, diff.changedLineCount - diff.testFiles.length);
    const body = {
        repoFullName: input.repoFullName,
        targetType: "local_diff",
        targetKey: input.targetKey ?? localDiffTargetKey(branchPayload, input.baseRef),
        contributorLogin: input.contributorLogin,
        labels: input.labels,
        linkedIssueMode: input.linkedIssueMode,
        sourceTokenScore: input.sourceTokenScore ?? estimatedSourceLines,
        sourceLines: estimatedSourceLines,
        totalTokenScore: input.totalTokenScore ?? diff.changedLineCount,
        testTokenScore: diff.testFiles.length,
        openPrCount: input.openPrCount,
        credibility: input.credibility,
        changesRequestedCount: input.changesRequestedCount,
        pendingMergedPrCount: input.pendingMergedPrCount,
        pendingClosedPrCount: input.pendingClosedPrCount,
        approvedPrCount: input.approvedPrCount,
        expectedOpenPrCountAfterMerge: input.expectedOpenPrCountAfterMerge,
        projectedCredibility: input.projectedCredibility,
        scenarioNotes: input.scenarioNotes,
        branchEligibility: input.branchEligibility,
        metadataOnly: !upstreamPreview.ok,
    };
    return {
        localDiff: {
            changedFiles: diff.changedFiles,
            changedLineCount: diff.changedLineCount,
            testFiles: diff.testFiles,
            codeFiles: diff.codeFiles,
            commitMessage: input.commitMessage ?? diff.commitMessage,
        },
        upstreamPreview: sanitizeLocalScorerStatus(upstreamPreview),
        remotePreview: await apiPost("/v1/scoring/preview", body),
        setupGuidance: upstreamPreview.ok
            ? []
            : setupGuidanceForLocalScorer(upstreamPreview),
    };
}
function localDiffTargetKey(branchPayload, baseRef) {
    return [
        branchPayload.repoFullName,
        branchPayload.branchName ?? branchPayload.headRef ?? "local",
        branchPayload.headSha ?? baseRef ?? "diff",
    ]
        .filter(Boolean)
        .join(":");
}
function branchEligibilityFromOptions(options) {
    const status = options.branchEligibility ?? options.branchEligibilityStatus;
    if (!["eligible", "ineligible", "unknown"].includes(status))
        return undefined;
    const source = ["github_metadata", "local_metadata", "registry", "user_supplied"].includes(options.branchEligibilitySource) ? options.branchEligibilitySource : "user_supplied";
    return stripUndefined({
        status,
        source,
        reason: options.branchEligibilityReason,
        checkedAt: options.branchEligibilityCheckedAt,
        stale: optionalBoolean(options.branchEligibilityStale),
    });
}
function optionalBoolean(value) {
    if (value === undefined)
        return undefined;
    if (value === true)
        return true;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["false", "0", "no", "off"].includes(normalized))
            return false;
        if (["true", "1", "yes", "on"].includes(normalized))
            return true;
    }
    return Boolean(value);
}
function toolResult(summary, data) {
    return {
        content: [
            {
                type: "text",
                text: `${summary}\n\n${JSON.stringify(data, null, 2)}`,
            },
        ],
        structuredContent: data,
    };
}
function camel(value) {
    return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
function stripUndefined(value) {
    if (Array.isArray(value))
        return value.map(stripUndefined);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)]));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcG92ZXItbWNwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9vcG92ZXItbWNwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFDQSxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQ3pDLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxJQUFJLFdBQVcsRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLFlBQVksRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxhQUFhLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDaEwsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNsQyxPQUFPLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFDckQsT0FBTyxFQUFFLFNBQVMsRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLHlDQUF5QyxDQUFDO0FBQ3RGLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLDJDQUEyQyxDQUFDO0FBQ2pGLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxlQUFlLEVBQUUscUJBQXFCLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUMzSCwyR0FBMkc7QUFDM0csOEZBQThGO0FBQzlGLE9BQU8sRUFDTCxvQkFBb0IsRUFDcEIsZ0JBQWdCLEVBQ2hCLHFCQUFxQixFQUNyQixxQkFBcUIsRUFDckIsa0JBQWtCLEVBQ2xCLHNCQUFzQixFQUN0QixlQUFlLEVBQ2YsK0JBQStCLEVBQy9CLGdCQUFnQixHQUNqQixNQUFNLGtCQUFrQixDQUFDO0FBQzFCLG9HQUFvRztBQUNwRyxrRkFBa0Y7QUFDbEYsT0FBTyxFQUFFLDRCQUE0QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDaEUsc0dBQXNHO0FBQ3RHLDZDQUE2QztBQUM3QyxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxrQkFBa0Is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S0FBSyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsRUFBRTtDQUNsRCxDQUFDO0FBRUYsTUFBTSxhQUFhLEdBQUc7SUFDcEIsS0FBSyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUU7SUFDakIsSUFBSSxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUU7SUFDaEIsS0FBSyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUU7SUFDakIsSUFBSSxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxRQUFRLEVBQUU7SUFDM0IsTUFBTSxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsUUFBUSxFQUFFO0lBQ3RDLElBQUksRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLEVBQUU7Q0FDakQsQ0FBQztBQUVGLE1BQU0sZUFBZSxHQUFHO0lBQ3RCLGNBQWMsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLEVBQUU7SUFDdEQsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxRQUFRLEVBQUU7SUFDN0IsV0FBVyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxRQUFRLEVBQUU7Q0FDcEQsQ0FBQztBQUVGLE1BQU0sbUJBQW1CLEdBQUc7SUFDMUIsT0FBTyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLENBQUMsR0FBRyxHQUFHLElBQUksQ0FBQztJQUNuQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFD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LENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLEVBQUU7Q0FDeEQsQ0FBQztLQUNELE1BQU0sRUFBRSxDQUFDO0FBQ1osTUFBTSxhQUFhLEdBQUcsQ0FBQztLQUNwQixNQUFNLENBQUM7SUFDTixFQUFFLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO0lBQzlCLEtBQUssRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7SUFDakMsV0FBVyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsRUFBRTtJQUNqRCxTQUFTLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7SUFDdEQsTUFBTSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLEVBQUUsU0FBUyxFQUFFLFdBQVcsRUFBRSxRQUFRLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFDeEUsUUFBUSxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ2pDLFdBQVcsRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7SUFDNUMsU0FBUyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsUUFBUSxFQUFFO0NBQ3RELENBQUM7S0FDRCxNQUFNLEVBQUUsQ0FBQztBQUNaLE1BQU0sWUFBWSxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBQ25GLE1BQU0sY0FBYyxHQUFHLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFDNUUsTUFBTSxlQUFlLEdBQUcsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLENBQUM7QUFDL0MsTUFBTSxxQkFBcUIsR0FBRztJQUM1QixJQUFJLEVBQUUsWUFBWTtJQUNsQixNQUFNLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO0lBQ2xDLE9BQU8sRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsV0FBVyxFQUFFLFFBQVEsRUFBRSxTQUFTLENBQUMsQ0FBQztJQUNuRCxLQUFLLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxRQUFRLEVBQUU7Q0FDdkMsQ0FBQztBQUVGLDJHQUEyRztBQUMzRyw4R0FBOEc7QUFDOUcsNkZBQTZGO0FBQzdGLE1BQU0sZ0JBQWdCLEdBQUc7SUFDdkIsS0FBSyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ3hCLEtBQUssRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUN4QixJQUFJLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDdkIsS0FBSyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ3hCLElBQUksRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLFFBQVEsRUFBRTtJQUN0QyxNQUFNLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsUUFBUSxFQUFFO0lBQzlDLFlBQVksRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLEVBQUU7SUFDckUsWUFBWSxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxFQUFFO0NBQ3RFLENBQUM7QUFFRixNQUFNLGNBQWMsR0FBRztJQUNyQixZQUFZLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDL0IsZ0JBQWdCLEVBQUUsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUU7SUFDOUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ3hCLElBQUksRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsUUFBUSxFQUFFO0lBQzNCLE1BQU0sRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLFFBQVEsRUFBRTtJQUN0QyxZQUFZLEVBQUUsQ0FBQyxDQUFD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O0lBQy9ELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxZQUFZLElBQUksT0FBTyxDQUFDLElBQUksQ0FBQztJQUMxRCxJQUFJLENBQUMsWUFBWSxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHNEQUFzRCxDQUFDLENBQUM7SUFDbEksSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO0lBQzVELE1BQU0sZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLEtBQUssSUFBSSxPQUFPLENBQUMsZ0JBQWdCLENBQUM7SUFDbkUsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDMUcsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDeEksTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDO1FBQy9DLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQVUsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBVSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsU0FB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