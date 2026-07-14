// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const shouldBuildNitro = process.env.npm_lifecycle_event?.startsWith("build") ?? false;
// Source maps (#1737) are OFF by default -- the regular `ui:build`/Cloudflare Workers Build pipeline that
// serves `dist/client` publicly must never produce `.map` files, or a static-asset deploy would serve them.
// Only the dedicated Sentry source-map-upload workflow (.github/workflows/ui-sentry-release.yml) sets
// SENTRY_BUILD_SOURCEMAPS=1 for its own separate, never-deployed build. "hidden" emits `.map` files on disk
// (for that workflow to read and upload) without embedding a `//# sourceMappingURL` comment in the shipped
// JS, so even if this var were ever set by mistake on a real deploy build, the maps would not be
// auto-discoverable from the public bundle.
const sentryBuildSourcemaps = process.env.SENTRY_BUILD_SOURCEMAPS === "1";
const vendorChunks = [
  ["react-vendor", ["/node_modules/react", "/node_modules/react-dom"]],
  ["tanstack-vendor", ["/node_modules/@tanstack"]],
  ["motion-vendor", ["/node_modules/framer-motion", "/node_modules/motion"]],
  [
    "ui-vendor",
    ["/node_modules/@radix-ui", "/node_modules/cmdk", "/node_modules/sonner", "/node_modules/vaul"],
  ],
  [
    "charts-vendor",
    ["/node_modules/recharts", "/node_modules/d3-", "/node_modules/victory-vendor"],
  ],
] as const;

function manualChunks(id: string) {
  const normalized = id.replaceAll("\\", "/");
  const match = vendorChunks.find(([, paths]) => paths.some((path) => normalized.includes(path)));
  return match?.[0];
}

export default defineConfig({
  // Pin the Cloudflare target + output layout explicitly.
  //
  // Outside a Lovable sandbox (e.g. the Cloudflare Workers Build CI), the plugin
  // only forwards `defaultPreset`/`preset` to nitro and does NOT override the
  // output dir. With the pinned `nitro@3.0.260429-beta` (which predates nitro's
  // `defaultPreset` option, added in 3.0.260603-beta), the Cloudflare fallback is
  // ignored and a zero-config build targets Node, writing to `.output/server/`
  // with no `wrangler.json`. Deploy then fails: `Could not read file:
  // dist/server/wrangler.json (ENOENT)`.
  //
  // Replicate exactly what the plugin's sandbox path does so a fresh `npm ci`
  // build lands the Cloudflare worker (and its generated `wrangler.json`) at
  // `dist/server/`, matching the `version:built`/`deploy:built` scripts.
  nitro: shouldBuildNitro
    ? {
        preset: "cloudflare-module",
        output: { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" },
        cloudflare: { nodeCompat: true, deployConfig: true },
      }
    : false,
  vite: {
    build: {
      ...(sentryBuildSourcemaps ? { sourcemap: "hidden" as const } : {}),
      rollupOptions: {
        output: { manualChunks },
      },
    },
  },
  tanstackStart: {
    client: { entry: "client" },
    // Redirect production SSR builds through src/server.ts, which wraps catastrophic errors.
    // Dev mode uses TanStack Start's default server entry.
    ...(shouldBuildNitro ? { server: { entry: "server" } } : {}),
  },
});
