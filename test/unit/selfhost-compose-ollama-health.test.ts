import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

function readYaml(path: string): Record<string, unknown> {
  const value = parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a YAML object`);
  }
  return value as Record<string, unknown>;
}

// Pure structural checks only (no `docker` CLI invocation): the self-hosted runner container this actually
// runs on does not have Docker-in-Docker access, so a test that shells out to `docker compose config`
// would be unreliable/environment-dependent here (same constraint as docker-compose-override-example.test.ts).
describe("docker-compose.yml — ollama healthcheck (#2504)", () => {
  it("gives ollama a healthcheck so docker compose ps and a future depends_on can gate on it", () => {
    const compose = readYaml("docker-compose.yml");
    const services = (compose.services as Record<string, Record<string, unknown>>) ?? {};
    const ollama = services.ollama ?? {};
    const healthcheck = ollama.healthcheck as { test?: unknown[]; retries?: number };

    // The image ships the ollama CLI but no curl/wget/nc, so `ollama list` is the only in-image probe that
    // only succeeds once the daemon is actually serving API calls.
    expect(healthcheck.test).toEqual(["CMD", "ollama", "list"]);
    expect(healthcheck.retries).toBeGreaterThan(0);
  });
});
