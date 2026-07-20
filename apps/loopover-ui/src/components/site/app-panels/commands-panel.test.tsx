import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BotReply } from "@/components/site/app-panels/commands-panel";

describe("BotReply renderInline underscore handling (#7531)", () => {
  it("REGRESSION: renders underscore-heavy identifiers verbatim, without italicizing an intraword fragment", () => {
    const { container } = render(
      <BotReply
        boundary="public"
        body="Use LOOPOVER_ENABLE_PAGERDUTY to opt in, and set repo_full_name accordingly."
      />,
    );
    // Every underscore in the identifiers survives...
    expect(container.textContent).toContain("LOOPOVER_ENABLE_PAGERDUTY");
    expect(container.textContent).toContain("repo_full_name");
    // ...and no intraword fragment was turned into an <em> (the pre-fix bug italicized "_ENABLE_"/"_full_").
    expect(container.querySelector("em")).toBeNull();
  });

  it("still italicizes a genuine word-boundary _italic_ span", () => {
    const { container } = render(
      <BotReply boundary="public" body="This is _important_ context." />,
    );
    expect(container.querySelector("em")?.textContent).toBe("important");
    // The underscores are stripped only for the genuine italic span; the surrounding text is intact.
    expect(container.textContent).toContain("This is important context.");
  });

  it("leaves **bold** and `code` matching unchanged", () => {
    const { container } = render(<BotReply boundary="public" body="Use **run** or `queue` now." />);
    expect(container.querySelector("strong")?.textContent).toBe("run");
    expect(container.querySelector("code")?.textContent).toBe("queue");
    expect(container.querySelector("em")).toBeNull();
  });
});
