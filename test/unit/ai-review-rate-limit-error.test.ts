import { describe, expect, it } from "vitest";
import { isRateLimitError } from "../../src/services/ai-review";

// Direct contract test for isRateLimitError (#5385-sentry / GITTENSORY-K/8, added in #5481). The helper is the
// SHARED short-circuit that four independent AI-calling retry loops now depend on — runWorkersOpinion +
// runDualAiTieBreakJudgeCall (services/ai-review.ts), planner.ts, ai-slop.ts, and
// linked-issue-satisfaction-run.ts all `break` out of the same-model retry on a 429 instead of burning the
// remaining per-model budget on a rate-limit window that will not have cleared a few hundred ms later. It
// shipped wired into those loops but with no test of its own; this pins the exact set of error shapes that count
// as a rate limit so a future tweak to the `/_(?:http|error)_429$/` matcher can't silently regress the
// short-circuit across every one of those call sites at once.

describe("isRateLimitError — the shared 429 retry short-circuit (#5481)", () => {
  it("matches every provider 429 shape src/selfhost/ai.ts actually throws", () => {
    // ai.ts line 344 `ai_http_${status}`, line 392 `anthropic_http_${status}`, line 990
    // `claude_code_error_${errStatus}`, and the embeddings path's `ai_embed_http_${status}`.
    for (const message of ["ai_http_429", "anthropic_http_429", "claude_code_error_429", "ai_embed_http_429"]) {
      expect(isRateLimitError(new Error(message))).toBe(true);
    }
  });

  it("does NOT match a non-429 provider status (a 4xx/5xx that a retry might legitimately clear)", () => {
    for (const message of ["claude_code_error_404", "ai_http_400", "anthropic_http_500", "ai_http_503"]) {
      expect(isRateLimitError(new Error(message))).toBe(false);
    }
  });

  it("does NOT match the sibling non-transient error that has its own separate short-circuit", () => {
    // runWorkersOpinion breaks on `isSubscriptionCliTimeout(error) || isRateLimitError(error)` — the two guards
    // are distinct, so a CLI timeout must not be absorbed by the 429 matcher.
    expect(isRateLimitError(new Error("subscription_cli_timeout"))).toBe(false);
    expect(isRateLimitError(new Error("codex_exit_1: unknown model"))).toBe(false);
    expect(isRateLimitError(new Error("claude_code_empty_output"))).toBe(false);
  });

  it("anchors on 429 as the FULL suffix — a longer status or a trailing detail is not a 429", () => {
    // The `$` anchor is deliberate: only a bare `..._http_429` / `..._error_429` is the rate-limit signal.
    expect(isRateLimitError(new Error("ai_http_4291"))).toBe(false);
    expect(isRateLimitError(new Error("claude_code_error_429_retryable"))).toBe(false);
    expect(isRateLimitError(new Error("ai_http_429: too many requests"))).toBe(false);
  });

  it("requires the `_http`/`_error` delimiter, so a bare '429' substring never trips it", () => {
    expect(isRateLimitError(new Error("http_429"))).toBe(false); // no leading `_` before `http`
    expect(isRateLimitError(new Error("429"))).toBe(false);
    expect(isRateLimitError(new Error("rate limited (429)"))).toBe(false);
  });

  it("is false for any non-Error value (the `error instanceof Error` guard)", () => {
    expect(isRateLimitError("ai_http_429")).toBe(false); // a matching string, but not an Error instance
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError(429)).toBe(false);
    expect(isRateLimitError({ message: "ai_http_429" })).toBe(false);
  });
});
