// Issue-centric RAG query composition (#2320), extracted from `src/review/issue-rag-wire.ts` (#4254) so the
// gittensory-miner analyze phase can build the identical retrieval query without importing the review stack.
// Pure, string-only: the miner has no PR diff yet, so retrieval is fed from the issue's title/body/labels
// while the RAG engine itself stays unchanged (retrieveContext remains Vectorize/D1-bound in `src/review/rag.ts`
// and is intentionally NOT part of this module).

/** Skip retrieval for a trivially-short query (e.g. a one-word scope string): not worth an embed +
 *  a vector query, and the matches would be noise. Single source of truth — `src/review/rag.ts`
 *  re-exports this so the retrieval guard and the query builder can never drift apart. (#cloud-opt) */
export const MIN_QUERY_CHARS = 40;

const MAX_ISSUE_BODY_CHARS = 4000;
const MAX_ISSUE_LABELS = 20;

export type IssueRagQueryInput = {
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
};

function cleanLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  return labels
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, MAX_ISSUE_LABELS);
}

export function buildIssueRagQuery(input: IssueRagQueryInput): { queryText: string } {
  const sections: string[] = [];
  const title = input.title.trim();
  if (title) sections.push(title);

  const body = (input.body ?? "").trim().slice(0, MAX_ISSUE_BODY_CHARS);
  if (body) sections.push(body);

  const labels = cleanLabels(input.labels);
  if (labels.length > 0) sections.push(`Labels: ${labels.join(", ")}`);

  const queryText = sections.join("\n\n").trim();
  if (queryText.length < MIN_QUERY_CHARS) return { queryText: "" };
  return { queryText };
}
