// Plain client-side Vite + React + TanStack Router config -- deliberately NOT
// @lovable.dev/vite-tanstack-config and NOT TanStack Start. This app has no server/SSR entry and no
// Cloudflare Worker deploy target: it is a 100% client-side dashboard read from a miner instance's own
// local SQLite state (see packages/gittensory-miner/DEPLOYMENT.md's "no required phone-home" invariant),
// so a plain `vite build` static bundle the CLI can serve locally is the right fit, not a hosted deploy
// pipeline built for gittensory-ui's public website.
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
  ],
});
