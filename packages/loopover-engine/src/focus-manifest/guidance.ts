import type {
  FocusManifest,
  FocusManifestFinding,
  FocusManifestGuidance,
} from "../types/predicted-gate-types.js";

const FOCUS_MANIFEST_TERMS = /\b(reward\w*|score\w*|wallets?|hotkeys?|coldkeys?|seed[-\s]?phrases?|mnemonics?|private[-\s]?keys?|farming|payouts?|rankings?|raw[-\s]?trust(?:[-\s]?scores?)?|trust[-\s]?scores?|private[-\s]?reviewability|reviewability(?:[-\s]?internals?)?|private[-\s]?scoreability|scoreability|public[-\s]?score[-\s]?(?:estimate|prediction|claim)s?|estimated[-\s]?scores?|score[-\s]?(?:estimate|prediction|preview)s?)\b/i;
const FOCUS_MANIFEST_LOCAL_PATH_PATTERN = new RegExp(String.raw`/Users/|/home/|/root/|/var/|/opt/|/tmp/|/private/|[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]Program Files[\\/]`, "i");

export function isFocusManifestPublicSafe(text: string): boolean {
  return !FOCUS_MANIFEST_TERMS.test(text) && !FOCUS_MANIFEST_LOCAL_PATH_PATTERN.test(text);
}

const MAX_GLOBSTAR_SLASH_ALTERNATIVES = 128;

