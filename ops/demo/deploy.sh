#!/usr/bin/env bash
# Ships this working tree's tracked files (never .env, ignored files or suites/) to the demo server,
# installs its dependencies, runs the test pipeline there on its own Node, then switches the release,
# installs the services (the demo and the training plant beside the trainings, §37), Caddy's sites and the
# landing page (site/, opencoremes.com), and restarts. `--provision` runs provision.sh first.
# SUITES names installed suites (folders under suites/, each its own repository) to ship too, each its
# repository's files as they are here, into the release's suites/ (DESIGN.md §29). Unset, the suites the live
# release runs are shipped again, so an update never drops what the demo shows (its nightly reset seeds only the
# suites it has); one of them not installed here stops the deploy, naming it. SUITES=none ships none, on purpose.
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
    # (site/src/ is how the pages are made, not part of the site.)
    COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --exclude=./src -czf - -C site . | "${SSH[@]}" "set -e
        rm -rf /srv/opencoremes-site.next && mkdir -p /srv/opencoremes-site.next && tar -xzf - -C /srv/opencoremes-site.next && chmod -R a+rX /srv/opencoremes-site.next
        rm -rf /srv/opencoremes-site.old && { [ -d /srv/opencoremes-site ] && mv /srv/opencoremes-site /srv/opencoremes-site.old || true; } && mv /srv/opencoremes-site.next /srv/opencoremes-site"
    echo "site published"
    exit 0
fi

# A host laid out under the old names (/srv/open-mes, the user openmes) is renamed first, once, on purpose:
# ops/demo/rename-host.sh. Deploying the new names beside the old would run two layouts at once.
if "${SSH[@]}" '[ -d /srv/open-mes ]'; then
    echo "this host still has the old layout (/srv/open-mes): run ops/demo/rename-host.sh (first without --apply, to read what it does), then deploy again"
    exit 1
fi

if [ -z "${SUITES+x}" ]; then
    SUITES="$("${SSH[@]}" 'ls -1 /srv/opencore-mes/current/suites 2>/dev/null | grep -v "^\." | tr "\n" " "' || true)"
    echo "suites as live: ${SUITES:-none}"
    for SUITE in $SUITES; do [ -f "suites/$SUITE/suite.mjs" ] || { echo "the demo runs suite $SUITE, not installed here (suites/$SUITE): install it, or say SUITES=\"…\" (SUITES=none for none)"; exit 1; }; done
fi
[ "${SUITES:-}" = "none" ] && SUITES=""
echo "shipping $STAMP"
git ls-files -co --exclude-standard -z | grep -zv '^INVENTION_DISCLOSURE' | COPYFILE_DISABLE=1 xargs -0 tar --no-mac-metadata --no-xattrs -czf - | "${SSH[@]}" "set -e
    R=/srv/opencore-mes/releases/$STAMP
    mkdir -p \$R && tar -xzf - -C \$R && echo 'BUILD=$STAMP' > \$R/BUILD.env && chown -R opencore:opencore \$R
    cd \$R && su -s /bin/sh opencore -c 'npm ci --omit=dev --no-audit --no-fund --loglevel=error'
    # The script runner's walls (§12.4, demo.env SCRIPT_RUNNER_WRAP): Ubuntu 24.04 lets bubblewrap make its
    # namespaces only under a profile that allows it. Loaded before the tests, which try the wrapper.
    if command -v bwrap >/dev/null && command -v apparmor_parser >/dev/null; then
        install -m 0644 \$R/ops/script-runner-sandbox.apparmor /etc/apparmor.d/opencore-mes-bwrap && apparmor_parser -r /etc/apparmor.d/opencore-mes-bwrap
    fi"
