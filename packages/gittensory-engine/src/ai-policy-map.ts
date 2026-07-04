// AI policy map (#2305) with organic AI-fatigue tier (#3009).
//
// Formal ban phrases hard-skip a repo. Fatigue is a separate, lower-confidence metadata signal that deprioritizes
// or defers mining before a maintainer writes an outright ban — never conflated with or promoted to the hard-skip.

export type AiPolicySource = "AI-USAGE.md" | "CONTRIBUTING.md" | "none";

export type AiPolicyFatigueTier = "none" | "elevated" | "high";

export type AiPolicyPriorityAdjustment = "none" | "deprioritize" | "defer";

export type AiPolicyFatigueEvidenceKind = "terse_rejection_pattern" | "contributing_doc_language";

export type AiPolicyFatigueEvidence = {
  kind: AiPolicyFatigueEvidenceKind;
  detail: string;
  weight: number;
};

export type AiPolicyFatigueSignal = {
  tier: AiPolicyFatigueTier;
  priorityAdjustment: AiPolicyPriorityAdjustment;
  /** Multiplier applied to opportunity rank scores in (0, 1]; 1 means no adjustment. */
  priorityFactor: number;
  deferRecheckUntil: string | null;
  evidence: AiPolicyFatigueEvidence[];
};

export type AiPolicyVerdict = {
  allowed: boolean;
  matchedPhrase: string | null;
  source: AiPolicySource;
  fatigue: AiPolicyFatigueSignal;
};

export type AiAttributedPullRequestMetadata = {
  number: number;
  state: "closed" | "open" | string;
  merged?: boolean | undefined;
  closedAt?: string | null | undefined;
  labels?: readonly string[] | undefined;
  authorLogin?: string | null | undefined;
  /** Caller-provided hint when metadata already identified AI/automation attribution. */
  aiAttributed?: boolean | undefined;
  /** Caller-provided hint when metadata shows a terse close/rejection without merge. */
  terseRejection?: boolean | undefined;
};

export type AiPolicyAssessmentInput = {
  docs: {
    aiUsage: string | null | undefined;
    contributing: string | null | undefined;
  };
  previousContributing?: string | null | undefined;
  contributingObservedAt?: string | null | undefined;
  closedPullRequests?: readonly AiAttributedPullRequestMetadata[] | undefined;
  nowMs?: number | undefined;
};

export type AiPolicyVerdictCacheEntry = {
  repoFullName: string;
  verdict: AiPolicyVerdict;
  cachedAtMs: number;
  expiresAtMs: number;
  cacheKind: "formal_ban" | "fatigue" | "clean";
};

/** Formal-ban policy docs change slowly; cache longer. */
export const AI_POLICY_FORMAL_BAN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Fatigue metadata is time-sensitive; recheck sooner. */
export const AI_POLICY_FATIGUE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Defer window before a repo with a high fatigue signal may be reconsidered. */
export const AI_POLICY_FATIGUE_DEFER_RECHECK_MS = 48 * 60 * 60 * 1000;

const AI_POLICY_FATIGUE_NONE: AiPolicyFatigueSignal = {
  tier: "none",
  priorityAdjustment: "none",
  priorityFactor: 1,
  deferRecheckUntil: null,
  evidence: [],
};

const AI_POLICY_ALLOWED: AiPolicyVerdict = {
  allowed: true,
  matchedPhrase: null,
  source: "none",
  fatigue: AI_POLICY_FATIGUE_NONE,
};

type BanPhrase = {
  phrase: string;
  pattern: RegExp;
};

type FatiguePhrase = {
  phrase: string;
  pattern: RegExp;
};

const BAN_PHRASES: BanPhrase[] = [
  {
    phrase: "no ai-generated pull requests",
    pattern: /\bno\s+ai[-\s]+generated\s+(?:pull\s+requests|prs|contributions)\b/i,
  },
  {
    phrase: "ai-generated prs are rejected",
    pattern:
      /\bai[-\s]+generated\s+(?:prs?|pull\s+requests|contributions?)\s+(?:are|will\s+be)\s+(?:banned|rejected|not\s+accepted)\b/i,
  },
  {
    phrase: "do not submit ai-generated code",
    pattern: /\bdo\s+not\s+(?:use|submit)\s+ai[-\s]+(?:written|generated)\s+code\b/i,
  },
  {
    phrase: "llm-generated code is not accepted",
    pattern: /\b(?:ai|llm)[-\s]+generated\s+code\s+(?:is|will\s+be)\s+(?:rejected|not\s+accepted)\b/i,
  },
];

