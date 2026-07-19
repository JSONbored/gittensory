import { defineConfig } from "vitest/config";

const junitPath = process.env.VITEST_JUNIT_PATH;

export default defineConfig({
  ssr: {
    noExternal: ["agents", "partyserver"],
  },
  resolve: {
    alias: {
      "cloudflare:email": new URL("./test/stubs/cloudflare-email.ts", import.meta.url).pathname,
      "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    globals: true,
    testTimeout: 15000,
    // Retry a failed test once before failing the run. The loopover gate auto-CLOSES a contributor PR
    // on a red required CI, so a single transient flake must not kill an honest PR; a deterministic
    // failure still fails both attempts (and vitest flags the retried test as flaky so it stays visible).
    retry: 1,
    include: ["test/**/*.test.ts"],
    exclude: ["test/workers/**/*.test.ts"],
    reporters: junitPath ? ["default", "junit"] : ["default"],
    ...(junitPath ? { outputFile: { junit: junitPath } } : {}),
    coverage: {
      provider: "v8",
      include: [
        "src/**/*.ts",
        "packages/loopover-engine/src/**/*.ts",
        "packages/loopover-miner/lib/**/*.js",
        // Files already converted to real TypeScript (#7290) execute as the compiled .js above, but
        // v8's coverage provider remaps through the inline sourcemap tsc emits, attributing coverage to
        // the .ts source instead -- this entry is what keeps that remapped file in the report.
        "packages/loopover-miner/lib/**/*.ts",
        "packages/discovery-index/src/**/*.ts",
        // review-enrichment is a standalone (non-workspace) package with its own node:test suite; its
        // coverage is collected separately via `npm run rees:coverage` (c8 over the built dist, remapped
        // to src through source maps) and uploaded to Codecov under the `rees` flag -- vitest never runs
        // it, so it must not be listed here (an entry here just reports 0% for files vitest can't reach).
      ],
      // packages/discovery-index/src/server.ts is the process entrypoint (calls @hono/node-server's serve()
      // as a side effect of import) -- like the main app's own src/server.ts, it's exercised by a Docker
      // build+boot path, not unit-coverable without actually binding a port. See codecov.yml's matching
      // ignore entry; app.ts (everything server.ts wires together) is what tests actually import.
      //
      // packages/loopover-miner/lib/**/*.ts (above) also glob-matches its own still-hand-maintained
      // *.d.ts siblings (a ".d.ts" path ends in ".ts" too) -- those aren't real modules and can't be
      // parsed as coverage source, so they're excluded the same way src/env.d.ts already is.
      exclude: ["src/env.d.ts", "apps/**", "packages/discovery-index/src/server.ts", "packages/loopover-miner/lib/**/*.d.ts"],
      // Emit lcov for Codecov to compute patch (changed-lines) coverage.
      reporter: ["text", "lcov"],
      // The 99% requirement now lives in codecov.yml as a *patch* gate (changed
      // lines only), which is compositional: merging one PR can't drop another
      // below the bar. These global thresholds are only a loose catastrophe net
      // (e.g. a deleted test file), set well below actual coverage so routine
      // PRs never trip them. Do NOT raise these toward the real coverage number
      // or the cross-PR churn returns.
      //
      // Disabled when COVERAGE_NO_THRESHOLDS is set: CI shards the suite, and a
      // single shard only exercises part of the tree, so a per-shard global
      // threshold would always false-fail. CI gates coverage via Codecov on the
      // merged shards instead; this backstop still runs on the full local
      // `npm run test:coverage`. Spread-omit the key (rather than set it to
      // undefined) to satisfy exactOptionalPropertyTypes.
      ...(process.env.COVERAGE_NO_THRESHOLDS
        ? {}
        : {
            thresholds: {
              lines: 90,
              functions: 90,
              branches: 90,
              statements: 90,
            },
          }),
    },
  },
});
