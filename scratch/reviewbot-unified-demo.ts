// Throwaway fixture to verify reviewbot's unified CodeRabbit-style review (one thread: summary body +
// inline committable suggestions + a consolidated "Prompt for AI agents"). Lives in scratch/ — outside
// the build, typecheck, test, and coverage scope — so it cannot affect CI. Safe to delete.

/** Return the average of the numbers. */
export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Parse a port number from a string, defaulting to 8080. */
export function parsePort(raw: string): number {
  return parseInt(raw) || 8080;
}
