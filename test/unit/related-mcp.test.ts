import { describe, expect, it } from "vitest";
import {
  buildRelatedToolsHint,
  METAGRAPHED_NAME,
  METAGRAPHED_RELATED_HINT,
  METAGRAPHED_SITE_URL,
} from "../../src/services/related-mcp";

describe("cross-MCP related-tools hint (#696)", () => {
  it("points a Gittensory agent at metagraphed for the adjacent subnet-discovery intent", () => {
    const hint = buildRelatedToolsHint();

    expect(hint.self.name).toBe("gittensory");
    expect(hint.self.role).toBe("contribution_interface");

    const metagraphed = hint.related.find((sibling) => sibling.name === METAGRAPHED_NAME);
    expect(metagraphed, "metagraphed sibling hint is present").toBeDefined();
    expect(metagraphed?.site).toBe(METAGRAPHED_SITE_URL);
    expect(metagraphed?.role).toBe("subnet_discovery");
    // The sibling exposes its own discovery/validation/invocation tools to hand off to.
    expect(metagraphed?.handoffTools).toEqual(expect.arrayContaining(["get_subnet", "how_do_i_call"]));
    expect(metagraphed?.useFor.length).toBeGreaterThan(0);
  });

  it("keeps the two scopes linked, not merged", () => {
    const hint = buildRelatedToolsHint();
    expect(hint.note.toLowerCase()).toContain("link, don't merge");
    expect(METAGRAPHED_RELATED_HINT.boundary.toLowerCase()).toContain("link, don't merge");
  });

  it("is pure product metadata with no private/reward/score wording", () => {
    const serialized = JSON.stringify(buildRelatedToolsHint());
    expect(serialized).not.toMatch(/wallet|hotkey|coldkey|reward|payout|trust score|ranking/i);
  });
});
