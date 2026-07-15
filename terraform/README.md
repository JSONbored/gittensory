# ORB self-host server — Terraform module

Provisions a single Hetzner Cloud VPS for the **ORB** self-host stack (the persistent HTTP review service), with
Docker + Docker Compose pre-installed via cloud-init and a persistent volume mounted at `/data` for the SQLite DB
and Litestream WAL segments.

It is **not** the [`packages/loopover-miner/terraform/`](../packages/loopover-miner/terraform/) module, which
provisions a fleet-mode AMS miner host and exposes no public endpoints. This module serves public HTTP(S), so its
firewall opens the Caddy ports to the internet and keeps everything else admin-scoped.

## What it creates

| Resource                   | Purpose                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `hcloud_server`            | One Ubuntu 24.04 VM (`server_type` default `cx22` = 2 vCPU / 4 GB, sufficient for <50 reviews/day) |
| `hcloud_firewall`          | Inbound 22 (admin), 80 + 443/tcp + 443/udp (public, Caddy), 8787 (admin), 3000 (admin, opt-in)   |
| `hcloud_volume` (+ attach) | Persistent ext4 volume mounted at `/data` so the DB and WAL survive re-provisioning              |
| `hcloud_ssh_key`           | Your SSH public key, for access                                                                  |

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) `>= 1.6`
- A Hetzner Cloud project + API token (console.hetzner.cloud → Security → API Tokens)
- An SSH key pair

## Usage

```sh
cd terraform

export TF_VAR_hcloud_token="…"                       # or set it in a *.tfvars file (never commit it)
terraform init
terraform plan  -var "ssh_public_key=$(cat ~/.ssh/id_ed25519.pub)"
terraform apply -var "ssh_public_key=$(cat ~/.ssh/id_ed25519.pub)"
```

Useful variables (see [`variables.tf`](variables.tf) for all): `server_type`, `location`, `volume_size_gb`,
`admin_ip_allowlist` (restrict this to your IP in production), `expose_grafana`.

## After apply — start the stack

The module provisions the **host**; you finish setup over SSH (secrets never live in Terraform state):

1. `terraform output ssh_command` → SSH in.
2. Clone the repo and copy [`../.env.example`](../.env.example) → `.env` — it is the exhaustive reference for
   every variable the stack reads.
3. `docker compose up -d` (or `docker compose --profile postgres --profile caddy up -d`).

## Reaching Grafana (`--profile observability`)

`docker compose --profile observability up -d` publishes Grafana on the host at `3000:3000`. Because the
observability profile is itself opt-in, the firewall does **not** open port 3000 by default — a default-open port
for a service most operators never start would widen the attack surface for nothing. Pick one:

**SSH tunnel (default, nothing to change).** Keep 3000 closed and forward it over your existing SSH access:

```sh
ssh -L 3000:localhost:3000 ubuntu@$(terraform output -raw server_ipv4)
# then browse http://localhost:3000
```

**Open the port to your own IP.** Set `expose_grafana = true` and re-apply. The rule is always scoped to
`admin_ip_allowlist` — never `0.0.0.0/0` like the public Caddy ports — so restrict that allowlist to your own
IP(s) first, or you will publish Grafana to the internet:

```sh
terraform apply \
  -var "ssh_public_key=$(cat ~/.ssh/id_ed25519.pub)" \
  -var "expose_grafana=true" \
  -var 'admin_ip_allowlist=["203.0.113.4/32"]'
```

## Outputs

| Output          | Description                            |
| --------------- | -------------------------------------- |
| `server_ipv4`   | Public IPv4 of the server              |
| `server_ipv6`   | Public IPv6 of the server              |
| `ssh_command`   | Ready-to-run SSH command               |
| `volume_device` | Block device path for the data volume  |