function normalizePathForMatch(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/**
 * LINEAR-TIME wildcard matcher for a `*`-glob pattern over an already-normalized path. `*` (and a collapsed
 * run of `*`) matches any run of characters INCLUDING `/` (gittensory globs cross slashes). Implemented as a
 * prefix + suffix + ordered-substring (indexOf) scan rather than a `.*`-per-star regex: the old regex
 * (`^.*a.*a...$`) backtracks catastrophically on a near-miss path and could hang the gate for an entire repo
 * (a manifest glob with many non-adjacent `*`). This algorithm is O(path × parts) with NO backtracking.
 */
function linearGlobMatcher(pattern: string): (path: string) => boolean {
  // The caller only compiles this for a pattern that contains a wildcard, so split always yields >= 2 parts.
  const parts = pattern.split(/\*+/); // literal segments between (collapsed) wildcard runs
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const middles = parts.slice(1, -1).filter((part) => part.length > 0);
  return (path) => {
    if (!path.startsWith(first) || !path.endsWith(last)) return false;
    let idx = first.length;
    for (const part of middles) {
      const found = path.indexOf(part, idx);
      if (found === -1) return false;
      idx = found + part.length;
    }
    return path.length - last.length >= idx; // the suffix must not overlap the consumed prefix/middles
  };
}

/**
 * Compile a manifest path pattern into a predicate over an ALREADY-normalized path. Supports exact paths,
 * directory prefixes (`src/` or `src`), and `*` wildcards (`*` and a double-star both match any run of chars
 * across `/`). A double-star-then-separator prefix means "zero or more path segments", so the mandatory slash
 * is absorbed and a double-star glob also matches a ROOT-level (zero-depth) file, not only nested ones.
 * Compiling once lets a caller test many paths against one pattern without recompiling per path — see
 * {@link matchedPatterns}. An empty/blank pattern never matches.
 */
function expandGlobstarSlash(pattern: string): string[] {
  const alternatives = [""];
  for (let idx = 0; idx < pattern.length; ) {
    if (pattern.startsWith("**/", idx)) {
      const count = alternatives.length;
      const canKeepRootAlternatives = count * 2 <= MAX_GLOBSTAR_SLASH_ALTERNATIVES;
      for (let altIdx = count - 1; altIdx >= 0; altIdx -= 1) {
        const prefix = alternatives[altIdx]!;
        alternatives[altIdx] = `${prefix}*/`;
        if (canKeepRootAlternatives) alternatives.push(prefix);
      }
      idx += 3;
      continue;
    }
    for (let altIdx = 0; altIdx < alternatives.length; altIdx += 1) alternatives[altIdx] += pattern[idx]!;
    idx += 1;
  }
  return alternatives;
}

function compileManifestPathMatcher(pattern: string): (normalizedPath: string) => boolean {
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPattern) return () => false;
  if (normalizedPattern.includes("*")) {
    // `**/` means zero or more whole path segments. Keep the slash in the non-root alternative so
    // basename globs (e.g. `**/safe.ts`) do not degrade into suffix globs that match `unsafe.ts`.
    const matchers = expandGlobstarSlash(normalizedPattern).map((globbed) =>
      globbed.includes("*") ? linearGlobMatcher(globbed) : (normalizedPath: string) => normalizedPath === globbed,
    );
    return (normalizedPath) => matchers.some((matcher) => matcher(normalizedPath));
  }
  const dirPattern = normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`;
  return (normalizedPath) => normalizedPath === normalizedPattern || normalizedPath.startsWith(dirPattern);
}

/**
 * Match a changed path against a manifest path pattern. Supports exact paths, directory
 * prefixes (`src/` or `src`), and `*` wildcards (`**` collapses to `*`).
 */
export function matchesManifestPath(path: string, pattern: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  if (!normalizedPath) return false;
  return compileManifestPathMatcher(pattern)(normalizedPath);
}

function matchedPatterns(paths: string[], patterns: string[]): string[] {
  // Normalize each path once and compile each pattern once, instead of redoing both for every (path,
  // pattern) pair — the wildcard regex was previously recompiled per path.
  const normalizedPaths = paths.map(normalizePathForMatch).filter(Boolean);
  return patterns.filter((pattern) => {
    const matches = compileManifestPathMatcher(pattern);
    return normalizedPaths.some((normalizedPath) => matches(normalizedPath));
  });
}

/**
 * Build deterministic, public-safe guidance from a focus manifest for a concrete change set.
 * Explains why changed paths are preferred or discouraged and surfaces manifest-driven blockers
 * without leaking maintainer-private notes into public next steps.
 */
export function buildFocusManifestGuidance(args: {
  manifest: FocusManifest;
  changedPaths: string[];
  labels?: string[] | undefined;
  linkedIssueCount?: number | undefined;
  testFileCount?: number | undefined;
  passedValidationCount?: number | undefined;
}): FocusManifestGuidance {
  const { manifest } = args;
  const changedPaths = args.changedPaths.filter((path) => typeof path === "string" && path.length > 0);
  const labels = (args.labels ?? []).map((label) => label.toLowerCase());
  const linkedIssueCount = Math.max(0, args.linkedIssueCount ?? 0);
  const testFileCount = Math.max(0, args.testFileCount ?? 0);
  const passedValidationCount = Math.max(0, args.passedValidationCount ?? 0);

  const matchedWantedPaths = matchedPatterns(changedPaths, manifest.wantedPaths);
  const preferredLabelHits = manifest.preferredLabels.filter((label) => labels.includes(label.toLowerCase()));

  const findings: FocusManifestFinding[] = [];
  const publicNextSteps: string[] = [];

  if (!manifest.present) {
    for (const warning of manifest.warnings) {
      findings.push({ code: "manifest_malformed", severity: "info", title: "Maintainer focus manifest not applied", detail: warning });
    }
    return {
      present: false,
      source: manifest.source,
      linkedIssuePolicy: manifest.linkedIssuePolicy,
      issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
      matchedWantedPaths: [],
      preferredLabelHits: [],
      findings,
      publicNextSteps: [],
      warnings: manifest.warnings,
      summary: "No maintainer focus manifest applied; using deterministic signals only.",
    };
  }

  if (manifest.wantedPaths.length > 0 && matchedWantedPaths.length === 0 && changedPaths.length > 0) {
    findings.push({
      code: "manifest_off_focus",
      severity: "warning",
      title: "Change is outside maintainer-wanted areas",
      detail: `No changed path matches the maintainer-wanted patterns (${manifest.wantedPaths.slice(0, 5).join(", ")}).`,
      action: "Refocus the change onto a maintainer-wanted area or explain why this out-of-focus work is needed.",
    });
    publicNextSteps.push("Refocus onto the maintainer-wanted areas, or explain why this out-of-focus change is needed.");
  }

  if (matchedWantedPaths.length > 0) {
    findings.push({
      code: "manifest_preferred_path",
      severity: "info",
      title: "Change aligns with maintainer-wanted areas",
      detail: `Changed paths match maintainer-wanted patterns: ${matchedWantedPaths.slice(0, 5).join(", ")}.`,
    });
    publicNextSteps.push("Changed paths align with the maintainer's wanted areas for this repo.");
  }

  if (manifest.preferredLabels.length > 0 && preferredLabelHits.length === 0) {
    findings.push({
      code: "manifest_missing_preferred_label",
      severity: "info",
      title: "No maintainer-preferred label applied",
      detail: `Maintainer prefers labels: ${manifest.preferredLabels.slice(0, 5).join(", ")}.`,
      action: "Consider applying a maintainer-preferred label so triage stays aligned.",
    });
    publicNextSteps.push(`Consider a maintainer-preferred label (${manifest.preferredLabels.slice(0, 3).join(", ")}).`);
  }

  if (manifest.linkedIssuePolicy === "required" && linkedIssueCount === 0) {
    findings.push({
      code: "manifest_linked_issue_required",
      severity: "warning",
      title: "Maintainer requires a linked issue",
      detail: "This repo's maintainer focus manifest requires every PR to reference a tracked issue.",
      action: "Link the relevant issue (for example `Closes #123`) before opening the PR.",
    });
    publicNextSteps.push("Link the relevant tracked issue; the maintainer requires linked issues on PRs.");
  } else if (manifest.linkedIssuePolicy === "preferred" && linkedIssueCount === 0) {
    findings.push({
      code: "manifest_linked_issue_preferred",
      severity: "info",
      title: "Maintainer prefers a linked issue",
      detail: "This repo's maintainer focus manifest prefers PRs to reference a tracked issue.",
      action: "Link a tracked issue if one exists.",
    });
    publicNextSteps.push("Link a tracked issue if one exists; the maintainer prefers linked issues.");
  }

  if (manifest.testExpectations.length > 0 && testFileCount === 0 && passedValidationCount === 0) {
    const safeExpectations = manifest.testExpectations.filter(isFocusManifestPublicSafe).slice(0, 3);
    const expectationDetail = safeExpectations.length > 0 ? ` Expected evidence: ${safeExpectations.join("; ")}.` : "";
    findings.push({
      code: "manifest_missing_tests",
      severity: "warning",
      title: "Configured validation evidence missing",
      detail: `No changed test files or passing validation evidence were detected for this PR.${expectationDetail}`,
      action: "Add regression/invariant coverage, update relevant tests, or attach passing validation output that satisfies the repo's configured expectations.",
    });
    publicNextSteps.push("Add relevant tests or passing validation evidence that matches the repo's configured expectations.");
  }

  if (manifest.issueDiscoveryPolicy === "discouraged") {
    findings.push({
      code: "manifest_issue_discovery_discouraged",
      severity: "info",
      title: "Maintainer discourages issue-discovery reports",
      detail: "This repo's maintainer focus manifest discourages new issue-discovery reports; prefer direct fixes.",
      action: "Prefer a direct PR over filing a new issue-discovery report here.",
    });
    publicNextSteps.push("This repo prefers direct fixes over new issue-discovery reports.");
  }

  const safePublicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe);
  const safeNextSteps = [...new Set([...publicNextSteps, ...safePublicNotes])].filter(isFocusManifestPublicSafe);

  return {
    present: true,
    source: manifest.source,
    linkedIssuePolicy: manifest.linkedIssuePolicy,
    issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
    matchedWantedPaths,
    preferredLabelHits,
    findings,
    publicNextSteps: safeNextSteps,
    warnings: manifest.warnings,
    summary: summarize(manifest, matchedWantedPaths),
  };
}

function summarize(manifest: FocusManifest, wanted: string[]): string {
  if (wanted.length > 0) return "Maintainer focus manifest: change aligns with a wanted area.";
  if (manifest.wantedPaths.length > 0) return "Maintainer focus manifest: change is outside the wanted areas.";
  return "Maintainer focus manifest applied with no path-specific verdict.";
}

export type { FocusManifest, FocusManifestGuidance, PreMergeCheck } from "../types/predicted-gate-types.js";
