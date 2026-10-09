#!/usr/bin/env bash
# The demo host hardened (COMPLIANCE.md G13), one step at a time, each safe to run again; `status` changes nothing.
#
#   DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/harden.sh <step>
#
#   status     what is in place: ports listening, firewall, SSH, updates, fail2ban, backups, a reboot pending
#   ssh        keys only: no passwords, root by key only (sshd_config.d/00-0-opencore-mes.conf; checked by sshd -t
#              before the reload, and the session in use is kept)
#   firewall   ufw: nothing in but the SSH port, 80 and 443 (TCP, and UDP for HTTP/3); everything out
#   fail2ban   bans an address after repeated SSH failures (with keys only, mostly noise kept out of the logs)
#   backups    nightly encrypted backups and the monthly restore test (ops/backup/), of every database named in
#              BACKUP_DATABASES (default: the demo, the training plant, and whatever else is on the host). The
#              key is made on the host if missing: copy it off (`… cat /etc/opencore-mes/backup.key`), or no backup
#              can be restored once the host is lost. Needs a release with ops/backup/ (deploy first).
#   reboot     restarts the host when an update asks for it (the demo is down for a minute)
set -euo pipefail
HOST="${DEMO_HOST:?DEMO_HOST}"; PORT="${DEMO_PORT:-22}"; KEY="${DEMO_KEY:?DEMO_KEY}"
SSH=(ssh -p "$PORT" -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "root@$HOST")
step="${1:?a step: status, ssh, firewall, fail2ban, backups or reboot}"

case "$step" in
status) "${SSH[@]}" 'set +e
    echo "listening:"; ss -tlnpH | awk "{print \"  \" \$4}" | sort -u
    echo "firewall: $(ufw status | head -1)"
    echo "ssh: $(sshd -T | grep -Ei "^(permitrootlogin|passwordauthentication) " | tr "\n" " ")"
    echo "updates: $(apt-config dump | grep -c "Unattended-Upgrade \"1\"") unattended; $(apt list --upgradable 2>/dev/null | tail -n +2 | wc -l) pending"
    echo "fail2ban: $(systemctl is-active fail2ban 2>/dev/null)"
    echo "backups: $(systemctl is-enabled opencore-mes-backup.timer 2>/dev/null | head -1); restore test: $(systemctl is-enabled opencore-mes-restore-test.timer 2>/dev/null | head -1)"
    echo "time: $(timedatectl show -p NTPSynchronized --value) (NTP synchronized)"
    [ -f /var/run/reboot-required ] && echo "reboot: required" || echo "reboot: not needed"' ;;
ssh) "${SSH[@]}" "set -e
    cat > /etc/ssh/sshd_config.d/00-0-opencore-mes.conf <<'CONF'
# The demo host (ops/demo/harden.sh): keys only. Named to be read before 00-custom.conf and the provider's files: the first value read wins.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
X11Forwarding no
CONF
    sshd -t
    systemctl reload ssh
    sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '"
    echo "ssh: keys only. This key still signs in:"; "${SSH[@]}" true && echo "  yes" ;;
firewall) "${SSH[@]}" "set -e
    command -v ufw >/dev/null || apt-get install -y -qq ufw
    ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
    ufw allow $PORT/tcp comment ssh >/dev/null
    ufw allow 80/tcp comment http >/dev/null; ufw allow 443/tcp comment https >/dev/null; ufw allow 443/udp comment http3 >/dev/null
    ufw --force enable >/dev/null
    ufw status verbose"
    echo "firewall: on. This key still signs in:"; "${SSH[@]}" true && echo "  yes" ;;
fail2ban) "${SSH[@]}" "set -e
    command -v fail2ban-server >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
    cat > /etc/fail2ban/jail.d/opencore-mes.local <<CONF
[sshd]
enabled = true
port = $PORT
backend = systemd
maxretry = 5
bantime = 1h
CONF
    systemctl enable --now fail2ban >/dev/null && systemctl restart fail2ban && sleep 1 && fail2ban-client status sshd | head -4" ;;
backups) "${SSH[@]}" "set -e
    R=/srv/opencore-mes/current
    [ -f \$R/ops/backup/backup.sh ] || { echo 'the live release has no ops/backup/: deploy first'; exit 1; }
    install -d -m 0750 /etc/opencore-mes
    [ -f /etc/opencore-mes/backup.key ] || { openssl rand -base64 48 > /etc/opencore-mes/backup.key; echo 'a new backup key: /etc/opencore-mes/backup.key (copy it off this host now)'; }
    chmod 0400 /etc/opencore-mes/backup.key; chown root:root /etc/opencore-mes/backup.key
    if [ ! -f /etc/opencore-mes/backup.env ]; then
        DBS=\$(su -s /bin/sh postgres -c \"psql -Atc \\\"SELECT 'postgres:///' || datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres') AND datname !~ '(_test|_restore|_sbx|_sbxt)' ORDER BY 1\\\"\" | tr '\n' ' ')
        printf 'BACKUP_DATABASES=\"%s\"\nBACKUP_DIR=/var/backups/opencore-mes\n# BACKUP_COPY=\"rclone copy {} remote:path/\"\n' \"\${BACKUP_DATABASES:-\$DBS}\" > /etc/opencore-mes/backup.env
    fi
    chmod 0640 /etc/opencore-mes/backup.env
    install -d -m 0700 -o postgres -g postgres /var/backups/opencore-mes
    install -m 644 \$R/ops/backup/opencore-mes-backup.service \$R/ops/backup/opencore-mes-backup.timer \$R/ops/backup/opencore-mes-restore-test.service \$R/ops/backup/opencore-mes-restore-test.timer /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now opencore-mes-backup.timer opencore-mes-restore-test.timer >/dev/null
    cat /etc/opencore-mes/backup.env
    systemctl start opencore-mes-backup.service && ls -lh /var/backups/opencore-mes | tail -n +2
    systemctl start opencore-mes-restore-test.service && journalctl -u opencore-mes-restore-test --since '-5 min' --no-pager -o cat | grep 'restore test:'" ;;
reboot) "${SSH[@]}" '[ -f /var/run/reboot-required ] || { echo "no reboot needed"; exit 0; }; cat /var/run/reboot-required.pkgs 2>/dev/null; systemctl reboot' || true
    echo "rebooting; waiting for it"; for i in $(seq 1 30); do sleep 5; "${SSH[@]}" -o ConnectTimeout=5 'uptime; systemctl is-active opencore-mes opencore-mes-training caddy' 2>/dev/null && break; done ;;
*) echo "unknown step: $step"; exit 2 ;;
esac
