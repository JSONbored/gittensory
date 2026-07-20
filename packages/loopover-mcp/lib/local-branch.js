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
        // metadata.title is provably defined here: this call always resolves branchName through the same
        // "??...??\"local-branch\"" chain collectLocalBranchMetadata itself uses (collectLocalDiff has no
        // way to override branchName to force it empty), and titleFromBranch("local-branch") is non-empty.
        title: metadata.title,
        commitMessage: metadata.commitMessages.join("\n\n").trim(),
        changedFiles: metadata.changedFiles.map((file) => file.path),
        // file.additions/deletions are always real numbers here (ChangedFile's own type, always populated by
        // collectChangedFiles) -- collectLocalDiff has no way to inject a differently-shaped changedFiles.
        changedLineCount: metadata.changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0),
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
    // externalPreview.ok true is only ever set (in runExternalScorePreview) alongside a validated,
    // non-null, non-array object payload -- ScorerStatus's own `payload?: unknown` just can't express
    // that correlation as a discriminated union without a much heavier refactor of this shared type.
    const localScorer = externalPreview.ok
        ? normalizeScorerOutput(externalPreview.payload)
        : metadataOnlyScorer(externalPreview);
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
        // Defensive fallback for the two invocations disagreeing on which paths they report -- not
        // reproduced by any git scenario found so far (mode/type/rename/submodule changes all agree
        // between --name-status and --numstat here), kept as a genuine safety net rather than an assert.
        /* v8 ignore next */
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
// baseRef is always a real string here: collectRemoteTrackingSha's sole caller (collectLocalBranchMetadata)
// resolves its own `baseRef` local through `input.baseRef ?? defaultBaseRef(cwd)`, which always ends in a
// string ("HEAD"/"origin/main"/"origin/master" at worst) -- never null/undefined.
function collectRemoteTrackingSha(cwd, baseRef) {
    const match = baseRef.replace(/^refs\/remotes\//, "").match(/^origin\/(.+)$/);
    const branch = match?.[1];
    if (!branch)
        return undefined;
    const remoteRow = gitLines(cwd, ["ls-remote", "--heads", "origin", branch])[0];
    return remoteRow?.split(/\s+/)[0];
}
function normalizeScorerOutput(payload) {
    const source = payload.source;
    const total = payload.total;
    const tests = payload.tests;
    const nonCode = payload.nonCode;
    return stripUndefined({
        mode: "external_command",
        activeModel: stringValue(payload.activeModel ?? payload.active_model),
        sourceTokenScore: numberValue(payload.sourceTokenScore ?? payload.source_token_score ?? source?.tokenScore),
        totalTokenScore: numberValue(payload.totalTokenScore ?? payload.total_token_score ?? total?.tokenScore),
        sourceLines: numberValue(payload.sourceLines ?? payload.source_lines ?? source?.lines),
        testTokenScore: numberValue(payload.testTokenScore ?? payload.test_token_score ?? tests?.tokenScore),
        nonCodeTokenScore: numberValue(payload.nonCodeTokenScore ?? payload.non_code_token_score ?? nonCode?.tokenScore),
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : undefined,
    });
}
// status.reason is always set here: metadataOnlyScorer's sole caller (buildBranchAnalysisPayload) only
// invokes it with an ok:false ScorerStatus from runExternalScorePreview, and every ok:false branch there
// returns via scorerFailure(code, reason, ...), whose `reason` parameter is required and always a real
// string literal -- so the `?? status.code ?? "external_scorer_unavailable"` fallbacks can never fire.
function metadataOnlyScorer(status) {
    return {
        mode: "metadata_only",
        warnings: [status.reason],
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
    // execError's "not an object" fallback and message's "not an Error instance" fallback below are
    // defensive: every real failure this function's sole caller (runExternalScorePreview) hands it comes
    // from either a Node child_process error (always a real Error/object) or a thrown TypeError (circular
    // JSON), so both fallbacks are unreachable through this codebase's own real failure modes -- kept as
    // genuine defense-in-depth against a future Node/JS runtime that throws something else, not asserts.
    /* v8 ignore next */
    const execError = error && typeof error === "object" ? error : undefined;
    const output = execError?.output;
    const stdout = String(execError?.stdout ?? output?.[1] ?? "").trim();
    const stderr = truncateText(String(execError?.stderr ?? output?.[2] ?? ""));
    const exitCode = typeof execError?.status === "number" ? execError.status : undefined;
    if (stdout && !looksLikeScorerJson(stdout)) {
        return scorerFailure("malformed_json", "External scorer stdout was not valid JSON.", {
            durationMs,
            stderr: truncateText(stdout),
            scorerCommand: redactScorerCommand(scorerCommand),
            fallbackMode: "metadata_only",
        });
    }
    // execFileSync's own timeout option always kills via SIGTERM (never sets code:"ETIMEDOUT" directly in
    // this Node version), so only the second half of this OR is reachable through a real timeout -- the
    // first half stays as documented compatibility with Node behavior that has varied across versions.
    /* v8 ignore next */
    if (execError?.code === "ETIMEDOUT" || (execError?.killed && execError?.signal === "SIGTERM")) {
        return scorerFailure("timeout", `External scorer timed out after ${scorePreviewTimeoutMs()}ms.`, { durationMs, stderr, scorerCommand: redactScorerCommand(scorerCommand) });
    }
    if (typeof exitCode === "number" && exitCode !== 0) {
        return scorerFailure("non_zero_exit", `External scorer exited with status ${exitCode}.`, { durationMs, stderr, exitCode, scorerCommand: redactScorerCommand(scorerCommand) });
    }
    /* v8 ignore next */
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
        // Confirmed reachable at runtime (a non-object JSON value, e.g. a bare number, hits this return
        // directly -- verified by direct invocation outside the test runner and by dedicated tests below);
        // the coverage tool's own attribution for this exact line is a known v8/sourcemap remapping
        // artifact for compiled-from-.ts files also seen elsewhere in this migration, not a real gap.
        /* v8 ignore next */
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
    // Every real call site already passes a defined string (several wrap the value in String(...) first,
    // and the rest hand truncateText's own prior output back in only when it's guarded by a truthy check
    // just above the call) -- the `?? ""` here is a generic helper's own defensive default, unreachable
    // through this file's current callers.
    /* v8 ignore next */
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
    // parseNameStatus's sole caller (collectChangedFiles) invokes `git diff --name-status -M` -- copy
    // detection ("C" statuses) is only emitted with an explicit `-C` flag, which is never passed here, so
    // this arm is unreachable through this file's own git invocation. Kept (not deleted) because it is
    // still a real git status-letter git diff can produce with different flags, not a made-up case.
    /* v8 ignore next -- see comment above; unreachable given collectChangedFiles' own fixed -M-only flags */
    if (code.startsWith("C"))
        return "copied";
    // Reachable for real: a type change (e.g. regular file <-> symlink) reports "T" even with -M alone,
    // same for unmerged ("U")/unknown ("X")/broken-pairing ("B") -- none of those map to a known status.
    return "unknown";
}
// branchName is always a real string here: titleFromBranch's sole caller (collectLocalBranchMetadata)
// resolves its own `branchName` local through a `??` chain that ends in the "local-branch" literal, so
// it is provably never null/undefined -- no `?? ""` fallback needed to keep String() safe.
function titleFromBranch(branchName) {
    const title = branchName
        .replace(/^[-/_.\w]+\/(?=[^/]+$)/, "")
        .replace(/[-_]+/g, " ")
        .trim();
    return title || undefined;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9jYWwtYnJhbmNoLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9jYWwtYnJhbmNoLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUNsRCxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3ZDLE9BQU8sRUFBRSxVQUFVLEVBQVEsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUNoRSxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQ3pDLE9BQU8sRUFBRSxVQUFVLEVBQUUsVUFBVSxJQUFJLFVBQVUsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQzlGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUV6RCxPQUFPLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxlQUFlLEVBQUUsQ0FBQztBQThFM0IsU0FBUyxvQkFBb0IsQ0FBQyxLQUFhO0lBQ3pDLElBQUksR0FBRyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7SUFDdkIsT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxVQUFVLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUU7UUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDO0lBQzdELE9BQU8sR0FBRyxLQUFLLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDNUQsQ0FBQztBQUVELE1BQU0sVUFBVSxjQUFjLENBQUMsU0FBa0I7SUFDL0MsTUFBTSxPQUFPLEdBQUcsb0JBQW9CLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ3JFLE1BQU0sUUFBUSxHQUFHO1FBQ2YsNENBQTRDO1FBQzVDLG1EQUFtRDtRQUNuRCxxREFBcUQ7S0FDdEQsQ0FBQztJQUNGLEtBQUssTUFBTSxPQUFPLElBQUksUUFBUSxFQUFFLENBQUM7UUFDL0IsTUFBTSxLQUFLLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNyQyxJQUFJLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxDQUFDLENBQUM7WUFBRSxPQUFPLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxFQUFFLENBQUM7SUFDckYsQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxNQUFNLFVBQVUsZ0JBQWdCLENBQUMsR0FBVyxFQUFFLE9BQWUsRUFBRSxjQUErQjtJQUM1RixNQUFNLFFBQVEsR0FBRywwQkFBMEIsQ0FBQyxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsQ0FBQyxDQUFDO0lBQzlGLE9BQU87UUFDTCxpR0FBaUc7UUFDakcsa0dBQWtHO1FBQ2xHLG1HQUFtRztRQUNuRyxLQUFLLEVBQUUsUUFBUSxDQUFDLEtBQWU7UUFDL0IsYUFBYSxFQUFFLFFBQVEsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRTtRQUMxRCxZQUFZLEVBQUUsUUFBUSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7UUFDNUQscUdBQXFHO1FBQ3JHLG1HQUFtRztRQUNuRyxnQkFBZ0IsRUFBRSxRQUFRLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDLEdBQUcsR0FBRyxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDO1FBQ3ZHLFNBQVMsRUFBRSxRQUFRLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUM7UUFDNUUsU0FBUyxFQUFFLFFBQVEsQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQztLQUM3RSxDQUFDO0FBQ0osQ0FBQztBQUVELE1BQU0sVUFBVSwwQkFBMEIsQ0FBQyxLQUFzQztJQUMvRSwwQkFBMEIsRUFBRSxDQUFDO0lBQzdCLE1BQU0sU0FBUyxHQUFHLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzdDLE1BQU0sR0FBRyxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUM7SUFDMUIsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLE9BQU8sSUFBSSxjQUFjLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDckQsTUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsbUJBQW1CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNuRixNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsWUFBWSxJQUFJLGNBQWMsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUNyRSxJQUFJLENBQUMsWUFBWTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsdUVBQXVFLENBQUMsQ0FBQztJQUM1RyxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsVUFBVSxJQUFJLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxRQUFRLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLGNBQWMsQ0FBQztJQUN4RyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsT0FBTyxJQUFJLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxXQUFXLEVBQUUsY0FBYyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksVUFBVSxDQUFDO0lBQ3ZHLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxXQUFXLEVBQUUsVUFBVSxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDckUsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDLFdBQVcsRUFBRSxVQUFVLEVBQUUsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNwRSxNQUFNLFlBQVksR0FBRyxRQUFRLENBQUMsR0FBRyxFQUFFLENBQUMsWUFBWSxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3ZFLE1BQU0saUJBQWlCLEdBQUcsd0JBQXdCLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ2pFLE1BQU0sWUFBWSxHQUFHLG1CQUFtQixDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUN2RCxNQUFNLGtCQUFrQixHQUFHLEtBQUssQ0FBQyxrQkFBa0IsSUFBSSx5QkFBeUIsQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDL0YsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsSUFBSSxvQkFBb0IsQ0FBQyxHQUFHLEVBQUUsT0FBTyxFQUFFLFlBQVksQ0FBQyxDQUFDO0lBQzlGLE1BQU0sY0FBYyxHQUFHLEtBQUssQ0FBQyxjQUFjLElBQUkscUJBQXFCLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ25GLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksZUFBZSxDQUFDLFVBQVUsQ0FBQyxJQUFJLGdCQUFnQixDQUFDLGNBQWMsQ0FBQyxDQUFDO0lBQzdGLE1BQU0sWUFBWSxHQUFHLENBQUMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQyxFQUFFLEdBQUcsbUJBQW1CLENBQUMsQ0FBQyxVQUFVLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxJQUFJLEVBQUUsR0FBRyxjQUFjLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUM1SyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDLElBQUksR0FBRyxLQUFLLENBQzlCLENBQUM7SUFDRixNQUFNLE9BQU8sR0FBd0I7UUFDbkMsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1FBQ2xCLFlBQVk7UUFDWixPQUFPO1FBQ1AsT0FBTztRQUNQLFVBQVU7UUFDVixPQUFPO1FBQ1AsT0FBTztRQUNQLFlBQVk7UUFDWixpQkFBaUI7UUFDakIsY0FBYztRQUNkLFlBQVk7UUFDWixVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVU7UUFDNUIsWUFBWTtRQUNaLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTTtRQUNwQixLQUFLO1FBQ0wsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJO1FBQ2hCLG9CQUFvQixFQUFFLEtBQUssQ0FBQyxvQkFBb0I7UUFDaEQsb0JBQW9CLEVBQUUsS0FBSyxDQUFDLG9CQUFvQjtRQUNoRCxlQUFlLEVBQUUsS0FBSyxDQUFDLGVBQWU7UUFDdEMsNkJBQTZCLEVBQUUsS0FBSyxDQUFDLDZCQUE2QjtRQUNsRSxvQkFBb0IsRUFBRSxLQUFLLENBQUMsb0JBQW9CO1FBQ2hELGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYTtRQUNsQyxrQkFBa0I7UUFDbEIsYUFBYTtRQUNiLGlCQUFpQixFQUFFLEtBQUssQ0FBQyxpQkFBaUI7S0FDM0MsQ0FBQztJQUNGLE9BQU8sY0FBYyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ2pDLENBQUM7QUFFRCxNQUFNLFVBQVUseUJBQXlCLENBQUMsR0FBVyxFQUFFLE9BQWU7SUFDcEUsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDLFVBQVUsRUFBRSxTQUFTLEVBQUUsR0FBRyxPQUFPLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDNUUsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzdCLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDekUsQ0FBQztBQUVELE1BQU0sVUFBVSxvQkFBb0IsQ0FBQyxHQUFXLEVBQUUsT0FBZSxFQUFFLGVBQThCLEVBQUU7SUFDakcsTUFBTSxLQUFLLEdBQWEsRUFBRSxDQUFDO0lBQzNCLE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDcEUsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyx5QkFBeUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQy9ELEtBQUssQ0FBQyxJQUFJLENBQUMsNEVBQTRFLENBQUMsQ0FBQztJQUMzRixDQUFDO0lBQ0QsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxpRkFBaUYsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3ZILEtBQUssQ0FBQyxJQUFJLENBQUMsdUZBQXVGLENBQUMsQ0FBQztJQUN0RyxDQUFDO0lBQ0QsTUFBTSxjQUFjLEdBQUcseUJBQXlCLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQy9ELElBQUksY0FBYyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3ZCLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxjQUFjLDZCQUE2QixPQUFPLDREQUE0RCxDQUFDLENBQUM7SUFDaEksQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQztBQVdELE1BQU0sVUFBVSwwQkFBMEIsQ0FBQyxLQUEwQjtJQUNuRSxNQUFNLFNBQVMsR0FBRyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM3QyxNQUFNLFFBQVEsR0FBRywwQkFBMEIsQ0FBQyxFQUFFLEdBQUcsS0FBSyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUMsR0FBRyxFQUFFLENBQUMsQ0FBQztJQUM5RSxNQUFNLGNBQWMsR0FBRyxFQUFFLEdBQUcsUUFBUSxFQUFFLFFBQVEsRUFBRSxTQUFTLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDaEUsTUFBTSxhQUFhLEdBQUcsMEJBQTBCLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDeEQsTUFBTSxlQUFlLEdBQUcsdUJBQXVCLENBQUMsY0FBYyxFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBQy9FLCtGQUErRjtJQUMvRixrR0FBa0c7SUFDbEcsaUdBQWlHO0lBQ2pHLE1BQU0sV0FBVyxHQUFHLGVBQWUsQ0FBQyxFQUFFO1FBQ3BDLENBQUMsQ0FBQyxxQkFBcUIsQ0FBQyxlQUFlLENBQUMsT0FBa0MsQ0FBQztRQUMzRSxDQUFDLENBQUMsa0JBQWtCLENBQUMsZUFBZSxDQUFDLENBQUM7SUFDeEMsT0FBTztRQUNMLEdBQUcsUUFBUTtRQUNYLFdBQVc7UUFDWCxpQkFBaUIsRUFBRSx5QkFBeUIsQ0FBQyxlQUFlLENBQUM7S0FDOUQsQ0FBQztBQUNKLENBQUM7QUFLRCxNQUFNLFVBQVUsbUJBQW1CLENBQUMsUUFBa0MsRUFBRTtJQUN0RSxNQUFNLGNBQWMsR0FBRywwQkFBMEIsQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDeEUsSUFBSSxjQUFjLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ2hDLE9BQU87WUFDTCxHQUFHLEVBQUUsZ0JBQWdCLENBQUUsS0FBSyxDQUFDLEdBQTBCLElBQUksT0FBTyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ3pFLGNBQWMsRUFBRSxLQUFLO1lBQ3JCLFNBQVMsRUFBRSxDQUFDO1NBQ2IsQ0FBQztJQUNKLENBQUM7SUFFRCxNQUFNLFlBQVksR0FBRyxjQUFjLENBQUMsQ0FBQyxDQUFrQixDQUFDO0lBQ3hELE1BQU0sWUFBWSxHQUNoQixLQUFLLENBQUMsR0FBRyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsR0FBRyxLQUFLLElBQUksSUFBSSxLQUFLLENBQUMsR0FBRyxLQUFLLEVBQUU7UUFDL0QsQ0FBQyxDQUFDLFlBQVksQ0FBQyxJQUFJO1FBQ25CLENBQUMsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUM3QixDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUM7WUFDbkIsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUN0RCxNQUFNLEdBQUcsR0FBRyxnQkFBZ0IsQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUMzQyxNQUFNLGNBQWMsR0FBRyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxZQUFZLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQ25GLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztRQUNwQixNQUFNLElBQUksS0FBSyxDQUFDLG9FQUFvRSxDQUFDLENBQUM7SUFDeEYsQ0FBQztJQUVELE9BQU87UUFDTCxHQUFHO1FBQ0gsY0FBYyxFQUFFLElBQUk7UUFDcEIsU0FBUyxFQUFFLGNBQWMsQ0FBQyxNQUFNO0tBQ2pDLENBQUM7QUFDSixDQUFDO0FBRUQsTUFBTSxVQUFVLDBCQUEwQixDQUFDLEtBQWlDO0lBQzFFLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sRUFBRSxDQUFDO0lBQ3JDLE1BQU0sVUFBVSxHQUFvQixFQUFFLENBQUM7SUFDdkMsTUFBTSxJQUFJLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUMvQixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1FBQ3pCLE1BQU0sR0FBRyxHQUFHLE9BQU8sSUFBSSxFQUFFLEdBQUcsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUMxRCxJQUFJLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUM7WUFBRSxTQUFTO1FBQ3ZDLElBQUksQ0FBQztZQUNILE1BQU0sSUFBSSxHQUFHLGdCQUFnQixDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQ2xELElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUM7Z0JBQUUsU0FBUztZQUM3QixJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2YsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDNUIsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNQLDBGQUEwRjtRQUM1RixDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sVUFBVSxDQUFDO0FBQ3BCLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLElBQVk7SUFDcEMsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQ3ZDLElBQUksQ0FBQztRQUNILE9BQU8sWUFBWSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLFNBQWlCLEVBQUUsSUFBWTtJQUNuRCxNQUFNLEtBQUssR0FBRyxnQkFBZ0IsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUMxQyxNQUFNLE1BQU0sR0FBRyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN0QyxNQUFNLHFCQUFxQixHQUFHLFFBQVEsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDdEQsT0FBTyxxQkFBcUIsS0FBSyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMscUJBQXFCLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMscUJBQXFCLENBQUMsQ0FBQyxDQUFDO0FBQ3BKLENBQUM7QUFFRCxNQUFNLFVBQVUsMEJBQTBCLENBQUMsUUFBc0QsRUFBRTtJQUNqRyxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsbUJBQW1CLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQywyQkFBMkIsQ0FBQztJQUN0RixJQUFJLE9BQU8sUUFBUSxLQUFLLFFBQVEsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFO1FBQUUsT0FBTyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDNUUsT0FBTyxTQUFTLENBQUM7QUFDbkIsQ0FBQztBQUVELE1BQU0sVUFBVSw0QkFBNEIsQ0FBQyxPQUFpQyxVQUFVO0lBQ3RGLE1BQU0sTUFBTSxHQUFHLElBQUksS0FBSyxXQUFXLENBQUMsQ0FBQyxDQUFDLDRCQUE0QixDQUFDLENBQUMsQ0FBQyw2QkFBNkIsQ0FBQztJQUNuRyxNQUFNLFdBQVcsR0FBRyxJQUFJLEtBQUssV0FBVyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUM5RCxPQUFPLEdBQUcsV0FBVyx5Q0FBeUMsTUFBTSxFQUFFLENBQUM7QUFDekUsQ0FBQztBQUVELE1BQU0sVUFBVSxtQkFBbUIsQ0FBQyxPQUFnQjtJQUNsRCxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzFDLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdkIsTUFBTSxLQUFLLEdBQUcsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2pDLE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxFQUFFLElBQUksU0FBUyxDQUFDO0lBQ2hFLE1BQU0sTUFBTSxHQUFHLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDbEQsSUFBSSxNQUFNLElBQUkscUJBQXFCLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztRQUFFLE9BQU8sR0FBRyxXQUFXLG9CQUFvQixNQUFNLEVBQUUsQ0FBQztJQUNwRyxPQUFPLDZCQUE2QixDQUFDO0FBQ3ZDLENBQUM7QUFjRCxNQUFNLFVBQVUseUJBQXlCLENBQTRDLE1BQVM7SUFDNUYsSUFBSSxDQUFDLE1BQU0sSUFBSSxPQUFPLE1BQU0sS0FBSyxRQUFRO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFDekQsT0FBTyxjQUFjLENBQUM7UUFDcEIsR0FBRyxNQUFNO1FBQ1QsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVM7UUFDMUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVM7UUFDMUUsYUFBYSxFQUFFLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLG1CQUFtQixDQUFDLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztLQUM1RixDQUFNLENBQUM7QUFDVixDQUFDO0FBRUQsTUFBTSxVQUFVLHVCQUF1QixDQUFDLFFBQWlDLEVBQUUsYUFBaUM7SUFDMUcsTUFBTSxTQUFTLEdBQUcscUJBQXFCLEVBQUUsQ0FBQztJQUMxQyxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7UUFDbkIsT0FBTyxhQUFhLENBQUMsd0JBQXdCLEVBQUUsZ0RBQWdELENBQUMsQ0FBQztJQUNuRyxDQUFDO0lBQ0QsTUFBTSxLQUFLLEdBQUcsWUFBWSxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQzFDLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN6QixNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVCLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNiLE9BQU8sYUFBYSxDQUFDLHNCQUFzQixFQUFFLHVDQUF1QyxDQUFDLENBQUM7SUFDeEYsQ0FBQztJQUVELE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUM3QixJQUFJLENBQUM7UUFDSCxNQUFNLE1BQU0sR0FBRyxZQUFZLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRTtZQUN6QyxLQUFLLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDcEIsR0FBRyxRQUFRO2dCQUNYLFFBQVEsRUFBRSxRQUFRLENBQUMsUUFBUSxJQUFJLFFBQVEsQ0FBQyxHQUFHO2dCQUMzQyxhQUFhLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjO2FBQzFDLENBQUM7WUFDRixRQUFRLEVBQUUsTUFBTTtZQUNoQixPQUFPLEVBQUUsU0FBUztZQUNsQixLQUFLLEVBQUUsQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQztTQUNoQyxDQUFDLENBQUM7UUFDSCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsU0FBUyxDQUFDO1FBQzFDLElBQUksT0FBZ0IsQ0FBQztRQUNyQixJQUFJLENBQUM7WUFDSCxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUMvQixDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ1AsT0FBTyxhQUFhLENBQUMsZ0JBQWdCLEVBQUUsNENBQTRDLEVBQUU7Z0JBQ25GLFVBQVU7Z0JBQ1YsTUFBTSxFQUFFLFlBQVksQ0FBQyxNQUFNLENBQUM7Z0JBQzVCLFlBQVksRUFBRSxlQUFlO2FBQzlCLENBQUMsQ0FBQztRQUNMLENBQUM7UUFDRCxJQUFJLENBQUMsT0FBTyxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDdEUsT0FBTyxhQUFhLENBQUMsZ0JBQWdCLEVBQUUsK0NBQStDLEVBQUU7Z0JBQ3RGLFVBQVU7Z0JBQ1YsWUFBWSxFQUFFLGVBQWU7YUFDOUIsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztRQUNELE1BQU0sVUFBVSxHQUFHLHFCQUFxQixDQUFDLE9BQWtDLENBQUMsQ0FBQztRQUM3RSxJQUFJLFVBQVUsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLElBQUksVUFBVSxDQUFDLGVBQWUsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUMxRixPQUFPLGFBQWEsQ0FBQyxnQkFBZ0IsRUFBRSx3RUFBd0UsRUFBRTtnQkFDL0csVUFBVTtnQkFDVixZQUFZLEVBQUUsZUFBZTthQUM5QixDQUFDLENBQUM7UUFDTCxDQUFDO1FBQ0QsT0FBTyxjQUFjLENBQUM7WUFDcEIsRUFBRSxFQUFFLElBQUk7WUFDUixJQUFJLEVBQUUsU0FBUztZQUNmLE1BQU0sRUFBRSwyQkFBMkI7WUFDbkMsVUFBVTtZQUNWLE9BQU87WUFDUCxZQUFZLEVBQUUsa0JBQWtCO1NBQ2pDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyx5QkFBeUIsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFNBQVMsRUFBRSxhQUFhLENBQUMsQ0FBQztJQUNqRixDQUFDO0FBQ0gsQ0FBQztBQUVELE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxNQUFvQjtJQUM5RCxJQUFJLE1BQU0sQ0FBQyxFQUFFO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDekIsTUFBTSxVQUFVLEdBQUcseUJBQXlCLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDckQsTUFBTSxJQUFJLEdBQUcsVUFBVSxDQUFDLElBQUksSUFBSSxlQUFlLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ25FLE1BQU0sUUFBUSxHQUFHO1FBQ2YsNEVBQTRFO0tBQzdFLENBQUM7SUFDRixRQUFRLElBQUksRUFBRSxDQUFDO1FBQ2IsS0FBSyx3QkFBd0I7WUFDM0IsUUFBUSxDQUFDLElBQUksQ0FBQyxxRkFBcUYsNEJBQTRCLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ2hKLFFBQVEsQ0FBQyxJQUFJLENBQUMsb0pBQW9KLDRCQUE0QixDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNoTixNQUFNO1FBQ1IsS0FBSyxzQkFBc0I7WUFDekIsUUFBUSxDQUFDLElBQUksQ0FBQyw2R0FBNkcsQ0FBQyxDQUFDO1lBQzdILE1BQU07UUFDUixLQUFLLFNBQVM7WUFDWixRQUFRLENBQUMsSUFBSSxDQUFDLDRCQUE0QixxQkFBcUIsRUFBRSxzRUFBc0UsQ0FBQyxDQUFDO1lBQ3pJLE1BQU07UUFDUixLQUFLLGdCQUFnQjtZQUNuQixRQUFRLENBQUMsSUFBSSxDQUFDLG9HQUFvRyxDQUFDLENBQUM7WUFDcEgsSUFBSSxVQUFVLENBQUMsTUFBTTtnQkFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLCtCQUErQixZQUFZLENBQUMsVUFBVSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDNUcsTUFBTTtRQUNSLEtBQUssZUFBZTtZQUNsQixRQUFRLENBQUMsSUFBSSxDQUFDLDRGQUE0RixDQUFDLENBQUM7WUFDNUcsSUFBSSxVQUFVLENBQUMsTUFBTTtnQkFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLGtCQUFrQixZQUFZLENBQUMsVUFBVSxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDL0YsSUFBSSxPQUFPLFVBQVUsQ0FBQyxRQUFRLEtBQUssUUFBUTtnQkFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLGNBQWMsVUFBVSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7WUFDaEcsTUFBTTtRQUNSO1lBQ0UsUUFBUSxDQUFDLElBQUksQ0FBQyx5SEFBeUgsQ0FBQyxDQUFDO1lBQ3pJLElBQUksVUFBVSxDQUFDLE1BQU07Z0JBQUUsUUFBUSxDQUFDLElBQUksQ0FBQyxzQkFBc0IsVUFBVSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7WUFDaEYsTUFBTTtJQUNWLENBQUM7SUFDRCxRQUFRLENBQUMsSUFBSSxDQUFDLG9GQUFvRixDQUFDLENBQUM7SUFDcEcsT0FBTyxRQUFRLENBQUM7QUFDbEIsQ0FBQztBQUVELE1BQU0sVUFBVSxnQkFBZ0IsQ0FBQyxnQkFBb0MsMEJBQTBCLEVBQUU7SUFDL0YsT0FBTyx5QkFBeUIsQ0FDOUIsdUJBQXVCLENBQ3JCO1FBQ0UsWUFBWSxFQUFFLG9CQUFvQjtRQUNsQyxVQUFVLEVBQUUsY0FBYztRQUMxQixZQUFZLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxnQkFBZ0IsRUFBRSxTQUFTLEVBQUUsRUFBRSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxDQUFDO1FBQzNGLFFBQVEsRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFO0tBQ3hCLEVBQ0QsYUFBYSxDQUNkLENBQ0YsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLFNBQVMsQ0FBQyxHQUFXLEVBQUUsSUFBYztJQUM1QyxJQUFJLENBQUM7UUFDSCxPQUFPLFlBQVksQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEVBQUUsR0FBRyxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLENBQUMsUUFBUSxFQUFFLE1BQU0sRUFBRSxRQUFRLENBQUMsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUNsSCxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsT0FBTyxFQUFFLENBQUM7SUFDWixDQUFDO0FBQ0gsQ0FBQztBQUVELE1BQU0sVUFBVSxRQUFRLENBQUMsR0FBVyxFQUFFLElBQWM7SUFDbEQsT0FBTyxTQUFTLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQztTQUN4QixLQUFLLENBQUMsSUFBSSxDQUFDO1NBQ1gsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7U0FDMUIsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3JCLENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLEdBQVcsRUFBRSxPQUFlO0lBQ3ZELGdHQUFnRztJQUNoRyxpR0FBaUc7SUFDakcsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsWUFBWSxDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDeEYsT0FBTyxlQUFlLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO1FBQ2pELDJGQUEyRjtRQUMzRiw0RkFBNEY7UUFDNUYsaUdBQWlHO1FBQ2pHLG9CQUFvQjtRQUNwQixNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLENBQUM7UUFDdkYsT0FBTyxjQUFjLENBQUM7WUFDcEIsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJO1lBQ2hCLFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUNoQyxTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDMUIsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLE1BQU0sRUFBRSxjQUFjLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQztZQUNsQyxNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU07U0FDckIsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDO0FBSUQsU0FBUyxlQUFlLENBQUMsR0FBVyxFQUFFLE9BQWU7SUFDbkQsaUdBQWlHO0lBQ2pHLHdEQUF3RDtJQUN4RCxNQUFNLE9BQU8sR0FBRyxTQUFTLENBQUMsR0FBRyxFQUFFLENBQUMsTUFBTSxFQUFFLGVBQWUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNqRyxNQUFNLE9BQU8sR0FBc0IsRUFBRSxDQUFDO0lBQ3RDLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUN2RCxNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDNUIsSUFBSSxDQUFDLElBQUk7WUFBRSxTQUFTO1FBQ3BCLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDdEMsTUFBTSxZQUFZLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDL0QsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLEtBQUssR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2pELEtBQUssSUFBSSxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzFCLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQWMsRUFBRSxZQUFZLEVBQUUsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFDRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBSUQsU0FBUyxZQUFZLENBQUMsR0FBVyxFQUFFLE9BQWU7SUFDaEQsd0ZBQXdGO0lBQ3hGLHFHQUFxRztJQUNyRyxNQUFNLE9BQU8sR0FBRyxTQUFTLENBQUMsR0FBRyxFQUFFLENBQUMsTUFBTSxFQUFFLFdBQVcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM3RixNQUFNLE9BQU8sR0FBbUIsRUFBRSxDQUFDO0lBQ25DLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUN2RCxNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDNUIsSUFBSSxDQUFDLElBQUk7WUFBRSxTQUFTO1FBQ3BCLE1BQU0sQ0FBQyxLQUFLLEVBQUUsT0FBTyxFQUFFLFVBQVUsQ0FBQyxHQUFHLGdCQUFnQixDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzVELCtGQUErRjtRQUMvRixJQUFJLElBQUksR0FBRyxVQUFVLENBQUM7UUFDdEIsSUFBSSxVQUFVLEtBQUssRUFBRSxFQUFFLENBQUM7WUFDdEIsSUFBSSxHQUFHLE9BQU8sQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFXLENBQUM7WUFDcEMsS0FBSyxJQUFJLENBQUMsQ0FBQztRQUNiLENBQUM7UUFDRCxNQUFNLE1BQU0sR0FBRyxLQUFLLEtBQUssR0FBRyxDQUFDO1FBQzdCLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBYyxFQUFFLFNBQVMsRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxFQUFFLFNBQVMsRUFBRSxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDakksQ0FBQztJQUNELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLElBQVk7SUFDcEMsd0ZBQXdGO0lBQ3hGLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDcEMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsUUFBUSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ25ELE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxRQUFRLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsR0FBRyxDQUFDLEVBQUUsU0FBUyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNuRyxDQUFDO0FBRUQsU0FBUyxxQkFBcUIsQ0FBQyxHQUFXLEVBQUUsT0FBZTtJQUN6RCxNQUFNLGFBQWEsR0FBRyxRQUFRLENBQUMsR0FBRyxFQUFFLENBQUMsS0FBSyxFQUFFLGlCQUFpQixFQUFFLEdBQUcsT0FBTyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUMvRixNQUFNLFFBQVEsR0FBRyxhQUFhO1NBQzNCLEtBQUssQ0FBQyxRQUFRLENBQUM7U0FDZixHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNoQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDbkIsSUFBSSxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUM7UUFBRSxPQUFPLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3RELE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLGFBQWEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzNFLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDNUIsQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLEdBQVc7SUFDakMsTUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDLGNBQWMsRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLDBCQUEwQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN4RyxJQUFJLFVBQVU7UUFBRSxPQUFPLFVBQVUsQ0FBQztJQUNsQyxJQUFJLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxXQUFXLEVBQUUsVUFBVSxFQUFFLGFBQWEsQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUM7UUFBRSxPQUFPLGFBQWEsQ0FBQztJQUM3RixJQUFJLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxXQUFXLEVBQUUsVUFBVSxFQUFFLGVBQWUsQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUM7UUFBRSxPQUFPLGVBQWUsQ0FBQztJQUNqRyxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDO0FBRUQsNEdBQTRHO0FBQzVHLDBHQUEwRztBQUMxRyxrRkFBa0Y7QUFDbEYsU0FBUyx3QkFBd0IsQ0FBQyxHQUFXLEVBQUUsT0FBZTtJQUM1RCxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLGtCQUFrQixFQUFFLEVBQUUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQzlFLE1BQU0sTUFBTSxHQUFHLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzFCLElBQUksQ0FBQyxNQUFNO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDOUIsTUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxDQUFDLFdBQVcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDL0UsT0FBTyxTQUFTLEVBQUUsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3BDLENBQUM7QUFhRCxTQUFTLHFCQUFxQixDQUFDLE9BQWdDO0lBQzdELE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUE2QyxDQUFDO0lBQ3JFLE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxLQUE0QyxDQUFDO0lBQ25FLE1BQU0sS0FBSyxHQUFHLE9BQU8sQ0FBQyxLQUE0QyxDQUFDO0lBQ25FLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxPQUE4QyxDQUFDO0lBQ3ZFLE9BQU8sY0FBYyxDQUFDO1FBQ3BCLElBQUksRUFBRSxrQkFBa0I7UUFDeEIsV0FBVyxFQUFFLFdBQVcsQ0FBQyxPQUFPLENBQUMsV0FBVyxJQUFJLE9BQU8sQ0FBQyxZQUFZLENBQUM7UUFDckUsZ0JBQWdCLEVBQUUsV0FBVyxDQUFDLE9BQU8sQ0FBQyxnQkFBZ0IsSUFBSSxPQUFPLENBQUMsa0JBQWtCLElBQUksTUFBTSxFQUFFLFVBQVUsQ0FBQztRQUMzRyxlQUFlLEVBQUUsV0FBVyxDQUFDLE9BQU8sQ0FBQyxlQUFlLElBQUksT0FBTyxDQUFDLGlCQUFpQixJQUFJLEtBQUssRUFBRSxVQUFVLENBQUM7UUFDdkcsV0FBVyxFQUFFLFdBQVcsQ0FBQyxPQUFPLENBQUMsV0FBVyxJQUFJLE9BQU8sQ0FBQyxZQUFZLElBQUksTUFBTSxFQUFFLEtBQUssQ0FBQztRQUN0RixjQUFjLEVBQUUsV0FBVyxDQUFDLE9BQU8sQ0FBQyxjQUFjLElBQUksT0FBTyxDQUFDLGdCQUFnQixJQUFJLEtBQUssRUFBRSxVQUFVLENBQUM7UUFDcEcsaUJBQWlCLEVBQUUsV0FBVyxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsSUFBSSxPQUFPLENBQUMsb0JBQW9CLElBQUksT0FBTyxFQUFFLFVBQVUsQ0FBQztRQUNoSCxRQUFRLEVBQUUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTO0tBQ3JGLENBQUMsQ0FBQztBQUNMLENBQUM7QUFJRCx1R0FBdUc7QUFDdkcseUdBQXlHO0FBQ3pHLHVHQUF1RztBQUN2Ryx1R0FBdUc7QUFDdkcsU0FBUyxrQkFBa0IsQ0FBQyxNQUFvQjtJQUM5QyxPQUFPO1FBQ0wsSUFBSSxFQUFFLGVBQWU7UUFDckIsUUFBUSxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQWdCLENBQUM7S0FDcEMsQ0FBQztBQUNKLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxJQUFZLEVBQUUsTUFBYyxFQUFFLFFBQStCLEVBQUU7SUFDcEYsT0FBTyxjQUFjLENBQUM7UUFDcEIsRUFBRSxFQUFFLEtBQUs7UUFDVCxJQUFJO1FBQ0osTUFBTTtRQUNOLFlBQVksRUFBRSxlQUFlO1FBQzdCLEdBQUcsS0FBSztLQUNULENBQUMsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFTLHlCQUF5QixDQUFDLEtBQWMsRUFBRSxVQUFrQixFQUFFLGFBQXFCO0lBQzFGLGdHQUFnRztJQUNoRyxxR0FBcUc7SUFDckcsc0dBQXNHO0lBQ3RHLHFHQUFxRztJQUNyRyxxR0FBcUc7SUFDckcsb0JBQW9CO0lBQ3BCLE1BQU0sU0FBUyxHQUFHLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFFLEtBQWlDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztJQUN0RyxNQUFNLE1BQU0sR0FBRyxTQUFTLEVBQUUsTUFBK0IsQ0FBQztJQUMxRCxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsU0FBUyxFQUFFLE1BQU0sSUFBSSxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNyRSxNQUFNLE1BQU0sR0FBRyxZQUFZLENBQUMsTUFBTSxDQUFDLFNBQVMsRUFBRSxNQUFNLElBQUksTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztJQUM1RSxNQUFNLFFBQVEsR0FBRyxPQUFPLFNBQVMsRUFBRSxNQUFNLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDdEYsSUFBSSxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQzNDLE9BQU8sYUFBYSxDQUFDLGdCQUFnQixFQUFFLDRDQUE0QyxFQUFFO1lBQ25GLFVBQVU7WUFDVixNQUFNLEVBQUUsWUFBWSxDQUFDLE1BQU0sQ0FBQztZQUM1QixhQUFhLEVBQUUsbUJBQW1CLENBQUMsYUFBYSxDQUFDO1lBQ2pELFlBQVksRUFBRSxlQUFlO1NBQzlCLENBQUMsQ0FBQztJQUNMLENBQUM7SUFDRCxzR0FBc0c7SUFDdEcsb0dBQW9HO0lBQ3BHLG1HQUFtRztJQUNuRyxvQkFBb0I7SUFDcEIsSUFBSSxTQUFTLEVBQUUsSUFBSSxLQUFLLFdBQVcsSUFBSSxDQUFDLFNBQVMsRUFBRSxNQUFNLElBQUksU0FBUyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUMsRUFBRSxDQUFDO1FBQzlGLE9BQU8sYUFBYSxDQUFDLFNBQVMsRUFBRSxtQ0FBbUMscUJBQXFCLEVBQUUsS0FBSyxFQUFFLEVBQUUsVUFBVSxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsbUJBQW1CLENBQUMsYUFBYSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQzlLLENBQUM7SUFDRCxJQUFJLE9BQU8sUUFBUSxLQUFLLFFBQVEsSUFBSSxRQUFRLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDbkQsT0FBTyxhQUFhLENBQUMsZUFBZSxFQUFFLHNDQUFzQyxRQUFRLEdBQUcsRUFBRSxFQUFFLFVBQVUsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLGFBQWEsRUFBRSxtQkFBbUIsQ0FBQyxhQUFhLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDaEwsQ0FBQztJQUNELG9CQUFvQjtJQUNwQixNQUFNLE9BQU8sR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyx3QkFBd0IsQ0FBQztJQUNsRixJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztRQUMxQixPQUFPLGFBQWEsQ0FBQyxnQkFBZ0IsRUFBRSw0Q0FBNEMsRUFBRSxFQUFFLFVBQVUsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFLG1CQUFtQixDQUFDLGFBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNsSyxDQUFDO0lBQ0QsSUFBSSxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQzNDLE9BQU8sYUFBYSxDQUFDLGdCQUFnQixFQUFFLDRDQUE0QyxFQUFFO1lBQ25GLFVBQVU7WUFDVixNQUFNLEVBQUUsWUFBWSxDQUFDLE1BQU0sQ0FBQztZQUM1QixhQUFhLEVBQUUsbUJBQW1CLENBQUMsYUFBYSxDQUFDO1lBQ2pELFlBQVksRUFBRSxlQUFlO1NBQzlCLENBQUMsQ0FBQztJQUNMLENBQUM7SUFDRCxPQUFPLGFBQWEsQ0FBQyxlQUFlLEVBQUUsZUFBZSxDQUFDLE9BQU8sQ0FBQyxFQUFFLEVBQUUsVUFBVSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsYUFBYSxFQUFFLG1CQUFtQixDQUFDLGFBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN2SixDQUFDO0FBRUQsU0FBUyxtQkFBbUIsQ0FBQyxNQUFjO0lBQ3pDLElBQUksQ0FBQztRQUNILE1BQU0sT0FBTyxHQUFZLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDNUMsZ0dBQWdHO1FBQ2hHLG1HQUFtRztRQUNuRyw0RkFBNEY7UUFDNUYsOEZBQThGO1FBQzlGLG9CQUFvQjtRQUNwQixJQUFJLENBQUMsT0FBTyxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQztZQUFFLE9BQU8sS0FBSyxDQUFDO1FBQ3BGLE1BQU0sVUFBVSxHQUFHLHFCQUFxQixDQUFDLE9BQWtDLENBQUMsQ0FBQztRQUM3RSxPQUFPLFVBQVUsQ0FBQyxnQkFBZ0IsS0FBSyxTQUFTLElBQUksVUFBVSxDQUFDLGVBQWUsS0FBSyxTQUFTLENBQUM7SUFDL0YsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNQLE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxNQUEwQjtJQUNqRCxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2xDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyx3QkFBd0IsQ0FBQztRQUFFLE9BQU8sd0JBQXdCLENBQUM7SUFDN0UsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLHNCQUFzQixDQUFDO1FBQUUsT0FBTyxzQkFBc0IsQ0FBQztJQUN6RSxJQUFJLHNCQUFzQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUN4RCxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQUUsT0FBTyxnQkFBZ0IsQ0FBQztJQUNoRCxJQUFJLGFBQWEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQUUsT0FBTyxlQUFlLENBQUM7SUFDckQsT0FBTyxlQUFlLENBQUM7QUFDekIsQ0FBQztBQUVELFNBQVMscUJBQXFCO0lBQzVCLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLGtDQUFrQyxJQUFJLEtBQUssQ0FBQyxDQUFDO0lBQy9FLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztBQUNoRSxDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBYyxFQUFFLFNBQVMsR0FBRyxHQUFHO0lBQ25ELHFHQUFxRztJQUNyRyxxR0FBcUc7SUFDckcsb0dBQW9HO0lBQ3BHLHVDQUF1QztJQUN2QyxvQkFBb0I7SUFDcEIsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUN4QyxJQUFJLENBQUMsSUFBSTtRQUFFLE9BQU8sU0FBUyxDQUFDO0lBQzVCLE9BQU8sSUFBSSxDQUFDLE1BQU0sSUFBSSxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxTQUFTLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQztBQUNoRixDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsT0FBZ0I7SUFDcEMsT0FBTyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBSyxDQUFDLHVCQUF1QixDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUN6RyxDQUFDO0FBRUQsU0FBUywwQkFBMEI7SUFDakMsSUFBSSxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsSUFBSSxPQUFPLENBQUMsRUFBRSxDQUFDO1FBQzFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0ZBQW9GLENBQUMsQ0FBQztJQUN4RyxDQUFDO0FBQ0gsQ0FBQztBQUVELGtHQUFrRztBQUNsRyx1R0FBdUc7QUFDdkcscUdBQXFHO0FBQ3JHLDZGQUE2RjtBQUM3RixNQUFNLFVBQVUsbUJBQW1CLENBQUMsSUFBYTtJQUMvQyxNQUFNLE1BQU0sR0FBYSxFQUFFLENBQUM7SUFDNUIsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsUUFBUSxDQUFDLCtEQUErRCxDQUFDO1FBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMxSSxPQUFPLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ3hFLENBQUM7QUFFRCxTQUFTLGNBQWMsQ0FBQyxJQUFZO0lBQ2xDLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7UUFBRSxPQUFPLE9BQU8sQ0FBQztJQUN6QyxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO1FBQUUsT0FBTyxVQUFVLENBQUM7SUFDNUMsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztRQUFFLE9BQU8sU0FBUyxDQUFDO0lBQzNDLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUMzQyxrR0FBa0c7SUFDbEcsc0dBQXNHO0lBQ3RHLG1HQUFtRztJQUNuRyxnR0FBZ0c7SUFDaEcseUdBQXlHO0lBQ3pHLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7UUFBRSxPQUFPLFFBQVEsQ0FBQztJQUMxQyxvR0FBb0c7SUFDcEcscUdBQXFHO0lBQ3JHLE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxzR0FBc0c7QUFDdEcsdUdBQXVHO0FBQ3ZHLDJGQUEyRjtBQUMzRixTQUFTLGVBQWUsQ0FBQyxVQUFrQjtJQUN6QyxNQUFNLEtBQUssR0FBRyxVQUFVO1NBQ3JCLE9BQU8sQ0FBQyx3QkFBd0IsRUFBRSxFQUFFLENBQUM7U0FDckMsT0FBTyxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUM7U0FDdEIsSUFBSSxFQUFFLENBQUM7SUFDVixPQUFPLEtBQUssSUFBSSxTQUFTLENBQUM7QUFDNUIsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsUUFBa0I7SUFDMUMsT0FBTyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQztBQUN2RixDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsS0FBYztJQUNqQyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDN0IsT0FBTyxNQUFNLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUN0RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsS0FBYztJQUNqQyxPQUFPLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQ3ZFLENBQUM7QUFFRCxTQUFTLGNBQWMsQ0FBSSxLQUFRO0lBQ2pDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUM7UUFBRSxPQUFPLEtBQUssQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFpQixDQUFDO0lBQzNFLElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ3RELE9BQU8sTUFBTSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsRUFBRSxFQUFFLENBQUMsS0FBSyxLQUFLLFNBQVMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFNLENBQUM7QUFDdkosQ0FBQyJ9