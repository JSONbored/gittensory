import { isDemoMode } from "@/lib/demo-mode";

/** Persistent notice when the public demo Worker is serving synthetic data (#5963). */
export function DemoModeBanner() {
  if (!isDemoMode()) return null;
  return (
    <div
      role="status"
      className="border-b-hairline bg-muted/60 px-4 py-2 text-center text-token-sm text-muted-foreground"
    >
      Public demo — synthetic sample data only. Not a live miner and not a commitment to hosted AMS (#5229).
    </div>
  );
}