const FATIGUE_LANGUAGE_PHRASES: FatiguePhrase[] = [
  { phrase: "ai-assisted contributions", pattern: /\bai[-\s]+assisted\s+(?:contributions|pull\s+requests|prs)\b/i },
  { phrase: "automated pull requests", pattern: /\bautomated\s+(?:pull\s+requests|prs|contributions)\b/i },
  { phrase: "copilot contributions", pattern: /\bcopilot\b/i },
  { phrase: "large language model tooling", pattern: /\b(?:large\s+language\s+model|llm)\b/i },
  { phrase: "ai tooling policy", pattern: /\bai\s+tools?\b/i },
  { phrase: "automation policy", pattern: /\bautomation\s+(?:policy|contributions|pull\s+requests)\b/i },
  { phrase: "review ai-generated work carefully", pattern: /\breview\s+ai[-\s]+generated\b/i },
];

const AI_ATTRIBUTION_LABELS = new Set([
  "automated",
  "automation",
  "bot",
  "ai",
  "copilot",
  "llm",
  "generated",
]);

const MIN_AI_ATTRIBUTED_CLOSED_PRS = 3;
const TERSE_REJECTION_ELEVATED_RATE = 0.55;
const TERSE_REJECTION_HIGH_RATE = 0.75;

function roundWeight(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function normalizeRepoKey(repoFullName: string): string {
  const trimmed = repoFullName.trim().toLowerCase();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) return trimmed;
  return `${owner}/${repo}`;
}

function normalizeLabels(labels: readonly string[] | undefined): string[] {
  if (!labels) return [];
  return labels
    .filter((label): label is string => typeof label === "string")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

function matchesBanPhrase(text: string): BanPhrase | null {
  for (const ban of BAN_PHRASES) {
    if (ban.pattern.test(text)) return ban;
  }
  return null;
}

function matchesFatiguePhrase(text: string): FatiguePhrase | null {
  for (const phrase of FATIGUE_LANGUAGE_PHRASES) {
    if (phrase.pattern.test(text) && !matchesBanPhrase(text)) return phrase;
  }
  return null;
}

function parseInstantMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function recencyWeight(observedAtMs: number | null, nowMs: number): number {
  if (observedAtMs === null || !Number.isFinite(nowMs)) return 0.5;
  const ageDays = Math.max(0, (nowMs - observedAtMs) / 86_400_000);
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 90) return 0.5;
  return 0.25;
}

/**
 * Infer AI/automation attribution from metadata markers only — never from PR source content.
 */
export function inferAiAttributionFromPrMetadata(pr: {
  labels?: readonly string[] | undefined;
  authorLogin?: string | null | undefined;
  aiAttributed?: boolean | undefined;
}): boolean {
  if (pr.aiAttributed === true) return true;
  if (pr.aiAttributed === false) return false;
  const login = typeof pr.authorLogin === "string" ? pr.authorLogin.trim().toLowerCase() : "";
  if (login.endsWith("[bot]") || login.endsWith("-bot") || login.endsWith("bot")) return true;
  return normalizeLabels(pr.labels).some((label) => AI_ATTRIBUTION_LABELS.has(label));
}

function isClosedWithoutMerge(pr: AiAttributedPullRequestMetadata): boolean {
  const state = typeof pr.state === "string" ? pr.state.trim().toLowerCase() : "";
  if (pr.merged === true) return false;
  if (pr.merged === false) return true;
  return state === "closed";
}

function isTerseRejection(pr: AiAttributedPullRequestMetadata): boolean {
  if (pr.terseRejection === true) return true;
  if (pr.terseRejection === false) return false;
  return isClosedWithoutMerge(pr);
}

