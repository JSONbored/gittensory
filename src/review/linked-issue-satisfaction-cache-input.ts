import { sha256Hex } from "../utils/crypto";

// #linked-issue-satisfaction-cache: mirrors ai-slop-cache-input.ts's fingerprint discipline exactly (kept as
// its own small module -- not reused directly -- so the two caches' version strings never collide/alias each
// other in stored rows). The satisfaction assessment's only input that can change independently of the PR's
// head SHA is which provider writes the opinion: the free/default reviewer vs. a maintainer's BYOK key/model
// (see LinkedIssueSatisfactionRunInput in ../services/linked-issue-satisfaction-run). Issue title/body/diff are
// pinned to the head SHA (a fresh commit is what invalidates the cache row itself) and the linked issue number
// is a SEPARATE primary-key column (not folded into this fingerprint) -- see the cache table's migration doc
// for why a changed primary linked issue must miss the cache rather than replay a different issue's verdict.
export const LINKED_ISSUE_SATISFACTION_CACHE_INPUT_VERSION = "linked-issue-satisfaction-input:v1";

export type LinkedIssueSatisfactionCacheInput = {
  byok: boolean;
  provider: string | null | undefined;
  model: string | null | undefined;
};

export async function linkedIssueSatisfactionCacheInputFingerprint(input: LinkedIssueSatisfactionCacheInput): Promise<string> {
  const payload = [
    LINKED_ISSUE_SATISFACTION_CACHE_INPUT_VERSION,
    input.byok ? "1" : "0",
    input.provider ?? "",
    input.model ?? "",
  ].join("|");
  return `${LINKED_ISSUE_SATISFACTION_CACHE_INPUT_VERSION}:${await sha256Hex(payload)}`;
}
