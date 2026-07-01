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
mkdir -p "$OUT/postgres" "$OUT/sqlite" "$OUT/qdrant"

# Set to 1 if the SQLite online backup fails verification, so we skip its retention prune
# (never delete the last good backup) and still exit non-zero at the end (fail loudly).
SQLITE_BACKUP_FAILED=0

# 1) Active app database. Prefer Postgres when DATABASE_URL is set; otherwise keep the SQLite online backup path.
case "$PG_DB" in
  postgres://*|postgresql://*)
    if ! command -v pg_dump >/dev/null 2>&1; then
      echo "[backup] pg_dump not found; cannot back up Postgres database" >&2
      exit 1
    fi
    pg_dump -Fc -f "$OUT/postgres/gittensory-$TS.dump" "$PG_DB"
    echo "[backup] postgres -> $OUT/postgres/gittensory-$TS.dump"
    ;;
  *)
    if [ -f "$DB" ]; then
      SQLITE_OUT="$OUT/sqlite/gittensory-$TS.sqlite"
      # `.backup` can exit 0 while writing a partial/corrupt file, so verify the result
      # (non-empty AND `PRAGMA integrity_check` == ok) before we gzip it or let retention
      # prune older, good backups. A failed backup must be loud, not silently "successful".
      if sqlite3 "$DB" ".backup '$SQLITE_OUT'" \
        && [ -s "$SQLITE_OUT" ] \
        && [ "$(sqlite3 "$SQLITE_OUT" 'PRAGMA integrity_check;' 2>/dev/null)" = "ok" ]; then
        gzip -f "$SQLITE_OUT"
        echo "[backup] sqlite -> $SQLITE_OUT.gz"
      else
        rm -f "$SQLITE_OUT"
        echo "[backup] ERROR: sqlite online backup failed verification; keeping previous backups" >&2
        SQLITE_BACKUP_FAILED=1
      fi
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
  # After a failed SQLite backup, skip its prune so the newest surviving (older) backups are kept.
  if [ "$d" = sqlite ] && [ "$SQLITE_BACKUP_FAILED" = 1 ]; then
    echo "[backup] skipping sqlite retention after a failed backup (preserving existing backups)"
    continue
  fi
  # ls is safe here: backup filenames are controlled timestamps with no spaces or newlines.
  # shellcheck disable=SC2012
  ls -1t "$OUT/$d" 2>/dev/null | tail -n +"$((RETAIN + 1))" | while IFS= read -r f; do
    rm -f "$OUT/$d/$f"
    echo "[backup] pruned old backup $d/$f"
  done
done

if [ "$SQLITE_BACKUP_FAILED" = 1 ]; then
  echo "[backup] FAILED ($TS): sqlite online backup did not verify; see errors above" >&2
  exit 1
fi

echo "[backup] complete ($TS); retaining newest $RETAIN per target"
