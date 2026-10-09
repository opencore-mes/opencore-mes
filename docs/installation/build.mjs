// OpenCore MES installation procedure, printable: a plant's installation on a Linux server (production),
// a plant folder from npm (a pilot, a small plant), upgrades and going back, suites. Every command is the
// one the scripts in ops/ and app/mes/db/ take today; what no script does yet is said so.
//   node docs/installation/build.mjs          → docs/installation/installation-procedure.html
//   node docs/installation/build.mjs --pdf    → and .pdf (headless Chrome; CHROME=<path> if not on macOS)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printable, code, pre, table, kv, note, h3, cmd, file, undoable } from "../lib/printable.mjs";
import pkg from "../../package.json" with { type: "json" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = "OMES-INS-001";
const REVISION = "D";
const ISSUED = "2026-10-07";
const NAME = "installation-procedure";
const doc = printable();
const { add, h1, h2, proc } = doc;

// npm's global folder of the user's own, before `npm install -g`: with Node from the nodejs.org installer (Mac) or
// Ubuntu's packages, the default one belongs to root and the install fails with EACCES. Given beside each install.
const NPM_FOLDER = [
    ["<b>On a Mac</b>, only if Node came from the nodejs.org installer (Homebrew's Node and nvm need nothing): give npm a folder of your own, so the install below does not fail with <code>EACCES</code>. Once per Mac.", "<code>npm config get prefix</code> then says your <code>~/.npm-global</code>.", ["mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global", "echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.zshrc && source ~/.zshrc"]],
    ["<b>On Linux or Windows (Ubuntu)</b>, only if Node came from Ubuntu's packages (nvm needs nothing): the same, for bash. Once per machine.", "The same.", ["mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global", "echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.bashrc && source ~/.bashrc"]],
];

// ---- 1. before you start ----
add(h1("Before you start", "start"));
add(`<p>This procedure installs OpenCore MES for a plant: the server, its database, its keys, its first
administrator, backups, and the checks before go-live; then laptops, upgrades and suites. Each procedure is a
table of steps with what you should see; tick <b>Done</b> as you go, and keep the signed copy with the
installation's handover.</p>`);
add(`<div class="rules"><b>How to read a step.</b>
<ul>
<li>The words say what to do. The <b>dark box</b> under them holds only commands: one whole command a line,
nothing else. Copy the box (its <b>Copy</b> button) or type it line by line, in the order shown.</li>
<li>Replace what is <span class="ph-sample">&lt;in yellow, between angle brackets&gt;</span> before you run a line
(the brackets go too): <code>&lt;server name&gt;</code> becomes <code>mes.plant.example</code>.</li>
<li>A <b>light box titled File</b> is the content of a file: open the file in an editor (the step's dark box
does), paste it there, save. Never paste a file's content into the terminal.</li>
<li>Where there are two ways (from npm or from the source, a Mac or Windows), each way is a step of its own:
do the one that fits, skip the other.</li>
</ul></div>`);
add(h2("What you install", "what"));
add(`<div class="flow">
<div><b>PostgreSQL</b>: everything the plant keeps (designs, records, the audit trail, sessions), on the same server, reached over the local socket.</div>
<div><b>OpenCore MES</b>: one Node process (<code>app/mes/server.mjs</code>), run by systemd as the user <code>opencore</code>, listening on 127.0.0.1 only. It upgrades its own database at each start.</div>
<div><b>Caddy</b>: HTTPS in front, with a certificate it fetches and renews by itself, and HSTS. The application writes its own Content-Security-Policy.</div>
<div><b>Backups</b>: nightly, encrypted, kept on the server and copied off it; a restore tested every month (<code>ops/backup/</code>).</div>
</div>`);
add(h2("Requirements", "requirements"), table(["", "What", "Notes"], [
    ["Server", "Ubuntu 24.04 LTS, x86-64, root access", "Sized for your plant (the load figures measured so far are in app/mes/README.md); disk for the database, its backups (14 daily and 12 monthly kept by default) and the event log."],
    ["Node.js", `${pkg.engines.node} (the package's <code>engines</code>)`, "<code>ops/demo/provision.sh</code> installs the latest release, checked against its published checksum; pin it with <code>NODE_VERSION</code>."],
    ["PostgreSQL", "16 or later", "The test pipeline runs on 16. Ubuntu 24.04's own package is used."],
    ["Network", "A DNS name for the server; ports 80 and 443 open to the plant's users", "Outbound: your identity provider or directory, the systems your services call (ERP…), Let's Encrypt, the suites registry if you use suites, the AI provider if you use the copilot."],
    ["Browsers", "Safari 15.4, Chrome 93, Firefox 92 or later", "Firefox 114 or later for the rule advice beside a form (older: the server decides at save)."],
    ["Your workstation", "SSH with a key to the server", "Chrome only if you print these documents as PDF."],
    ["A laptop (trying it)", "A Mac on a macOS Homebrew supports, or Windows 10 (2004 or later) or 11 with WSL 2", "Node and PostgreSQL as above, installed per IN-31 or IN-32."],
]));
add(h2("Which way", "which"), table(["", "Linux server (part 2)", "npm plant folder (part 3)", "MacBook or Windows laptop (part 3)"], [
    ["For", "Production: a plant's live system", "A pilot, a small plant", "Trying it, training, a demo, designing offline; never a plant's live system"],
    ["From", "A source archive of the version you install (github.com/opencore-mes/opencore-mes)", `The npm package <code>@opencore-mes/server</code> (a plant folder holds its settings)`, "The npm package, or a source archive"],
    ["Runs as", "systemd, its own user, HTTPS by Caddy, hardened host", "<code>opencore-mes start</code>; production practice is part 2's", "From a terminal, on the laptop only (http://localhost:9090)"],
    ["Backups, audit protection, host hardening", "Scripts in <code>ops/</code>, used as they are", "Not in the package: take <code>ops/</code> from the source archive of the same version", "None: a laptop's data is not backed up by OpenCore MES"],
]));
add(note("Versions. The empty installation (<code>--empty</code>), the first administrator (<code>admin</code>) and the suite commands come with the release this procedure accompanies. The npm package published as <code>0.1.0</code> was built before them: with it, a plant folder or a laptop can try the sample plant (IN-33, way A) only; install from a source archive for the rest, or wait for the next package.", "warn"));
add(h2("Decide first", "decide"));
add(`<p>Write these down before you start; the procedures ask for them.</p>`, table(["", "Decision", "Where it goes"], [
    ["1", "The server's name (e.g. <code>mes.plant.example</code>)", "Caddy, the password links (<code>--url</code>)"],
    ["2", "How people sign in: your identity provider (OpenID Connect), your directory (LDAP or Active Directory), or passwords of OpenCore MES's own with a second factor", "<code>OIDC_*</code>, <code>LDAP_*</code>, <code>MFA</code> ([[see:settings]])"],
    ["3", "The first administrator: their sign-in id, as your directory or identity provider knows them (lower case letters, digits, _ and -: an employee number such as <code>104523</code> works; a dot does not), and their full name", "[[see:p-IN-15]]"],
    ["4", "The first department, which governs the organization (Engineering unless you say otherwise)", "<code>--department</code>"],
    ["5", "The plant's time zone", "<code>PLANT_TZ</code>"],
    ["6", "Where backups are copied off the server (a bucket, another host)", "<code>BACKUP_COPY</code>"],
    ["7", "Where alerts go (a chat channel's or on-call service's incoming webhook)", "<code>ALERT_WEBHOOK_URL</code>"],
    ["8", "Which hosts services may reach (ERP, the identity provider…)", "<code>MES_CONNECTION_HOSTS</code>"],
    ["9", "Who keeps the keys, and where the offline copies are", "[[see:p-IN-13]]"],
    ["10", "The copilot: none, or an AI provider and its key", "<code>AI_PROVIDER</code>"],
]));
add(note("Never copy the public demo's settings (<code>ops/demo/demo.env</code>: <code>DEMO=1</code>, guests, <code>SEED_*</code>) nor its reset timer (<code>opencore-mes-reset.timer</code>, which wipes its database every night) to a plant. Take the steps here, not the demo's deploy script as it is.", "warn"));

// ---- 2. Linux server ----
add(h1("Install on a Linux server", "server"));
add(`<p>Everything below is done on the server, in a root shell (<code>sudo -i</code>), unless a step says
otherwise. The installation's settings are one file, <code>/etc/opencore-mes/opencore-mes.env</code>. Where a step runs
something as the service's user with those settings, it first opens that user's shell (IN-15 shows how), and
closes it after.</p>`);
add(proc({
    id: "IN-10", title: "Prepare the server", who: "IT",
    purpose: "PostgreSQL, Caddy, Node, the system user and its directories, the database role.",
    before: ["A fresh Ubuntu 24.04 server; its DNS name points at it.", "A source archive of the version you install, unpacked on your workstation (it holds <code>ops/</code>)."],
    steps: [
        ["On your workstation, in the unpacked source archive: copy the provisioning script to the server.", "—", ["scp ops/demo/provision.sh root@<server name>:/root/"]],
        ["On the server, run it with the Node version you choose (leave <code>NODE_VERSION</code> out for the latest).", "It installs <code>postgresql caddy curl ca-certificates python3 xz-utils libatomic1 bubblewrap</code>, Node in <code>/opt/node</code> (its checksum checked) with <code>/usr/local/bin/node</code>, the system user <code>opencore</code>, <code>/srv/opencore-mes/releases</code> and <code>/var/lib/opencore-mes/events</code>, the database role <code>opencore</code> (local socket, peer authentication, may create databases) and the role <code>mes_query</code> the query page reads as. It is safe to run again.", ["NODE_VERSION=<v24.11.0> bash /root/provision.sh"]],
        ["Check what it installed.", `Node ${pkg.engines.node.replace(">=", "")} or later; PostgreSQL 16 or later; <code>active</code> twice.`, ["node -v", "sudo -u postgres psql -Atc 'select version()'", "systemctl is-active postgresql caddy"]],
        ["Make the folder for the settings and keys.", "—", ["install -d -m 0750 -o root -g opencore /etc/opencore-mes"]],
    ],
    after: "provision.sh does not install the service, harden the host or set up backups: those are IN-11, IN-14 and IN-18.",
}));
add(proc({
    id: "IN-11", title: "Harden the host", who: "IT",
    purpose: "SSH by key only, a firewall, bans after failed SSH logins, security updates.",
    before: ["You sign in to the server with an SSH key (keep a second session open while you do step 3).", "The variables below are named for the demo; the script is for any such server."],
    steps: [
        ["On your workstation, in the source archive: see where the server stands. Nothing is changed.", "Listening ports, the firewall, SSH's settings, updates, fail2ban, backup timers, time sync.", ["export DEMO_HOST=<server name> DEMO_PORT=<SSH port> DEMO_KEY=<path to your SSH key>", "ops/demo/harden.sh status"]],
        ["Still on your workstation (same terminal): SSH by key only.", "<code>/etc/ssh/sshd_config.d/00-0-opencore-mes.conf</code>: no passwords, root by key only, 3 tries; it checks that your key still signs in.", ["ops/demo/harden.sh ssh"], "Passwords stop working for SSH at once. If your key does not sign in, you are locked out of SSH and need the host's console to get back in: keep the second session open until you have signed in again with the key."],
        ["The firewall.", "ufw: incoming denied but your SSH port, 80 and 443 (TCP, and UDP for HTTP/3).", ["ops/demo/harden.sh firewall"], "Everything not let through is refused at once. If the SSH port you gave is not the one you use, you are locked out and need the host's console."],
        ["Bans after failed SSH logins.", "SSH banned for an hour after 5 failures.", ["ops/demo/harden.sh fail2ban"]],
        ["On the server: Ubuntu's automatic security updates (not done by the script). Answer <b>Yes</b> when asked.", "Security updates install by themselves; <code>harden.sh status</code> reports them.", ["apt-get install -y unattended-upgrades", "dpkg-reconfigure -plow unattended-upgrades"]],
        ["Encrypt the disk or volume that holds <code>/var/lib/postgresql</code> and <code>/var/backups</code>: your host's encrypted volumes, or LUKS when the server is installed.", "Data at rest is encrypted. The product does not do this for you."],
    ],
}));
add(proc({
    id: "IN-12", title: "Install a release", who: "IT",
    purpose: "The application's files, in a release folder that the service runs from.",
    before: ["The source archive copied to the server (e.g. <code>/root/opencore-mes-&lt;version&gt;.tar.gz</code>). Name the release folder yourself: its version and date, e.g. <code>1.0.0-20261006</code>."],
    steps: [
        ["Unpack it as a release folder, owned by the service's user.", "The folder holds <code>app/</code>, <code>ops/</code>, <code>package.json</code>.", ["mkdir /srv/opencore-mes/releases/<build>", "tar -xzf /root/<archive>.tar.gz -C /srv/opencore-mes/releases/<build> --strip-components=1", "chown -R opencore:opencore /srv/opencore-mes/releases/<build>"]],
        ["Install its dependencies.", "<code>node_modules/</code>: the runtime dependencies (the framework, <code>@opencore-mes/juris-kit</code>, among them).", ["cd /srv/opencore-mes/releases/<build>", "sudo -u opencore npm ci --omit=dev --no-audit --no-fund"]],
        ["Let the release name itself (in <code>/healthz</code> and the event log).", "—", ["echo 'BUILD=<build>' > /srv/opencore-mes/releases/<build>/BUILD.env"]],
        ["Make it the release that runs.", "<code>/srv/opencore-mes/current</code> points at it.", ["ln -sfn /srv/opencore-mes/releases/<build> /srv/opencore-mes/current"]],
    ],
}));
add(proc({
    id: "IN-13", title: "Keys and settings", who: "IT, and whoever keeps the keys",
    purpose: "The installation's settings, and the two keys kept outside the database and its backups.",
    steps: [
        ["Make the two keys: <code>seal.key</code> seals the second-factor secrets (AES-256-GCM); <code>integrity.key</code> seals every record for the data integrity review.", "64 hex characters each, readable by root and the service only.", ["openssl rand -hex 32 > /etc/opencore-mes/seal.key", "openssl rand -hex 32 > /etc/opencore-mes/integrity.key", "chown root:opencore /etc/opencore-mes/seal.key /etc/opencore-mes/integrity.key", "chmod 0440 /etc/opencore-mes/seal.key /etc/opencore-mes/integrity.key"], "Only on a new installation. Run again, the first two lines replace the keys: second factors sealed with the old seal key can no longer be read (everyone sets theirs up again), and every integrity seal reads as changed until a reviewer seals everything again."],
        ["Copy both keys off the server, to the place decided (item 9 of [[see:decide]]): a password manager, or a sealed envelope in a safe. Never with the database backups. Show each one to copy it:", "Lost, a sealed second factor cannot be read (people set theirs up again), and the integrity seals must be made again by a reviewer.", ["cat /etc/opencore-mes/seal.key", "cat /etc/opencore-mes/integrity.key"]],
        ["Open the settings file in an editor.", "An empty file opens.", ["nano /etc/opencore-mes/opencore-mes.env"]],
        ["Paste the content below, change it to your decisions, save (Ctrl+O, Enter) and leave (Ctrl+X). Lines starting with # are notes, and stay as they are.", "—", file("/etc/opencore-mes/opencore-mes.env", `# OpenCore MES: this installation's settings. Never in the repository.
PROD=1
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres:///opencore_mes
PGHOST=/var/run/postgresql
PLANT_TZ=<Europe/Paris>
EVENT_LOG_DIR=/var/lib/opencore-mes/events
TRUST_PROXY=1
SEAL_KEY_FILE=/etc/opencore-mes/seal.key
INTEGRITY_KEY_FILE=/etc/opencore-mes/integrity.key
# How people sign in: one or more of these (passwords of its own are on unless PASSWORDS=0).
# OIDC_ISSUER=https://login.plant.example
# OIDC_CLIENT_ID=opencore-mes
# OIDC_CLIENT_SECRET=<secret>
# LDAP_URL=ldaps://dc.plant.example:636
# LDAP_USER_DN={user}@plant.local
MFA=optional
# Scripts walled in (IN-16), and the hosts services may reach.
SCRIPT_RUNNER_WRAP=/srv/opencore-mes/current/ops/script-runner-sandbox.sh
# SCRIPT_ISOLATION=required
MES_CONNECTION_HOSTS=<erp.plant.example,login.plant.example>
# Alerts (IN-19).
# ALERT_WEBHOOK_URL=<https://hooks.example/...>
# The copilot: none unless set.
# AI_PROVIDER=anthropic
# ANTHROPIC_API_KEY=<key>`)],
        ["Let root and the service read it, nobody else.", "—", ["chown root:opencore /etc/opencore-mes/opencore-mes.env", "chmod 0640 /etc/opencore-mes/opencore-mes.env"]],
    ],
}));
add(proc({
    id: "IN-14", title: "The service and HTTPS", who: "IT",
    purpose: "OpenCore MES started by systemd, behind Caddy.",
    steps: [
        ["Open the service's unit file in an editor.", "—", ["nano /etc/systemd/system/opencore-mes.service"]],
        ["Paste the content below (the demo's unit, with the plant's settings file), save and leave.", "—", file("/etc/systemd/system/opencore-mes.service", `[Unit]
Description=OpenCore MES
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
User=opencore
Group=opencore
WorkingDirectory=/srv/opencore-mes/current
EnvironmentFile=/etc/opencore-mes/opencore-mes.env
EnvironmentFile=-/srv/opencore-mes/current/BUILD.env
ExecStart=/usr/local/bin/node app/mes/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/opencore-mes

[Install]
WantedBy=multi-user.target`)],
        ["Open Caddy's configuration in an editor; delete what is in it.", "—", ["nano /etc/caddy/Caddyfile"]],
        ["Paste the content below with your server's name, save and leave.", "—", file("/etc/caddy/Caddyfile", `<mes.plant.example> {
	encode gzip
	reverse_proxy 127.0.0.1:3000
	header Strict-Transport-Security "max-age=31536000"
}`)],
        ["Check it and load it.", "<code>Valid configuration</code>. Caddy fetches the certificate by itself, and renews it.", ["caddy validate --config /etc/caddy/Caddyfile", "systemctl reload caddy"]],
        ["Do not start the service yet: the database comes first (IN-15).", "—"],
    ],
}));
add(proc({
    id: "IN-15", title: "The database and the first administrator", who: "IT",
    purpose: "An empty database, and the one person who sets up the rest.",
    steps: [
        ["Open a shell as the service's user.", "The prompt changes to <code>opencore@…</code>.", ["sudo -u opencore bash"]],
        ["In that shell: load the settings and go to the release.", "—", ["set -a; . /etc/opencore-mes/opencore-mes.env; set +a", "cd /srv/opencore-mes/current"]],
        ["Make the empty database.", "<code>database opencore_mes: empty (the platform's built-ins only, nobody in it)</code>. Nobody can sign in yet.", ["node app/mes/db/reset.mjs --empty"], "It makes the database again: everything in it is lost, with no backup made first. Only on a new installation; it refuses a database whose audit trail is protected."],
        ["Name the first administrator: their sign-in id, their full name in quotes, and the server's address.", "<code>&lt;Name&gt; (&lt;id&gt;) is the first administrator: designer and reviewer, sign-in administrator, approver for Engineering, which governs the organization.</code> <code>Setup is open: …</code> and a one-time link to set their password, for 3 days (<code>PASSWORD_LINK_DAYS</code>, or <code>--days</code> up to 14).", ['node app/mes/db/admin.mjs <id> "<Full name>" --url https://<server name>'], "It runs once per installation: refused once anybody is in People & departments. Check the sign-in id and the name before you press Enter; afterwards they are changed only through a change in People & departments."],
        ["Only if they sign in through your identity provider or directory, instead of the line above: the same without a password link (their id must be theirs there).", "The same, without a link.", ['node app/mes/db/admin.mjs <id> "<Full name>" --no-password'], "The same: once per installation. Check the sign-in id and the name first."],
        ["Leave the service user's shell.", "Back to root's prompt.", ["exit"]],
        ["Give the link to that person only.", "Whoever opens it first sets the password."],
        ["Start the service, and make it start with the server.", "<code>active</code>. The journal says what migrated and where it listens.", ["systemctl daemon-reload", "systemctl enable --now opencore-mes", "systemctl is-active opencore-mes"]],
        ["Ask it how it is.", "<code>\"ok\":true</code>, the build, <code>db</code> up, <code>audit</code> ok, <code>scripts</code>.", ["curl -fsS http://127.0.0.1:3000/healthz"]],
        ["Open <code>https://&lt;server name&gt;/</code> in a browser.", "The sign-in page, over HTTPS."],
    ],
    after: note("Never run <code>reset.mjs</code> on a database in use: it makes the database again, and everything in it is lost. It refuses a database whose audit trail is protected (IN-17).", "warn"),
}));
add(proc({
    id: "IN-16", title: "Wall the script runner in", who: "IT",
    purpose: "Rule and service scripts run with no network and no files of the host's: the operating system's walls, not only Node's.",
    steps: [
        ["Install the AppArmor profile that lets bubblewrap make its walls (Ubuntu 23.10 and later).", "—", ["install -m 0644 /srv/opencore-mes/current/ops/script-runner-sandbox.apparmor /etc/apparmor.d/opencore-mes-bwrap", "apparmor_parser -r /etc/apparmor.d/opencore-mes-bwrap"]],
        ["Restart, and ask it how its scripts run.", "<code>\"scripts\":{\"network\":\"none\",\"sandbox\":\"bwrap\",…}</code>", ["systemctl restart opencore-mes", "curl -fsS http://127.0.0.1:3000/healthz"]],
        ["Open the settings file, and remove the <code>#</code> before <code>SCRIPT_ISOLATION=required</code>; save and leave.", "—", ["nano /etc/opencore-mes/opencore-mes.env"]],
        ["Restart.", "From now on the service refuses to start without its walls, rather than run scripts outside them.", ["systemctl restart opencore-mes"]],
    ],
}));
add(proc({
    id: "IN-17", title: "Protect the audit trail", who: "A database administrator",
    purpose: "The audit trail out of the application's own reach: it may add to it and read it, never change or remove it.",
    steps: [
        ["Run the protection script as the database's owner.", "The trail moves to the schema <code>audit</code>, owned by <code>mes_audit</code>; the application keeps <code>SELECT, INSERT</code>.", ["sudo -u postgres psql -v app=opencore -d opencore_mes -f /srv/opencore-mes/current/ops/db/protect-audit.sql"], "On purpose: from then on the application can never change or remove the audit trail, and reset.mjs refuses this database. Run it on the live database only, once the installation is in use."],
        ["Restart, and check the trail.", "<code>\"audit\":{\"ok\":true,…}</code>", ["systemctl restart opencore-mes", "curl -fsS http://127.0.0.1:3000/healthz"]],
    ],
    after: "Run it again after an upgrade whose migration adds a column to the trail; such a migration fails at start on a protected database until a database administrator runs it as postgres (<code>ops/db/README.md</code>).",
}));
add(proc({
    id: "IN-18", title: "Backups and the restore test", who: "IT",
    purpose: "Nightly encrypted backups, copied off the server, and a monthly restore that proves them.",
    steps: [
        ["Make the backup key, readable by root only; copy it off the server with the other keys.", "Without it, a backup cannot be read.", ["openssl rand -base64 48 > /etc/opencore-mes/backup.key", "chown root:root /etc/opencore-mes/backup.key", "chmod 0400 /etc/opencore-mes/backup.key", "cat /etc/opencore-mes/backup.key"], "Only once. Run again, the first line replaces the key, and every backup made with the old one can no longer be read: keep the old key as long as its backups."],
        ["Open the backup settings in an editor.", "—", ["nano /etc/opencore-mes/backup.env"]],
        ["Paste the content below, with where backups are copied (any command; <code>{}</code> stands for the file), save and leave.", "—", file("/etc/opencore-mes/backup.env", `BACKUP_DATABASES="postgres:///opencore_mes"
BACKUP_DIR=/var/backups/opencore-mes
BACKUP_COPY="rclone copy {} <remote>:<path>/"`)],
        ["Install the backup timers.", "Backups nightly at 02:30 UTC; the restore test on the 1st of each month at 04:00 UTC.", ["chmod 0640 /etc/opencore-mes/backup.env", "install -d -m 0700 -o postgres -g postgres /var/backups/opencore-mes", "install -m 644 /srv/opencore-mes/current/ops/backup/opencore-mes-backup.service /srv/opencore-mes/current/ops/backup/opencore-mes-backup.timer /etc/systemd/system/", "install -m 644 /srv/opencore-mes/current/ops/backup/opencore-mes-restore-test.service /srv/opencore-mes/current/ops/backup/opencore-mes-restore-test.timer /etc/systemd/system/", "systemctl daemon-reload", "systemctl enable --now opencore-mes-backup.timer opencore-mes-restore-test.timer"]],
        ["Make a backup now.", "<code>opencore_mes-&lt;stamp&gt;.dump.enc</code> and its <code>.sha256</code>; copied where <code>BACKUP_COPY</code> says.", ["systemctl start opencore-mes-backup.service", "ls -lh /var/backups/opencore-mes"]],
        ["Test a restore now.", "<code>restore test:</code> the backup restored into a scratch database, its audit chain verified, then dropped. Keep this output: it is the evidence an auditor asks for.", ["systemctl start opencore-mes-restore-test.service", "journalctl -u opencore-mes-restore-test --since -5min -o cat"]],
    ],
    after: note("These are nightly backups: a failure loses up to a day. Continuous WAL archiving (pgBackRest or WAL-G) is not set up by these scripts; add it if the plant needs less. Restoring for real: [[see:p-IN-42]].", "warn") + "<p><code>harden.sh backups</code>, from your workstation, does steps 1 to 6 in one go (it backs up every database on the server but test and scratch ones).</p>",
}));
add(proc({
    id: "IN-19", title: "Alerts and monitoring", who: "IT",
    purpose: "Hear about it when something breaks.",
    steps: [
        ["Open the settings file; remove the <code>#</code> before <code>ALERT_WEBHOOK_URL</code> and give your webhook's address; save and leave. (<code>ALERT_MIN_SEVERITY</code> is <code>error</code> unless set.)", "—", ["nano /etc/opencore-mes/opencore-mes.env"]],
        ["Restart.", "Each event at or above it is posted as <code>{ text, event }</code>, the same kind at most once in ten minutes: the database down, the audit chain broken, data changed outside the platform, a crash.", ["systemctl restart opencore-mes"]],
        ["Set an uptime check from outside, every minute, on <code>https://&lt;server name&gt;/healthz</code>, alerting on anything but 200, and when <code>scripts.network</code> is not <code>none</code>.", "—"],
        ["Ship the journal off the server (your log platform), and watch for failed units (a failed backup fails its unit).", "Nothing listed.", ["systemctl --failed"]],
    ],
}));
add(proc({
    id: "IN-20", title: "First sign-in, and setting the plant up", who: "The first administrator",
    purpose: "The plant's people, departments and roles, then the end of setup.",
    steps: [
        ["Open the link from IN-15 and set a password (12 characters or more), or sign in through your identity provider.", "The designer, with a banner: <b>Setup is open</b>."],
        ["Design → People & departments: start a change; add the people, departments and their approval steps, and the roles. Submit it with <b>Execute now (setup)</b>, signing it.", "It executes at once, marked <b>setup</b>. Every such change is in the audit trail with your signature."],
        ["Optional: what the sign-in page calls the id (a Windows user name, an employee number), the hint in its box (<code>PLANT\\username</code>), and the plant's domains a typed id may carry: People & departments → <b>Sign-in</b>, in the same change or another, executed the same way.", "The sign-in page shows that label and hint; <code>PLANT\\jdoe</code> or <code>jdoe@plant.local</code> signs in as <code>jdoe</code>."],
        ["Everyone's first password, for people who sign in with a password here: Design → Sign-in administration → <b>Setup codes for people with no password yet</b>. Choose a department (or everyone) and how many days the codes last, then <b>Make codes and download</b>.", "A CSV file: each person's id, name, departments, a code of five capital letters, until when it works, and the address to open. Print the slips (or a mail merge), hand each to its person, then delete the file: it holds the codes."],
        ["Each person opens the sign-in page, clicks <b>I have a setup code</b>, and types their sign-in id, the code and a new password twice.", "Their password is set; the code works once. Making codes again for the same people stops the earlier ones."],
        ["Only where the plant also signs people in through its directory (Active Directory, LDAP): someone with a password here who has an account there moves to it from <b>Your password</b> (their name, top right): their directory password, then <b>Switch to</b> the directory.", "Their password here is taken off; they sign in with the directory's from then on."],
        ["Choose the plant's approval level on the same tab: <b>Full</b> (a reviewer, then each department: a regulated plant keeps it), <b>One approval</b> (one approver of a department it touches signs, and it executes) or <b>None</b> (each designer signs their own changes, for a plant with nobody else to ask). Then, when the level's people are there (Full: someone besides the designers who can review; One: an approver of governance besides each designer), clear <b>Setup is open</b> in the same change; execute it the same way.", "From then on every change is reviewed and approved. The change says what is still missing if it cannot end yet.", null, "Not on one signature any more: opening setup again later is a change that governance reviews and approves."],
        ["Note in the handover that the installation was set up this way, and that the changes made in setup (Designer → Changes → <b>Setup</b>) are covered by the plant's validation.", "—"],
    ],
    after: "The user guide (USERGUIDES.md) is for the people who design the plant from here.",
}));
add(proc({
    id: "IN-21", title: "Before go-live", who: "IT and the plant's quality or validation lead",
    purpose: "The installation as it should be, checked and signed.",
    steps: [
        ["Ask the service how it is.", "<code>ok</code> true; <code>db</code> up; <code>audit.ok</code> true; <code>scripts.network</code> <code>none</code>; the build you installed.", ["curl -fsS http://127.0.0.1:3000/healthz"]],
        ["Run the test pipeline on the server, against a test database (never the live one), as the service's user.", "<code>all … stages passed</code>. It makes and drops its own test databases; the name it is given must contain \"test\", so the live database is safe.", ["cd /srv/opencore-mes/current", "sudo -u opencore env PGHOST=/var/run/postgresql TEST_DATABASE_URL=postgres:///opencore_mes_test EVENT_LOG_DIR=/var/lib/opencore-mes/test-events npm run test:all"]],
        ["From your workstation (the variables of IN-11 set): where the server stands.", "Only your SSH port, 80 and 443 listen from outside; SSH by key; updates on; fail2ban; backup and restore-test timers active; time in sync.", ["ops/demo/harden.sh status"]],
        ["The keys (seal, integrity, backup) are copied off the server, and the backup key is not stored with the backups.", "—"],
        ["The latest restore test passed (IN-18 step 6).", "—"],
        ["Setup has ended (IN-20 step 3), unless the plant decided otherwise and wrote why.", "Design → People & departments → Approvals: <b>Setup is open</b> not ticked."],
        ["None of the demo's settings or timers are present.", "No <code>DEMO</code> or <code>SEED_</code> line; only the backup and restore-test timers.", ["grep -E 'DEMO|SEED_' /etc/opencore-mes/opencore-mes.env", "systemctl list-timers | grep opencore-mes"]],
        ["Sign-in policy as decided: <code>MFA</code>, password expiry (<code>PASSWORD_MAX_DAYS</code>), idle sign-out (<code>SESSION_IDLE_MINUTES</code>).", "—"],
    ],
}));

// ---- 3. npm, laptops ----
add(h1("A plant folder, a MacBook, a Windows laptop", "npm"));
add(`<p>The npm package is the application, ready to run; a <b>plant folder</b> holds an installation's settings
(<code>.env</code>), its suites and its event log, outside the package. Use it for a pilot or a small plant.
For production, run it as part 2 does (systemd, its own user, Caddy, backups, hardening).</p>`);
add(proc({
    id: "IN-30", title: "Install from npm", who: "IT",
    purpose: "OpenCore MES from its npm package, in a plant folder.",
    before: ["Node 24 or later; PostgreSQL 16 or later, with a role that may create databases, reached over the local socket or <code>DATABASE_URL</code>."],
    steps: [
        ...NPM_FOLDER,
        ["Install the package.", "<code>opencore-mes version</code> answers.", ["npm install -g @opencore-mes/server", "opencore-mes version"]],
        ["Make a plant folder, and go into it.", "<code>.env</code> (mode 0600: the settings, commented), <code>suites/</code>, <code>.local/</code>.", ["opencore-mes init my-plant", "cd my-plant"]],
        ["Open <code>.env</code> in an editor and set <code>DATABASE_URL</code> (<code>postgres:///opencore_mes</code> unless changed), <code>PROD=1</code>, how people sign in, <code>PLANT_TZ</code>, and <code>SEAL_KEY_FILE</code> and <code>INTEGRITY_KEY_FILE</code> (keys made as in IN-13, kept outside the folder); save and leave.", "—", ["nano .env"]],
        ["Make the empty database.", "An empty database.", ["opencore-mes db reset --yes --empty"], "It makes the database named in .env again: everything in it is lost. Check DATABASE_URL in .env names a new database."],
        ["Name the first administrator.", "The first administrator, a one-time link, setup open (as IN-15).", ['opencore-mes admin <id> "<Full name>" --url https://<server name>'], "Once per installation: check the sign-in id and the name first."],
        ["Start it, from inside the folder.", "<code>listening on …</code>; the sign-in page at the address.", ["opencore-mes start"]],
        ["For scripts walled in (Linux): see where the package is, then set <code>SCRIPT_RUNNER_WRAP</code> in <code>.env</code> to <code>&lt;that folder&gt;/@opencore-mes/server/ops/script-runner-sandbox.sh</code> (an absolute path), and install its AppArmor profile beside it as in IN-16.", "<code>/healthz</code>: <code>\"network\":\"none\"</code>.", ["npm root -g"]],
    ],
    after: note("The package holds the application and the script runner's walls only. Backups, the audit trail's protection and host hardening are in <code>ops/</code> of the source archive of the same version: use them as in IN-11, IN-17 and IN-18, with this folder's database.", "warn"),
}));
add(h2("On a laptop", "laptops"));
add(`<p>A laptop runs the same OpenCore MES, for trying it, training, a demo or designing offline. It is never a
plant's live system: nothing backs its data up, it sleeps when its lid closes, and nobody else should reach
it. Prepare the laptop (IN-31 on a Mac, IN-32 on Windows), then IN-33.</p>`);
add(proc({
    id: "IN-31", title: "Prepare a MacBook", who: "Whoever uses the laptop",
    purpose: "Node and PostgreSQL on macOS (Apple silicon or Intel), in Terminal.",
    before: ["A macOS that Homebrew supports; an administrator's account; <a href=\"https://brew.sh\">Homebrew</a> installed (it prints the line that adds it to your PATH: run it)."],
    steps: [
        ["Node 24 or later, from the macOS installer at nodejs.org (LTS), or from Homebrew. Then, in a new Terminal window, check it.", `<code>v24.…</code> or later (${pkg.engines.node}).`, ["node -v"]],
        ["Only if Node came from the nodejs.org installer: give npm a global folder of your own. Otherwise installing a package for every user fails with <code>EACCES</code> on <code>/usr/local/lib/node_modules</code>; never work around it with sudo.", "Your <code>~/.npm-global</code>.", ["mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global", "echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.zshrc && source ~/.zshrc", "npm config get prefix"]],
        ["PostgreSQL, started now and with the Mac.", "<code>Successfully started postgresql@17</code>.", ["brew install postgresql@17", "brew services start postgresql@17"]],
        ["Check that PostgreSQL lets you in. (If <code>psql</code> is not found, the next step.)", "Your macOS user name: Homebrew's PostgreSQL lets you in as yourself, over its local socket, as a superuser. So <code>postgres:///&lt;database&gt;</code> needs no password here.", ["psql -d postgres -c 'select current_user'"]],
        ["Only if <code>psql</code> was not found: see where Homebrew put PostgreSQL, add the <code>bin</code> folder it names to your PATH as it says, open a new Terminal, and do the step before again.", "The folder, and the line to add.", ["brew info postgresql@17"]],
    ],
    after: "The script runner's operating-system walls are Linux's (bubblewrap): on a Mac scripts run inside Node's own permission model only, and <code>/healthz</code> says so. That is fine on a laptop; never set <code>SCRIPT_ISOLATION=required</code> there.",
}));
add(proc({
    id: "IN-32", title: "Prepare a Windows laptop", who: "Whoever uses the laptop",
    purpose: "OpenCore MES on Windows 10 or 11, inside WSL 2 (Ubuntu running inside Windows): everything then runs on Linux, as on a server.",
    before: ["Windows 10 (version 2004 or later) or Windows 11; an administrator's account; virtualisation on in the firmware (it is on most laptops)."],
    steps: [
        ["In PowerShell, opened as administrator: install Ubuntu in WSL. Restart Windows when asked.", "Ubuntu opens and asks for a Linux user name and password (your own, for this laptop).", ["wsl --install -d Ubuntu-24.04"]],
        ["From here on, in Ubuntu (Start → Ubuntu): PostgreSQL, and bubblewrap for the script runner's walls.", "PostgreSQL 16 installed.", ["sudo apt-get update", "sudo apt-get install -y postgresql bubblewrap"]],
        ["Start PostgreSQL, and let your Linux user in (a superuser, on a laptop only).", "<code>CREATE ROLE</code>: <code>postgres:///&lt;database&gt;</code> needs no password for you.", ["sudo service postgresql start", "sudo -u postgres createuser --superuser \"$USER\""]],
        ["Node 24 or later in Ubuntu: from nodejs.org (Download → Linux, with a version manager such as nvm). Then check it.", `<code>v24.…</code> or later (${pkg.engines.node}).`, ["node -v"]],
        ["Only if Node came another way (Ubuntu's packages, a tarball in <code>/usr</code>): give npm a global folder of your own. Otherwise installing a package for every user fails with <code>EACCES</code>. With nvm, skip this step.", "Your <code>~/.npm-global</code>.", ["mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global", "echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.bashrc && source ~/.bashrc", "npm config get prefix"]],
        ["Each time Windows restarts, in Ubuntu, before starting OpenCore MES:", "—", ["sudo service postgresql start"]],
    ],
    after: "Work inside Ubuntu's own folders (<code>~</code>), not on <code>/mnt/c</code>: it is much faster. Open the address it prints in a browser on Windows: WSL passes <code>localhost</code> through. If it does not open, set <code>HOST=0.0.0.0</code> in the settings: WSL's network stays inside the laptop unless you forward it, but never leave the sample people's picker on a network others reach. OpenCore MES on Windows outside WSL is not tested.",
}));
add(proc({
    id: "IN-33", title: "Install and run it on a laptop", who: "Whoever uses the laptop",
    purpose: "OpenCore MES running on the laptop: the sample plant to try it (way A), or an empty plant of your own (way B). From npm, or from a source archive: do the steps for one, skip the other's.",
    before: ["IN-31 or IN-32 done. In Terminal (Mac) or Ubuntu (Windows)."],
    steps: [
        ...NPM_FOLDER.map(([a, b, c]) => [`<b>From npm</b>. ${a}`, b, c]),
        ["<b>From npm</b>: install the package, make a plant folder, go into it.", "A plant folder with its <code>.env</code>.", ["npm install -g @opencore-mes/server", "opencore-mes init my-plant", "cd my-plant"]],
        ["<b>From npm, way A</b> (the sample plant): make the database with the sample people (Dana, Iris, Sam…) and plant (lots, machines, work orders).", "It says what it loaded.", ["opencore-mes db reset --yes"], "It makes the database named in .env again: everything in it is lost. On a laptop's own new database only."],
        ["<b>From npm, way B</b> (a plant of your own): the empty database, and its first administrator.", "The first administrator, and a one-time link to set their password; setup open.", ["opencore-mes db reset --yes --empty", 'opencore-mes admin <id> "<Full name>" --url http://localhost:9090'], "The first line makes the database again (everything in it is lost); the second runs once per installation: check the id and name first."],
        ["<b>From npm</b>: start it. For way B add <code>PROD=1</code> to <code>.env</code> first, for the real sign-in page.", "<code>… listening on http://127.0.0.1:9090 …</code>", ["opencore-mes start"]],
        ["<b>From a source archive</b>: get the source and its dependencies.", "The source, with its three dependencies.", ["git clone https://github.com/opencore-mes/opencore-mes.git", "cd opencore-mes", "npm ci"]],
        ["<b>From source, way A</b>: the database with the sample plant.", "It says what it loaded.", ["DATABASE_URL=postgres:///opencore_mes node app/mes/db/reset.mjs"], "It makes the database opencore_mes again: everything in it is lost."],
        ["<b>From source, way B</b>: the empty database, and its first administrator.", "The first administrator, and a one-time link to set their password; setup open.", ["DATABASE_URL=postgres:///opencore_mes node app/mes/db/reset.mjs --empty", 'DATABASE_URL=postgres:///opencore_mes node app/mes/db/admin.mjs <id> "<Full name>" --url http://localhost:9090'], "The first line makes the database again (everything in it is lost); the second runs once per installation: check the id and name first."],
        ["<b>From source, way A</b>: start it, on this laptop only.", "<code>… listening on http://127.0.0.1:9090 (development …)</code>", ["HOST=127.0.0.1 DATABASE_URL=postgres:///opencore_mes node app/mes/server.mjs"]],
        ["<b>From source, way B</b>: start it, on this laptop only, with the real sign-in page.", "<code>… listening on http://127.0.0.1:9090 (production …)</code>", ["HOST=127.0.0.1 PROD=1 DATABASE_URL=postgres:///opencore_mes node app/mes/server.mjs"]],
        ["Open http://localhost:9090. Way A: pick who you are. Way B: open the password link first. With <code>PROD=1</code> over plain <code>http://localhost</code>, use Chrome, Edge or Firefox: the sign-in cookie is marked Secure, which they accept on localhost.", "Way A: the people to pick from (no passwords: a development instance). Way B: the sign-in page."],
        ["To stop it: Ctrl+C in the terminal where it runs. To start again: the start step above.", "—"],
    ],
    after: `<p>To remove it, the database, then the folder; and, if nothing else uses them, the package and PostgreSQL (on Windows, unregistering Ubuntu removes the whole Ubuntu, everything in it included):</p>${cmd(["dropdb opencore_mes"])}${undoable("The database and everything in it are deleted.")}${cmd(["npm uninstall -g @opencore-mes/server"])}${cmd(["brew services stop postgresql@17", "brew uninstall postgresql@17"])}<p>On Windows, in PowerShell:</p>${cmd(["wsl --unregister Ubuntu-24.04"])}${undoable("The whole Ubuntu is deleted: OpenCore MES, its database, and every other file in it.")}`
        + note("A development instance (without <code>PROD=1</code>) lets anyone who reaches it sign in as anyone. Keep it on 127.0.0.1 on a laptop: the plant folder's <code>.env</code> says so already; from source, <code>HOST=127.0.0.1</code> as in the start steps. It warns at start when it is reachable from other machines.", "warn"),
}));

// ---- 4. upgrades ----
add(h1("Upgrades", "upgrades"));
add(`<p>A release changes the application; the plant's designs live in its database and change only
through change requests, so an upgrade leaves them as they are. The database upgrades itself: at each start,
every new or changed migration runs, in order, under one lock (several instances starting together run each
once). Migrations go forward only.</p>`);
add(proc({
    id: "IN-40", title: "Upgrade a server", who: "IT",
    purpose: "A new release, with its database changes, and a way back.",
    before: ["The release notes read: anything to do by hand is said there.", "A time agreed with the plant: the service restarts."],
    steps: [
        ["Make a backup now, and note its file name: it is the way back (IN-42).", "The newest <code>opencore_mes-&lt;stamp&gt;.dump.enc</code>.", ["systemctl start opencore-mes-backup.service", "ls -lt /var/backups/opencore-mes | head -3"]],
        ["Install the new release beside the current one: IN-12 steps 1 to 3, with its own folder name (not step 4 yet).", "—"],
        ["Optionally, the test pipeline in the new release (IN-21 step 2, in its folder).", "<code>all … stages passed</code>."],
        ["Switch to it, and restart.", "—", ["ln -sfn /srv/opencore-mes/releases/<new build> /srv/opencore-mes/current", "systemctl restart opencore-mes"], "Once it has started, the new release's migrations have changed the database, and they go forward only: the previous release cannot run on it again. The way back is the backup of step 1 (IN-42)."],
        ["See what migrated, and ask it how it is.", "<code>database: applied …</code> for each migration (the event <code>db.migrated</code> names them); <code>ok</code> true; the new build.", ["journalctl -u opencore-mes -n 50 -o cat", "curl -fsS http://127.0.0.1:3000/healthz"]],
        ["If the trail is protected and the release notes say a migration changes it: run that migration and the protection script as postgres (IN-17).", "—"],
        ["The first upgrade to a release with the data integrity review: an integrity reviewer opens Design → Data integrity and signs <b>Take the baseline</b>.", "From then on a change made around the platform is found."],
        ["Keep the last few releases in <code>/srv/opencore-mes/releases</code>; remove older ones.", "—"],
    ],
}));
add(proc({
    id: "IN-41", title: "Upgrade a plant folder (npm)", who: "IT",
    purpose: "A new version of the npm package.",
    steps: [
        ["Make a backup first (IN-18 step 5, or <code>backup.sh</code> by hand), and stop the server (Ctrl+C, or its service).", "—"],
        ["Install the new version.", "The new version.", ["npm install -g @opencore-mes/server@<version>", "opencore-mes version"]],
        ["From inside the plant folder: bring the database up to date (or let the start do it).", "What migrated, or <code>database: up to date</code>.", ["opencore-mes db migrate"], "The database's changes go forward only: the previous version cannot run on it again. The way back is the backup of step 1."],
        ["Start it.", "<code>listening on …</code>; <code>/healthz</code> answers.", ["opencore-mes start"]],
    ],
}));
add(proc({
    id: "IN-42", title: "Going back after a bad upgrade, or restoring a backup", who: "IT, with the plant's agreement",
    purpose: "The previous release running again, on the data as it was before the upgrade.",
    steps: [
        ["If the new release never started (its migrations did not run): point <code>current</code> back at the previous release, and restart. Then stop here.", "The previous build in <code>/healthz</code>.", ["ln -sfn /srv/opencore-mes/releases/<previous build> /srv/opencore-mes/current", "systemctl restart opencore-mes"]],
        ["Otherwise its migrations have changed the database, and the previous release cannot be pointed at it. Stop the service.", "—", ["systemctl stop opencore-mes"]],
        ["Give the service's user the backup taken before the upgrade, its checksum and the key, for the restore only.", "—", ["install -d -m 0700 -o opencore /var/lib/opencore-mes/restore", "install -m 0400 -o opencore /var/backups/opencore-mes/<file>.dump.enc /var/backups/opencore-mes/<file>.dump.enc.sha256 /etc/opencore-mes/backup.key /var/lib/opencore-mes/restore/"]],
        ["Restore it into a new database, as the service's user (so the service owns it, as it owned the old one); then remove the copies.", "Checksum checked, restored, and its audit chain verified (<code>verify-audit.mjs --full</code>). It refuses a target that exists.", ["cd /srv/opencore-mes/current", "sudo -u opencore env PGHOST=/var/run/postgresql BACKUP_KEY=/var/lib/opencore-mes/restore/backup.key TARGET_URL=postgres:///opencore_mes_<date> ops/backup/restore.sh /var/lib/opencore-mes/restore/<file>.dump.enc", "rm -rf /var/lib/opencore-mes/restore"], "The last line removes only the copies made in step 3; the backups in /var/backups stay."],
        ["Open the settings file and point <code>DATABASE_URL</code> at <code>postgres:///opencore_mes_&lt;date&gt;</code>; save and leave.", "—", ["nano /etc/opencore-mes/opencore-mes.env"]],
        ["Point <code>current</code> at the previous release, and start.", "The previous build, on the data of the backup.", ["ln -sfn /srv/opencore-mes/releases/<previous build> /srv/opencore-mes/current", "systemctl start opencore-mes"], "Everything recorded after the backup was taken is not in the restored database. Keep the upgraded database aside: it is the only place those records remain."],
        ["Tell the plant what is lost: everything recorded between the backup and the stop. Run the protection script on the restored database (IN-17, with its name), and keep the upgraded database aside until it is no longer needed.", "—"],
    ],
    after: note("There is no rollback command: going back is this procedure. A backup before every upgrade is what makes it possible.", "warn"),
}));

// ---- 5. suites ----
add(h1("Suites", "suites"));
add(`<p>A suite is an npm package (<code>@opencore-suites/&lt;name&gt;</code>) that adds designs, blocks, steps or
equipment adapters, from the suites registry, with your licence token. The core works the same with any suite
removed: what a suite leaves stays inert and labelled, never deleted, and works again once it is reinstalled;
every version an installation ran is kept. (The suites store is not open yet.)</p>`);
add(proc({
    id: "IN-50", title: "Install, update, remove a suite (a plant folder)", who: "IT",
    purpose: "A suite in an installation, and every version it ran kept.",
    before: ["A licence token for the suites registry (or the suite's <code>.tgz</code> for a plant without internet access).", "In the plant folder (on a server, IN-51 first)."],
    steps: [
        ["Sign in to the registry; paste the token when asked (it is not shown).", "The token is kept in <code>.local/suites/.npmrc</code> (mode 0600), for this installation only.", ["opencore-mes suite login"]],
        ["Install the suite.", "<code>&lt;name&gt; &lt;version&gt; installed in suites/&lt;name&gt;</code>.", ["opencore-mes suite install <name>"]],
        ["Without internet access, instead: install it from its file.", "The same.", ["opencore-mes suite install <name> --from <file>.tgz"]],
        ["Restart OpenCore MES.", "The suite's migrations run; it is listed in the designer, and its designs can be started from it."],
        ["Later, to see, update, remove, or go back to a kept version (restart after each):", "A replaced or removed version is kept in <code>suites/.versions/</code>, never deleted; <code>use</code> puts one back.", ["opencore-mes suite list", "opencore-mes suite update <name>", "opencore-mes suite remove <name>", "opencore-mes suite use <name>@<version>"]],
    ],
}));
add(proc({
    id: "IN-51", title: "Suites on a server", who: "IT",
    purpose: "The suite commands on a server installed as part 2, with the suites kept outside the releases.",
    steps: [
        ["Open the settings file and add <code>SUITES_DIR=/var/lib/opencore-mes/suites</code>; save and leave.", "—", ["nano /etc/opencore-mes/opencore-mes.env"]],
        ["Open a shell as the service's user, in its data folder.", "The prompt changes to <code>opencore@…</code>.", ["sudo -u opencore bash"]],
        ["In that shell: load the settings, and go to the data folder.", "—", ["set -a; . /etc/opencore-mes/opencore-mes.env; set +a", "cd /var/lib/opencore-mes"]],
        ["In that shell, run the suite commands of IN-50, with the command's full path in front instead of opencore-mes, as here:", "As in IN-50.", ["node /srv/opencore-mes/current/app/mes/cli.mjs suite login", "node /srv/opencore-mes/current/app/mes/cli.mjs suite install <name>"]],
        ["Leave the shell, and restart the service.", "—", ["exit", "systemctl restart opencore-mes"]],
    ],
}));

// ---- 6. reference ----
add(h1("Reference", "reference"));
add(h2("Settings", "settings"), table(["Setting", "Default", "What"], [
    ["<code>PROD=1</code>", "off", "Production: no sign-in picker, Secure cookies, a snapshot of the pages."],
    ["<code>HOST</code>, <code>PORT</code>", "0.0.0.0, 9090", "Where it listens: 127.0.0.1 behind Caddy."],
    ["<code>DATABASE_URL</code>, <code>PGHOST</code>", "development's own: always set it", "The database (a plant's: <code>postgres:///opencore_mes</code>); <code>PGHOST</code> the socket's folder."],
    ["<code>PLANT_TZ</code>", "the server's", "The time zone of schedules that name none."],
    ["<code>EVENT_LOG_DIR</code>", ".local/events", "Where the event log file is written."],
    ["<code>TRUST_PROXY</code>", "unset", "How many proxies are in front (1 behind Caddy), so the client's address is the real one."],
    ["<code>SEAL_KEY_FILE</code>, <code>INTEGRITY_KEY_FILE</code>", "none", "The two keys (IN-13), or <code>SEAL_KEY</code>, <code>INTEGRITY_KEY</code> themselves."],
    ["<code>INTEGRITY_FULL_HOURS</code>", "168", "How often the integrity scan reads every record."],
    ["<code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, <code>OIDC_CLIENT_SECRET</code>, <code>OIDC_CLAIM</code>, <code>OIDC_LABEL</code>", "—", "Single sign-on. The redirect address is <code>https://&lt;server&gt;/login/sso/callback</code>; the claim is the sign-in id (<code>preferred_username</code> unless set)."],
    ["<code>LDAP_URL</code>, <code>LDAP_USER_DN</code>, <code>LDAP_CA_FILE</code>, <code>LDAP_LABEL</code>", "—", "The directory: <code>ldaps://host:636</code>, and whom an id binds as (<code>{user}@plant.local</code>)."],
    ["<code>PASSWORDS=0</code>", "on", "No passwords of OpenCore MES's own."],
    ["<code>MFA</code>", "optional", "<code>required</code> or <code>off</code>: an authenticator's code after a password."],
    ["<code>SIGN_WITH_PASSWORD=0</code>", "on", "Signatures ask the signer's password (or a fresh single sign-on)."],
    ["<code>PASSWORD_MAX_DAYS</code>, <code>PASSWORD_HISTORY</code>", "90, 5", "Password expiry and reuse."],
    ["<code>SESSION_IDLE_MINUTES</code>", "30", "Sign-out after that long with nothing done (12 hours at most)."],
    ["<code>PASSWORD_LINK_DAYS</code>", "3", "How long a one-time password link lasts unless its maker says (1 to 14 days)."],
    ["<code>SCRIPT_RUNNER_WRAP</code>, <code>SCRIPT_ISOLATION=required</code>", "none", "The script runner's walls (IN-16)."],
    ["<code>MES_CONNECTION_HOSTS</code>", "any host", "The hosts services may reach (comma separated)."],
    ["<code>ALERT_WEBHOOK_URL</code>, <code>ALERT_MIN_SEVERITY</code>", "none, error", "Alerts (IN-19)."],
    ["<code>SETUP=1</code>", "off", "Setup at the first start of an installation not made empty (the first administrator of an empty one opens it already)."],
    ["<code>REPLICA_URL</code>, <code>BUS=1</code>, <code>INSTANCE</code>", "—", "Reads from a replica; several instances on one database (app/mes/README.md, Scaling)."],
    ["<code>AI_PROVIDER</code>, <code>ANTHROPIC_API_KEY</code>, <code>AI_MODEL</code>", "none", "The copilot."],
    ["<code>SUITES_DIR</code>, <code>SUITES_REGISTRY</code>", "suites/, the store's", "Where suites are, and where they come from."],
]), `<p>The full list, with every option: the header of <code>app/mes/server.mjs</code> and <code>app/mes/README.md</code>.</p>`);
add(h2("Files and folders", "files"), table(["Path", "What"], [
    ["/srv/opencore-mes/releases/&lt;build&gt;", "Each release; <code>/srv/opencore-mes/current</code> points at the one that runs."],
    ["/etc/opencore-mes/opencore-mes.env", "The settings (root:opencore, 0640)."],
    ["/etc/opencore-mes/seal.key, integrity.key, backup.key", "The keys (copies off the server)."],
    ["/etc/opencore-mes/backup.env", "What is backed up, where, and where it is copied."],
    ["/var/lib/opencore-mes/events", "The event log file (also copied into the database)."],
    ["/var/backups/opencore-mes", "The encrypted backups (postgres, 0700)."],
    ["/etc/systemd/system/opencore-mes.service; opencore-mes-backup.*; opencore-mes-restore-test.*", "The service and the backup timers."],
]));
add(h2("Console commands", "commands"), table(["Command (on a server: <code>node app/mes/…</code> with the settings loaded)", "What"], [
    ["<code>db/reset.mjs --empty</code> · <code>opencore-mes db reset --yes --empty</code>", "An empty database. <b>Everything in the database is lost</b>; refused on a protected one."],
    ["<code>db/admin.mjs &lt;id&gt; \"&lt;name&gt;\"</code> · <code>opencore-mes admin</code>", "The first administrator of an empty installation."],
    ["<code>db/password.mjs &lt;id&gt; --url &lt;site&gt;</code> · <code>opencore-mes password</code>", "A one-time link for a person to set their password."],
    ["<code>db/token.mjs &lt;user&gt; \"&lt;name&gt;\" [--days 1..365]</code> · <code>opencore-mes token</code>", "A token for an integration user."],
    ["<code>db/migrate.mjs</code> · <code>opencore-mes db migrate</code>", "The database brought up to date (the server does it at start)."],
    ["<code>db/verify-audit.mjs [--full]</code>", "The audit chain checked by hand."],
    ["<code>db/seal-secrets.mjs</code>", "Second-factor secrets kept before a seal key was set, sealed now."],
    ["<code>db/recover-designer.mjs &lt;designer&gt; [--reviewer &lt;user&gt;] \"&lt;why&gt;\"</code>", "Design roles given back when nobody can change the system any more; refused otherwise, audited."],
]));
add(h2("When something refuses", "troubleshooting"), table(["You see", "Why, and what to do"], [
    ["The service stops at start: the script runner has no walls", "<code>SCRIPT_ISOLATION=required</code> without bubblewrap or its AppArmor profile: install them (IN-16), or remove the setting while you do."],
    ["Signing in says nobody has been added yet", "The database is empty: name the first administrator (IN-15)."],
    ["<code>npm install -g</code>: <code>EACCES</code>, permission denied on <code>/usr/local/lib/node_modules</code>", "npm's global folder belongs to root (Node from the nodejs.org installer on a Mac, or Ubuntu's packages): give npm one of your own (IN-31 step 2, IN-32 step 5), not <code>sudo</code>."],
    ["<code>opencore-mes</code>: unknown command <code>admin</code>, or <code>--empty</code> loads the sample people", "The npm package is 0.1.0, from before them: try the sample plant with it, or install from a source archive (IN-33) until the next package."],
    ["<code>admin.mjs</code>: People & departments has … already", "The first administrator is named once; add people through a change, or recover with <code>recover-designer.mjs</code> if nobody can change the system."],
    ["<code>reset.mjs</code>: a protected database is never reset", "Its audit trail is protected (IN-17): it is a plant's. Restore a backup into a new database instead (IN-42)."],
    ["<code>/healthz</code> answers 503", "The database is not answering, or the service is stopping: <code>journalctl -u opencore-mes</code>."],
    ["A migration fails at start on a protected database", "It changes the audit trail: run it as postgres, then <code>protect-audit.sql</code> (IN-17)."],
    ["<code>SETUP=1</code> ignored", "Changes were already reviewed and approved there: setup is opened again by a change governance approves."],
]));
add(h2("Revision history", "history"), table(["Revision", "Date", "What changed"], [["A", "2026-10-06", "First issue."], ["B", "2026-10-06", "Laptops: a MacBook and a Windows laptop (WSL 2), the sample plant or a plant of one's own (IN-31 to IN-33)."], [REVISION, ISSUED, "MacBook: npm's global folder of one's own (EACCES with the nodejs.org installer); two more refusals explained."], ["D", "2026-10-07", "IN-20: everyone's first password with setup codes (a file for printed slips), and moving to the plant's directory; the sign-in id's label, hint and domains."]]));

await doc.write({ dir: HERE, name: NAME, doc: DOC, revision: REVISION, issued: ISSUED, title: "OpenCore MES installation procedure", subtitle: "Installation procedure<br>A plant's server, a plant folder, upgrades and suites", appliesTo: "OpenCore MES as built on the issue date", footerTitle: "OpenCore MES installation procedure", pdf: process.argv.includes("--pdf") });
