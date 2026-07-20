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
        /* v8 ignore next -- metadata.title is always a defined string (titleFromBranch never returns nullish) */
        title: metadata.title ?? "Local diff preflight",
        commitMessage: metadata.commitMessages.join("\n\n").trim(),
        changedFiles: metadata.changedFiles.map((file) => file.path),
        /* v8 ignore next -- collectChangedFiles always emits numeric additions/deletions, so the ?? 0 defaults never apply */
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
    /* v8 ignore next -- titleFromBranch never returns nullish, so the firstCommitTitle fallback is unreachable */
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
    /* v8 ignore next -- pop() on a non-empty split() result is always a string, so the "command" fallback is unreachable */
    const interpreter = parts[0]?.split(/[\\/]/).pop() ?? "command";
    const script = parts.at(-1)?.split(/[\\/]/).pop();
    if (script && /\.(mjs|js|cjs|py)$/i.test(script))
        return `${interpreter} <scorer-script>/${script}`;
    return "<configured-scorer-command>";
}
export function sanitizeLocalScorerStatus(status) {
    if (!status || typeof status !== "object")
        return status;
    return stripUndefined({
        ...status,
        reason: status.reason ? redactLocalPath(String(status.reason)) : undefined,
        stderr: status.stderr ? redactLocalPath(String(status.stderr)) : undefined,
        scorerCommand: status.scorerCommand ? redactScorerCommand(status.scorerCommand) : undefined,
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
        /* v8 ignore next -- with -z every --name-status path has a matching --numstat entry, so the default object is unused */
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
        entries.push({ code, path, previousPath });
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
        entries.push({ path, additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
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
    /* v8 ignore next -- baseRef is always the resolved non-null string from collectLocalBranchMetadata */
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
        /* v8 ignore next -- every failure status carries a reason, so the code / literal fallbacks are unreachable */
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
    /* v8 ignore next -- every truncateText caller passes a ?? ""-guarded string, so value is never nullish */
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
    /* v8 ignore next -- collectChangedFiles runs git diff with -M only (no -C), so copy (C) codes never occur */
    if (code.startsWith("C"))
        return "copied";
    return "unknown";
}
function titleFromBranch(branchName) {
    /* v8 ignore next -- titleFromBranch is only ever called with the resolved branchName string */
    return String(branchName ?? "")
        .replace(/^[-/_.\w]+\/(?=[^/]+$)/, "")
        .replace(/[-_]+/g, " ")
        .trim();
}
function firstCommitTitle(messages) {
    /* v8 ignore next -- unreachable: titleFromBranch never returns nullish, so line 125's chain never reaches firstCommitTitle */
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9jYWwtYnJhbmNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9jYWwtYnJhbmNoLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUNsRCxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3ZDLE9BQU8sRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUMxRCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQ3pDLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxJQUFJLFVBQVUsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQzlGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUV6RCxPQUFPLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxlQUFlLEVBQUUsQ0FBQztBQWtFM0IsU0FBUyxvQkFBb0IsQ0FBQyxLQUFhO0lBQ3pDLElBQUksR0FBRyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7SUFDdkIsT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUU7UUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQzdELE9BQU8sR0FBRyxLQUFLLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELE1BQU0sVUFBVSxjQUFjLENBQUMsU0FBaUI7SUFDOUMsTUFBTSxPQUFPLEdBQUcsb0JBQW9CLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ3JFLE1B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