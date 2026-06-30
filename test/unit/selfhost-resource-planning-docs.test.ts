import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CAPACITY_DOCS_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.self-hosting-capacity.tsx",
);
const AI_PROVIDERS_DOCS_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.self-hosting-ai-providers.tsx",
);
const COMPOSE_PATH = resolve(import.meta.dirname, "../../docker-compose.yml");
const ENV_EXAMPLE_PATH = resolve(import.meta.dirname, "../../.env.example");

describe("self-host resource planning docs", () => {
  const capacitySource = readFileSync(CAPACITY_DOCS_PATH, "utf8");
  const aiProvidersSource = readFileSync(AI_PROVIDERS_DOCS_PATH, "utf8");
  const composeSource = readFileSync(COMPOSE_PATH, "utf8");
  const envExampleSource = readFileSync(ENV_EXAMPLE_PATH, "utf8");

  it("covers the common self-host profiles and operator measurement commands (#1828)", () => {
    expect(capacitySource).toMatch(/Minimal \(default\)/);
    expect(capacitySource).toMatch(/Backup/);
    expect(capacitySource).toMatch(/Qdrant \+ Ollama/);
    expect(capacitySource).toMatch(/Observability/);
    expect(capacitySource).toMatch(/Runners/);
    expect(capacitySource).toMatch(/docker stats --no-stream/);
    expect(capacitySource).toMatch(/docker image inspect/);
    expect(capacitySource).toMatch(/docker system df -v/);
  });

  it("documents the tuned defaults that now control stack weight", () => {
    expect(capacitySource).toMatch(/INSTALL_AI_CLIS/);
    expect(capacitySource).toMatch(/PROMETHEUS_RETENTION_TIME/);
    expect(capacitySource).toMatch(/REDIS_MAXMEMORY/);
    expect(capacitySource).toMatch(/GRAFANA_INSTALL_PLUGINS/);
    expect(capacitySource).toMatch(/QUEUE_CONCURRENCY/);
  });

  it("keeps the compose defaults aligned with the resource guide", () => {
    expect(composeSource).toMatch(/INSTALL_AI_CLIS:\s*"\$\{INSTALL_AI_CLIS:-false\}"/);
    expect(composeSource).toMatch(/REDIS_MAXMEMORY:-256mb/);
    expect(composeSource).toMatch(/REDIS_MAXMEMORY_POLICY:-allkeys-lru/);
    expect(composeSource).toMatch(/PROMETHEUS_RETENTION_TIME:-30d/);
    expect(composeSource).toMatch(
      /GRAFANA_INSTALL_PLUGINS:-frser-sqlite-datasource,grafana-github-datasource/,
    );
  });

  it("surfaces the same knobs in the sample env and AI provider docs", () => {
    expect(envExampleSource).toMatch(/REDIS_MAXMEMORY=256mb/);
    expect(envExampleSource).toMatch(/PROMETHEUS_RETENTION_TIME=30d/);
    expect(envExampleSource).toMatch(/GRAFANA_INSTALL_PLUGINS=/);
    expect(aiProvidersSource).toMatch(/INSTALL_AI_CLIS=true/);
    expect(aiProvidersSource).toMatch(/docker compose up --build/);
  });
});
