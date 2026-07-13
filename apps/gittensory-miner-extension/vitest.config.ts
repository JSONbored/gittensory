import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["*.test.js"],
    coverage: {
      provider: "v8",
      include: ["background.js", "content.js", "opportunity-badge.js", "options.js", "toolbar-badge.js"],
      reporter: ["text", "lcov"],
      // A real baseline (#4865), not an aspirational target -- see apps/gittensory-miner-ui/vitest.config.ts's
      // identical framing. Measured at 99.2% statements / 92.1% branches / 95.12% functions / 100% lines the
      // day this was wired up, with a small buffer below that so routine churn doesn't false-fail. This is a
      // floor meant to catch a genuine regression, not a ratchet to ceremonially raise every PR.
      thresholds: {
        statements: 97,
        branches: 89,
        functions: 92,
        lines: 97,
      },
    },
  },
});