for SUITE in ${SUITES:-}; do
    [ -f "suites/$SUITE/suite.mjs" ] || { echo "suites/$SUITE is not an installed suite"; exit 1; }
    echo "shipping suite $SUITE ($(git -C "suites/$SUITE" rev-parse --short HEAD 2>/dev/null || echo "no commits")$(git -C "suites/$SUITE" diff --quiet HEAD -- . 2>/dev/null || echo "-dirty"))"
    (cd "suites/$SUITE" && git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 xargs -0 tar --no-mac-metadata --no-xattrs -czf -) | "${SSH[@]}" "set -e
        D=/srv/opencore-mes/releases/$STAMP/suites/$SUITE && mkdir -p \$D && tar -xzf - -C \$D && chown -R opencore:opencore /srv/opencore-mes/releases/$STAMP/suites"
done

echo "testing on the server"
"${SSH[@]}" "set -eo pipefail; cd /srv/opencore-mes/releases/$STAMP
    su -s /bin/sh opencore -c 'PGHOST=/var/run/postgresql TEST_DATABASE_URL=postgres:///opencore_mes_test EVENT_LOG_DIR=/var/lib/opencore-mes/test-events npm run test:all' | tail -6"

echo "switching"
"${SSH[@]}" "set -e; R=/srv/opencore-mes/releases/$STAMP
    install -m 644 \$R/ops/demo/opencore-mes.service \$R/ops/demo/opencore-mes-reset.service \$R/ops/demo/opencore-mes-reset.timer \$R/ops/demo/opencore-mes-training.service \$R/ops/demo/opencore-mes-training-reset.service \$R/ops/demo/opencore-mes-training-reset.timer /etc/systemd/system/
    install -m 644 \$R/ops/demo/Caddyfile /etc/caddy/Caddyfile
    # The landing page (opencoremes.com), swapped in whole.
    rm -rf /srv/opencoremes-site.next && cp -r \$R/site /srv/opencoremes-site.next && rm -rf /srv/opencoremes-site.next/src && chmod -R a+rX /srv/opencoremes-site.next
    rm -rf /srv/opencoremes-site.old && { [ -d /srv/opencoremes-site ] && mv /srv/opencoremes-site /srv/opencoremes-site.old || true; } && mv /srv/opencoremes-site.next /srv/opencoremes-site
    systemctl daemon-reload
    # The first release makes the demo database (later ones migrate it at start).
    if ! su -s /bin/sh postgres -c \"psql -lqt\" | cut -d'|' -f1 | grep -qw opencore_mes_demo; then
        su -s /bin/sh opencore -c \"cd \$R && set -a && . ops/demo/demo.env && set +a && node app/mes/db/reset.mjs\"
    fi
    ln -sfn \$R /srv/opencore-mes/current
    systemctl enable --now opencore-mes-reset.timer >/dev/null
    systemctl enable opencore-mes >/dev/null && systemctl restart opencore-mes
    # The training plant (training.env, DESIGN.md §37): its first reset makes its database (and the trainings'
    # reader token, when the trainings are on this host); later releases restart it, and it migrates at start.
    install -d -o opencore -g opencore /var/lib/opencore-mes/training-suites /var/lib/opencore-mes/training-events
    systemctl enable --now opencore-mes-training-reset.timer >/dev/null
    systemctl enable opencore-mes-training >/dev/null
    if ! su -s /bin/sh postgres -c \"psql -lqt\" | cut -d'|' -f1 | grep -qw opencore_mes_training; then
        su -s /bin/sh postgres -c \"createdb -O opencore opencore_mes_training\" && systemctl start opencore-mes-training-reset
    else
        systemctl restart opencore-mes-training
    fi
    systemctl reload caddy
    ls -1dt /srv/opencore-mes/releases/* | tail -n +6 | xargs -r rm -rf
    sleep 3; curl -fsS http://127.0.0.1:3000/healthz | head -c 200; echo
    curl -fsS http://127.0.0.1:3001/healthz | head -c 200; echo
    # The script runner's walls, as it reports them (§12.4): no network of its own, in bubblewrap.
    curl -fsS http://127.0.0.1:3000/healthz | python3 -c 'import json,sys; s=json.load(sys.stdin).get(\"scripts\") or {}; print(\"scripts:\", s); sys.exit(0 if s.get(\"network\")==\"none\" else 1)'"
echo "deployed $STAMP"
