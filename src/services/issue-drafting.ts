// Issue-drafting core (#8103, epic #8082) — expands a loose maintainer prompt into a gate-ready draft
// issue body in this repo's heavy template, grounded in REAL precedent from the current checkout. The gate
// only enforces what an issue explicitly says (see .claude/skills/contributor-pipeline-gardening/
// reference.md, "The gate only enforces what the issue explicitly says"), so a publishable issue must cite
// exact files/functions/patterns — this module automates that grounding pass and assembles the draft, and
// it says so EXPLICITLY wherever it could not ground part of the prompt, never inventing a plausible but
// unverified requirement.
//
// PURE, ADAPTER-AGNOSTIC (the issue's own ⚠️ required shape): no process.argv, no fs, no IO of any kind.
// The caller supplies the searchable corpus (the CLI wrapper scripts/draft-issue.ts reads the checkout; a
// future ORB dashboard API route can supply the same shape from whatever storage it has — a Worker has no
// filesystem, which is exactly why the search input is data, not a path) and gets back a structured
// result. Mirrors the pure-core/host-adapter split of packages/loopover-engine/src/calibration/
// signal-tracking.ts + src/review/signal-tracking-wire.ts.
//
// Hard boundaries (#8103): drafts BODY TEXT only. Never publishes, never picks labels/milestone/
// contributor-vs-maintainer-only status, never decides relationships — those stay maintainer decisions on
// every issue, no exceptions.

/** One searchable file of the checkout, supplied by the caller — `path` is repo-relative. */
export type CorpusFile = { path: string; content: string };

/** How specific an extracted term is. Backticked/path/identifier terms name something exact, so failing to
 *  ground one is a real spec gap the draft must flag; a plain word failing to ground is just vocabulary and
 *  is silently dropped rather than manufactured into a scary-but-empty ⚠️ warning. */
export type GroundingTermTier = "exact" | "path" | "identifier" | "word";

export type GroundingTerm = { term: string; tier: GroundingTermTier };

/** One place a grounding term was actually found in the supplied corpus. `line` is 1-based. */
export type GroundingMatch = { path: string; line: number; text: string };

/** A term from the loose prompt that WAS grounded in real precedent. */
export type GroundedTerm = GroundingTerm & { matches: readonly GroundingMatch[] };

/** One recorded drafting miss (#8118): a real post-merge gap traceable to a draft that should have
 *  specified something and didn't. Recorded manually by the maintainer after the fact — this module never
 *  auto-detects gaps, it only learns from the ones a human already confirmed. */
export type DraftingMiss = {
  /** ISO timestamp of when the miss was recorded. */
  recordedAt: string;
  /** The loose prompt the flawed draft was generated from. */
  loosePrompt: string;
  /** What the draft should have specified but didn't — written as a reusable lesson. */
  missing: string;
  /** Optional gap category ("unstated-anti-pattern", "unverified-signature", …) used to dedupe the
   *  checklist: two misses in one category render as one checklist line with a ×N count. */
  category?: string;
};

/** Repo-relative default location of the misses file, shared by the recorder and drafter CLIs (#8118) —
 *  a plain committed JSON file per the issue's "no new database" boundary. The core only exports the
 *  string; reading/writing it stays the thin consumers' IO. */
export const DEFAULT_DRAFTING_MISSES_FILE = "scripts/drafting-misses.json";

export type IssueDraftOptions = {
  /** Cap on distinct terms extracted from the prompt (default 12). */
  maxTerms?: number;
  /** Cap on matches kept per grounded term (default 3). */
  maxMatchesPerTerm?: number;
  /** Accumulated drafting misses (#8118) — rendered into every draft as a pre-publish checklist. */
  misses?: readonly DraftingMiss[];
};

export type IssueDraftResult = {
  /** The drafted issue body (heavy template) for the maintainer to read, edit, and only then publish. */
  body: string;
  groundedTerms: readonly GroundedTerm[];
  /** Specific terms (exact/path/identifier tier) with NO precedent in the searched corpus — surfaced
   *  verbatim in the body as ⚠️ UNGROUNDED so the human decision point is visible, never papered over. */
  ungroundedTerms: readonly GroundingTerm[];
};

const DEFAULT_MAX_TERMS = 12;
const DEFAULT_MAX_MATCHES_PER_TERM = 3;
const MAX_MATCH_TEXT_CHARS = 160;

