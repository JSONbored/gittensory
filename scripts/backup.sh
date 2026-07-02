#!/bin/sh
# Self-host backup: active DB backup (Postgres dump or online SQLite backup) + a Qdrant snapshot, with retention.
# Run by the `backup` compose service (--profile backup) on a loop, or on demand:
#   docker compose --profile backup run --rm backup sh /backup.sh
# Backups land in the `gittensory-backups` volume at /backups/{postgres,sqlite,qdrant}.
set -eu

TS=$(date -u +%Y%m%dT%H%M%SZ)
RETAIN=${BACKUP_RETAIN:-7}
DB=${DATABASE_PATH:-/data/gittensory.sqlite}
PG_DB="${GITTENSORY_BACKUP_SOURCE_DATABASE_URL:-${DATABASE_URL:-}}"
OUT=${BACKUP_OUT_DIR:-/backups}
PGPASSFILE_CREATED=""
cleanup() {
  if [ -n "$PGPASSFILE_CREATED" ]; then
    rm -f "$PGPASSFILE_CREATED"
  fi
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$OUT/postgres" "$OUT/sqlite" "$OUT/qdrant"

url_decode() {
  printf '%s' "$1" | awk '
    BEGIN { for (i = 0; i < 256; i++) hex[sprintf("%02X", i)] = sprintf("%c", i); }
    {
      out = "";
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1);
        if (c == "%" && i + 2 <= length($0)) {
          h = toupper(substr($0, i + 1, 2));
          if (h in hex) { out = out hex[h]; i += 2; } else { out = out c; }
        } else if (c == "+") {
          out = out " ";
        } else {
          out = out c;
        }
      }
      printf "%s", out;
    }'
}

pgpass_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/:/\\:/g'
}

prepare_pg_env() {
  pg_url_no_scheme=${PG_DB#postgres://}
  pg_url_no_scheme=${pg_url_no_scheme#postgresql://}
  pg_without_query=${pg_url_no_scheme%%\?*}

  pg_auth=""
  pg_host_path=$pg_without_query
  case "$pg_without_query" in
    *@*)
      pg_auth=${pg_without_query%%@*}
      pg_host_path=${pg_without_query#*@}
      ;;
  esac

  PGUSER_VALUE=""
  PGPASSWORD_VALUE=""
  if [ -n "$pg_auth" ]; then
    PGUSER_VALUE=$(url_decode "${pg_auth%%:*}")
    if [ "$pg_auth" != "${pg_auth#*:}" ]; then
      PGPASSWORD_VALUE=$(url_decode "${pg_auth#*:}")
    fi
  fi

  pg_host_port=${pg_host_path%%/*}
  PGDATABASE_VALUE=$(url_decode "${pg_host_path#*/}")
  if [ "$PGDATABASE_VALUE" = "$pg_host_path" ] || [ -z "$PGDATABASE_VALUE" ]; then
    PGDATABASE_VALUE=postgres
  fi

  PGHOST_VALUE=${pg_host_port%%:*}
  PGPORT_VALUE=${pg_host_port#*:}
  if [ "$PGPORT_VALUE" = "$pg_host_port" ]; then
    PGPORT_VALUE=5432
  fi

  export PGHOST="$PGHOST_VALUE" PGPORT="$PGPORT_VALUE" PGDATABASE="$PGDATABASE_VALUE"
  if [ -n "$PGUSER_VALUE" ]; then
    export PGUSER="$PGUSER_VALUE"
  fi

  if [ -n "$PGPASSWORD_VALUE" ]; then
    PGPASSFILE_CREATED=$(mktemp "${TMPDIR:-/tmp}/gittensory-pgpass.XXXXXX")
    chmod 600 "$PGPASSFILE_CREATED"
    printf '%s:%s:%s:%s:%s\n' \
      "$(pgpass_escape "$PGHOST_VALUE")" \
      "$(pgpass_escape "$PGPORT_VALUE")" \
      "$(pgpass_escape "$PGDATABASE_VALUE")" \
      "$(pgpass_escape "${PGUSER_VALUE:-*}")" \
      "$(pgpass_escape "$PGPASSWORD_VALUE")" > "$PGPASSFILE_CREATED"
    export PGPASSFILE="$PGPASSFILE_CREATED"
  fi
}

# 1) Active app database. Prefer Postgres when DATABASE_URL is set; otherwise keep the SQLite online backup path.
case "$PG_DB" in
  postgres://*|postgresql://*)
    if ! command -v pg_dump >/dev/null 2>&1; then
      echo "[backup] pg_dump not found; cannot back up Postgres database" >&2
      exit 1
    fi
    prepare_pg_env
    pg_dump -Fc -f "$OUT/postgres/gittensory-$TS.dump"
    echo "[backup] postgres -> $OUT/postgres/gittensory-$TS.dump"
    ;;
  *)
    if [ -f "$DB" ]; then
      sqlite3 "$DB" ".backup '$OUT/sqlite/gittensory-$TS.sqlite'"
      gzip -f "$OUT/sqlite/gittensory-$TS.sqlite"
      echo "[backup] sqlite -> $OUT/sqlite/gittensory-$TS.sqlite.gz"
    else
      echo "[backup] sqlite db not found at $DB (skipping)"
    fi
    ;;
esac

# 2) Qdrant — trigger a full storage snapshot, download it, then delete it from Qdrant's own storage so snapshots
#    don't accumulate inside the vector store. Best-effort: a Qdrant outage must not fail the DB backup.
if [ -n "${QDRANT_URL:-}" ]; then
  NAME=$(curl -sf -X POST "$QDRANT_URL/snapshots" 2>/dev/null | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "$NAME" ]; then
    if curl -sf "$QDRANT_URL/snapshots/$NAME" -o "$OUT/qdrant/$NAME" 2>/dev/null; then
      echo "[backup] qdrant -> $OUT/qdrant/$NAME"
    fi
    curl -sf -X DELETE "$QDRANT_URL/snapshots/$NAME" >/dev/null 2>&1 || true
  else
    echo "[backup] qdrant snapshot could not be created (skipping)"
  fi
fi

# 3) Retention — keep only the newest $RETAIN in each directory.
for d in postgres sqlite qdrant; do
  ls -1t "$OUT/$d" 2>/dev/null | tail -n +"$((RETAIN + 1))" | while IFS= read -r f; do
    rm -f "$OUT/$d/$f"
    echo "[backup] pruned old backup $d/$f"
  done
done

echo "[backup] complete ($TS); retaining newest $RETAIN per target"
