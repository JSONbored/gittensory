import { describe, expect, it } from "vitest";

import {
  computeToolbarBadge,
  TOOLBAR_BADGE_EMPTY_COLOR,
  TOOLBAR_BADGE_HAS_DATA_COLOR,
  TOOLBAR_BADGE_NO_DATA_TEXT,
} from "./toolbar-badge.js";

describe("computeToolbarBadge", () => {
  it("shows a dash when rankedCandidates was never populated (undefined)", () => {
    expect(computeToolbarBadge(undefined)).toEqual({
      text: TOOLBAR_BADGE_NO_DATA_TEXT,
      backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
    });
  });

  it("shows a dash for a malformed non-array value, never a count", () => {
    expect(computeToolbarBadge("not-an-array")).toEqual({
      text: TOOLBAR_BADGE_NO_DATA_TEXT,
      backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR,
    });
  });

  it("shows cleared/empty text for a populated-but-empty array (distinct from never-populated)", () => {
    expect(computeToolbarBadge([])).toEqual({ text: "", backgroundColor: TOOLBAR_BADGE_EMPTY_COLOR });
  });

  it("shows the count with the has-data color for a populated array", () => {
    expect(computeToolbarBadge([{}, {}, {}])).toEqual({
      text: "3",
      backgroundColor: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });
  });
});
