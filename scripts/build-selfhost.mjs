// Bundle the self-host Node entry (src/server.ts) into dist/server.mjs. node_modules stay external (resolved
// at runtime); `cloudflare:workers` is resolved to the Node shim via a plugin (which takes precedence over
// `packages: "external"`, so it is BUNDLED rather than left as an unresolvable bare import).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [resolve(root, "src/server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(root, "dist/server.mjs"),
  packages: "external",
  plugins: [
    {
      name: "selfhost-stubs",
      setup(build) {
        // Cloudflare-only modules → Node stubs (their features are inert/degraded on self-host).
        build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: resolve(root, "src/selfhost/cf-workers-shim.ts") }));
        build.onResolve({ filter: /^@cloudflare\/puppeteer$/ }, () => ({ path: resolve(root, "src/selfhost/stubs/puppeteer.ts") }));
        build.onResolve({ filter: /^agents\/mcp$/ }, () => ({ path: resolve(root, "src/selfhost/stubs/agents-mcp.ts") }));
      },
    },
  ],
  logLevel: "info",
});
