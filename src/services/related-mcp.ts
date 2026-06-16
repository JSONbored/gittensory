import { GITTENSORY_SITE_URL } from "../github/footer";
import { GITTENSORY_MCP_PACKAGE_NAME } from "./mcp-compatibility";
import { GITTENSOR_NETUID } from "./subnet-interface";

// Public catalog MCP for Bittensor subnet discovery/validation/invocation (the sibling of Gittensory).
export const METAGRAPHED_NAME = "metagraphed";
export const METAGRAPHED_SITE_URL = "https://metagraph.sh";

/**
 * One direction of a cross-MCP related-tools hint (#696): "for this adjacent intent, use that sibling MCP".
 * Pure product metadata (names, URLs, intents) — never private/reward/score wording, so it never needs
 * sanitization and is safe on public + unauthenticated surfaces.
 */
export type RelatedMcpHint = {
  name: string;
  role: "subnet_discovery" | "contribution_interface";
  site: string;
  package?: string;
  summary: string;
  // Adjacent intents the agent should hand off to the sibling for (not served here).
  useFor: ReadonlyArray<string>;
  // Representative sibling tool/query names to reach for once handed off.
  handoffTools: ReadonlyArray<string>;
  // The scope line that keeps the two MCPs linked, not merged.
  boundary: string;
};

const SCOPE_BOUNDARY =
  "Gittensory stays scoped to gittensor (SN74) code-contribution workflow; metagraphed covers cross-subnet discovery, validation, and invocation. Link, don't merge.";

/**
 * gittensory → metagraphed: an agent inside the Gittensory MCP that needs the *adjacent* intent
 * (does this subnet exist, what does it do, how do I call it) is pointed at metagraphed (#696).
 */
export const METAGRAPHED_RELATED_HINT: RelatedMcpHint = {
  name: METAGRAPHED_NAME,
  role: "subnet_discovery",
  site: METAGRAPHED_SITE_URL,
  summary: "Bittensor subnet discovery, validation, and invocation catalog across all subnets.",
  useFor: [
    `Validate that a subnet (e.g. gittensor / SN${GITTENSOR_NETUID}) exists and confirm what it does.`,
    "Discover how to invoke a subnet's APIs or agents (invocation methods).",
    "Browse the cross-subnet agent catalog beyond code contribution.",
  ],
  handoffTools: ["get_subnet", "list_subnet_apis", "get_agent_catalog", "how_do_i_call"],
  boundary: SCOPE_BOUNDARY,
};

/**
 * metagraphed → gittensory: the reverse hint, for metagraphed (and any agent that discovered SN74 there)
 * to route the code-contribution intent back to Gittensory. Surfaced in the public subnet-interface
 * descriptor so the link is declared from both sides without merging scopes (#696, builds on #695).
 */
export const GITTENSORY_RELATED_HINT: RelatedMcpHint = {
  name: "gittensory",
  role: "contribution_interface",
  site: GITTENSORY_SITE_URL,
  package: GITTENSORY_MCP_PACKAGE_NAME,
  summary: `Gittensor (SN${GITTENSOR_NETUID}) code-contribution quality & planning layer for miners and maintainers.`,
  useFor: [
    `Plan and prep an actual code contribution to a gittensor (SN${GITTENSOR_NETUID}) repo.`,
    "Find high-fit, low-duplicate issues and check an issue before starting work.",
    "Preflight a planned PR for lane fit, duplicate risk, and review burden.",
  ],
  handoffTools: ["gittensory_get_decision_pack", "gittensory_check_before_start", "gittensory_preflight_pr"],
  boundary: SCOPE_BOUNDARY,
};

export type RelatedToolsHint = {
  self: { name: string; role: "contribution_interface"; site: string; summary: string };
  related: ReadonlyArray<RelatedMcpHint>;
  note: string;
};

/**
 * The cross-MCP related-tools payload returned by the gittensory_related_tools MCP tool (#696): declares
 * Gittensory's own scope and points the agent at metagraphed for the adjacent subnet-discovery intent.
 */
export function buildRelatedToolsHint(): RelatedToolsHint {
  return {
    self: {
      name: "gittensory",
      role: "contribution_interface",
      site: GITTENSORY_SITE_URL,
      summary: GITTENSORY_RELATED_HINT.summary,
    },
    related: [METAGRAPHED_RELATED_HINT],
    note: SCOPE_BOUNDARY,
  };
}
