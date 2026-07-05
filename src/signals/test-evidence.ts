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

// A body can mention testing without having actually done it ("No tests run", "Tests not run", "did not
// run tests") -- the affirmative keyword match below would otherwise treat that as passing evidence and
// let a configured manifest test expectation silently disappear. Reject both negation-before-noun and
// noun-before-negation orderings before falling through to the affirmative match.
const NEGATES_BEFORE_TEST_NOUN = /\b(?:no|not|without|skip(?:ped)?|did not|haven't|have not|never)\s+(?:run\s+|passing\s+|passed\s+)?(?:tests?|validation|manual check|smoke(?: tests?)?)\b/i;
const NEGATES_AFTER_TEST_NOUN = /\b(?:tests?|validation|manual check|smoke(?: tests?)?)\s+(?:not\s+run|not\s+passed|not\s+passing|not\s+included|failed|failing|skipped|were\s+not\s+run|was\s+not\s+run)\b/i;

export function hasValidationNote(value: string): boolean {
  if (NEGATES_BEFORE_TEST_NOUN.test(value) || NEGATES_AFTER_TEST_NOUN.test(value)) return false;
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