/**
 * Detect concentrated terse rejections on AI-attributed PRs from metadata-only rows.
 */
export function detectTerseRejectionFatigue(
  pullRequests: readonly AiAttributedPullRequestMetadata[],
): { score: number; evidence: AiPolicyFatigueEvidence[] } {
  const aiAttributedClosed = pullRequests.filter(
    (pr) => inferAiAttributionFromPrMetadata(pr) && isClosedWithoutMerge(pr),
  );
  if (aiAttributedClosed.length < MIN_AI_ATTRIBUTED_CLOSED_PRS) {
    return { score: 0, evidence: [] };
  }
  const terseRejections = aiAttributedClosed.filter((pr) => isTerseRejection(pr)).length;
  const rate = terseRejections / aiAttributedClosed.length;
  if (rate < TERSE_REJECTION_ELEVATED_RATE) return { score: 0, evidence: [] };
  const score = roundWeight(Math.min(1, rate));
  return {
    score,
    evidence: [
      {
        kind: "terse_rejection_pattern",
        detail: `${terseRejections}/${aiAttributedClosed.length} recent AI-attributed PRs closed without merge`,
        weight: score,
      },
    ],
  };
}

/**
 * Scan contributing/policy doc text for AI/automation language that stops short of an explicit ban phrase.
 */
export function scanContributingDocFatigueLanguage(
  content: string | null | undefined,
  source: AiPolicySource,
): AiPolicyFatigueEvidence[] {
  const text = content ?? "";
  if (source === "none" || text.trim().length === 0) return [];
  const evidence: AiPolicyFatigueEvidence[] = [];
  for (const phrase of FATIGUE_LANGUAGE_PHRASES) {
    if (phrase.pattern.test(text) && !matchesBanPhrase(text)) {
      evidence.push({
        kind: "contributing_doc_language",
        detail: `${phrase.phrase} (${source})`,
        weight: 0.5,
      });
    }
  }
  return evidence;
}

/**
 * Detect newly added AI/automation language in a contributing doc revision without matching a formal ban phrase.
 */
export function detectContributingDocFatigueRevision(input: {
  previous: string | null | undefined;
  current: string | null | undefined;
  source: AiPolicySource;
  observedAt?: string | null | undefined;
  nowMs?: number | undefined;
}): { score: number; evidence: AiPolicyFatigueEvidence[] } {
  const current = input.current ?? "";
  const previous = input.previous ?? "";
  if (input.source === "none" || current.trim().length === 0) return { score: 0, evidence: [] };

  const currentMatches = scanContributingDocFatigueLanguage(current, input.source);
  const previousPhrases = new Set(
    scanContributingDocFatigueLanguage(previous, input.source).map((item) => item.detail),
  );
  const freshEvidence = currentMatches.filter((item) => !previousPhrases.has(item.detail));
  if (freshEvidence.length === 0 && previous.trim().length > 0) return { score: 0, evidence: [] };

  const evidence =
    previous.trim().length === 0
      ? currentMatches
      : freshEvidence.length > 0
        ? freshEvidence
        : currentMatches;
  if (evidence.length === 0) return { score: 0, evidence: [] };

  const weight = recencyWeight(parseInstantMs(input.observedAt), input.nowMs ?? Date.now());
  const score = roundWeight(Math.min(1, 0.35 + evidence.length * 0.15) * weight);
  return {
    score,
    evidence: evidence.map((item) => ({ ...item, weight: roundWeight(item.weight * weight) })),
  };
}

function composeFatigueSignal(input: {
  terseScore: number;
  terseEvidence: AiPolicyFatigueEvidence[];
  docScore: number;
  docEvidence: AiPolicyFatigueEvidence[];
  nowMs: number;
}): AiPolicyFatigueSignal {
  const combinedScore = roundWeight(Math.max(input.terseScore, input.docScore * 0.85));
  const evidence = [...input.terseEvidence, ...input.docEvidence];
  if (combinedScore <= 0 || evidence.length === 0) return { ...AI_POLICY_FATIGUE_NONE };

  if (combinedScore >= 0.65 || input.terseScore >= TERSE_REJECTION_HIGH_RATE) {
    return {
      tier: "high",
      priorityAdjustment: "defer",
      priorityFactor: 0.15,
      deferRecheckUntil: new Date(input.nowMs + AI_POLICY_FATIGUE_DEFER_RECHECK_MS).toISOString(),
      evidence,
    };
  }

  return {
    tier: "elevated",
    priorityAdjustment: "deprioritize",
    priorityFactor: 0.55,
    deferRecheckUntil: null,
    evidence,
  };
}

