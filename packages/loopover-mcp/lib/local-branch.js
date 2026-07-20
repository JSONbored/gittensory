import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCodeFile, isTestPath as isTestFile } from "@loopover/engine/signals/test-evidence";
import { redactLocalPath } from "./redact-local-path.js";
export { isCodeFile, isTestFile };
export { redactLocalPath };
function stripTrailingSlashes(value) {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47)
        end -= 1;
    return end === value.length ? value : value.slice(0, end);
}
export function parseGitRemote(remoteUrl) {
    const trimmed = stripTrailingSlashes(String(remoteUrl ?? "").trim());
    const patterns = [
        /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
        /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
        /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
    ];
    for (const pattern of patterns) {
        const match = trimmed.match(pattern);
        if (match?.[1] && match[2])
            return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
    }
    return undefined;
}
export function collectLocalDiff(cwd, baseRef, workspaceRoots) {
    const metadata = collectLocalBranchMetadata({ cwd, baseRef, login: "local", workspaceRoots });
    return {
        title: metadata.title ?? "Local diff preflight",
        commitMessage: metadata.commitMessages.join("\n\n").trim(),
        changedFiles: metadata.changedFiles.map((file) => file.path),
        changedLineCount: metadata.changedFiles.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0),
        testFiles: metadata.changedFiles.map((file) => file.path).filter(isTestFile),
        codeFiles: metadata.changedFiles.map((file) => file.path).filter(isCodeFile),
    };
}
export function collectLocalBranchMetadata(input) {
    assertSourceUploadDisabled();
    const workspace = resolveWorkspaceCwd(input);
    const cwd = workspace.cwd;
    const baseRef = input.baseRef ?? defaultBaseRef(cwd);
    const remoteUrl = gitLines(cwd, ["config", "--get", "remote.origin.url"])[0] ?? "";
    const repoFullName = input.repoFullName ?? parseGitRemote(remoteUrl);
    if (!repoFullName)
        throw new Error("Could not infer repoFullName from git remote; pass --repo owner/repo.");
    const branchName = input.branchName ?? gitLines(cwd, ["branch", "--show-current"])[0] ?? "local-branch";
    const headRef = input.headRef ?? gitLines(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])[0] ?? branchName;
    const baseSha = gitLines(cwd, ["rev-parse", "--verify", baseRef])[0];
    const headSha = gitLines(cwd, ["rev-parse", "--verify", "HEAD"])[0];
    const mergeBaseSha = gitLines(cwd, ["merge-base", baseRef, "HEAD"])[0];
    const remoteTrackingSha = collectRemoteTrackingSha(cwd, baseRef);
    const changedFiles = collectChangedFiles(cwd, baseRef);
    const pendingCommitCount = input.pendingCommitCount ?? collectPendingCommitCount(cwd, baseRef);
    const ciStatusHints = input.ciStatusHints ?? collectCiStatusHints(cwd, baseRef, changedFiles);
    const commitMessages = input.commitMessages ?? collectCommitMessages(cwd, baseRef);
    const title = input.title ?? titleFromBranch(branchName) ?? firstCommitTitle(commitMessages);
    const linkedIssues = [...new Set([...(input.linkedIssues ?? []), ...extractLinkedIssues([branchName, title, input.body, ...commitMessages].filter(Boolean).join("\n"))])].sort((left, right) => left - right);
    const payload = {
        login: input.login,
        repoFullName,
        baseRef,
        headRef,
        branchName,
        baseSha,
        headSha,
        mergeBaseSha,
        remoteTrackingSha,
        commitMessages,
        changedFiles,
        validation: input.validation,
        linkedIssues,
        labels: input.labels,
        title,
        body: input.body,
        pendingMergedPrCount: input.pendingMergedPrCount,
        pendingClosedPrCount: input.pendingClosedPrCount,
        approvedPrCount: input.approvedPrCount,
        expectedOpenPrCountAfterMerge: input.expectedOpenPrCountAfterMerge,
        projectedCredibility: input.projectedCredibility,
        scenarioNotes: input.scenarioNotes,
        pendingCommitCount,
        ciStatusHints,
        branchEligibility: input.branchEligibility,
    };
    return stripUndefined(payload);
}
export function collectPendingCommitCount(cwd, baseRef) {
    const count = gitLines(cwd, ["rev-list", "--count", `${baseRef}..HEAD`])[0];
    const parsed = Number(count);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}