// Words too generic to ground anything by themselves — searching these would match half the repo and
// produce citation noise, the opposite of the explicit-precedent discipline this tool exists to serve.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "them", "they",
  "should", "would", "could", "must", "have", "has", "had", "are", "was", "were", "been",
  "add", "adds", "added", "new", "make", "makes", "made", "use", "uses", "used", "using",
  "file", "files", "code", "test", "tests", "issue", "issues", "also", "only", "over", "under",
  "each", "every", "all", "any", "some", "not", "never", "always", "existing", "current", "real",
  "same", "way", "more", "less", "one", "two", "like", "its", "our", "your", "their", "than",
]);

/**
 * Extract the candidate grounding terms from a loose prompt, most-specific first:
 *   1. `exact` — backtick-quoted fragments, kept verbatim (the maintainer already named something);
 *   2. `path` — path-shaped tokens (contain `/` or end in a source-file extension);
 *   3. `identifier` — camelCase / snake_case / dotted words (the shapes real symbols take);
 *   4. `word` — remaining plain words ≥ 4 chars that aren't stopwords.
 * Each tier's matches are consumed from the text before the next tier scans, so a fragment never
 * double-extracts (e.g. `record.ts` out of `backtest-track-record.ts`). Deduplicated case-insensitively
 * in tier order, capped at `maxTerms`.
 */
export function extractGroundingTerms(prompt: string, maxTerms: number = DEFAULT_MAX_TERMS): GroundingTerm[] {
  const seen = new Set<string>();
  const terms: GroundingTerm[] = [];
  const push = (term: string, tier: GroundingTermTier) => {
    const key = term.toLowerCase();
    if (term.length < 3 || seen.has(key) || STOPWORDS.has(key)) return;
    seen.add(key);
    terms.push({ term, tier });
  };

  for (const [, quoted] of prompt.matchAll(/`([^`]+)`/g)) push(quoted!.trim(), "exact");
  let rest = prompt.replace(/`[^`]*`/g, " ");

  const pathPattern = /[A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.(?:tsx?|sql|ya?ml|jsonc?|md)\b/g;
  for (const [token] of rest.matchAll(pathPattern)) push(token, "path");
  rest = rest.replace(pathPattern, " ");

  const identifierPattern = /\b(?:[a-z0-9]+(?:[A-Z][a-z0-9]*)+|[A-Za-z0-9]+(?:[_.][A-Za-z0-9]+)+)\b/g;
  for (const [token] of rest.matchAll(identifierPattern)) push(token, "identifier");
  rest = rest.replace(identifierPattern, " ");

  for (const [token] of rest.matchAll(/\b[A-Za-z]{4,}\b/g)) push(token, "word");

  return terms.slice(0, Math.max(0, maxTerms));
}

/** Rank source paths the way a precedent citation should read: live code first, then shared packages,
 *  then scripts, then any test file (wherever it lives), everything else (workflows, config) last. */
function pathRank(path: string): number {
  if (path.includes("/test/") || path.includes(".test.")) return 3;
  if (path.startsWith("src/")) return 0;
  if (path.startsWith("packages/")) return 1;
  if (path.startsWith("scripts/")) return 2;
  return 4;
}

/** Definition lines make better citations than usages or comments — a contributor mirroring precedent
 *  needs the declaration, not a random mention. */
function lineRank(text: string): number {
  return /^(?:export\s|function\s|class\s|const\s|type\s)/.test(text) ? 0 : 1;
}

/**
 * Search the supplied corpus for one term (case-insensitive substring). Returns the term's grounded
 * matches — definition lines in best-ranked paths first, then by path/line for byte-stable deterministic
 * output — capped at `maxMatchesPerTerm`, or null when the corpus has no trace of the term at all.
 * A `word`-tier term only searches files whose PATH contains it: a plain word matching arbitrary comment
 * prose across the repo is citation noise, but a word that names a file ("backtest", "track") is a real
 * anchor — this is what keeps loose vocabulary from grounding to random unrelated lines.
 */
export function groundTerm(
  groundingTerm: GroundingTerm,
  corpus: readonly CorpusFile[],
  maxMatchesPerTerm: number = DEFAULT_MAX_MATCHES_PER_TERM,
): GroundedTerm | null {
  const needle = groundingTerm.term.toLowerCase();
  const searchable = groundingTerm.tier === "word" ? corpus.filter((file) => file.path.toLowerCase().includes(needle)) : corpus;
  const matches: GroundingMatch[] = [];
  for (const file of searchable) {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]!.toLowerCase().includes(needle)) continue;
      matches.push({ path: file.path, line: i + 1, text: lines[i]!.trim().slice(0, MAX_MATCH_TEXT_CHARS) });
    }
  }
  if (matches.length === 0) return null;
  matches.sort(
    (a, b) => pathRank(a.path) - pathRank(b.path) || lineRank(a.text) - lineRank(b.text) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return { ...groundingTerm, matches: matches.slice(0, Math.max(1, maxMatchesPerTerm)) };
}