function resolveFormalBanVerdict(docs: AiPolicyAssessmentInput["docs"]): Pick<AiPolicyVerdict, "allowed" | "matchedPhrase" | "source"> {
  if (docs.aiUsage !== null && docs.aiUsage !== undefined && docs.aiUsage.trim().length > 0) {
    return scanAiPolicyText(docs.aiUsage, "AI-USAGE.md");
  }
  if (docs.contributing !== null && docs.contributing !== undefined) {
    return scanAiPolicyText(docs.contributing, "CONTRIBUTING.md");
  }
  return { allowed: true, matchedPhrase: null, source: "none" };
}

/**
 * Resolve formal-ban and organic-fatigue signals together. Fatigue never overrides a formal ban and is never
 * promoted into one — the hard-skip boolean stays authoritative for fan-out skip decisions.
 */
export function resolveAiPolicyAssessment(input: AiPolicyAssessmentInput): AiPolicyVerdict {
  const formal = resolveFormalBanVerdict(input.docs);
  if (!formal.allowed) {
    return { ...formal, fatigue: AI_POLICY_FATIGUE_NONE };
  }
  const nowMs = Number.isFinite(input.nowMs) ? (input.nowMs as number) : Date.now();
  const policySource =
    formal.source !== "none"
      ? formal.source
      : input.docs.contributing && input.docs.contributing.trim().length > 0
        ? "CONTRIBUTING.md"
        : input.docs.aiUsage && input.docs.aiUsage.trim().length > 0
          ? "AI-USAGE.md"
          : "none";

  const terse = detectTerseRejectionFatigue(input.closedPullRequests ?? []);
  const doc = detectContributingDocFatigueRevision({
    previous: input.previousContributing,
    current: input.docs.contributing,
    source: policySource === "none" ? "CONTRIBUTING.md" : policySource,
    observedAt: input.contributingObservedAt,
    nowMs,
  });

  const fatigue = composeFatigueSignal({
    terseScore: terse.score,
    terseEvidence: terse.evidence,
    docScore: doc.score,
    docEvidence: doc.evidence,
    nowMs,
  });

  return { ...formal, fatigue };
}

/**
 * Conservative by design (#2305): explicit ban phrases deny a repo, but ambiguous or absent policy text stays
 * allowed. False negatives can be tightened with new literal phrases; false positives would hide valid work.
 */
export function scanAiPolicyText(content: string | null | undefined, source: AiPolicySource): AiPolicyVerdict {
  const text = content ?? "";
  if (source === "none" || text.trim().length === 0) {
    return { allowed: true, matchedPhrase: null, source, fatigue: AI_POLICY_FATIGUE_NONE };
  }
  const ban = matchesBanPhrase(text);
  if (ban) {
    return { allowed: false, matchedPhrase: ban.phrase, source, fatigue: AI_POLICY_FATIGUE_NONE };
  }
  return { allowed: true, matchedPhrase: null, source, fatigue: AI_POLICY_FATIGUE_NONE };
}

export function resolveAiPolicyVerdict(docs: {
  aiUsage: string | null | undefined;
  contributing: string | null | undefined;
}): AiPolicyVerdict {
  return resolveAiPolicyAssessment({ docs });
}

/** Cache TTL depends on whether the repo is formally banned or carrying a fatigue signal. Pure. */
export function aiPolicyVerdictCacheTtlMs(verdict: AiPolicyVerdict): number {
  if (!verdict.allowed) return AI_POLICY_FORMAL_BAN_CACHE_TTL_MS;
  if (verdict.fatigue.tier !== "none") return AI_POLICY_FATIGUE_CACHE_TTL_MS;
  return AI_POLICY_FORMAL_BAN_CACHE_TTL_MS;
}

