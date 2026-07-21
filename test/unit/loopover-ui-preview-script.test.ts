import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("apps/loopover-ui preview script", () => {
  // Regression guard: @tanstack/start-plugin-core's preview-server-plugin derives the file it imports
  // from the vite-level server entry's basename ("server" -> server.js), but this app's nitro
  // cloudflare-module preset (vite.config.ts) repackages the server build as dist/server/index.mjs --
  // server.js is never produced, so bare `vite preview` 500s on every request after any build, with no
  // upstream fix available as of @tanstack/start-plugin-core@1.171.24 (latest at time of writing). wrangler
  // dev against the real built Worker -- the same mechanism deploy:built/version:built already use just
  // above this script -- is the only local command that actually serves this app's production build.
  it("uses wrangler dev against the built Cloudflare Worker output, not the broken vite preview", () => {
    const pkg = JSON.parse(readFileSync("apps/loopover-ui/package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.preview).toBe(
      "wrangler dev --config dist/server/wrangler.json --ip 127.0.0.1 --port 4173 --local",
    );
  });
});
