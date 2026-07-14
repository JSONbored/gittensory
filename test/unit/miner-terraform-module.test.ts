import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Static structural checks for the fleet-mode AMS Terraform starter module (#5183). `terraform validate`/`fmt`
// prove the HCL is syntactically valid + well-formed; these assertions lock in the SAFETY-CRITICAL invariants a
// syntax check can't see — chiefly "no public inbound by default" and "state lands on the persistent /data/miner
// volume" — so a future edit can't silently regress them.

const DIR = "packages/loopover-miner/terraform";
const mainTf = readFileSync(`${DIR}/main.tf`, "utf8");
const variablesTf = readFileSync(`${DIR}/variables.tf`, "utf8");
const outputsTf = readFileSync(`${DIR}/outputs.tf`, "utf8");
const readme = readFileSync(`${DIR}/README.md`, "utf8");

describe("gittensory-miner fleet-mode Terraform module (#5183)", () => {
  it("uses the same Hetzner Cloud provider as the root module (consistency)", () => {
    expect(mainTf).toMatch(/source\s*=\s*"hetznercloud\/hcloud"/);
    expect(mainTf).toMatch(/provider\s+"hcloud"/);
    expect(mainTf).toMatch(/required_version\s*=\s*">= 1\.6"/);
  });

  it("INVARIANT: exposes NO public inbound endpoints — the only inbound firewall rule is SSH", () => {
    // Every inbound rule must be port 22. No 80/443/8787 or any other public port.
    const inboundPorts = [
      ...mainTf.matchAll(/direction\s*=\s*"in"[\s\S]*?port\s*=\s*"(\d+)"/g),
    ].map((m) => m[1]);
    expect(inboundPorts.length).toBeGreaterThan(0);
    expect(inboundPorts).toEqual(inboundPorts.filter((p) => p === "22"));
    // SSH is scoped to the admin allowlist, never hardcoded open.
    expect(mainTf).toMatch(
      /port\s*=\s*"22"[\s\S]*?source_ips\s*=\s*var\.admin_ip_allowlist/,
    );
    // Guard against the ORB profile leaking in.
    for (const publicPort of [
      'port       = "80"',
      'port       = "443"',
      'port       = "8787"',
    ]) {
      expect(mainTf).not.toContain(publicPort);
    }
  });

  it("mounts the persistent volume at /data/miner without a first-boot attach race", () => {
    expect(mainTf).toMatch(/resource\s+"hcloud_volume"\s+"miner_data"/);
    expect(mainTf).toMatch(
      /resource\s+"hcloud_volume_attachment"\s+"miner_data"/,
    );
    // RACE FIX (#5542): cloud-init polls for the attached volume's block device (post-attachment mechanism) BEFORE
    // mounting, so /data/miner can never be silently backed by the root disk on first boot.
    expect(mainTf).toMatch(
      /until \[ -b \/dev\/disk\/by-id\/scsi-0HC_Volume_\$\{hcloud_volume\.miner_data\.id\} \]; do sleep 2; done/,
    );
    expect(mainTf).toContain(
      "mount /dev/disk/by-id/scsi-0HC_Volume_${hcloud_volume.miner_data.id} /data/miner",
    );
    expect(mainTf).toContain("/data/miner ext4");
    expect(outputsTf).toContain("/data/miner");
  });

  it("installs Docker via the distro package in cloud-init — no remote-fetch-and-execute", () => {
    expect(mainTf).toContain("#cloud-config");
    expect(mainTf).toMatch(/user_data\s*=\s*<<-CLOUDINIT/);
    // Docker from Ubuntu's own signed `docker.io` package (declarative `packages:`), not a piped install script.
    expect(mainTf).toMatch(/packages:[\s\S]*?- docker\.io/);
    expect(mainTf).toContain("systemctl enable --now docker");
    expect(mainTf).not.toMatch(/provisioner\s+"remote-exec"/);
    // SECURITY: no third-party apt repo, no `curl … | gpg`, no remote-fetch-execute in user-data.
    expect(mainTf).not.toMatch(/download\.docker\.com/);
    expect(mainTf).not.toMatch(/curl[\s\S]*?\|\s*gpg/);
    expect(mainTf).not.toContain("docker-ce");
  });

  it("exposes provider-credential, region, and instance-size variables so operators adapt without editing the body", () => {
    for (const v of [
      "hcloud_token",
      "location",
      "server_type",
      "volume_size_gb",
      "ssh_public_key",
    ]) {
      expect(variablesTf).toMatch(new RegExp(`variable\\s+"${v}"`));
    }
    // The credential is marked sensitive so it never prints in plan/apply output.
    expect(variablesTf).toMatch(
      /variable\s+"hcloud_token"[\s\S]*?sensitive\s*=\s*true/,
    );
  });

  it("defaults to a modest CLI-worker size, distinct from ORB, and validates the volume floor", () => {
    expect(variablesTf).toMatch(
      /variable\s+"server_type"[\s\S]*?default\s*=\s*"cx22"/,
    );
    // Hetzner's 10 GB volume minimum is enforced via a validation block (both branches documented in the message).
    expect(variablesTf).toMatch(
      /condition\s*=\s*var\.volume_size_gb\s*>=\s*10/,
    );
  });

  it("SECURITY: contains no hardcoded secrets — credentials come only from variables", () => {
    // no literal token/secret assignment anywhere in the HCL (the scanner's own rule, applied here too)
    for (const tf of [mainTf, variablesTf, outputsTf]) {
      expect(tf).not.toMatch(
        /(token|secret|password)\s*=\s*"[A-Za-z0-9_\-]{16,}"/,
      );
    }
    expect(mainTf).toMatch(/token\s*=\s*var\.hcloud_token/);
  });

  it("documents prerequisites, the init/plan/apply flow, and how outputs map into AMS setup", () => {
    expect(readme).toMatch(/terraform init/);
    expect(readme).toMatch(/terraform apply/);
    expect(readme).toMatch(/docker-compose\.miner\.yml/);
    expect(readme).toMatch(/\/data\/miner/);
  });
});