export function readAiPolicyVerdictCache(
  cache: ReadonlyMap<string, AiPolicyVerdictCacheEntry> | Readonly<Record<string, AiPolicyVerdictCacheEntry>>,
  repoFullName: string,
  nowMs: number,
): AiPolicyVerdictCacheEntry | null {
  const key = normalizeRepoKey(repoFullName);
  let entry: AiPolicyVerdictCacheEntry | undefined;
  if (cache instanceof Map) {
    entry = cache.get(key);
  } else {
    entry = (cache as Record<string, AiPolicyVerdictCacheEntry>)[key];
  }
  if (!entry) return null;
  if (!Number.isFinite(nowMs) || nowMs >= entry.expiresAtMs) return null;
  return entry;
}

export function writeAiPolicyVerdictCache(
  cache: Map<string, AiPolicyVerdictCacheEntry>,
  repoFullName: string,
  verdict: AiPolicyVerdict,
  nowMs: number,
): AiPolicyVerdictCacheEntry {
  const ttl = aiPolicyVerdictCacheTtlMs(verdict);
  const entry: AiPolicyVerdictCacheEntry = {
    repoFullName: normalizeRepoKey(repoFullName),
    verdict,
    cachedAtMs: nowMs,
    expiresAtMs: nowMs + ttl,
    cacheKind: !verdict.allowed ? "formal_ban" : verdict.fatigue.tier !== "none" ? "fatigue" : "clean",
  };
  cache.set(entry.repoFullName, entry);
  return entry;
}

/** Apply fatigue priority adjustment to an opportunity rank score. Deferred repos score to zero until recheck. */
export function applyAiPolicyFatigueToRankScore(
  rankScore: number,
  fatigue: AiPolicyFatigueSignal,
  nowMs: number,
): { rankScore: number; deferred: boolean } {
  if (!Number.isFinite(rankScore) || rankScore <= 0) return { rankScore: 0, deferred: false };
  if (fatigue.priorityAdjustment === "none") return { rankScore, deferred: false };
  const deferUntilMs = parseInstantMs(fatigue.deferRecheckUntil);
  if (fatigue.priorityAdjustment === "defer" && deferUntilMs !== null && nowMs < deferUntilMs) {
    return { rankScore: 0, deferred: true };
  }
  const factor = Number.isFinite(fatigue.priorityFactor) ? Math.min(1, Math.max(0, fatigue.priorityFactor)) : 1;
  return { rankScore: roundWeight(rankScore * factor), deferred: false };
}

function markdownSafe(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

/** Render a deterministic audit block for hard-skip and fatigue decisions. */
export function renderAiPolicyAssessmentMarkdown(repoFullName: string, verdict: AiPolicyVerdict): string {
  const lines = [
    `# AI policy assessment — ${markdownSafe(repoFullName)}`,
    "",
    `- hard skip: ${!verdict.allowed}`,
    `- matched ban phrase: ${verdict.matchedPhrase ? markdownSafe(verdict.matchedPhrase) : "none"}`,
    `- policy source: ${verdict.source}`,
    `- fatigue tier: ${verdict.fatigue.tier}`,
    `- priority adjustment: ${verdict.fatigue.priorityAdjustment}`,
    `- priority factor: ${verdict.fatigue.priorityFactor.toFixed(6)}`,
    `- defer recheck until: ${verdict.fatigue.deferRecheckUntil ?? "n/a"}`,
    "",
    "## Fatigue evidence",
    "",
  ];
  if (verdict.fatigue.evidence.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      "| Kind | Detail | Weight |",
      "| --- | --- | ---: |",
      ...verdict.fatigue.evidence.map(
        (item) => `| ${markdownSafe(item.kind)} | ${markdownSafe(item.detail)} | ${item.weight.toFixed(6)} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

export const aiPolicyMapInternals = {
  AI_POLICY_FATIGUE_NONE,
  AI_POLICY_ALLOWED,
};
