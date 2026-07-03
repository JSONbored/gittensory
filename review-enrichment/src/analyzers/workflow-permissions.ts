// Risky GitHub Actions workflow permissions / triggers analyzer. Scans changed `.github/workflows/*` for added
// lines that grant broad or sensitive permissions, or add a high-risk event trigger — the `pull_request_target`
// + write-token supply-chain class, where untrusted fork code runs with the base repo's secrets and a write
// token. Pure compute, no network. Bounded: it matches the FIXED GitHub Actions workflow schema (a documented
// enum of permission scopes and event names), never arbitrary code, so it cannot suffer the unbounded edge cases
// of a code parser. YAML `#` comments are stripped before matching. Line-cited via hunk headers, mirroring the
// other local patch analyzers.
import type { EnrichRequest, WorkflowPermissionFinding } from "../types.js";
import { isWorkflowPath } from "../workflow-path.js";

const MAX_FINDINGS = 25;
const MAX_LINE_CHARS = 2000;

// High-risk event triggers. `pull_request_target` runs on untrusted fork code with the base repo's secrets and a
// read/write token; `workflow_run` runs in an elevated context triggered by another workflow. Both are the classic
// GitHub Actions privilege-escalation vectors. `on:` is always a TOP-LEVEL workflow key (column 0), so both forms
// require zero indentation: the same-line `on:` declaration form (`on: pull_request_target`,
// `on: [push, pull_request_target]`) is unambiguous at column 0 and matched context-free (the `^` anchor with no
// leading `\s*` enforces this). The block-mapping (`on:\n  event:`) and list-item (`on:\n  - event`) forms are
// only unambiguous once we know we are inside the top-level `on:` block — a bare `event:` or `- event` line
// elsewhere (e.g. a job id, a `needs:` entry, or a nested `with:`/`on:` value under some other key) is NOT a
// trigger. Rather than parse arbitrary YAML, `OnBlockTracker` below tracks just enough — that the `on:` key
// itself is at column 0, and the indentation of its direct children — to answer that one question; see its own
// comment for the bounded nesting rule it uses.
const PRT_TRIGGER_RE = /^on\s*:.*\bpull_request_target\b/;
const WORKFLOW_RUN_RE = /^on\s*:.*\bworkflow_run\b/;
const ON_BLOCK_KEY_RE = /^on\s*:\s*$/;
const PRT_CHILD_KEY_RE = /^pull_request_target\s*:/;
const WORKFLOW_RUN_CHILD_KEY_RE = /^workflow_run\s*:/;
const PRT_CHILD_LIST_RE = /^-\s*pull_request_target\s*$/;
const WORKFLOW_RUN_CHILD_LIST_RE = /^-\s*workflow_run\s*$/;

/** Tracks whether the current line sits directly inside a top-level `on:` block, using only the indentation
 *  visible within one diff hunk (state resets per hunk — an unseen gap between hunks could hold anything, so
 *  carrying state across it would risk a WORSE false positive than simply not tracking). Nesting rule: once an
 *  `on:` key line is seen, the next line at greater indentation fixes the "direct child" indentation level; any
 *  line back at or above the `on:` key's own indentation ends the block. Only lines at exactly the direct-child
 *  level are trigger declarations — deeper lines (e.g. `workflow_call:` inputs/secrets) are sub-config, not a
 *  trigger name, so they are never flagged. */
class OnBlockTracker {
  private onIndent: number | null = null;
  private childIndent: number | null = null;

  reset(): void {
    this.onIndent = null;
    this.childIndent = null;
  }

  /** Observe one context/added line (in final-file order) and report a direct on:-block child trigger, if any. */
  observe(indent: number, trimmed: string): "pull-request-target-trigger" | "workflow-run-trigger" | null {
    if (trimmed === "") return null;
    if (indent === 0 && ON_BLOCK_KEY_RE.test(trimmed)) {
      this.onIndent = indent;
      this.childIndent = null;
      return null;
    }
    if (this.onIndent === null) return null;
    if (indent <= this.onIndent) {
      this.reset();
      return null;
    }
    if (this.childIndent === null) this.childIndent = indent;
    if (indent !== this.childIndent) return null;
    if (PRT_CHILD_KEY_RE.test(trimmed) || PRT_CHILD_LIST_RE.test(trimmed)) {
      return "pull-request-target-trigger";
    }
    if (WORKFLOW_RUN_CHILD_KEY_RE.test(trimmed) || WORKFLOW_RUN_CHILD_LIST_RE.test(trimmed)) {
      return "workflow-run-trigger";
    }
    return null;
  }
}
// `permissions: write-all` grants every scope write access at once.
const WRITE_ALL_RE = /\bpermissions\s*:\s*write-all\b/i;
// `id-token: write` enables OIDC cloud-credential exchange, so a compromised job can mint cloud credentials.
const OIDC_WRITE_RE = /\bid-token\s*:\s*write\b/i;
// `secrets: inherit` forwards ALL of the caller's secrets to a (possibly third-party) reusable workflow.
const SECRETS_INHERIT_RE = /\bsecrets\s*:\s*inherit\b/i;
// Sensitive per-scope write grants. Captures the scope name for the finding detail.
const SENSITIVE_WRITE_RE =
  /\b(contents|packages|actions|deployments|security-events)\s*:\s*write\b/i;

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  for (let i = 0; i <= patch.length; i++) {
    if (i === patch.length || patch[i] === "\n") {
      yield patch.slice(start, i);
      start = i + 1;
    }
  }
}

