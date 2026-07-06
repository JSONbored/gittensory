export function isTestPath(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb|dart)$/i.test(file) ||
    /(^|\/)test_[^/]*\.py$/i.test(file) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs)$/i.test(file) ||
    /(^|\/)[^/]+\.(cy|e2e)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(file) ||
    /(^|\/)\w*(Tests?|Spec)\.(java|kt|kts|scala|cs|swift|groovy|php)$/.test(file) ||
    /(^|\/)__snapshots__\//i.test(file)
  );
}

const TEST_STEM = "(?:test(?:ed|s|ing)?|validat(?:ion|ed)|verif(?:y|ied|ying)|manual check|smoke(?:\\s+tests?)?)";
const NEGATION_WORD = "(?:no|not|never|without|skip(?:ped)?|didn't|doesn't|isn't|wasn't|weren't|haven't|hasn't)";
const NEGATION_CONTINUATION = "(?:not|never|failed|failing|skipped|incomplete)";
const SAME_SENTENCE_FILLER_WORD = "[^\\s.,!?;]+";
const LABEL_SEPARATOR_GAP = "(?:\\s+|[:;\\-\\u2013\\u2014]\\s*)";
const NEGATES_BEFORE_TEST_STEM = new RegExp(`\\b${NEGATION_WORD}\\b${LABEL_SEPARATOR_GAP}(?:${SAME_SENTENCE_FILLER_WORD}\\s+){0,3}${TEST_STEM}\\b`, "i");
const NEGATES_AFTER_TEST_STEM = new RegExp(`\\b${TEST_STEM}\\b${LABEL_SEPARATOR_GAP}(?:${SAME_SENTENCE_FILLER_WORD}\\s+){0,2}${NEGATION_CONTINUATION}\\b`, "i");
const NEGATES_TEST_STEM_PREFIX = /\bun(?:tested|validated|verified)\b/i;
const AFFIRMATIVE_TEST_MENTION = /\b(test(?:ed|s|ing)?|validation|validated|verified|manual check|smoke|pytest|vitest|npm test|pnpm test|cargo test|go test)\b/i;

export function hasValidationNote(value: string): boolean {
  return value
    .split(/[.,!?]+/)
    .some(
      (clause) =>
        !NEGATES_TEST_STEM_PREFIX.test(clause) &&
        !NEGATES_BEFORE_TEST_STEM.test(clause) &&
        !NEGATES_AFTER_TEST_STEM.test(clause) &&
        AFFIRMATIVE_TEST_MENTION.test(clause),
    );
}
