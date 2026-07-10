# gittensory-miner-ui

A local, read-only dashboard shell over a running `@jsonbored/gittensory-miner` instance's own state.
This is a scaffold only (issue #4303): routing/layout shell, no data views yet. The run-history table
(#4305) and portfolio/queue summary cards (#4306) are separate, dependent follow-up issues.

## Deploy-model decision

`apps/gittensory-ui` (the main web app) deploys as a Cloudflare Worker and depends on
`@lovable.dev/vite-tanstack-config`, a Lovable-authored scaffold tool specific to that app's own origin.
This app intentionally does **not** copy either of those:

- No Cloudflare/`wrangler` deploy target, no `@lovable.dev/*` dependency.
- Plain client-side Vite + `@tanstack/react-router` (not TanStack Start) -- there is no server/SSR entry
  to deploy in the first place.
- `packages/gittensory-miner/DEPLOYMENT.md` states the miner is "100% client-side for core operation --
  the miner never uploads source and never requires a hosted Gittensory callback to boot." A dashboard
  that only reads a miner's own local SQLite state should keep that same posture: a local dev server
  (`npm run dev`) or a static `npm run build` output the CLI can serve, never a hosted deploy.

## Scripts

- `npm run dev` -- local dev server
- `npm run build` -- static production build
- `npm run typecheck` / `npm run lint` / `npm run test` -- match the monorepo's per-app script naming
  convention (see `apps/gittensory-ui/package.json`)
