import type { AmsPolicySpec } from "@jsonbored/gittensory-engine";
import type { SelfReviewContextFetch } from "./self-review-context.js";

export function resolveAmsPolicyConfigPath(env?: Record<string, string | undefined>): string;

export type AmsPolicySource = "local" | "repo" | "default";

export type ResolvedAmsPolicy = {
  spec: AmsPolicySpec;
  source: AmsPolicySource;
  warnings: string[];
};

export function resolveAmsPolicy(
  repoFullName: string,
  options?: {
    rawContentBaseUrl?: string;
    fetchImpl?: SelfReviewContextFetch;
    readFileSync?: (path: string, encoding: "utf8") => string;
    existsSync?: (path: string) => boolean;
    env?: Record<string, string | undefined>;
  },
): Promise<ResolvedAmsPolicy>;
