# Gittensory Miner UI

Local, read-only dashboard shell for a laptop or fleet miner instance. It mirrors the main
`apps/gittensory-ui/` tooling versions (React 19, TanStack Router, Vite, Tailwind v4) but intentionally
does **not** adopt that app's Cloudflare Worker deploy model or `@lovable.dev/*` scaffold dependency.

The miner package invariant is client-side only with no required phone-home to boot
(`packages/gittensory-miner/DEPLOYMENT.md`). This app is a plain Vite dev server / static build that a
local miner CLI can serve later — not a Wrangler deploy target.

Phase 6 data views (run history, portfolio cards) land in follow-up issues after this empty shell.

## Configuration

| Env var                     | Required | Description                                                                                                                                                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_MINER_UI_GRAFANA_URL` | No       | If set (and non-empty), renders a footer link to your ORB/Grafana dashboard at this URL. Unset ⇒ no link. Must be `VITE_`-prefixed so Vite exposes it to the client bundle. It is a plain navigational link — no token or credential is ever appended. |

## Local API authentication

`/api/*` (run-state, portfolio-queue, ledgers, and any future endpoint under that prefix) requires a
same-origin session cookie — an unauthenticated request is rejected with `401`. The dev/preview server
(`vite-auth.ts`) generates a random token once per process and sets it as an `HttpOnly; SameSite=Strict`
cookie on every response; a browser that has loaded this app's own page (`/`) already carries the cookie
automatically on every subsequent same-origin `fetch()` call, so none of the client-side data fetchers need
to know about it. A request from another local process, or from a different page/origin the user has open
(including a DNS-rebinding attempt), has no way to obtain the cookie and is rejected. There is nothing to
configure — this is always on for both `vite dev` and `vite preview`.
