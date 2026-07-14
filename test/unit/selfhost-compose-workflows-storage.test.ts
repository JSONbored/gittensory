import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

function readYaml(path: string): Record<string, unknown> {
  const value = parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a YAML object`);
  }
  return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

// Pure structural checks only (no `docker` CLI invocation): the self-hosted runner container this actually
// runs on does not have Docker-in-Docker access, so a test that shells out to `docker compose config`
// would be unreliable/environment-dependent here (same constraint as selfhost-compose-ollama-health.test.ts).
describe("docker-compose.yml — workflows + storage profiles (#1219)", () => {
  const compose = readYaml("docker-compose.yml");
  const services = record(compose.services);
  const volumes = record(compose.volumes);
  const n8n = record(services.n8n);
  const minio = record(services.minio);

  it("documents the optional workflows and storage profiles in the header", () => {
    const header = readFileSync("docker-compose.yml", "utf8");
    expect(header).toContain("--profile workflows");
    expect(header).toContain("--profile storage");
    expect(header).toContain("n8n workflow automation");
    expect(header).toContain("MinIO S3-compatible object storage");
  });

  it("gates n8n behind --profile workflows with basic-auth env and a runtime password check", () => {
    expect(n8n.image).toBe("n8nio/n8n:latest");
    expect(n8n.profiles).toEqual(["workflows"]);
    expect(n8n.ports).toEqual(["5678:5678"]);
    expect(n8n.volumes).toEqual(["n8n-data:/home/node/.n8n"]);

    const env = record(n8n.environment);
    expect(env.N8N_BASIC_AUTH_ACTIVE).toBe("true");
    expect(env.N8N_BASIC_AUTH_USER).toBe("${N8N_USER:-admin}");
    // Soft default (:-), not hard :? -- compose interpolates the whole file even when the profile is inactive.
    expect(env.N8N_BASIC_AUTH_PASSWORD).toBe("${N8N_PASSWORD:-}");
    expect(env.WEBHOOK_URL).toBe("${N8N_WEBHOOK_URL:-http://localhost:5678}");
    expect(env.N8N_ENCRYPTION_KEY).toBe("${N8N_ENCRYPTION_KEY:-}");

    const entrypoint = n8n.entrypoint as string[];
    expect(entrypoint[0]).toBe("/bin/sh");
    expect(entrypoint.join("\n")).toContain("N8N_PASSWORD");
    expect(entrypoint.join("\n")).toContain("exit 1");
  });

  it("gates MinIO behind --profile storage on the S3 API and console ports", () => {
    expect(minio.image).toBe("minio/minio:latest");
    expect(minio.profiles).toEqual(["storage"]);
    expect(minio.ports).toEqual(["9000:9000", "9001:9001"]);
    expect(minio.volumes).toEqual(["minio-data:/data"]);
    expect(minio.command).toContain("server");
    expect(minio.command).toContain("--console-address");

    const env = record(minio.environment);
    // Same soft-default posture as n8n/grafana/browserless -- avoids breaking default `docker compose up`.
    expect(env.MINIO_ROOT_USER).toBe("${MINIO_ROOT_USER:-}");
    expect(env.MINIO_ROOT_PASSWORD).toBe("${MINIO_ROOT_PASSWORD:-}");
  });

  it("declares persistent volumes for both optional services", () => {
    expect(volumes["n8n-data"]).toBeDefined();
    expect(volumes["minio-data"]).toBeDefined();
  });
});

describe("n8n/workflows — bundled templates (#1219)", () => {
  const templateNames = [
    "review-slack-notify.json",
    "gate-daily-summary.json",
    "issue-auto-triage.json",
  ] as const;

  it.each(templateNames)("ships importable workflow template %s", (filename) => {
    const raw = readFileSync(join("n8n/workflows", filename), "utf8");
    const workflow = JSON.parse(raw) as {
      name?: string;
      nodes?: unknown[];
      connections?: Record<string, unknown>;
    };
    expect(workflow.name?.length).toBeGreaterThan(0);
    expect(Array.isArray(workflow.nodes)).toBe(true);
    expect(workflow.nodes?.length).toBeGreaterThan(0);
    expect(workflow.connections).toBeTypeOf("object");
  });

  it("includes the Slack notify starter template required by the issue", () => {
    const slack = JSON.parse(readFileSync("n8n/workflows/review-slack-notify.json", "utf8")) as {
      nodes: Array<{ type: string }>;
    };
    expect(slack.nodes.some((n) => n.type === "n8n-nodes-base.webhook")).toBe(true);
    expect(slack.nodes.some((n) => n.type === "n8n-nodes-base.slack")).toBe(true);
  });
});

describe(".env.example — workflows + storage vars (#1219)", () => {
  const envExample = readFileSync(".env.example", "utf8");

  it("documents n8n and MinIO profile env vars", () => {
    expect(envExample).toContain("# --- n8n workflow automation (--profile workflows) ---");
    expect(envExample).toContain("# N8N_PASSWORD=changeme");
    expect(envExample).toContain("# --- MinIO S3-compatible object storage (--profile storage) ---");
    expect(envExample).toContain("# MINIO_ROOT_USER=minio");
    expect(envExample).toContain("# MINIO_ROOT_PASSWORD=changeme");
  });

  it("documents Litestream → MinIO wiring for local backups", () => {
    expect(envExample).toContain("LITESTREAM_ENDPOINT=http://minio:9000");
    expect(envExample).toContain("LITESTREAM_ACCESS_KEY_ID=${MINIO_ROOT_USER}");
    expect(envExample).toContain("LITESTREAM_SECRET_ACCESS_KEY=${MINIO_ROOT_PASSWORD}");
  });
});
