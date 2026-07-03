import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";

function readYamlWithMerge(path: string): Record<string, unknown> {
  const doc = parseDocument(readFileSync(path, "utf8"), { merge: true });
  const value = doc.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a YAML object`);
  }
  return value as Record<string, unknown>;
}

type ComposeService = Record<string, unknown>;

function composeServices(): Record<string, ComposeService> {
  const compose = readYamlWithMerge("docker-compose.yml");
  return (compose.services as Record<string, ComposeService>) ?? {};
}

function runnerService(): ComposeService {
  const services = composeServices();
  expect(services.runner, "docker-compose.yml must define a runner service").toBeTruthy();
  return services.runner as ComposeService;
}

// Runner CI job temp writes must stay on the mounted runner-work volume, never the container's plain
// /tmp (which lives in Docker's overlay/containerd snapshot storage and grows the HOST's Docker root
// storage directly -- invisible to volume-scoped cleanup, confirmed in production as unbounded overlay
// growth, disk pressure, and `docker system df` races against disappearing temp files). Pure structural
// checks only (no `docker` CLI invocation): the self-hosted runner container this actually runs on does
// not have Docker-in-Docker access, so a test that shells out to `docker compose config` would be
// unreliable/environment-dependent here (same constraint as the other selfhost-compose-*.test.ts files).
// `{ merge: true }` resolves `<<: *runner-tmp-env` the same way Docker Compose's own YAML 1.1 merge-key
// support does -- verified once by hand against `docker compose config` with every profile active.
describe("docker-compose.yml — runner temp storage stays off overlay (#selfhost-runner-tmp)", () => {
  it("mounts the runner-work volume at /tmp/runner", () => {
    const runner = runnerService();
    const volumes = (runner.volumes as string[]) ?? [];
    expect(volumes).toContain("runner-work:/tmp/runner");
  });

  it("keeps RUNNER_WORKDIR on the mounted volume", () => {
    const runner = runnerService();
    const env = runner.environment as Record<string, unknown>;
    expect(env.RUNNER_WORKDIR).toBe("/tmp/runner");
  });

  it.each(["TMPDIR", "TMP", "TEMP"])("sets %s for the runner", (key) => {
    const runner = runnerService();
    const env = runner.environment as Record<string, unknown>;
    expect(env[key], key).toBeDefined();
  });

  it.each(["TMPDIR", "TMP", "TEMP"])(
    "points %s at mounted runner storage, not the container's plain /tmp",
    (key) => {
      const runner = runnerService();
      const env = runner.environment as Record<string, unknown>;
      const value = env[key];
      expect(value, key).not.toBe("/tmp");
      expect(typeof value, key).toBe("string");
      expect(value as string, `${key}=${String(value)} must live under the mounted /tmp/runner volume`).toMatch(
        /^\/tmp\/runner(\/|$)/,
      );
    },
  );

  it("never mounts the Docker socket into the runner service", () => {
    const runner = runnerService();
    const volumes = (runner.volumes as string[]) ?? [];
    expect(volumes.some((v) => v.includes("docker.sock"))).toBe(false);
  });

  it("guarantees the configured TMPDIR exists before the runner starts, via a depends_on init service", () => {
    const services = composeServices();
    const runner = runnerService();
    const dependsOn = runner.depends_on as Record<string, { condition?: string }> | undefined;
    expect(dependsOn, "runner must declare depends_on for a bootstrap/init service").toBeTruthy();

    const initServiceNames = Object.keys(dependsOn ?? {});
    expect(initServiceNames.length, "runner must depend on exactly the init service").toBeGreaterThan(0);
    const initServiceName = initServiceNames[0]!;
    expect(dependsOn?.[initServiceName]?.condition, "the dependency must wait for successful completion").toBe(
      "service_completed_successfully",
    );

    const initService = services[initServiceName];
    expect(initService, `the depends_on target "${initServiceName}" must exist as a service`).toBeTruthy();
    const initVolumes = (initService?.volumes as string[]) ?? [];
    expect(
      initVolumes.some((v) => v.startsWith("runner-work:")),
      "the init service must mount the same runner-work volume it bootstraps",
    ).toBe(true);
    expect(JSON.stringify(initService?.command)).toMatch(/mkdir -p/);
  });

  it("does not introduce volume-deleting behavior in the runner temp bootstrap step", () => {
    const services = composeServices();
    const runner = runnerService();
    const dependsOn = runner.depends_on as Record<string, unknown>;
    const initServiceName = Object.keys(dependsOn)[0]!;
    const initService = services[initServiceName];
    const command = JSON.stringify(initService?.command ?? "");
    expect(command).not.toMatch(/\brm\b|\bprune\b|\bdown\b\s+-v/);
  });

  it("keeps the runner service gated behind the runners profile (opt-in, not part of the default stack)", () => {
    const runner = runnerService();
    expect(runner.profiles).toEqual(["runners"]);
  });

  it("exposes a reusable x-runner-tmp-env anchor that the runner service actually merges in", () => {
    const compose = readYamlWithMerge("docker-compose.yml");
    const anchorBlock = compose["x-runner-tmp-env"] as Record<string, unknown>;
    expect(anchorBlock, "x-runner-tmp-env extension field must exist for multi-runner reuse").toBeTruthy();
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      expect(anchorBlock[key], key).toBe("/tmp/runner/tmp");
    }

    // The runner service's resolved env must equal the anchor's values (not a separately hand-written
    // duplicate that could drift) -- `{ merge: true }` above already resolved `<<: *runner-tmp-env`.
    const runner = runnerService();
    const env = runner.environment as Record<string, unknown>;
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      expect(env[key], key).toBe(anchorBlock[key]);
    }
  });
});