export function collectCiStatusHints(cwd, baseRef, changedFiles = []) {
    const hints = [];
    const paths = changedFiles.map((file) => file.path).filter(Boolean);
    if (paths.some((path) => /^\.github\/workflows\//i.test(path))) {
        hints.push("Workflow files changed; CI required-check behavior may change after merge.");
    }
    if (paths.some((path) => /(^|\/)(Makefile|Dockerfile|package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/i.test(path))) {
        hints.push("Build or dependency manifests changed; rerun the repo's standard validation commands.");
    }
    const pendingCommits = collectPendingCommitCount(cwd, baseRef);
    if (pendingCommits > 0) {
        hints.push(`${pendingCommits} local commit(s) ahead of ${baseRef}; push or rebase before reviewers rely on the latest diff.`);
    }
    return hints;
}
export function buildBranchAnalysisPayload(input) {
    const workspace = resolveWorkspaceCwd(input);
    const metadata = collectLocalBranchMetadata({ ...input, cwd: workspace.cwd });
    const scorerMetadata = { ...metadata, repoRoot: workspace.cwd };
    const scorerCommand = resolveScorePreviewCommand(input);
    const externalPreview = runExternalScorePreview(scorerMetadata, scorerCommand);
    const localScorer = externalPreview.ok ? normalizeScorerOutput(externalPreview.payload) : metadataOnlyScorer(externalPreview);
    return {
        ...metadata,
        localScorer,
        localScorerStatus: sanitizeLocalScorerStatus(externalPreview),
    };
}
export function resolveWorkspaceCwd(input = {}) {
    const workspaceRoots = normalizeMcpWorkspaceRoots(input.workspaceRoots);
    if (workspaceRoots.length === 0) {
        return {
            cwd: safeResolvedPath(input.cwd ?? process.cwd()),
            rootsAvailable: false,
            rootCount: 0,
        };
    }
    const selectedRoot = workspaceRoots[0];
    const requestedCwd = input.cwd === undefined || input.cwd === null || input.cwd === ""
        ? selectedRoot.path
        : isAbsolute(String(input.cwd))
            ? String(input.cwd)
            : resolve(selectedRoot.path, String(input.cwd));
    const cwd = safeResolvedPath(requestedCwd);
    const containingRoot = workspaceRoots.find((root) => pathIsInside(cwd, root.path));
    if (!containingRoot) {
        throw new Error("Selected workspace is outside the MCP roots exposed by the client.");
    }
    return {
        cwd,
        rootsAvailable: true,
        rootCount: workspaceRoots.length,
    };
}
export function normalizeMcpWorkspaceRoots(roots) {
    if (!Array.isArray(roots))
        return [];
    const normalized = [];
    const seen = new Set();
    for (const root of roots) {
        const uri = typeof root?.uri === "string" ? root.uri : "";
        if (!uri.startsWith("file:"))
            continue;
        try {
            const path = safeResolvedPath(fileURLToPath(uri));
            if (seen.has(path))
                continue;
            seen.add(path);
            normalized.push({ path });
        }
        catch {
            // Ignore non-local or malformed root URIs. Clients without usable roots fall back to cwd.
        }
    }
    return normalized;
}
function safeResolvedPath(path) {
    const resolved = resolve(String(path));
    try {
        return realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
function pathIsInside(candidate, root) {
    const child = safeResolvedPath(candidate);
    const parent = safeResolvedPath(root);
    const childRelativeToParent = relative(parent, child);
    return childRelativeToParent === "" || (!!childRelativeToParent && !childRelativeToParent.startsWith("..") && !isAbsolute(childRelativeToParent));
}
export function resolveScorePreviewCommand(input = {}) {
    const explicit = input.scorePreviewCommand ?? process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    if (typeof explicit === "string" && explicit.trim())
        return explicit.trim();
    return undefined;
}
export function referenceScorePreviewExample(kind = "metadata") {
    const script = kind === "gittensor" ? "gittensor-score-preview.py" : "gittensor-score-preview.mjs";
    const interpreter = kind === "gittensor" ? "python3" : "node";
    return `${interpreter} ./node_modules/@loopover/mcp/scripts/${script}`;
}
export function redactScorerCommand(command) {
    const text = String(command ?? "").trim();
    if (!text)
        return text;
    const parts = splitCommand(text);
    const interpreter = parts[0]?.split(/[\\/]/).pop() ?? "command";
    const script = parts.at(-1)?.split(/[\\/]/).pop();
    if (script && /\.(mjs|js|cjs|py)$/i.test(script))
        return `${interpreter} <scorer-script>/${script}`;
    return "<configured-scorer-command>";
}
export function sanitizeLocalScorerStatus(status) {
    if (!status || typeof status !== "object")
        return status;
    const scorerStatus = status;
    return stripUndefined({
        ...scorerStatus,
        reason: scorerStatus.reason ? redactLocalPath(String(scorerStatus.reason)) : undefined,
        stderr: scorerStatus.stderr ? redactLocalPath(String(scorerStatus.stderr)) : undefined,
        scorerCommand: scorerStatus.scorerCommand ? redactScorerCommand(scorerStatus.scorerCommand) : undefined,
    });
}
export function runExternalScorePreview(metadata, scorerCommand) {
    const timeoutMs = scorePreviewTimeoutMs();
    if (!scorerCommand) {
        return scorerFailure("missing_scorer_command", "GITTENSOR_SCORE_PREVIEW_CMD is not configured.");
    }
    const parts = splitCommand(scorerCommand);
    const command = parts[0];
    const args = parts.slice(1);
    if (!command) {
        return scorerFailure("empty_scorer_command", "GITTENSOR_SCORE_PREVIEW_CMD is empty.");
    }
    const startedAt = Date.now();
    try {
        const output = execFileSync(command, args, {
            input: JSON.stringify({
                ...metadata,
                repoRoot: metadata.repoRoot ?? metadata.cwd,
                gittensorRoot: process.env.GITTENSOR_ROOT,
            }),
            encoding: "utf8",
            timeout: timeoutMs,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const durationMs = Date.now() - startedAt;
        let payload;
        try {
            payload = JSON.parse(output);
        }
        catch {
            return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", {
                durationMs,
                stderr: truncateText(output),
                fallbackMode: "metadata_only",
            });
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return scorerFailure("malformed_json", "External scorer stdout must be a JSON object.", {
                durationMs,
                fallbackMode: "metadata_only",
            });
        }
        const normalized = normalizeScorerOutput(payload);
        if (normalized.sourceTokenScore === undefined && normalized.totalTokenScore === undefined) {
            return scorerFailure("malformed_json", "External scorer JSON must include sourceTokenScore or totalTokenScore.", {
                durationMs,
                fallbackMode: "metadata_only",
            });
        }
        return stripUndefined({
            ok: true,
            code: "success",
            reason: "external_scorer_succeeded",
            durationMs,
            payload,
            fallbackMode: "external_command",
        });
    }
    catch (error) {
        return classifyScorerExecFailure(error, Date.now() - startedAt, scorerCommand);
    }
}
export function setupGuidanceForLocalScorer(status) {
    if (status.ok)
        return [];
    const safeStatus = sanitizeLocalScorerStatus(status);
    const code = safeStatus.code ?? inferScorerCode(safeStatus.reason);
    const guidance = [
        "LoopOver used metadata-only analysis because no external scorer succeeded.",
    ];
    switch (code) {
        case "missing_scorer_command":
            guidance.push(`Set GITTENSOR_SCORE_PREVIEW_CMD, for example: export GITTENSOR_SCORE_PREVIEW_CMD="${referenceScorePreviewExample("metadata")}"`);
            guidance.push(`For tree-sitter scoring with a local gittensor checkout: export GITTENSOR_ROOT=<local-gittensor-checkout> && export GITTENSOR_SCORE_PREVIEW_CMD="${referenceScorePreviewExample("gittensor")}"`);
            break;
        case "empty_scorer_command":
            guidance.push("GITTENSOR_SCORE_PREVIEW_CMD is set but empty; provide a command that reads branch metadata JSON from stdin.");
            break;
        case "timeout":
            guidance.push(`External scorer exceeded ${scorePreviewTimeoutMs()}ms; simplify the scorer or raise GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS.`);
            break;
        case "malformed_json":
            guidance.push("External scorer must print one JSON object with sourceTokenScore/totalTokenScore fields to stdout.");
            if (safeStatus.stderr)
                guidance.push(`Last scorer stdout snippet: ${truncateText(safeStatus.stderr, 160)}`);
            break;
        case "non_zero_exit":
            guidance.push("External scorer exited with a non-zero status; inspect stderr and run loopover-mcp doctor.");
            if (safeStatus.stderr)
                guidance.push(`Scorer stderr: ${truncateText(safeStatus.stderr, 160)}`);
            if (typeof safeStatus.exitCode === "number")
                guidance.push(`Exit code: ${safeStatus.exitCode}`);
            break;
        default:
            guidance.push("Set GITTENSOR_SCORE_PREVIEW_CMD to a command that reads branch metadata JSON from stdin and emits scoring metrics JSON.");
            if (safeStatus.reason)
                guidance.push(`Last scorer error: ${safeStatus.reason}`);
            break;
    }
    guidance.push("Local scorer output stays on your machine; LoopOver never uploads source contents.");
    return guidance;
}
export function probeLocalScorer(scorerCommand = resolveScorePreviewCommand()) {
    return sanitizeLocalScorerStatus(runExternalScorePreview({
        repoFullName: "JSONbored/loopover",
        branchName: "doctor-probe",
        changedFiles: [{ path: "src/example.ts", additions: 12, deletions: 2, status: "modified" }],
        repoRoot: process.cwd(),
    }, scorerCommand));
}
function gitOutput(cwd, args) {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    }
    catch {
        return "";
    }
}
export function gitLines(cwd, args) {
    return gitOutput(cwd, args)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}
function collectChangedFiles(cwd, baseRef) {
    // Read both halves with `-z`: the human format quotes non-ASCII/control-char paths, so a quoted
    // name-status key would never match the verbatim numstat key and the file's stats would be lost.
    const numstat = new Map(parseNumstat(cwd, baseRef).map((entry) => [entry.path, entry]));
    return parseNameStatus(cwd, baseRef).map((entry) => {
        const stats = numstat.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
        return stripUndefined({
            path: entry.path,
            previousPath: entry.previousPath,
            additions: stats.additions,
            deletions: stats.deletions,
            status: statusFromCode(entry.code),
            binary: stats.binary,
        });
    });
}
function parseNameStatus(cwd, baseRef) {
    // `-z`: the status code is its own field and paths are verbatim; a rename is followed by the old
    // then the new path, any other status by a single path.
    const records = gitOutput(cwd, ["diff", "--name-status", "-M", "-z", baseRef, "--"]).split("\0");
    const entries = [];
    for (let index = 0; index < records.length; index += 1) {
        const code = records[index];
        if (!code)
            continue;
        const isRename = code.startsWith("R");
        const previousPath = isRename ? records[index + 1] : undefined;
        const path = records[index + (isRename ? 2 : 1)];
        index += isRename ? 2 : 1;
        entries.push({ code, path: path, previousPath });
    }
    return entries;
}
function parseNumstat(cwd, baseRef) {
    // `-z`: paths are verbatim and a rename emits old/new as separate fields, not the lossy
    // "{a => b}" / "a => b" human form that left cross-directory renames keyed by an unmatchable string.
    const records = gitOutput(cwd, ["diff", "--numstat", "-M", "-z", baseRef, "--"]).split("\0");
    const entries = [];
    for (let index = 0; index < records.length; index += 1) {
        const stat = records[index];
        if (!stat)
            continue;
        const [added, deleted, inlinePath] = splitNumstatStat(stat);
        // An empty inline path marks a rename: the new path is the second of the two following fields.
        let path = inlinePath;
        if (inlinePath === "") {
            path = records[index + 2];
            index += 2;
        }
        const binary = added === "-";
        entries.push({ path: path, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
    }
    return entries;
}
function splitNumstatStat(stat) {
    // "<added>\t<deleted>\t<path?>" -- keep the path slice intact even if it contains tabs.
    const firstTab = stat.indexOf("\t");
    const secondTab = stat.indexOf("\t", firstTab + 1);
    return [stat.slice(0, firstTab), stat.slice(firstTab + 1, secondTab), stat.slice(secondTab + 1)];
}
function collectCommitMessages(cwd, baseRef) {
    const rangeMessages = gitLines(cwd, ["log", "--pretty=%B%x1e", `${baseRef}..HEAD`]).join("\n");
    const messages = rangeMessages
        .split("\u001e")
        .map((message) => message.trim())
        .filter(Boolean);
    if (messages.length > 0)
        return messages.slice(0, 30);
    const last = gitLines(cwd, ["log", "-1", "--pretty=%B"]).join("\n").trim();
    return last ? [last] : [];
}
function defaultBaseRef(cwd) {
    const originHead = gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])[0];
    if (originHead)
        return originHead;
    if (gitLines(cwd, ["rev-parse", "--verify", "origin/main"]).length > 0)
        return "origin/main";
    if (gitLines(cwd, ["rev-parse", "--verify", "origin/master"]).length > 0)
        return "origin/master";
    return "HEAD";
}
function collectRemoteTrackingSha(cwd, baseRef) {
    const match = String(baseRef ?? "").replace(/^refs\/remotes\//, "").match(/^origin\/(.+)$/);
    const branch = match?.[1];
    if (!branch)
        return undefined;
    const remoteRow = gitLines(cwd, ["ls-remote", "--heads", "origin", branch])[0];
    return remoteRow?.split(/\s+/)[0];
}
function normalizeScorerOutput(payload) {
    return stripUndefined({
        mode: "external_command",
        activeModel: stringValue(payload.activeModel ?? payload.active_model),
        sourceTokenScore: numberValue(payload.sourceTokenScore ?? payload.source_token_score ?? payload.source?.tokenScore),
        totalTokenScore: numberValue(payload.totalTokenScore ?? payload.total_token_score ?? payload.total?.tokenScore),
        sourceLines: numberValue(payload.sourceLines ?? payload.source_lines ?? payload.source?.lines),
        testTokenScore: numberValue(payload.testTokenScore ?? payload.test_token_score ?? payload.tests?.tokenScore),
        nonCodeTokenScore: numberValue(payload.nonCodeTokenScore ?? payload.non_code_token_score ?? payload.nonCode?.tokenScore),
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : undefined,
    });
}
function metadataOnlyScorer(status) {
    return {
        mode: "metadata_only",
        warnings: [status.reason ?? status.code ?? "external_scorer_unavailable"],
    };
}
function scorerFailure(code, reason, extra = {}) {
    return stripUndefined({
        ok: false,
        code,
        reason,
        fallbackMode: "metadata_only",
        ...extra,
    });
}
function classifyScorerExecFailure(error, durationMs, scorerCommand) {
    const execError = error && typeof error === "object" ? error : undefined;
    const stdout = String(execError?.stdout ?? execError?.output?.[1] ?? "").trim();
    const stderr = truncateText(execError?.stderr ?? execError?.output?.[2] ?? "");
    const exitCode = typeof execError?.status === "number" ? execError.status : undefined;
    if (stdout && !looksLikeScorerJson(stdout)) {
        return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", {
            durationMs,
            stderr: truncateText(stdout),
            scorerCommand: redactScorerCommand(scorerCommand),
            fallbackMode: "metadata_only",
        });
    }
    if (execError?.code === "ETIMEDOUT" || (execError?.killed && execError?.signal === "SIGTERM")) {
        return scorerFailure("timeout", `External scorer timed out after ${scorePreviewTimeoutMs()}ms.`, { durationMs, stderr, scorerCommand: redactScorerCommand(scorerCommand) });
    }
    if (typeof exitCode === "number" && exitCode !== 0) {
        return scorerFailure("non_zero_exit", `External scorer exited with status ${exitCode}.`, { durationMs, stderr, exitCode, scorerCommand: redactScorerCommand(scorerCommand) });
    }
    const message = error instanceof Error ? error.message : "external_scorer_failed";
    if (/JSON/i.test(message)) {
        return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", { durationMs, stderr, scorerCommand: redactScorerCommand(scorerCommand) });
    }
    if (stderr && !looksLikeScorerJson(stderr)) {
        return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", {
            durationMs,
            stderr: truncateText(stderr),
            scorerCommand: redactScorerCommand(scorerCommand),
            fallbackMode: "metadata_only",
        });
    }
    return scorerFailure("scorer_failed", redactLocalPath(message), { durationMs, stderr, exitCode, scorerCommand: redactScorerCommand(scorerCommand) });
}
function looksLikeScorerJson(output) {
    try {
        const payload = JSON.parse(output);
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
            return false;
        const normalized = normalizeScorerOutput(payload);
        return normalized.sourceTokenScore !== undefined || normalized.totalTokenScore !== undefined;
    }
    catch {
        return false;
    }
}
function inferScorerCode(reason) {
    const text = String(reason ?? "");
    if (text.includes("missing_scorer_command"))
        return "missing_scorer_command";
    if (text.includes("empty_scorer_command"))
        return "empty_scorer_command";
    if (/timed out|ETIMEDOUT/i.test(text))
        return "timeout";
    if (/JSON/i.test(text))
        return "malformed_json";
    if (/status \d+/i.test(text))
        return "non_zero_exit";
    return "scorer_failed";
}
function scorePreviewTimeoutMs() {
    const parsed = Number(process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS ?? 15000);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}
