import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Accessible horizontal-scroll container for a wide data table (#794). A table that overflows its
 * column area on a narrow viewport can be scrolled by pointer/trackpad but NOT by keyboard alone:
 * marking the scroll region focusable (`tabIndex={0}`) with `role="region"` + an `aria-label` gives
 * keyboard users a real tab stop to scroll from (WCAG 2.1.1 Keyboard) and names the region for
 * assistive tech. Pair with a `<caption>` and `scope="col"` headers on the table inside — the three
 * together are the standard responsive-table a11y pattern this app's bare `overflow-x-auto` divs and
 * caption-less tables were missing.
 */
export function TableScroll({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn("overflow-x-auto focus-ring", className)}
    >
      {children}
    </div>
  );
}
