// Deterministic structural "objective-anchor" score for the historical-replay calibration harness (#3012).
//
// Once a replay run produces a plan/PR against a frozen snapshot, half of the calibration score is meant to
// come from a deterministic, auditable structural comparison rather than an LLM judgment. This module is that
// structural half: it compares what the miner's replayed output *targeted* (modules touched + change kind)
// against what the revealed post-T history *actually* changed, and returns a reproducible `[0, 1]` score plus
// a full audit breakdown. There is no model call in this path — given the same two feature sets it is
// byte-for-byte reproducible.
// Fixed change-kind vocabulary. Conventional-Commit types collapse onto these buckets; anything unrecognized
// degrades to "other" so a novel prefix lowers the signal instead of throwing.
export const CHANGE_KINDS = Object.freeze([
    "feature",
    "fix",
    "refactor",
    "docs",
    "test",
    "chore",
    "perf",
    "build",
    "ci",
    "style",
    "other",
]);
const CONVENTIONAL_TYPE_TO_KIND = new Map([
    ["feat", "feature"],
    ["feature", "feature"],
    ["fix", "fix"],
    ["bugfix", "fix"],
    ["refactor", "refactor"],
    ["docs", "docs"],
    ["doc", "docs"],
    ["test", "test"],
    ["tests", "test"],
    ["chore", "chore"],
    ["perf", "perf"],
    ["build", "build"],
    ["ci", "ci"],
    ["style", "style"],
]);
// Fixed weights for the two structural components. They sum to 1 so the composed score stays in [0, 1].
export const MODULE_OVERLAP_WEIGHT = 0.7;
export const CHANGE_KIND_WEIGHT = 0.3;
const SCORE_PRECISION = 1e4;
function roundScore(value) {
    return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}
