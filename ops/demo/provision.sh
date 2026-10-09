#!/usr/bin/env bash
# The public demo's server, from a fresh Ubuntu 24.04 (run as root; safe to run again): PostgreSQL,
# Caddy, Node (the latest release unless NODE_VERSION says), bubblewrap for the script runner's walls,
# the opencore user and its database role.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Caddy (HTTPS certificates by itself) from Ubuntu's own signed repositories.
rm -f /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y --no-install-recommends postgresql caddy curl ca-certificates python3 xz-utils libatomic1 bubblewrap
# (deploy.sh loads its AppArmor profile from each release, ops/script-runner-sandbox.apparmor.)

# Node: the official build, its checksum checked.
NODE_VERSION="${NODE_VERSION:-latest}"
if [ "$NODE_VERSION" = latest ]; then
    NODE_VERSION=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["version"])')
fi
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
    file="node-$NODE_VERSION-linux-x64.tar.xz"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$file" -o "/tmp/$file"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $file\$" | (cd /tmp && sha256sum -c -)
    rm -rf /opt/node && mkdir -p /opt/node
    tar -xJf "/tmp/$file" -C /opt/node --strip-components=1
    ln -sf /opt/node/bin/node /usr/local/bin/node
    ln -sf /opt/node/bin/npm /usr/local/bin/npm
    ln -sf /opt/node/bin/npx /usr/local/bin/npx
    rm -f "/tmp/$file"
fi
echo "node $(/usr/local/bin/node -v)"

# The user it runs as, its folders, and its database role (local socket, peer authentication).
id opencore >/dev/null 2>&1 || useradd --system --home-dir /srv/opencore-mes --shell /usr/sbin/nologin opencore
mkdir -p /srv/opencore-mes/releases /var/lib/opencore-mes/events
chown -R opencore:opencore /srv/opencore-mes /var/lib/opencore-mes
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'opencore'" | grep -q 1 || sudo -u postgres createuser --createdb opencore
# The role queries run as (query.js: it reads the q views and nothing else). Made here, so opencore
# needs no right to create roles; opencore may switch to it and grant it.
sudo -u postgres psql -v ON_ERROR_STOP=1 -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mes_query') THEN CREATE ROLE mes_query NOLOGIN; END IF; END \$\$; GRANT mes_query TO opencore WITH ADMIN OPTION;"

systemctl enable --now postgresql caddy
echo "provisioned"
