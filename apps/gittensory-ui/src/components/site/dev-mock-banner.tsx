import { useDevMockMode } from "@/lib/dev-mock-mode";

export function DevMockBanner() {
  const mockMode = useDevMockMode();
  if (!mockMode) return null;

  return (
    <div
      role="status"
      className="mb-4 rounded-token border border-mint/30 bg-mint/10 px-4 py-2 text-token-xs text-foreground"
    >
      <span className="font-mono uppercase tracking-wider text-mint">Dev mock data</span>
      <span className="text-muted-foreground">
        {" "}
        — API responses are replaced with fixtures for screenshot capture. Remove{" "}
        <code className="font-mono">mock=1</code> from the URL to load live data.
      </span>
    </div>
  );
}