/**
 * Parse the drafting-misses file's JSON content (#8118) into validated {@link DraftingMiss} records.
 * FAIL-LOUD, deliberately: this is the maintainer's own accumulated learning data, and silently dropping a
 * malformed lesson would defeat the entire feedback loop — a broken file should stop the draft, not shrink
 * the checklist. (Contrast with the corpus parsers' fail-open posture, which protect a live review pass.)
 */
export function parseDraftingMisses(json: string): DraftingMiss[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("drafting-misses file is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("drafting-misses file must be a JSON array of miss records");
  return parsed.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    if (typeof record.recordedAt !== "string" || !record.recordedAt || typeof record.loosePrompt !== "string" || typeof record.missing !== "string" || !record.missing) {
      throw new Error(`drafting miss #${index} is malformed — need recordedAt, loosePrompt, and a non-empty missing lesson`);
    }
    const miss: DraftingMiss = { recordedAt: record.recordedAt, loosePrompt: record.loosePrompt, missing: record.missing };
    if (typeof record.category === "string" && record.category) miss.category = record.category;
    return miss;
  });
}

/** Collapse recorded misses into checklist lines: one line per category (uncategorized misses stay
 *  one-per-lesson), counting repeats and keeping the most recently recorded lesson text as the actionable
 *  wording. Sorted by label for byte-stable drafts. */
