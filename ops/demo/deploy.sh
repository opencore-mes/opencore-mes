#!/usr/bin/env bash
# Ships this working tree's tracked files (never .env, ignored files or suites/) to the demo server,
# installs its dependencies, runs the test pipeline there on its own Node, then switches the release,
# installs the services, Caddy's sites and the landing page (site/, opencoremes.com), and restarts. `--provision` runs provision.sh first.
# SUITES names installed suites (folders under suites/, each its own repository) to ship too, each its
# repository's files as they are here, into the release's suites/ (DESIGN.md §29); none unless named.
#
#   DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> [SUITES="name …"] ops/demo/deploy.sh [--provision | --site]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
HOST="${DEMO_HOST:?DEMO_HOST}"; PORT="${DEMO_PORT:-22}"; KEY="${DEMO_KEY:?DEMO_KEY}"
SSH=(ssh -p "$PORT" -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "root@$HOST")
STAMP="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . 2>/dev/null || echo "-dirty")"

if [ "${1:-}" = "--provision" ]; then "${SSH[@]}" 'bash -s' < ops/demo/provision.sh; fi

# --site: the landing page alone (opencoremes.com), swapped in whole, with Caddy's settings (its Content
# Security Policy names what the page may load); the demo is not touched.
if [ "${1:-}" = "--site" ]; then
    "${SSH[@]}" "set -e; cat > /etc/caddy/Caddyfile.next && caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile >/dev/null 2>&1 && mv /etc/caddy/Caddyfile.next /etc/caddy/Caddyfile && chmod 644 /etc/caddy/Caddyfile && systemctl reload caddy" < ops/demo/Caddyfile
    COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf - -C site . | "${SSH[@]}" "set -e
        rm -rf /srv/opencoremes-site.next && mkdir -p /srv/opencoremes-site.next && tar -xzf - -C /srv/opencoremes-site.next && chmod -R a+rX /srv/opencoremes-site.next
        rm -rf /srv/opencoremes-site.old && { [ -d /srv/opencoremes-site ] && mv /srv/opencoremes-site /srv/opencoremes-site.old || true; } && mv /srv/opencoremes-site.next /srv/opencoremes-site"
    echo "site published"
    exit 0
fi

echo "shipping $STAMP"
git ls-files -co --exclude-standard -z | grep -zv '^INVENTION_DISCLOSURE' | COPYFILE_DISABLE=1 xargs -0 tar --no-mac-metadata --no-xattrs -czf - | "${SSH[@]}" "set -e
    R=/srv/open-mes/releases/$STAMP
    mkdir -p \$R && tar -xzf - -C \$R && echo 'BUILD=$STAMP' > \$R/BUILD.env && chown -R openmes:openmes \$R
    cd \$R && su -s /bin/sh openmes -c 'npm ci --omit=dev --no-audit --no-fund --loglevel=error'
    # The script runner's walls (§12.4, demo.env SCRIPT_RUNNER_WRAP): Ubuntu 24.04 lets bubblewrap make its
    # namespaces only under a profile that allows it. Loaded before the tests, which try the wrapper.
    if command -v bwrap >/dev/null && command -v apparmor_parser >/dev/null; then
        install -m 0644 \$R/ops/script-runner-sandbox.apparmor /etc/apparmor.d/open-mes-bwrap && apparmor_parser -r /etc/apparmor.d/open-mes-bwrap
    fi"
for SUITE in ${SUITES:-}; do
    [ -f "suites/$SUITE/suite.mjs" ] || { echo "suites/$SUITE is not an installed suite"; exit 1; }
    echo "shipping suite $SUITE ($(git -C "suites/$SUITE" rev-parse --short HEAD 2>/dev/null || echo "no commits")$(git -C "suites/$SUITE" diff --quiet HEAD -- . 2>/dev/null || echo "-dirty"))"
    (cd "suites/$SUITE" && git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 xargs -0 tar --no-mac-metadata --no-xattrs -czf -) | "${SSH[@]}" "set -e
        D=/srv/open-mes/releases/$STAMP/suites/$SUITE && mkdir -p \$D && tar -xzf - -C \$D && chown -R openmes:openmes /srv/open-mes/releases/$STAMP/suites"
done

echo "testing on the server"
"${SSH[@]}" "set -eo pipefail; cd /srv/open-mes/releases/$STAMP
    su -s /bin/sh openmes -c 'PGHOST=/var/run/postgresql TEST_DATABASE_URL=postgres:///openmes_test EVENT_LOG_DIR=/var/lib/open-mes/test-events npm run test:all' | tail -6"

echo "switching"
"${SSH[@]}" "set -e; R=/srv/open-mes/releases/$STAMP
    install -m 644 \$R/ops/demo/open-mes.service \$R/ops/demo/open-mes-reset.service \$R/ops/demo/open-mes-reset.timer /etc/systemd/system/
    install -m 644 \$R/ops/demo/Caddyfile /etc/caddy/Caddyfile
    # The landing page (opencoremes.com), swapped in whole.
    rm -rf /srv/opencoremes-site.next && cp -r \$R/site /srv/opencoremes-site.next && chmod -R a+rX /srv/opencoremes-site.next
    rm -rf /srv/opencoremes-site.old && { [ -d /srv/opencoremes-site ] && mv /srv/opencoremes-site /srv/opencoremes-site.old || true; } && mv /srv/opencoremes-site.next /srv/opencoremes-site
    systemctl daemon-reload
    # The first release makes the demo database (later ones migrate it at start).
    if ! su -s /bin/sh postgres -c \"psql -lqt\" | cut -d'|' -f1 | grep -qw openmes_demo; then
        su -s /bin/sh openmes -c \"cd \$R && set -a && . ops/demo/demo.env && set +a && node app/mes/db/reset.mjs\"
    fi
    ln -sfn \$R /srv/open-mes/current
    systemctl enable --now open-mes-reset.timer >/dev/null
    systemctl enable open-mes >/dev/null && systemctl restart open-mes
    systemctl reload caddy
    ls -1dt /srv/open-mes/releases/* | tail -n +6 | xargs -r rm -rf
    sleep 3; curl -fsS http://127.0.0.1:3000/healthz | head -c 200; echo
    # The script runner's walls, as it reports them (§12.4): no network of its own, in bubblewrap.
    curl -fsS http://127.0.0.1:3000/healthz | python3 -c 'import json,sys; s=json.load(sys.stdin).get(\"scripts\") or {}; print(\"scripts:\", s); sys.exit(0 if s.get(\"network\")==\"none\" else 1)'"
echo "deployed $STAMP"
