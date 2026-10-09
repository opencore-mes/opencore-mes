# The public demo: demo.opencoremes.com

One small Ubuntu 24.04 server runs the community edition as a **public sandbox**: production mode
with `DEMO=1` (anyone signs in as any demo person, every page says so, services call no outside system,
no AI key), its database reset every night at 03:00 UTC.

| | |
|---|---|
| `provision.sh` | Run once on the server, as root: Node (the latest release), PostgreSQL, Caddy (HTTPS by itself), bubblewrap (the script runner's walls), the `opencore` user and database role. Not the services (`deploy.sh` installs them), the firewall or SSH (`harden.sh`). Safe to run again. For a plant's own server, follow docs/installation/ instead of this folder's scripts as they are. |
| `deploy.sh` | Run here: ships the files git tracks (the landing page in `site/` too) (never `.env`, ignored files or `suites/`; the suites the live demo runs are shipped again unless `SUITES="name …"` names others or `SUITES=none` none, each its repository's files; a live suite not installed here stops the deploy), installs its dependencies, loads the script runner's AppArmor profile (`ops/script-runner-sandbox.apparmor`), runs the tests on the server, switches the release, restarts, checks `/healthz`, and fails unless the script runner reports no network (`scripts.network`, DESIGN.md §12.4). |
| `harden.sh` | Run here, one step at a time (COMPLIANCE.md G13): `status` (changes nothing), `ssh` (keys only), `firewall` (ufw: the SSH port, 80, 443), `fail2ban`, `backups` (`ops/backup/`'s timers, with a key made on the host: copy it off), `reboot` (when an update asks). Each is safe to run again. |
| `opencore-mes.service` | The server: `node app/mes/server.mjs` as `opencore`, on 127.0.0.1:3000, restarted when it stops. |
| `opencore-mes-reset.service`, `.timer` | The nightly reset: stop, `reset.mjs`, start. |
| `Caddyfile` | `demo.opencoremes.com` → 127.0.0.1:3000, and `opencoremes.com` → the landing page (`site/`, static, one small script of its own, `glow.js`), each with its certificate. |
| `training.env`, `opencore-mes-training.service`, `opencore-mes-training-reset.service`, `.timer` | The training plant at plant.trainings.opencoremes.com, beside the trainings (DESIGN.md §37): a second public demo from the same release, on 127.0.0.1:3001, its own database (`opencore_mes_training`), cookie and event log, the seed's own plant (lots, machines: what the courses use), no suite (`SUITES_DIR` an empty folder), a guest of each learner's own with room for a classroom behind one address (`DEMO_GUEST_LIMITS=60/600/3000`) who takes up the roles of what a change makes live (`DEMO_GUESTS_FOLLOW=1`), and framed only by the trainings (`EMBED_ORIGINS`). Reset every night at 03:00 UTC; the reset also issues the trainings' reader token (`design:read`, two days) into `/etc/trainings/plant-token` (0640, root:trainings) when the trainings are on the host. `deploy.sh` installs it and makes its database on the first release. |
| `demo.env` | The server's settings (no secrets). The copilot's provider and key live only on the server, in `/etc/opencore-mes/ai.env` (root:opencore, 0640), read by `opencore-mes.service` after it; without that file the demo has no copilot. `SCRIPT_RUNNER_WRAP=ops/script-runner-sandbox.sh` and `SCRIPT_ISOLATION=required`: scripts run in bubblewrap, with no network, and the server refuses to start otherwise. `SEED_GUEST=1`, `DEMO_AS=guest` and `DEMO_GUESTS=session`: every reset makes the group Guests, holding every role, and a visitor arrives as a guest of their own in it ("Guest 7F3K"; the shared Guest past the limits per address and per hour), so the landing page's links open any screen or design (DESIGN.md §6.9). `SEED_BLANK=1` and `SEED_SUITES=1`: every reset seeds the people and the shipped suites' models, their design packs and sample records (DESIGN.md §29.6), and not the seed's own plant (lots, machines, work orders), which stays the pipeline's test fixture. |

```bash
DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/deploy.sh --provision   # first time
DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/deploy.sh               # every release
DEMO_HOST=<the server> DEMO_PORT=<its SSH port> DEMO_KEY=<your key> ops/demo/deploy.sh --site        # the landing page only
```
On the server: `systemctl status opencore-mes`, `journalctl -u opencore-mes -f`, `systemctl start opencore-mes-reset` (reset now).