// A path's "module" is its directory (everything before the final slash); a bare filename is its own module.
// Grouping by directory is what makes two different files in one directory a *partial* overlap, not a miss.
function pathToModule(path) {
    const trimmed = path.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (!trimmed)
        return null;
    const slash = trimmed.lastIndexOf("/");
    return slash === -1 ? trimmed : trimmed.slice(0, slash);
}
function normalizeModules(pathsTouched) {
    if (!Array.isArray(pathsTouched))
        return [];
    const modules = new Set();
    for (const entry of pathsTouched) {
        if (typeof entry !== "string")
            continue;
        const module = pathToModule(entry);
        if (module)
            modules.add(module);
    }
    return [...modules].sort();
}
function normalizeKindList(value) {
    if (!Array.isArray(value))
        return [];
    const kinds = new Set();
    for (const entry of value) {
        if (typeof entry === "string" && CHANGE_KINDS.includes(entry))
            kinds.add(entry);
    }
    return [...kinds].sort();
}
function normalizeModuleList(value) {
    if (!Array.isArray(value))
        return [];
    const modules = new Set();
    for (const entry of value) {
        if (typeof entry === "string" && entry)
            modules.add(entry);
    }
    return [...modules].sort();
}
// Deterministically map a Conventional-Commit-style subject (`feat(scope)!: …`) to a change-kind bucket.
// Missing prefix, unknown type, or non-string input all resolve to "other" rather than throwing.
export function classifyChangeKind(value) {
    if (typeof value !== "string")
        return "other";
    const match = /^\s*([A-Za-z]+)\s*(?:\([^)]*\))?\s*!?\s*:/.exec(value);
    if (!match)
        return "other";
    return CONVENTIONAL_TYPE_TO_KIND.get(match[1].toLowerCase()) ?? "other";
}
function resolveChangeKind(entry) {
    if (entry && typeof entry.changeKind === "string") {
        const explicit = entry.changeKind.trim().toLowerCase();
        if (CHANGE_KINDS.includes(explicit))
            return explicit;
    }
    return classifyChangeKind(entry?.title);
}
// Structural features of the miner's replayed plan/PR: the sorted, de-duplicated set of modules it targeted
// and its single change kind (explicit `changeKind` wins; otherwise classified from `title`).
export function extractReplayTargetFeatures(plan) {
    return {
        modules: normalizeModules(plan?.pathsTouched),
        changeKind: resolveChangeKind(plan),
    };
}
// Structural features of the revealed post-T history. The history is a list of commits/PRs (a single object
// is tolerated as a one-element list); modules are unioned and change kinds collected into a set, since the
// revealed side legitimately spans several changes.
export function extractRevealedFeatures(history) {
    const entries = Array.isArray(history) ? history : history ? [history] : [];
    const modules = new Set();
    const changeKinds = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry !== "object")
            continue;
        const typedEntry = entry;
        for (const module of normalizeModules(typedEntry.pathsTouched))
            modules.add(module);
        changeKinds.add(resolveChangeKind(typedEntry));
    }
    return {
        modules: [...modules].sort(),
        changeKinds: [...changeKinds].sort(),
    };
}
// Deterministic objective-anchor score from two already-extracted feature sets. No LLM, no clock, no
// randomness — identical inputs always yield an identical breakdown. A zero-overlap comparison (disjoint
// modules and a change kind the revealed side never shows) resolves to the score floor `0`, never an error.
export function scoreObjectiveAnchor(replayFeatures, revealedFeatures) {
    const replayModules = normalizeModuleList(replayFeatures?.modules);
    const revealedModules = normalizeModuleList(revealedFeatures?.modules);
    const replayChangeKind = typeof replayFeatures?.changeKind === "string" && CHANGE_KINDS.includes(replayFeatures.changeKind)
        ? replayFeatures.changeKind
        : "other";
    const revealedChangeKinds = normalizeKindList(revealedFeatures?.changeKinds);
    const replaySet = new Set(replayModules);
    const revealedSet = new Set(revealedModules);
    const sharedModules = replayModules.filter((module) => revealedSet.has(module));
    const replayOnlyModules = replayModules.filter((module) => !revealedSet.has(module));
    const revealedOnlyModules = revealedModules.filter((module) => !replaySet.has(module));
    const unionSize = replayModules.length + revealedModules.length - sharedModules.length;
    const moduleOverlap = unionSize === 0 ? 0 : sharedModules.length / unionSize;
    const changeKindMatch = revealedChangeKinds.includes(replayChangeKind) ? 1 : 0;
    return {
        score: roundScore(MODULE_OVERLAP_WEIGHT * moduleOverlap + CHANGE_KIND_WEIGHT * changeKindMatch),
        moduleOverlap: roundScore(moduleOverlap),
        changeKindMatch,
        replayChangeKind,
        revealedChangeKinds,
        sharedModules,
        replayOnlyModules,
        revealedOnlyModules,
    };
}
// One-shot entry point: extract both sides, score them, and return the score together with the extracted
// feature sets so a low score is auditable after the fact without re-running the extraction.
export function computeObjectiveAnchor(input) {
    const replayFeatures = extractReplayTargetFeatures(input?.replayPlan);
    const revealedFeatures = extractRevealedFeatures(input?.revealedHistory);
    return {
        ...scoreObjectiveAnchor(replayFeatures, revealedFeatures),
        replayFeatures,
        revealedFeatures,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVwbGF5LW9iamVjdGl2ZS1hbmNob3IuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZXBsYXktb2JqZWN0aXZlLWFuY2hvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwyR0FBMkc7QUFDM0csRUFBRTtBQUNGLDRHQUE0RztBQUM1Ryw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDhHQUE4RztBQUM5RyxzR0FBc0c7QUFDdEcsOEJBQThCO0FBZTlCLDZHQUE2RztBQUM3RywrRUFBK0U7QUFDL0UsTUFBTSxDQUFDLE1BQU0sWUFBWSxHQUEwQixNQUFNLENBQUMsTUFBTSxDQUFDO0lBQy9ELFNBQVM7SUFDVCxLQUFLO0lBQ0wsVUFBVTtJQUNWLE1BQU07SUFDTixNQUFNO0lBQ04sT0FBTztJQUNQLE1BQU07SUFDTixPQUFPO0lBQ1AsSUFBSTtJQUNKLE9BQU87SUFDUCxPQUFPO0NBQ1IsQ0FBQyxDQUFDO0FBRUgsTUFBTSx5QkFBeUIsR0FBRyxJQUFJLEdBQUcsQ0FBcUI7SUFDNUQsQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0lBQ25CLENBQUMsU0FBUyxFQUFFLFNBQVMsQ0FBQztJQUN0QixDQUFDLEtBQUssRUFBRSxLQUFLLENBQUM7SUFDZCxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUM7SUFDakIsQ0FBQyxVQUFVLEVBQUUsVUFBVSxDQUFDO0lBQ3hCLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQztJQUNoQixDQUFDLEtBQUssRUFBRSxNQUFNLENBQUM7SUFDZixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7SUFDaEIsQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDO0lBQ2pCLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FBQztJQUNsQixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7SUFDaEIsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDO0lBQ2xCLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQztJQUNaLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FB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