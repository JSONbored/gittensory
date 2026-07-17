import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton } from "@loopover/ui-kit/components/skeleton";

// #7016: every other animated ui-kit primitive (Spinner, button.tsx, tabs.tsx) disables/reduces its
// animation under prefers-reduced-motion via motion-reduce:animate-none; Skeleton was the one loading-state
// primitive that didn't, despite state-views.tsx's own doc comment claiming the whole family respects it.
describe("Skeleton respects prefers-reduced-motion (#7016)", () => {
  it("pairs animate-pulse with motion-reduce:animate-none", () => {
    const { container } = render(<Skeleton data-testid="skeleton" />);
    const el = container.firstElementChild;
    expect(el?.className).toContain("animate-pulse");
    expect(el?.className).toContain("motion-reduce:animate-none");
  });

  it("still merges a caller-supplied className", () => {
    const { container } = render(<Skeleton className="h-4 w-full" />);
    const el = container.firstElementChild;
    expect(el?.className).toContain("h-4");
    expect(el?.className).toContain("w-full");
    expect(el?.className).toContain("motion-reduce:animate-none");
  });
});
