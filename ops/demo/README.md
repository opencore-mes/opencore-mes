# The public demo: demo.opencoremes.com

One small Ubuntu 24.04 server runs the community edition as a **public sandbox**: production mode
with `DEMO=1` (anyone signs in as any demo person, every page says so, services call no outside system,
no AI key), its database reset every night at 03:00 UTC.

| | |
|---|---|
| `provision.sh` | Run once on the server, as root: Node (the latest release), PostgreSQL, Caddy (HTTPS by itself), bubblewrap (the script runner's walls), the `openmes` user and database role, the services. Safe to run again. |
| `deploy.sh` | Run here: ships the files git tracks (the landing page in `site/` too) (never `.env`, ignored files or `suites/`; `SUITES="name …"` ships those installed suites too, each its repository's files), installs its dependencies, loads the script runner's AppArmor profile (`ops/script-runner-sandbox.apparmor`), runs the tests on the server, switches the release, restarts, checks `/healthz`, and fails unless the script runner reports no network (`scripts.network`, DESIGN.md §12.4). |
| `open-mes.service` | The server: `node app/mes/server.mjs` as `openmes`, on 127.0.0.1:3000, restarted when it stops. |
| `open-mes-reset.service`, `.timer` | The nightly reset: stop, `reset.mjs`, start. |
| `Caddyfile` | `demo.opencoremes.com` → 127.0.0.1:3000, and `opencoremes.com` → the landing page (`site/`, static, no scripts), each with its certificate. |
| `demo.env` | The server's settings (no secrets). The copilot's provider and key live only on the server, in `/etc/open-mes/ai.env` (root:openmes, 0640), read by `open-mes.service` after it; without that file the demo has no copilot. `SCRIPT_RUNNER_WRAP=ops/script-runner-sandbox.sh` and `SCRIPT_ISOLATION=required`: scripts run in bubblewrap, with no network, and the server refuses to start otherwise. `SEED_GUEST=1`, `DEMO_AS=guest` and `DEMO_GUESTS=session`: every reset makes the group Guests, holding every role, and a visitor arrives as a guest of their own in it ("Guest 7F3K"; the shared Guest past the limits per address and per hour), so the landing page's links open any screen or design (DESIGN.md §6.9). `SEED_BLANK=1` and `SEED_SUITES=1`: every reset seeds the people and the shipped suites' models, their design packs and sample records (DESIGN.md §29.6), and not the seed's own plant (lots, machines, work orders), which stays the pipeline's test fixture. |

```bash
DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/deploy.sh --provision   # first time
DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/deploy.sh               # every release
DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/deploy.sh --site        # the landing page only
```
On the server: `systemctl status open-mes`, `journalctl -u open-mes -f`, `systemctl start open-mes-reset` (reset now).
