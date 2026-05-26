declare global {
  interface Env {
    DB: D1Database;
    JOBS: Queue;
    RATE_LIMITER?: DurableObjectNamespace;
    PUBLIC_API_ORIGIN?: string;
    GITHUB_WEBHOOK_SECRET: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_APP_ID: string;
    GITHUB_APP_SLUG: string;
    GITHUB_OAUTH_CLIENT_ID?: string;
    GITTENSOR_REGISTRY_URL: string;
    GITHUB_PUBLIC_TOKEN?: string;
    GITTENSORY_API_TOKEN: string;
    GITTENSORY_MCP_TOKEN: string;
    INTERNAL_JOB_TOKEN: string;
  }
}

export {};
