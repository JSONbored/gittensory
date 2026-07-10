export class DurableObject {
  ctx: unknown;
  env: unknown;

  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint {
  ctx: unknown;
  env: unknown;

  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// NOT dead despite having no first-party caller: vitest.config.ts aliases the `cloudflare:workers`
// specifier to this file for EVERY module resolved under Node, including node_modules -- the `agents`
// package (a dependency of src/mcp/server.ts's `agents/mcp` import) does `import { RpcTarget } from
// "cloudflare:workers"` and extends it, so removing this breaks that whole dependency graph at test
// runtime (confirmed by `npm run test:changed`, not by static grep -- there is no in-repo caller).
export class RpcTarget {}

export const exports = {};
export const env = {};
