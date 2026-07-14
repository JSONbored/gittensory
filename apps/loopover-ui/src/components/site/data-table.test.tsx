import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TableScroll } from "@/components/site/data-table";

describe("TableScroll", () => {
  it("wraps its table in a keyboard-focusable, labelled scroll region (WCAG 2.1.1)", () => {
    render(
      <TableScroll label="Example data">
        <table>
          <caption className="sr-only">Example data rows</caption>
          <tbody>
            <tr>
              <td>cell</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );
    const region = screen.getByRole("region", { name: "Example data" });
    // A bare overflow-x-auto div is not a tab stop; this one is, so keyboard users can scroll it.
    expect(region.tabIndex).toBe(0);
    expect(region.className).toContain("overflow-x-auto");
    // The inner table takes its accessible name from the caption, not the region label.
    expect(screen.getByRole("table", { name: "Example data rows" })).toBeTruthy();
  });

  it("merges a caller className onto the scroll region without dropping the base classes", () => {
    render(
      <TableScroll label="Wide table" className="mt-4">
        <table>
          <tbody>
            <tr>
              <td>x</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );
    const region = screen.getByRole("region", { name: "Wide table" });
    expect(region.className).toContain("mt-4");
    expect(region.className).toContain("overflow-x-auto");
  });
});
