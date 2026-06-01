import { expect } from "vitest";

export const PUBLIC_FORBIDDEN_CONCEPT_CASES = [
  "wallet address",
  "hotkey id",
  "raw trust score",
  "payout",
  "reward estimate",
  "farming",
  "private reviewability",
  "private scoreability",
  "public score estimate",
] as const;

export const PUBLIC_FORBIDDEN_TEXT_PATTERN =
  /\b(wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|raw[-_\s]?trust(?:[-_\s]?scores?)?|trust[-_\s]?scores?|payouts?|reward\w*|farming|private[-_\s]?reviewability|reviewability|private[-_\s]?scoreability|scoreability|public[-_\s]?score[-_\s]?estimates?|estimated[-_\s]?scores?|score[-_\s]?estimates?|private[-_\s]?rankings?|rankings?)\b|\/100|\/Users\/|\/home\/|\/tmp\/|[A-Z]:\\Users\\/i;

export function expectPublicOutputSafe(output: unknown): void {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  expect(text).not.toMatch(PUBLIC_FORBIDDEN_TEXT_PATTERN);
}

export function expectPublicSanitizerCoversForbiddenConcepts(sanitize: (input: string) => string): void {
  for (const unsafeText of PUBLIC_FORBIDDEN_CONCEPT_CASES) {
    expectPublicOutputSafe(sanitize(`Unsafe fixture: ${unsafeText}.`));
  }
}
