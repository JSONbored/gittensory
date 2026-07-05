export function isTestPath(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb|dart)$/i.test(file) || // Dart/Flutter `foo_test.dart` co-located with source
    /(^|\/)test_[^/]*\.py$/i.test(file) || // pytest's default `test_*.py` prefix convention (the suffix rule above only catches `*_test.py`)
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs)$/i.test(file) ||
    /(^|\/)[^/]+\.(cy|e2e)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(file) ||
    // JVM / C# / Swift / PHP `SomethingTest(s)`/`SomethingSpec` class-suffix convention
    // (JUnit, Kotlin/ScalaTest, Spock, xUnit/NUnit, XCTest, PHPUnit/PHPSpec). Case-sensitive on the
    // PascalCase suffix so it can't false-positive on words that merely end in
    // "test"/"spec" (Latest.java, Contest.cs, manifest.scala, Latest.php).
    /(^|\/)\w*(Tests?|Spec)\.(java|kt|kts|scala|cs|swift|groovy|php)$/.test(file) ||
    /(^|\/)__snapshots__\//i.test(file)
  );
}

export function hasLocalTestEvidence(input: { tests?: string[] | undefined; testFiles?: string[] | undefined }): boolean {
  return (input.tests ?? []).length > 0 || (input.testFiles ?? []).some((file) => isTestPath(file));
}

// A body can mention testing without having actually done it ("No tests run", "Tests not run", "Not
// tested locally", "did not run any tests") -- the affirmative keyword match below would otherwise treat
// that as passing evidence and let a configured manifest test expectation silently disappear. Rather than
// enumerate ever more literal phrase templates (which a previous version of this function tried, and which
// still missed "Not tested" because its test-noun list didn't include the verb form "tested"), detect
// negation by PROXIMITY: a negation word within a few words of a test/validation stem, in either order,
// with a shared stem definition so the "is this a test/validation mention at all" question is answered
// exactly once. The filler between the negation word and the stem may not cross a clause/sentence boundary
// (a comma/period/exclamation/question mark/semicolon), so an unrelated "not" earlier in the body (e.g.
// "This is not a breaking change. Tested with npm run test:ci.") cannot suppress a later, unrelated
// affirmative note.
const TEST_STEM = "(?:test(?:ed|s|ing)?|validat(?:ion|ed)|verif(?:y|ied|ying)|manual check|smoke(?:\\s+tests?)?)";
const NEGATION_WORD = "(?:no|not|never|without|skip(?:ped)?|didn't|doesn't|isn't|wasn't|weren't|haven't|hasn't)";
const NEGATION_CONTINUATION = "(?:not|never|failed|failing|skipped|incomplete)";
const SAME_SENTENCE_FILLER_WORD = "[^\\s.,!?;]+";

const NEGATES_BEFORE_TEST_STEM = new RegExp(`\\b${NEGATION_WORD}\\b(?:\\s+${SAME_SENTENCE_FILLER_WORD}){0,3}\\s+${TEST_STEM}\\b`, "i");
const NEGATES_AFTER_TEST_STEM = new RegExp(`\\b${TEST_STEM}\\b(?:\\s+${SAME_SENTENCE_FILLER_WORD}){0,2}\\s+${NEGATION_CONTINUATION}\\b`, "i");
// A compound negated adjective with no separating whitespace at all ("untested", "unvalidated", "unverified").
const NEGATES_TEST_STEM_PREFIX = /\bun(?:tested|validated|verified)\b/i;

export function hasValidationNote(value: string): boolean {
  if (NEGATES_TEST_STEM_PREFIX.test(value) || NEGATES_BEFORE_TEST_STEM.test(value) || NEGATES_AFTER_TEST_STEM.test(value)) {
    return false;
  }
  return /\b(test(?:ed|s|ing)?|validation|validated|verified|manual check|smoke|pytest|vitest|npm test|pnpm test|cargo test|go test)\b/i.test(value);
}

/**
 * Coarse classification of how much test coverage accompanies a set of changed paths.
 * Used by slop signals to weight diffs that touch source but include no tests differently
 * from those with proportionally strong test changes.
 */
export type TestCoverageClassification = "strong" | "adequate" | "weak" | "absent";

export function classifyTestCoverage(changedPaths: string[]): TestCoverageClassification {
  if (changedPaths.length === 0) return "absent";
  const testCount = changedPaths.filter(isTestPath).length;
  if (testCount === 0) return "absent";
  const ratio = testCount / changedPaths.length;
  if (ratio >= 0.4) return "strong";
  if (ratio >= 0.2) return "adequate";
  return "weak";
}
