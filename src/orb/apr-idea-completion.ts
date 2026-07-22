// Trusted server-side idea-completion lookup for APR transfer gating (#7742).
//
// Until #7591/#7664 persist a completion record, this ALWAYS returns incomplete (fail closed). A client
// boolean must never substitute for this — that was the #8000 Superagent P1. When a persisted lookup lands,
// replace the body of this function (keep the signature) so every caller picks it up.

export type AprIdeaCompletionLookupInput = {
  repoFullName: string;
  /** Optional idea/submission id for the eventual #7664 record lookup. */
  ideaId?: string | undefined;
};

export type AprIdeaCompletionLookup = (
  env: Env,
  input: AprIdeaCompletionLookupInput,
) => Promise<{ ideaComplete: boolean }>;

/**
 * Resolve whether an APR idea's task-graph is complete (#7591). Fail-closed until a persisted record exists.
 * Declared return is `{ ideaComplete: boolean }` so a future persisted lookup (and test doubles) can return true;
 * today's body always returns false.
 */
export async function loadAprIdeaCompletion(
  _env: Env,
  _input: AprIdeaCompletionLookupInput,
): Promise<{ ideaComplete: boolean }> {
  return { ideaComplete: false };
}
