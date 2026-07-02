// Issue-centric RAG query composer (#2320). The miner's ANALYZE phase reasons about an ISSUE before any diff
// exists, so — unlike the review path, which composes its retrieval query from a PR's changed files + diff
// (`buildRagQuery` in `./rag-wire`) — there is no patch to embed, only the issue's title + body (+ labels). This
// module is the issue-centric analogue of `buildRagQuery`: it composes the retrieval QUERY TEXT that a later
// analyze-phase caller feeds to the SAME `retrieveContextWithMetrics` engine (`./rag`) unchanged, so the miner can
// pull the most relevant existing code/docs for an issue the same way the reviewer pulls them for a PR.
//
// PURE — no IO, no adapters, no vector query here: this file builds the query STRING only (retrieval itself is
// reused unchanged from `./rag`), mirroring how `buildRagQuery` is a pure composer separate from
// `buildReviewRagContext`'s wiring.

/** Cap on how much of the issue body feeds the query — bounds query length / embed cost. Mirrors
 *  `MAX_QUERY_DIFF_CHARS` in `./rag-wire` (the PR path's diff-sample budget), renamed for the body input. */
const MAX_QUERY_BODY_CHARS = 4000;
/** Trivially-short queries aren't worth an embed + a vector query (the matches would be noise), so a query below
 *  this floor degrades to "" and the caller skips retrieval — exactly like the PR path, where
 *  `retrieveContextWithMetrics` drops a sub-floor query (the private `MIN_QUERY_CHARS = 40` at `./rag`:358). We
 *  apply the SAME floor here so a one-line issue produces no query at all rather than an embed that returns noise. */
const MIN_QUERY_CHARS = 40;

/**
 * Compose the retrieval QUERY TEXT for an issue from its TITLE + BODY (+ optional LABELS). We PREPEND the issue
 * title (the intent in natural language — recall parity with `buildRagQuery`'s title-led PR query), then append a
 * bounded slice of the body so the embedder sees real tokens (identifiers, API names) and not just the title, then
 * append the labels as a short hint line. Returns "" when the composed query falls below the shared
 * `MIN_QUERY_CHARS` floor (a one-line issue): the caller then degrades to no-context, exactly like the PR path.
 * Pure — same input always yields the same query text.
 */
export function buildIssueRagQuery(input: {
  title: string;
  body?: string;
  labels?: string[];
}): { queryText: string } {
  const title = input.title.trim();
  // A bounded slice of the body gives the embedder real tokens to match on; over-budget bodies are truncated so the
  // query stays focused (the embedder truncates anyway).
  const body = (typeof input.body === "string" ? input.body : "").trim().slice(0, MAX_QUERY_BODY_CHARS);
  const labels = (input.labels ?? []).map((label) => label.trim()).filter(Boolean);
  // Title leads the query (before the body) so the embedder sees the issue's intent first; a blank/whitespace title
  // is omitted cleanly so the query still starts with the body — mirroring `buildRagQuery`'s blank-title handling.
  const titleLine = title ? `${title}\n\n` : "";
  const labelLine = labels.length > 0 ? `\n\nLabels: ${labels.join(", ")}` : "";
  const queryText = `${titleLine}${body}${labelLine}`.trim();
  return { queryText: queryText.length >= MIN_QUERY_CHARS ? queryText : "" };
}
