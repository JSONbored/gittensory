# LoopOver Miner UI

Local, read-only dashboard for a laptop or fleet miner instance. It mirrors the main
`apps/loopover-ui/` tooling versions (React 19, TanStack Router, Vite, Tailwind v4) but intentionally
does **not** adopt that app's Nitro SSR / production Cloudflare deploy model or `@lovable.dev/*`
scaffold dependency.

The miner package invariant is client-side only with no required phone-home to boot
(`packages/loopover-miner/DEPLOYMENT.md`). Self-host operators run a plain Vite dev server / static
build with local SQLite-backed `/api/*` plugins. Separately, a **demo-mode** static build
(`VITE_DEMO_MODE`, #5963) deploys as Workers Static Assets for a public prototype that informs
#5229 — synthetic data only, no operator credentials.

The Phase 6 data views have shipped: an overview summary (`routes/index.tsx`, #4853) alongside dedicated
run-history, portfolio, and ledgers views, each fed by the local read-only `/api/*` endpoints below
(or by in-bundle demo fixtures when `VITE_DEMO_MODE=true`).

## Configuration

| Env var                     | Required | Description                                                                                                                                                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MINER_UI_GRAFANA_URL` | No       | If set (and non-empty), renders a footer link to your ORB/Grafana dashboard at this URL. Unset ⇒ no link. Must be `VITE_`-prefixed so Vite exposes it to the client bundle. It is a plain navigational link — no token or credential is ever appended. |
| `VITE_DEMO_MODE`            | No       | When `"true"` (baked by `npm run build:demo` / `vite build --mode demo` via `vite.config.ts`), client fetchers serve synthetic sample data and skip `/api/*`. Used for the public Cloudflare Worker demo only — never for a real miner.                |

## Public demo Worker (#5963)

```bash
npm --workspace @loopover/ui-kit run build
npm --workspace @loopover/ui-miner run build:demo   # vite build --mode demo
npm --workspace @loopover/ui-miner run deploy:demo  # wrangler deploy → loopover-miner-ui-demo
```

Or trigger `.github/workflows/miner-ui-demo-deploy.yml` (`workflow_dispatch`). Custom domain routes are
omitted until DNS is provisioned; the Worker publishes on `*.workers.dev`. This demo is **not** a
decision that hosted AMS ships a web dashboard — that remains #5229.

## Local API authentication

`/api/*` (run-state, portfolio-queue, ledgers, and any future endpoint under that prefix) requires a
same-origin session cookie — an unauthenticated request is rejected with `401`. The dev/preview server
(`vite-auth.ts`) generates a random token once per process and sets it as an `HttpOnly; SameSite=Strict`
cookie on every response; a browser that has loaded this app's own page (`/`) already carries the cookie
automatically on every subsequent same-origin `fetch()` call, so none of the client-side data fetchers need
to know about it. A request from another local process, or from a different page/origin the user has open
(including a DNS-rebinding attempt), has no way to obtain the cookie and is rejected. There is nothing to
configure — this is always on for both `vite dev` and `vite preview`.

## Running as a persistent service

`npm run dev` is a foreground dev server; it doesn't survive a terminal closing or a reboot. For a
fleet/bare-host operator who wants the dashboard durably available, `npm run build` followed by
`npm run preview` serves the built dashboard **and** its local-SQLite-backed API routes (the
`vite-*-api.ts` plugins register for both `configureServer` and `configurePreviewServer`, so nothing
extra is needed beyond the build step) on port `4174` by default.

[`systemd/loopover-miner-ui.service.example`](../../systemd/loopover-miner-ui.service.example) at
the repo root is a ready-to-adapt persistent unit for this — a companion to
`loopover-miner.service.example` (the loop daemon), not a replacement for it. Its header comment
carries the full install steps. Like the loop daemon, this is a `Type=simple` service, not a `.timer`
job — the dashboard is a long-running HTTP server, not a periodic batch task.

## Test coverage

`npm test` runs with `--coverage` enabled (v8 provider) and enforces `vitest.config.ts`'s `coverage.thresholds`
— a real measured baseline (#4865), not an aspirational target, so CI fails on a genuine regression (e.g. a
large new feature landing with no tests) rather than staying silently unmeasured the way `apps/**` is by
default at the repo root. `apps/loopover-miner-extension` has its own matching gate (`npm test` in that workspace);
see its README for scope notes on deferred `content.js`/`options.js` coverage.
