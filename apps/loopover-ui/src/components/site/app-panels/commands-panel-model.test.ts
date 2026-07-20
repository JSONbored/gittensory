import { describe, expect, it } from "vitest";

import { splitInlineMarkup } from "@/components/site/app-panels/commands-panel-model";

describe("splitInlineMarkup intraword-underscore fix (#7531)", () => {
  it("does NOT split underscores inside a longer identifier (env vars / snake_case)", () => {
    // The exact repro from the issue: no intraword fragment is pulled out as an italics token, so the
    // identifiers survive verbatim as plain runs.
    expect(
      splitInlineMarkup(
        "Use LOOPOVER_ENABLE_PAGERDUTY to opt in, and set repo_full_name accordingly.",
      ),
    ).toEqual(["Use LOOPOVER_ENABLE_PAGERDUTY to opt in, and set repo_full_name accordingly."]);
    expect(splitInlineMarkup("DISCORD_REPO_WEBHOOKS")).toEqual(["DISCORD_REPO_WEBHOOKS"]);
    expect(splitInlineMarkup("set PAGERDUTY_REPO_ROUTING_KEYS now")).toEqual([
      "set PAGERDUTY_REPO_ROUTING_KEYS now",
    ]);
  });

  it("still treats a word-boundary _italic_ token as italics", () => {
    // Flanked by whitespace/punctuation → a real emphasis token (kept with its underscores for the renderer
    // to strip).
    expect(splitInlineMarkup("this is _important_ text")).toEqual([
      "this is ",
      "_important_",
      " text",
    ]);
    expect(splitInlineMarkup("_leading_ then trailing _tail_")).toEqual([
      "_leading_",
      " then trailing ",
      "_tail_",
    ]);
    // Punctuation-flanked (a common real case): "(_note_)" italicizes the inner word.
    expect(splitInlineMarkup("see (_note_) here")).toEqual(["see (", "_note_", ") here"]);
  });

  it("still tokenizes bold and inline code, and leaves them alongside the underscore fix", () => {
    expect(splitInlineMarkup("run **build** then `npm_ci` on FOO_BAR")).toEqual([
      "run ",
      "**build**",
      " then ",
      "`npm_ci`",
      " on FOO_BAR",
    ]);
  });

  it("returns a single plain run for text with no markup", () => {
    expect(splitInlineMarkup("plain text only")).toEqual(["plain text only"]);
  });

  it("returns an empty array for an empty line (filtered)", () => {
    expect(splitInlineMarkup("")).toEqual([]);
  });
});
