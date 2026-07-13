import type { SelfReviewContextFetch } from "./self-review-context.js";
import type { OwnRejectionHistoryOptions } from "./own-rejection-history.js";

export function resolveRejectionSignaled(
  repoFullName: string,
  options?: {
    rawContentBaseUrl?: string;
    fetchImpl?: SelfReviewContextFetch;
  } & Pick<OwnRejectionHistoryOptions, "githubToken" | "apiBaseUrl" | "maxFetches" | "listSubmissions">,
): Promise<boolean>;
