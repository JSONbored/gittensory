// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const shouldBuildNitro = process.env.npm_lifecycle_event?.startsWith("build") ?? false;

export default defineConfig({
  nitro: shouldBuildNitro,
  tanstackStart: {
    client: { entry: "client" },
    // Redirect production SSR builds through src/server.ts, which wraps catastrophic errors.
    // Dev mode uses TanStack Start's default server entry.
    ...(shouldBuildNitro ? { server: { entry: "server" } } : {}),
  },
});