function truncateText(value, maxLength = 240) {
    const text = String(value ?? "").trim();
    if (!text)
        return undefined;
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
function splitCommand(command) {
    return String(command).match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}
function assertSourceUploadDisabled() {
    if (/^(1|true|yes)$/i.test(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false")) {
        throw new Error("LOOPOVER_UPLOAD_SOURCE=true is not supported in v1; local MCP sends metadata only.");
    }
}
// Word-boundary the closing keywords (as the server-side extractors in src/db/repositories.ts and
// src/signals/engine.ts already do) so a keyword embedded in a longer word does not spuriously link an
// issue: without \b, `hotfix 5` / `prefixes 12` matched the `fix`/`fixes` substring and captured the
// trailing number. The bare `#` branch stays boundary-free so `#123` still matches anywhere.
export function extractLinkedIssues(text) {
    const issues = [];
    for (const match of String(text).matchAll(/(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)|#)\s*#?(\d+)/gi))
        issues.push(Number(match[1]));
    return issues.filter((issue) => Number.isInteger(issue) && issue > 0);
}
function statusFromCode(code) {
    if (code.startsWith("A"))
        return "added";
    if (code.startsWith("M"))
        return "modified";
    if (code.startsWith("D"))
        return "deleted";
    if (code.startsWith("R"))
        return "renamed";
    if (code.startsWith("C"))
        return "copied";
    return "unknown";
}
function titleFromBranch(branchName) {
    return String(branchName ?? "")
        .replace(/^[-/_.\w]+\/(?=[^/]+$)/, "")
        .replace(/[-_]+/g, " ")
        .trim();
}
function firstCommitTitle(messages) {
    return messages.find((message) => message.trim().length > 0)?.split("\n")[0]?.trim();
}
function numberValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function stripUndefined(value) {
    if (Array.isArray(value))
        return value.map(stripUndefined);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)]));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9jYWwtYnJhbmNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9jYWwtYnJhbmNoLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUNsRCxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3ZDLE9BQU8sRUFBRSxVQUFVLEVBQVEsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUNoRSxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQ3pDLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxJQUFJLFVBQVUsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQzlGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUV6RCxPQUFPLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxlQUFlLEVBQUUsQ0FBQztBQWlHM0IsU0FBUyxvQkFBb0IsQ0FBQyxLQUFhO0lBQ3pDLElBQUksR0FBRyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7SUFDdkIsT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUU7UUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQzdELE9BQU8sR0FBRyxLQUFLLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELE1BQU0sVUFBVSxjQUFjLENBQUMsU0FBa0I7SUFDL0MsTUFBTSxPQUFPLEdBQUcsb0JBQW9CLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ3JFLE1B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