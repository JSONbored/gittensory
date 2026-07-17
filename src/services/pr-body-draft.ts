// #6741: buildPublicPrBodyDraft moved to @loopover/engine so the CLI stdio mirror can share it.
// This file is a thin re-export preserving every existing import path (MCP server, unit tests).
export {
  EXCLUDED_PRIVATE_PR_BODY_FIELDS,
  buildPublicPrBodyDraft,
  type PrBodyDraftSection,
  type PrBodyDraftSource,
  type PublicPrBodyDraft,
} from "@loopover/engine";
