# Observing your miner

How to point Grafana at redacted miner reporting exports to see attempt and prediction history without exposing the
miner's live local ledgers. This covers the **miner-specific** observability wiring only; for general self-host
operations, see your ops runbook.

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

2. **Publish sanitized AMS reporting exports** into Grafana's existing reporting mount. Do not mount
   `GITTENSORY_MINER_CONFIG_DIR` into Grafana. The provisioned defaults are:

   - `/reporting/ams-attempt-log.sqlite`
   - `/reporting/ams-prediction-ledger.sqlite`

   If your exporter writes elsewhere, edit the two `path:` values in `ams-ledgers.yml` to match the redacted export
   locations.

3. **Restart Grafana.** The two datasources appear under **Connections → Data sources**, already provisioned
   (non-editable) so they survive restarts.

## Load a dashboard

Dashboards live in [`grafana/dashboards/`](../../../grafana/dashboards/) and are auto-provisioned from that
directory. To visualize AMS activity, add a dashboard JSON there — or import one at runtime via the Grafana UI
(**Dashboards → Import**) — and point its panels at the `AMS Attempt Log` / `AMS Prediction Ledger` datasources
above. Panels should query only the sanitized reporting schema exposed by your exporter, never the raw ledger tables.
