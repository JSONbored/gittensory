import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Static structural checks for the root ORB Terraform module's Grafana exposure (#5818). docker-compose.yml's
// `grafana` service (--profile observability) publishes 3000:3000 on the host, but the firewall had no rule for
// it — not even an admin-scoped one — so an operator following main.tf's own documented flow (provision, then
// `docker compose --profile observability up -d`) got a timed-out connection with no explanation. These lock in
// the SAFETY-CRITICAL invariants a `terraform validate` can't see: the port is opt-in, and it can never be
// opened to the public. Mirrors the pattern in test/unit/miner-terraform-module.test.ts.

const DIR = "terraform";
const mainTf = readFileSync(`${DIR}/main.tf`, "utf8");
const variablesTf = readFileSync(`${DIR}/variables.tf`, "utf8");
const readme = readFileSync(`${DIR}/README.md`, "utf8");
const dockerCompose = readFileSync("docker-compose.yml", "utf8");

/** The `dynamic "rule"` block that gates Grafana's port, body included. */
const grafanaRule = /dynamic\s+"rule"\s*\{[\s\S]*?for_each\s*=\s*var\.expose_grafana[\s\S]*?\n {2}\}/.exec(mainTf)?.[0] ?? "";

describe("root Terraform module — Grafana firewall (#5818)", () => {
  it("still matches the compose service it exists for: grafana publishes 3000 under the observability profile", () => {
    // If this drifts, the firewall rule below is guarding the wrong port.
    expect(dockerCompose).toMatch(/grafana:[\s\S]*?profiles:\s*\["observability"\]/);
    expect(dockerCompose).toMatch(/grafana:[\s\S]*?ports:[\s\S]*?"3000:3000"/);
  });

  it("opens Grafana's port 3000, gated by var.expose_grafana", () => {
    expect(grafanaRule, "a dynamic rule gated on var.expose_grafana must exist").not.toBe("");
    expect(grafanaRule).toMatch(/port\s*=\s*"3000"/);
    expect(grafanaRule).toMatch(/protocol\s*=\s*"tcp"/);
    expect(grafanaRule).toMatch(/direction\s*=\s*"in"/);
  });

  it("INVARIANT: Grafana's port is admin-allowlist-scoped — never opened to the public like the Caddy ports", () => {
    expect(grafanaRule).toMatch(/source_ips\s*=\s*var\.admin_ip_allowlist/);
    expect(grafanaRule).not.toMatch(/0\.0\.0\.0\/0/);
    expect(grafanaRule).not.toMatch(/::\/0/);
  });

  it("INVARIANT: exposure is opt-in — expose_grafana is a bool defaulting to false", () => {
    const variable = /variable\s+"expose_grafana"\s*\{[\s\S]*?\n\}/.exec(variablesTf)?.[0] ?? "";
    expect(variable, "expose_grafana must be declared").not.toBe("");
    expect(variable).toMatch(/type\s*=\s*bool/);
    expect(variable).toMatch(/default\s*=\s*false/);
    expect(variable).toMatch(/description\s*=/); // every var in this file documents itself
  });

  it("documents both access paths, including a runnable SSH-tunnel command for the closed default", () => {
    expect(readme).toMatch(/ssh -L 3000:localhost:3000/);
    expect(readme).toContain("expose_grafana");
  });
});