/** Strip a trailing YAML `#` comment (a `#` at line start or after whitespace) so a permission/trigger merely
 *  NAMED in a comment is not flagged. A `#` that is not comment-delimited (e.g. inside a value) is left alone. */
export function stripYamlComment(line: string): string {
  const match = /(?:^|\s)#/.exec(line);
  return match ? line.slice(0, match.index) : line;
}

type ScanLimits = {
  maxFindings?: number;
  signal?: AbortSignal;
};

function pushFinding(
  findings: WorkflowPermissionFinding[],
  seen: Set<string>,
  file: string,
  line: number,
  kind: WorkflowPermissionFinding["kind"],
  maxFindings: number,
  detail?: string,
): boolean {
  const key = `${kind}:${line}:${detail ?? ""}`;
  if (seen.has(key)) return false;
  seen.add(key);
  findings.push(detail ? { file, line, kind, detail } : { file, line, kind });
  return findings.length >= maxFindings;
}

/** Scan one workflow patch's added lines for risky permission grants / triggers, line-cited via hunk headers. Pure. */
export function scanPatchForWorkflowPermissions(
  path: string,
  patch: string,
  limits: ScanLimits = {},
): WorkflowPermissionFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];

  const findings: WorkflowPermissionFinding[] = [];
  const seen = new Set<string>();
  const onBlock = new OnBlockTracker();
  let newLine = 0;
  let inHunk = false;

  for (const raw of patchLines(patch)) {
    if (limits.signal?.aborted) throw new Error("analyzer_aborted");
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      // An unseen gap precedes this hunk; carrying on:-block state across it could misattribute an unrelated
      // block-mapping key as a trigger, so each hunk starts with no assumed nesting context.
      onBlock.reset();
      continue;
    }
    // Skip pre-hunk preamble; inside a hunk `+++x` is added content, not a header.
    if (!inHunk) continue;
    if (raw.startsWith("-")) continue; // removed lines do not exist in the final file

    const isAdded = raw.startsWith("+");
    const rawBody = raw.slice(1);
    if (rawBody.length > MAX_LINE_CHARS) {
      newLine++;
      continue;
    }
    const body = stripYamlComment(rawBody);
    const indent = body.length - body.trimStart().length;
    const onBlockTrigger = onBlock.observe(indent, body.trim());

    if (!isAdded) {
      newLine++;
      continue;
    }

    if (
      WRITE_ALL_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "write-all-permission", maxFindings)
    ) {
      return findings;
    }
    if (
      OIDC_WRITE_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "oidc-token-write", maxFindings)
    ) {
      return findings;
    }
    if (
      SECRETS_INHERIT_RE.test(body) &&
      pushFinding(findings, seen, path, newLine, "secrets-inherit", maxFindings)
    ) {
      return findings;
    }
    const sensitive = SENSITIVE_WRITE_RE.exec(body);
    if (
      sensitive &&
      pushFinding(
        findings,
        seen,
        path,
        newLine,
        "sensitive-scope-write",
        maxFindings,
        sensitive[1]!.toLowerCase(),
      )
    ) {
      return findings;
    }
    if (
      (PRT_TRIGGER_RE.test(body) || onBlockTrigger === "pull-request-target-trigger") &&
      pushFinding(
        findings,
        seen,
        path,
        newLine,
        "pull-request-target-trigger",
        maxFindings,
      )
    ) {
      return findings;
    }
    if (
      (WORKFLOW_RUN_RE.test(body) || onBlockTrigger === "workflow-run-trigger") &&
      pushFinding(findings, seen, path, newLine, "workflow-run-trigger", maxFindings)
    ) {
      return findings;
    }

    newLine++;
  }

  return findings;
}

/** Analyzer entrypoint: scan every changed workflow file for risky permission grants / triggers. */
export async function scanWorkflowPermissions(
  req: EnrichRequest,
  signal?: AbortSignal,
): Promise<WorkflowPermissionFinding[]> {
  const findings: WorkflowPermissionFinding[] = [];
  for (const file of req.files ?? []) {
    if (signal?.aborted) throw new Error("analyzer_aborted");
    if (!file.patch || !isWorkflowPath(file.path)) continue;
    for (const finding of scanPatchForWorkflowPermissions(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
      signal,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
