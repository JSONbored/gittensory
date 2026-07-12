import type { SelfReviewContextFetch } from "./self-review-context.js";

export function resolveRejectionSignaled(
  repoFullName: string,
  options?: { rawContentBaseUrl?: string; fetchImpl?: SelfReviewContextFetch },
): Promise<boolean>;
