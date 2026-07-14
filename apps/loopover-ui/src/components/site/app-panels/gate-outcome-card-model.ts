/** UI-side mirror of qualityDashboard.gateOutcomeBreakdown on GET /v1/app/maintainer-dashboard (#2203). */
export type GateOutcomeCardData = {
  windowDays: number;
  generatedAt: string;
  counts: {
    autoMerged: number;
    autoClosed: number;
    held: number;
  };
  total: number;
  rates: {
    autoMerged: number | null;
    autoClosed: number | null;
    held: number | null;
  };
  summary: string;
};

export type GateOutcomeSegment = {
  key: "autoMerged" | "autoClosed" | "held";
  label: string;
  count: number;
  widthPct: number;
  barClassName: string;
};

const SEGMENT_META: Record<GateOutcomeSegment["key"], { label: string; barClassName: string }> = {
  autoMerged: { label: "Auto-merged", barClassName: "bg-success/80" },
  autoClosed: { label: "Auto-closed", barClassName: "bg-danger/80" },
  held: { label: "Held / manual", barClassName: "bg-warning/80" },
};

export function formatGateOutcomeRate(rate: number | null): string {
  return rate === null ? "n/a" : `${rate}%`;
}

/** Width percentages for the stacked proportion bar; empty when there is no sample. Pure. */
export function gateOutcomeSegments(breakdown: GateOutcomeCardData): GateOutcomeSegment[] {
  if (breakdown.total <= 0) return [];
  return (Object.keys(SEGMENT_META) as GateOutcomeSegment["key"][])
    .map((key) => {
      const count = breakdown.counts[key];
      const meta = SEGMENT_META[key];
      return {
        key,
        label: meta.label,
        count,
        widthPct: (count / breakdown.total) * 100,
        barClassName: meta.barClassName,
      };
    })
    .filter((segment) => segment.widthPct > 0);
}

export function gateOutcomeHasSamples(breakdown: GateOutcomeCardData): boolean {
  return breakdown.total > 0;
}
