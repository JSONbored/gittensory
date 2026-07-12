#!/bin/sh
# Translate browserless's JSON /metrics endpoint into Prometheus text format (#5368). browserless's own
# /metrics?token=<token> returns a rolling history of 5-minute-window snapshots (an array, oldest first) --
# this exporter polls it, takes only the NEWEST snapshot (the array's last element), and re-exposes its
# fields as Prometheus gauges. Gauges, not counters: each field is a per-window sample from browserless's own
# rolling buffer, not a monotonic total, so it can legitimately go up or down between scrapes.
# Intended for the browserless-exporter compose sidecar; it never touches the app's own state.
set -eu

URL=${BROWSERLESS_METRICS_URL:-http://browserless:3000/metrics}
TOKEN=${BROWSERLESS_TOKEN:-}
OUT=${BROWSERLESS_METRICS_DIR:-/metrics}
FILE=${BROWSERLESS_METRICS_FILE:-$OUT/metrics}
INTERVAL=${BROWSERLESS_METRICS_INTERVAL_SECONDS:-30}
PORT=${BROWSERLESS_METRICS_PORT:-9102}

case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=30 ;;
esac

write_metrics() {
  mkdir -p "$OUT"
  tmp="$FILE.tmp"
  now=$(date +%s)
  raw=$(wget -qO- "$URL?token=$TOKEN" 2>/dev/null || true)
  latest=$(printf '%s' "$raw" | jq -c '.[-1] // empty' 2>/dev/null || true)

  {
    echo "# HELP browserless_exporter_last_scrape_success Whether the most recent poll of browserless's own /metrics succeeded (1) or failed (0)."
    echo "# TYPE browserless_exporter_last_scrape_success gauge"
    echo "# HELP browserless_exporter_last_scrape_timestamp_seconds Unix timestamp of the most recent poll attempt, successful or not."
    echo "# TYPE browserless_exporter_last_scrape_timestamp_seconds gauge"

    if [ -n "$latest" ]; then
      echo "browserless_exporter_last_scrape_success 1"
      echo "browserless_exporter_last_scrape_timestamp_seconds $now"

      echo "# HELP browserless_queued Sessions queued (over browserless's concurrency limit) in the most recent 5-minute window."
      echo "# TYPE browserless_queued gauge"
      echo "browserless_queued $(printf '%s' "$latest" | jq '.queued // 0')"

      echo "# HELP browserless_running Sessions currently running at the time of the most recent window sample."
      echo "# TYPE browserless_running gauge"
      echo "browserless_running $(printf '%s' "$latest" | jq '.running // 0')"

      echo "# HELP browserless_max_concurrent Peak concurrent sessions observed in the most recent 5-minute window."
      echo "# TYPE browserless_max_concurrent gauge"
      echo "browserless_max_concurrent $(printf '%s' "$latest" | jq '.maxConcurrent // 0')"

      echo "# HELP browserless_rejected Sessions rejected (over capacity) in the most recent 5-minute window."
      echo "# TYPE browserless_rejected gauge"
      echo "browserless_rejected $(printf '%s' "$latest" | jq '.rejected // 0')"

      echo "# HELP browserless_errors Sessions that errored in the most recent 5-minute window."
      echo "# TYPE browserless_errors gauge"
      echo "browserless_errors $(printf '%s' "$latest" | jq '.error // 0')"

      echo "# HELP browserless_timedout Sessions that timed out in the most recent 5-minute window."
      echo "# TYPE browserless_timedout gauge"
      echo "browserless_timedout $(printf '%s' "$latest" | jq '.timedout // 0')"

      echo "# HELP browserless_unauthorized Unauthorized session requests (bad/missing token) in the most recent 5-minute window."
      echo "# TYPE browserless_unauthorized gauge"
      echo "browserless_unauthorized $(printf '%s' "$latest" | jq '.unauthorized // 0')"

      echo "# HELP browserless_unhealthy Sessions marked unhealthy in the most recent 5-minute window."
      echo "# TYPE browserless_unhealthy gauge"
      echo "browserless_unhealthy $(printf '%s' "$latest" | jq '.unhealthy // 0')"

      echo "# HELP browserless_successful Sessions that completed successfully in the most recent 5-minute window."
      echo "# TYPE browserless_successful gauge"
      echo "browserless_successful $(printf '%s' "$latest" | jq '.successful // 0')"

      echo "# HELP browserless_session_mean_time_ms Mean session duration in milliseconds over the most recent 5-minute window."
      echo "# TYPE browserless_session_mean_time_ms gauge"
      echo "browserless_session_mean_time_ms $(printf '%s' "$latest" | jq '.meanTime // 0')"

      echo "# HELP browserless_cpu_ratio Host CPU utilization ratio (0-1) sampled at the most recent window."
      echo "# TYPE browserless_cpu_ratio gauge"
      echo "browserless_cpu_ratio $(printf '%s' "$latest" | jq '.cpu // 0')"

      echo "# HELP browserless_memory_ratio Host memory utilization ratio (0-1) sampled at the most recent window."
      echo "# TYPE browserless_memory_ratio gauge"
      echo "browserless_memory_ratio $(printf '%s' "$latest" | jq '.memory // 0')"

      echo "# HELP browserless_sample_timestamp_seconds Unix timestamp browserless itself assigned to the most recent window sample."
      echo "# TYPE browserless_sample_timestamp_seconds gauge"
      echo "browserless_sample_timestamp_seconds $(printf '%s' "$latest" | jq '(.date // 0) / 1000')"
    else
      echo "browserless_exporter_last_scrape_success 0"
      echo "browserless_exporter_last_scrape_timestamp_seconds $now"
    fi
  } > "$tmp"
  mv "$tmp" "$FILE"
}

if [ "${BROWSERLESS_METRICS_ONCE:-}" = "1" ]; then
  write_metrics
  exit 0
fi

write_metrics
httpd -f -p "$PORT" -h "$OUT" &
server=$!
trap 'kill "$server" 2>/dev/null || true' INT TERM EXIT

while true; do
  sleep "$INTERVAL"
  write_metrics
done
