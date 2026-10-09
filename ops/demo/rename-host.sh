#!/usr/bin/env bash
# Renames a host set up under the old names to the new ones, once: /srv/open-mes, /var/lib/open-mes, /etc/open-mes
# and /var/backups/open-mes become …/opencore-mes; the system user and database role openmes become opencore; the
# databases openmes_demo, openmes_training_plant and openmes_test become opencore_mes_demo, opencore_mes_training
# and opencore_mes_test; the old units, AppArmor profile, SSH and fail2ban snippets are removed or renamed. The
# user keeps its uid, the role its oid (what it owns and was granted stays), files stay where they were moved.
#
#   DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/rename-host.sh            what it would do
#   DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/rename-host.sh --apply    do it
#
# The services are stopped while it runs (a few seconds of downtime). Then deploy (ops/demo/deploy.sh), which
# installs the units under their new names and starts them, and reinstall the backup timers (harden.sh backups,
# which keeps the existing key and settings). Nothing is deleted but the old unit files and profile.
set -euo pipefail
HOST="${DEMO_HOST:?DEMO_HOST}"; PORT="${DEMO_PORT:-22}"; KEY="${DEMO_KEY:?DEMO_KEY}"
SSH=(ssh -p "$PORT" -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "root@$HOST")

PLAN='set -euo pipefail
[ -d /srv/open-mes ] || { echo "nothing to rename: no /srv/open-mes on this host"; exit 0; }
[ -e /srv/opencore-mes ] && { echo "both /srv/open-mes and /srv/opencore-mes exist: look before going on"; exit 1; }
UNITS="open-mes open-mes-training open-mes-reset.timer open-mes-training-reset.timer open-mes-backup.timer open-mes-restore-test.timer"
systemctl stop $UNITS 2>/dev/null || true
systemctl disable $UNITS 2>/dev/null || true
usermod -l opencore openmes
groupmod -n opencore openmes
usermod -d /srv/opencore-mes opencore
mv /srv/open-mes /srv/opencore-mes
[ -d /var/lib/open-mes ] && mv /var/lib/open-mes /var/lib/opencore-mes
[ -d /etc/open-mes ] && mv /etc/open-mes /etc/opencore-mes
[ -d /var/backups/open-mes ] && mv /var/backups/open-mes /var/backups/opencore-mes
T="$(basename "$(readlink /srv/opencore-mes/current)")"; ln -sfn "/srv/opencore-mes/releases/$T" /srv/opencore-mes/current
su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -qc \"ALTER ROLE openmes RENAME TO opencore\""
for pair in openmes_demo:opencore_mes_demo openmes_training_plant:opencore_mes_training openmes_test:opencore_mes_test; do
    old="${pair%%:*}"; new="${pair##*:}"
    if su -s /bin/sh postgres -c "psql -Atc \"SELECT 1 FROM pg_database WHERE datname = '"'"'$old'"'"'\"" | grep -q 1; then
        su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -qc \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'$old'"'"'\" -c \"ALTER DATABASE $old RENAME TO $new\""
        echo "database $old is now $new"
    fi
done
[ -f /etc/opencore-mes/backup.env ] && sed -i "s#/var/backups/open-mes#/var/backups/opencore-mes#g; s#openmes_demo#opencore_mes_demo#g; s#openmes_training_plant#opencore_mes_training#g" /etc/opencore-mes/backup.env
rm -f /etc/systemd/system/open-mes*.service /etc/systemd/system/open-mes*.timer
if [ -f /etc/apparmor.d/open-mes-bwrap ]; then apparmor_parser -R /etc/apparmor.d/open-mes-bwrap 2>/dev/null || true; rm -f /etc/apparmor.d/open-mes-bwrap; fi
if [ -f /etc/ssh/sshd_config.d/00-0-open-mes.conf ]; then mv /etc/ssh/sshd_config.d/00-0-open-mes.conf /etc/ssh/sshd_config.d/00-0-opencore-mes.conf; sshd -t && systemctl reload ssh; fi
if [ -f /etc/fail2ban/jail.d/open-mes.local ]; then mv /etc/fail2ban/jail.d/open-mes.local /etc/fail2ban/jail.d/opencore-mes.local; systemctl reload fail2ban 2>/dev/null || true; fi
systemctl daemon-reload
echo "renamed. Now: ops/demo/deploy.sh (installs and starts the units under their new names), then ops/demo/harden.sh backups"'

if [ "${1:-}" = "--apply" ]; then
    "${SSH[@]}" 'bash -s' <<< "$PLAN"
else
    echo "What it would do on $HOST (nothing is changed; run again with --apply to do it):"
    echo
    echo "$PLAN"
    echo
    echo "On the host now:"
    "${SSH[@]}" 'ls -d /srv/open-mes /srv/opencore-mes /var/lib/open-mes /etc/open-mes /var/backups/open-mes 2>/dev/null; id openmes 2>/dev/null; su -s /bin/sh postgres -c "psql -Atc \"SELECT datname FROM pg_database WHERE datname LIKE '"'"'openmes%'"'"'\""' || true
fi