function groupDraftingMisses(misses: readonly DraftingMiss[]): Array<{ label: string; count: number; lesson: string }> {
  const groups = new Map<string, { label: string; count: number; lesson: string; lessonAt: string }>();
  for (const miss of misses) {
    const key = miss.category ?? `uncategorized:${miss.missing}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { label: miss.category ?? "one-off", count: 1, lesson: miss.missing, lessonAt: miss.recordedAt });
    } else {
      existing.count += 1;
      if (miss.recordedAt > existing.lessonAt) {
        existing.lesson = miss.missing;
        existing.lessonAt = miss.recordedAt;
      }
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({ label: group.label, count: group.count, lesson: group.lesson }));
}

/** True when a cited path is graded by Codecov's patch gate (coverage.include: `src/**` and the engine's
 *  `src/**` — mirrors codecov.yml's ignore list + vitest.config.ts's include, kept in sync by hand). */
function pathIsCoverageGraded(path: string): boolean {
  if (path === "src/env.d.ts") return false;
  return path.startsWith("src/") || path.startsWith("packages/loopover-engine/src/");
}

/**
 * Draft a gate-ready issue body from a loose prompt + a searchable corpus. The output is a STARTING DRAFT
 * in the heavy template (Context / Requirements / Deliverables / Test Coverage Requirements / Expected
 * Outcome / Links & Resources) with grounded precedent cited as `path:line`, Requirements grouped one
 * bullet per anchor file (never one per raw term — near-duplicate terms grounding to the same file must
 * not read as separate requirements), and every ungroundable SPECIFIC term flagged ⚠️ UNGROUNDED at the
 * exact spot a human decision is still needed. Sections a human must still fill are explicit
 * `<!-- MAINTAINER: ... -->` markers, so nothing half-drafted can read as finished. Throws on a blank
 * prompt — there is nothing to ground. Pure and deterministic: same prompt + corpus ⇒ same draft.
 */
export function draftIssueBody(prompt: string, corpus: readonly CorpusFile[], options: IssueDraftOptions = {}): IssueDraftResult {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error("cannot draft from an empty prompt");

  const terms = extractGroundingTerms(trimmedPrompt, options.maxTerms ?? DEFAULT_MAX_TERMS);
  const groundedTerms: GroundedTerm[] = [];
  const ungroundedTerms: GroundingTerm[] = [];
  for (const term of terms) {
    const grounded = groundTerm(term, corpus, options.maxMatchesPerTerm ?? DEFAULT_MAX_MATCHES_PER_TERM);
    if (grounded) groundedTerms.push(grounded);
    // A plain word failing to ground is vocabulary, not a spec gap — only specific tiers get flagged.
    else if (term.tier !== "word") ungroundedTerms.push(term);
  }

  // Dedupe citations by path:line (several terms often ground on the same line), and group the
  // Requirements by each grounded term's TOP path so one anchor file yields one bullet.
  const citations = new Map<string, { match: GroundingMatch; terms: string[] }>();
  for (const grounded of groundedTerms) {
    for (const match of grounded.matches) {
      const key = `${match.path}:${match.line}`;
      const existing = citations.get(key);
      if (existing) existing.terms.push(grounded.term);
      else citations.set(key, { match, terms: [grounded.term] });
    }
  }
  const anchorGroups = new Map<string, { terms: string[]; topLine: number }>();
  for (const grounded of groundedTerms) {
    const top = grounded.matches[0]!;
    const group = anchorGroups.get(top.path);
    if (group) group.terms.push(grounded.term);
    else anchorGroups.set(top.path, { terms: [grounded.term], topLine: top.line });
  }
  const citedPaths = [...new Set(groundedTerms.flatMap((grounded) => grounded.matches.map((match) => match.path)))];
  // matches is never empty on a GroundedTerm (groundTerm caps at ≥1), so index directly rather than
  // optional-chain through a link that could never take its undefined side.
  const anchorPath = groundedTerms.length > 0 ? groundedTerms[0]!.matches[0]!.path : undefined;

  const lines: string[] = ["## Context", "", `Loose intent (maintainer's own words): ${trimmedPrompt}`, ""];
  if (citations.size > 0) {
    lines.push("Real precedent in the current checkout (verified by search, not memory):", "");
    for (const citation of citations.values()) {
      lines.push(
        `- \`${citation.match.path}:${citation.match.line}\` — \`${citation.match.text}\` (grounds ${citation.terms.map((term) => `"${term}"`).join(", ")})`,
      );
    }
    lines.push("");
  } else {
    lines.push("> ⚠️ NO grounded precedent was found for ANY part of this prompt — every requirement below needs human verification before publishing.", "");
  }

  lines.push("## Requirements", "");
  if (anchorPath) {
    lines.push(
      `> ⚠️ Required pattern. Mirror the existing implementation in \`${anchorPath}\` — a differently-shaped`,
      "> implementation, a second parallel mechanism, or an unspecified choice among multiple plausible",
      "> artifacts does NOT satisfy this issue.",
      "",
    );
  }
  for (const [path, group] of anchorGroups) {
    lines.push(
      `- Anchor the ${group.terms.map((term) => `"${term}"`).join(" / ")} work on \`${path}\` (see \`${path}:${group.topLine}\`); state in the PR how the change relates to it.`,
    );
  }
  for (const term of ungroundedTerms) {
    lines.push(
      `- > ⚠️ UNGROUNDED: no precedent found in the searched checkout for \`${term.term}\` — verify the requirement by hand (or drop it) before publishing; do NOT leave this marker in the published issue.`,
    );
  }
  lines.push("");

  lines.push(
    "## Deliverables",
    "",
    "- [ ] <!-- MAINTAINER: name each concrete artifact (exact file paths) — the gate enforces only what is written here. -->",
    "",
    "## Test Coverage Requirements",
    "",
  );
  if (citedPaths.some(pathIsCoverageGraded)) {
    lines.push(
      "99%+ Codecov patch coverage (branch-counted) on every changed line — aim for 100%, including both",
      "sides of every `??`/ternary/`&&`, invariant tests, and a regression test for any fix.",
    );
  } else {
    lines.push(
      "The cited paths are outside coverage.include (`src/**` and the engine's `src/**`), so Codecov does",
      "not gate this patch — full unit tests are still required per house convention where logic exists.",
    );
  }
  lines.push(
    "",
    "## Expected Outcome",
    "",
    "<!-- MAINTAINER: state what is true after this ships that was not true before. -->",
    "",
    "## Links & Resources",
    "",
  );
  for (const path of citedPaths) lines.push(`- \`${path}\``);
  if (citedPaths.length === 0) lines.push("- <!-- MAINTAINER: no grounded files to cite — add the real anchors by hand. -->");

  // #8118: the accumulated-misses checklist — every recorded post-merge gap becomes a concrete
  // double-check on every subsequent draft, so the tool gets better instead of repeating its misses.
  // Same "resolve, then delete" contract as the UNGROUNDED markers: it must never survive publishing.
  const misses = options.misses ?? [];
  if (misses.length > 0) {
    lines.push("", "## Pre-publish checklist — learned from recorded drafting misses. Resolve each item, then DELETE this section before publishing.", "");
    for (const group of groupDraftingMisses(misses)) {
      lines.push(`- [ ] ${group.label}${group.count > 1 ? ` (recorded ${group.count}×)` : ""}: ${group.lesson}`);
    }
  }
  lines.push("");

  return { body: lines.join("\n"), groundedTerms, ungroundedTerms };
}
