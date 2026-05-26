import { execFileSync } from "node:child_process";

export function parseGitRemote(remoteUrl) {
  const trimmed = String(remoteUrl ?? "").trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1] && match[2]) return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
  }
  return undefined;
}

export function collectLocalDiff(cwd, baseRef) {
  const metadata = collectLocalBranchMetadata({ cwd, baseRef, login: "local" });
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
  const cwd = input.cwd ?? process.cwd();
  const baseRef = input.baseRef ?? defaultBaseRef(cwd);
  const remoteUrl = gitLines(cwd, ["config", "--get", "remote.origin.url"])[0] ?? "";
  const repoFullName = input.repoFullName ?? parseGitRemote(remoteUrl);
  if (!repoFullName) throw new Error("Could not infer repoFullName from git remote; pass --repo owner/repo.");
  const branchName = input.branchName ?? gitLines(cwd, ["branch", "--show-current"])[0] ?? "local-branch";
  const headRef = input.headRef ?? gitLines(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])[0] ?? branchName;
  const changedFiles = collectChangedFiles(cwd, baseRef);
  const commitMessages = input.commitMessages ?? collectCommitMessages(cwd, baseRef);
  const title = input.title ?? titleFromBranch(branchName) ?? firstCommitTitle(commitMessages);
  const linkedIssues = [...new Set([...(input.linkedIssues ?? []), ...extractLinkedIssues([branchName, title, input.body, ...commitMessages].filter(Boolean).join("\n"))])].sort(
    (left, right) => left - right,
  );
  const payload = {
    login: input.login,
    repoFullName,
    baseRef,
    headRef,
    branchName,
    commitMessages,
    changedFiles,
    validation: input.validation,
    linkedIssues,
    labels: input.labels,
    title,
    body: input.body,
  };
  return stripUndefined(payload);
}

export function buildBranchAnalysisPayload(input) {
  const metadata = collectLocalBranchMetadata(input);
  const scorerCommand = input.scorePreviewCommand ?? process.env.GITTENSOR_SCORE_PREVIEW_CMD;
  const externalPreview = runExternalScorePreview(metadata, scorerCommand);
  const localScorer = externalPreview.ok ? normalizeScorerOutput(externalPreview.payload) : metadataOnlyScorer(externalPreview);
  return {
    ...metadata,
    localScorer,
    localScorerStatus: externalPreview,
  };
}

export function runExternalScorePreview(metadata, scorerCommand) {
  if (!scorerCommand) return { ok: false, reason: "missing_scorer_command" };
  try {
    const [command, ...args] = splitCommand(scorerCommand);
    if (!command) return { ok: false, reason: "empty_scorer_command" };
    const output = execFileSync(command, args, {
      input: JSON.stringify({
        ...metadata,
        gittensorRoot: process.env.GITTENSOR_ROOT,
      }),
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, payload: JSON.parse(output) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "external_scorer_failed" };
  }
}

export function setupGuidanceForLocalScorer(status) {
  if (status.ok) return [];
  return [
    "Gittensory used metadata-only analysis because no external scorer succeeded.",
    "Set GITTENSOR_SCORE_PREVIEW_CMD to a command that reads branch metadata JSON from stdin and emits scoring metrics JSON.",
    "Set GITTENSOR_ROOT if your scorer needs a local entrius/gittensor checkout.",
  ];
}

export function gitLines(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectChangedFiles(cwd, baseRef) {
  const statusRows = gitLines(cwd, ["diff", "--name-status", "-M", baseRef, "--"]);
  const numstat = new Map(parseNumstat(cwd, baseRef).map((entry) => [entry.path, entry]));
  return statusRows.map((row) => {
    const fields = row.split(/\t/);
    const code = fields[0] ?? "";
    const isRename = code.startsWith("R");
    const path = isRename ? fields[2] ?? fields[1] ?? "" : fields[1] ?? "";
    const previousPath = isRename ? fields[1] : undefined;
    const stats = numstat.get(path) ?? { additions: 0, deletions: 0, binary: false };
    return stripUndefined({
      path,
      previousPath,
      additions: stats.additions,
      deletions: stats.deletions,
      status: statusFromCode(code),
      binary: stats.binary,
    });
  });
}

function parseNumstat(cwd, baseRef) {
  return gitLines(cwd, ["diff", "--numstat", "-M", baseRef, "--"]).map((row) => {
    const fields = row.split(/\t/);
    const additions = fields[0] === "-" ? 0 : Number(fields[0] ?? 0);
    const deletions = fields[1] === "-" ? 0 : Number(fields[1] ?? 0);
    return {
      path: normalizeNumstatPath(fields.slice(2).join("\t")),
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: fields[0] === "-" || fields[1] === "-",
    };
  });
}

function normalizeNumstatPath(path) {
  const renamed = path.match(/\{.* => (.*)\}/);
  return renamed?.[1] ? path.replace(/\{.* => (.*)\}/, renamed[1]) : path;
}

function collectCommitMessages(cwd, baseRef) {
  const rangeMessages = gitLines(cwd, ["log", "--pretty=%B%x1e", `${baseRef}..HEAD`]).join("\n");
  const messages = rangeMessages
    .split("\u001e")
    .map((message) => message.trim())
    .filter(Boolean);
  if (messages.length > 0) return messages.slice(0, 30);
  const last = gitLines(cwd, ["log", "-1", "--pretty=%B"]).join("\n").trim();
  return last ? [last] : [];
}

function defaultBaseRef(cwd) {
  const originHead = gitLines(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])[0];
  if (originHead) return originHead;
  if (gitLines(cwd, ["rev-parse", "--verify", "origin/main"]).length > 0) return "origin/main";
  if (gitLines(cwd, ["rev-parse", "--verify", "origin/master"]).length > 0) return "origin/master";
  return "HEAD";
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
    warnings: [status.reason ?? "external_scorer_unavailable"],
  };
}

function splitCommand(command) {
  return String(command).match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function assertSourceUploadDisabled() {
  if (/^(1|true|yes)$/i.test(process.env.GITTENSORY_UPLOAD_SOURCE ?? "false")) {
    throw new Error("GITTENSORY_UPLOAD_SOURCE=true is not supported in v1; local MCP sends metadata only.");
  }
}

function extractLinkedIssues(text) {
  const issues = [];
  for (const match of String(text).matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|#)\s*#?(\d+)/gi)) issues.push(Number(match[1]));
  return issues.filter((issue) => Number.isInteger(issue) && issue > 0);
}

function statusFromCode(code) {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("M")) return "modified";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
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

function isTestFile(file) {
  return /(^|\/)(test|tests|spec|__tests__)\//i.test(file) || /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file);
}

function isCodeFile(file) {
  return /\.(ts|tsx|js|jsx|py|rb|rs|kt|scala|java|go|sql)$/i.test(file) && !isTestFile(file);
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)]));
}
