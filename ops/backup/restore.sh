#!/usr/bin/env bash
# Restores a backup made by backup.sh into a database (COMPLIANCE.md G2): checks its SHA-256, decrypts it with
# the key, and pg_restore's it into TARGET_URL, which must not exist yet (it is made here), unless --replace is
# given for a database whose name ends in _restore or _test. Then verifies what came back: the audit trail's hash
# chain from its first entry (app/mes/db/verify-audit.mjs), and counts of records and audit entries.
#
#   BACKUP_KEY=/etc/opencore-mes/backup.key TARGET_URL=postgres:///opencore_mes_restore ops/backup/restore.sh <file>.dump.enc [--replace]
#
# For a real recovery: restore into a new database, check it, then point DATABASE_URL at it (or rename it) and
# start the server: it migrates itself to the release it runs.
set -euo pipefail
file="${1:?the backup file}"; : "${BACKUP_KEY:?BACKUP_KEY}" "${TARGET_URL:?TARGET_URL}"
here="$(cd "$(dirname "$0")/../.." && pwd)"
target="$(basename "${TARGET_URL%%\?*}")"
admin="${TARGET_URL%/*}/postgres"
[ -f "$file.sha256" ] || { echo "restore: no $file.sha256 beside it"; exit 1; }
(cd "$(dirname "$file")" && (sha256sum -c "$(basename "$file").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "$file").sha256")) >/dev/null || { echo "restore: $file does not match its SHA-256: not restored"; exit 1; }
exists="$(psql "$admin" -Atc "SELECT 1 FROM pg_database WHERE datname = '$target'")"
if [ -n "$exists" ]; then
  if [ "${2:-}" = "--replace" ] && [[ "$target" == *_restore || "$target" == *_test ]]; then psql "$admin" -qc "DROP DATABASE \"$target\" WITH (FORCE)"
  else echo "restore: $target exists; restore into a new database (or --replace one named *_restore or *_test)"; exit 1; fi
fi
psql "$admin" -qc "CREATE DATABASE \"$target\""
# A restore that fails (a wrong key, a damaged file) leaves nothing half made behind.
trap 'status=$?; [ $status -eq 0 ] || { psql "$admin" -qc "DROP DATABASE IF EXISTS \"$target\" WITH (FORCE)" >/dev/null 2>&1; echo "restore: failed, $target removed"; }' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY" -in "$file" | pg_restore --no-owner --exit-on-error --dbname="$TARGET_URL"
# Another application's database on the same host (no MES audit trail): its tables' rows counted instead.
if [ "$(psql "$TARGET_URL" -Atc "SELECT to_regclass('mes.audit_log') IS NOT NULL")" != "t" ]; then
  tables="$(psql "$TARGET_URL" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")"
  [ "$tables" -gt 0 ] || { echo "restore: $target holds no tables"; exit 1; }
  echo "restore: $target: $tables tables (not an OpenCore MES database: no audit trail to verify)"
  exit 0
fi
records="$(psql "$TARGET_URL" -Atc "SELECT count(*) FROM mes.records")"
audit="$(psql "$TARGET_URL" -Atc "SELECT count(*) FROM mes.audit_log")"
echo "restore: $target: $records records, $audit audit entries"
DATABASE_URL="$TARGET_URL" node "$here/app/mes/db/verify-audit.mjs" --full
