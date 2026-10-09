#!/usr/bin/env bash
# A backup of one OpenCore MES database (COMPLIANCE.md G2): pg_dump's custom format, encrypted (AES-256, a key
# file of its own), with its SHA-256 beside it, kept by date in BACKUP_DIR; older ones pruned (KEEP_DAYS daily,
# and the first of each month for KEEP_MONTHS months). Optionally copied off the machine (BACKUP_COPY: a
# command run with the two files, e.g. `rclone copy {} remote:opencore/`). Exit 1 on any failure: a timer's
# failure is the alert.
#
#   DATABASE_URL=postgres:///opencore_mes_demo BACKUP_DIR=/var/backups/opencore-mes BACKUP_KEY=/etc/opencore-mes/backup.key ops/backup/backup.sh
#
# The key: `openssl rand -base64 48 > /etc/opencore-mes/backup.key; chmod 0400` (root), kept also somewhere off
# this machine: without it no backup can be restored. A dump holds the whole database: records, the audit
# trail, people and sign-in data (hashed passwords and sessions).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL}" "${BACKUP_DIR:?BACKUP_DIR}" "${BACKUP_KEY:?BACKUP_KEY}"
KEEP_DAYS="${KEEP_DAYS:-14}"; KEEP_MONTHS="${KEEP_MONTHS:-12}"
[ -r "$BACKUP_KEY" ] || { echo "backup: no key at $BACKUP_KEY"; exit 1; }
name="$(basename "${DATABASE_URL%%\?*}")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"; chmod 0700 "$BACKUP_DIR"
out="$BACKUP_DIR/$name-$stamp.dump.enc"
umask 077
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY" -out "$out.part"
mv "$out.part" "$out"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" 2>/dev/null || shasum -a 256 "$(basename "$out")" > "$(basename "$out").sha256")
echo "backup: $out ($(du -h "$out" | cut -f1))"
if [ -n "${BACKUP_COPY:-}" ]; then
  for f in "$out" "$out.sha256"; do sh -c "${BACKUP_COPY//\{\}/\"$f\"}"; done
  echo "backup: copied off the machine"
fi
# Keep the last KEEP_DAYS days, and the first backup of each of the last KEEP_MONTHS months.
cutoff="$(date -u -d "-$KEEP_DAYS days" +%Y%m%d 2>/dev/null || date -u -v-"$KEEP_DAYS"d +%Y%m%d)"
keep_months="$(for i in $(seq 0 $((KEEP_MONTHS - 1))); do date -u -d "-$i months" +%Y%m 2>/dev/null || date -u -v-"$i"m +%Y%m; done)"
for f in "$BACKUP_DIR/$name"-*.dump.enc; do
  d="$(basename "$f" | sed -E "s/^$name-([0-9]{8})T.*/\1/")"
  [ "$d" \> "$cutoff" ] || [ "$d" = "$cutoff" ] && continue
  m="${d:0:6}"
  first="$(ls -1 "$BACKUP_DIR/$name-$m"*.dump.enc 2>/dev/null | head -1)"
  if echo "$keep_months" | grep -qx "$m" && [ "$f" = "$first" ]; then continue; fi
  rm -f "$f" "$f.sha256"
done
