/** True when the client was built with `VITE_DEMO_MODE=true` (vite `--mode demo`, #5963). */
export function isDemoMode(): boolean {
  return import.meta.env.VITE_DEMO_MODE === "true";
}
