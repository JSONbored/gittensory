# Observing your miner

How to point Grafana at redacted miner reporting exports to see attempt and prediction history without exposing the
miner's live local ledgers. This covers the **miner-specific** observability wiring only; for general self-host
operations, see your ops runbook.

Everything here is **opt-in and off by default** ([#4839](https://github.com/JSONbored/gittensory/issues/4839)):
AMS's zero-infra "laptop mode" keeps working with no observability stack present at all. There are two independent
paths — **pull metrics** (Prometheus scrapes text you export) and **SQLite → Grafana** (Grafana reads redacted
ledger snapshots). Pick either, both, or neither.

## Scrape miner metrics with Prometheus (opt-in)

The miner renders its counters as Prometheus text-exposition on demand — nothing is emitted unless you run a
command, so this adds no runtime cost to a laptop miner:

- `gittensory-miner metrics` — prediction-calibration counters ([#4838](https://github.com/JSONbored/gittensory/issues/4838)).
- `gittensory-miner ledger metrics` — event-ledger counters by type ([#4841](https://github.com/JSONbored/gittensory/issues/4841)).
- `gittensory-miner metrics export` — the **unified** surface: both of the above composed into one exposition
  document, plus a `gittensory_miner_build_info{version="…"}` gauge and a `gittensory_miner_scrape_timestamp_seconds`
  gauge so staleness is visible in Grafana.

`metrics export` prints to stdout by default (always safe to run). To feed a Prometheus
[node_exporter textfile collector](https://github.com/prometheus/node_exporter#textfile-collector), point it at a
`.prom` file in the collector's directory — via `--file <path>` or the `GITTENSORY_MINER_METRICS_FILE` environment
variable (`--file` wins). The file is written atomically (temp file + rename), so the collector never scrapes a
half-written document:

```sh
# One-shot, or on a cron / systemd timer next to a long-running `gittensory-miner loop`:
GITTENSORY_MINER_METRICS_FILE=/var/lib/node_exporter/textfile/gittensory-miner.prom \
  gittensory-miner metrics export
```

Prometheus then scrapes node_exporter as usual, and the `gittensory_miner_*` series appear in your own Grafana.
Leaving `GITTENSORY_MINER_METRICS_FILE` unset and never running the command keeps the miner completely inert — the
laptop-mode contract.

## Tracing hook (opt-in integration point)

For a self-hoster wiring the miner into their own tracer, `withMinerSpan(name, attributes, fn, options)` (exported
from `lib/observability.js`) is a no-op-by-default span wrapper mirroring the main product's `withOtelSpan`: with
`options.enabled` unset it just runs `fn` with zero overhead; when enabled it times `fn` and reports
`{ name, attributes, durationMs, ok }` to `options.onSpan`, which an embedder points at their OpenTelemetry/other
tracer. It never changes control flow (the function's result and thrown errors pass straight through).

## What's observable

The miner writes append-only SQLite ledgers under `GITTENSORY_MINER_CONFIG_DIR` (default
`~/.config/gittensory-miner` on a laptop, or `/data/miner` in the fleet Docker image — see
[`DEPLOYMENT.md`](../DEPLOYMENT.md)):

- **`attempt-log.sqlite3`** — the driver-level attempt event trace (event type, action class, mode, reason,
  timestamps), table `attempt_log_events`.
- **`prediction-ledger.sqlite3`** — recorded predicted-gate verdicts for later scoring.

Those live files can contain free-form payloads, repo/target identifiers, readiness scores, and blocker/warning
codes. Keep `GITTENSORY_MINER_CONFIG_DIR` private to the miner. Grafana should read only sanitized reporting
exports that operators create from those ledgers.

## Point Grafana at reporting exports

The repo ships datasource provisioning at
[`grafana/provisioning/datasources/ams-ledgers.yml`](../../../grafana/provisioning/datasources/ams-ledgers.yml)
— two **read-only** `frser-sqlite-datasource` entries: `AMS Attempt Log` (uid `ams-attempt-log`) and
`AMS Prediction Ledger` (uid `ams-prediction-ledger`). Their default paths live under Grafana's reporting mount,
not under the miner config directory.

1. **Install the SQLite plugin** in Grafana — the same one the maintainer `GittensoryDB` datasource uses:

   ```sh
   GF_INSTALL_PLUGINS=frser-sqlite-datasource
   ```

2. **Run the AMS reporting exporter**, a dedicated compose profile (only useful when a miner also runs on this
   same host — an engine-only deployment has nothing for it to read):

   ```sh
   docker compose --profile ams-observability up -d
   ```

   Set `GITTENSORY_MINER_CONFIG_DIR` in your `.env` (see [`.env.example`](../../../.env.example)) to the same
   directory your miner uses. The `ams-reporting-exporter` container mounts it **read-only**, runs
   [`scripts/export-ams-reporting-db.sh`](../../../scripts/export-ams-reporting-db.sh) on an interval
   (`GITTENSORY_AMS_REPORTING_EXPORT_INTERVAL_SECONDS`, default 30s), and writes the redacted snapshots into the
   same `reporting` volume Grafana already reads — Grafana itself never mounts the live ledgers. The exported
   schema drops `attempt_log_events.reason`/`.payload_json` (the free-form fields) entirely; every other column,
   including the `predictions` table's `blocker_codes_json`/`warning_codes_json` (fixed, engine-defined codes —
   never free text), passes through unchanged.

3. **Restart Grafana.** The two datasources appear under **Connections → Data sources**, already provisioned
   (non-editable) so they survive restarts.

## Load a dashboard

Dashboards live in [`grafana/dashboards/`](../../../grafana/dashboards/) and are auto-provisioned from that
directory. To visualize AMS activity, add a dashboard JSON there — or import one at runtime via the Grafana UI
(**Dashboards → Import**) — and point its panels at the `AMS Attempt Log` / `AMS Prediction Ledger` datasources
above. Panels should query only the redacted reporting schema (e.g. `SELECT * FROM attempt_log_events`), never a
`payload_json`/`reason` column — the exporter drops both, so a panel referencing them returns no such column.
