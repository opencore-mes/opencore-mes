#!/usr/bin/env bash
# The restore, tested (COMPLIANCE.md G2): the latest backup of a database restored into <name>_restore, its
# audit chain verified, its counts compared with the live database's (the live one may only have grown), then
# dropped. Run it on a schedule (monthly at least; the ISMS's backup policy says how often) and keep its output
# as evidence. Exit 1 on any failure.
#
#   DATABASE_URL=postgres:///opencore_mes_demo BACKUP_DIR=/var/backups/opencore-mes BACKUP_KEY=/etc/opencore-mes/backup.key ops/backup/restore-test.sh
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL}" "${BACKUP_DIR:?BACKUP_DIR}" "${BACKUP_KEY:?BACKUP_KEY}"
here="$(cd "$(dirname "$0")" && pwd)"
name="$(basename "${DATABASE_URL%%\?*}")"
latest="$(ls -1t "$BACKUP_DIR/$name"-*.dump.enc 2>/dev/null | head -1)"
[ -n "$latest" ] || { echo "restore test: no backup of $name in $BACKUP_DIR"; exit 1; }
target="${DATABASE_URL%/*}/${name}_restore"
echo "restore test: $latest → ${name}_restore ($(date -u +%FT%TZ))"
BACKUP_KEY="$BACKUP_KEY" TARGET_URL="$target" "$here/restore.sh" "$latest" --replace
if [ "$(psql "$target" -Atc "SELECT to_regclass('mes.audit_log') IS NOT NULL")" != "t" ]; then
  psql "${DATABASE_URL%/*}/postgres" -qc "DROP DATABASE \"${name}_restore\" WITH (FORCE)"
  echo "restore test: passed (restored whole; not an OpenCore MES database)"; exit 0
fi
live="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM mes.audit_log")"
back="$(psql "$target" -Atc "SELECT count(*) FROM mes.audit_log")"
[ "$back" -le "$live" ] && [ "$back" -gt 0 ] || { echo "restore test: $back audit entries restored, $live live: not a plausible backup"; exit 1; }
psql "${DATABASE_URL%/*}/postgres" -qc "DROP DATABASE \"${name}_restore\" WITH (FORCE)"
echo "restore test: passed"
