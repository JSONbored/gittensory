import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ANALYTICS_WINDOWS, type AnalyticsWindow } from "@/lib/analytics-window";

/**
 * Header control that lets an operator pick the analytics time window. Purely
 * presentational — the selected value is owned (and persisted) by the route.
 */
export function AnalyticsWindowToggle({
  value,
  onChange,
  className,
}: {
  value: AnalyticsWindow;
  onChange: (value: AnalyticsWindow) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        // Radix emits "" when the active item is re-pressed; keep a window always selected.
        if (next) onChange(next as AnalyticsWindow);
      }}
      variant="outline"
      size="sm"
      aria-label="Analytics time window"
      className={className}
    >
      {ANALYTICS_WINDOWS.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label}>
          {option.value}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
