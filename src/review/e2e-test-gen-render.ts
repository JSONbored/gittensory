// Public-safe rendering for AI-generated E2E test coverage (#4193, part of the #4189 epic).
//
// Unlike fix-handoff (which splices a block into the automated review's sticky unified comment), this
// renders its OWN dedicated reply comment for the `@gittensory generate-tests` command (#4195) — a
// maintainer-triggered, on-demand action, not something that runs on every automated review pass. This
// mirrors how `explain`/`configuration` already post their own on-demand response comments rather than
// editing the main review comment (see `maybeProcessExplainCommand` in `src/queue/processors.ts`).
//
// This layer never re-derives safety: it trusts that #4191's `parseE2eTestGenResponse` already validated
// the test source is plausible Playwright before this ever sees it, and that #4195's caller already
// resolved authorization — this file only turns already-decided content into a public-safe comment body.
import { AGENT_COMMAND_COMMENT_MARKER } from "../github/comments";
import { gittensoryFooter } from "../github/footer";

export type E2eTestGenCommentInput = {
  actor: string;
  /** The generated test source, or null when generation ran but produced nothing usable. */
  testSource: string | null;
  framework?: string | undefined;
};

/**
 * Build the PR-comment body for a `@gittensory generate-tests` result. A null `testSource` renders a
 * clear "nothing usable" note rather than silently posting no comment at all — the maintainer who invoked
 * the command should always get a response, even a negative one.
 */
export function buildE2eTestGenCommentBody(input: E2eTestGenCommentInput): string {
  const framework = input.framework?.trim() || "Playwright";
  if (!input.testSource) {
    return [
      AGENT_COMMAND_COMMENT_MARKER,
      "",
      "> [!NOTE]",
      `> **E2E test generation for @${input.actor} did not produce a usable result**`,
      `> The model's output didn't parse as valid ${framework} source — try again, or add the test by hand.`,
      "",
      "---",
      gittensoryFooter(),
    ].join("\n");
  }
  return [
    AGENT_COMMAND_COMMENT_MARKER,
    "",
    "> [!NOTE]",
    `> **AI-generated ${framework} test for @${input.actor}**`,
    "> This is a suggestion, not a guarantee — review it like any other test before merging.",
    "",
    "```typescript",
    input.testSource,
    "```",
    "",
    "---",
    gittensoryFooter(),
  ].join("\n");
}
