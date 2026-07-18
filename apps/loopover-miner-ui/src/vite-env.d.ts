/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When `"true"`, client fetchers serve synthetic data and skip `/api/*` (#5963). */
  readonly VITE_DEMO_MODE?: string;
  /** Optional footer link to an operator Grafana dashboard. */
  readonly VITE_MINER_UI_GRAFANA_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
