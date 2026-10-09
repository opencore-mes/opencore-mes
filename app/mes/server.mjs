// The only file that reads the environment and touches the process (Juris README, "The boundary").
//   DATABASE_URL  postgres connection string (default: the local socket, database openmes_poc)
//   PORT          default 9090
//   HOST          the address to listen on: default 0.0.0.0, every IPv4 address this machine has; ::
//                 for IPv6 as well; 127.0.0.1 for this machine only
//   PROD=1        production mode (snapshot, minify, Secure cookies); development otherwise
//   BUILD         this deploy's name (production)
//   REPLICA_URL   a streaming replica: replica-safe reads go there once it has replayed this
//                 process's writes (routing.js); unset, the primary serves everything
//   REPLICA_FENCE=0  read the replica without waiting for replay (to show why the fence exists)
//   BUS=1         join the change bus (Juris pg-outbox): run several instances on one database, and a
//                 change on any of them reaches the pages and live queries of all
//   INSTANCE      this instance's name, in /healthz
//   DEMO=1        a public demo (with PROD=1): no sign-in page, a visitor is the demo person (DEMO_AS, or
//                 the first who designs; the public demo's is its guest, who holds every role, made by a
//                 reset with SEED_GUEST=1; with DEMO_GUESTS=session each visitor gets a guest of their own,
//                 "Guest 7F3K", within limits per address and per hour, else the shared one) and switches to anyone from the top bar; every page says it is a
//                 public demo, and services call no outside system. Its database is reset every night
//                 (ops/demo)
//   EMBED_ORIGINS the sites that may show OpenCore MES in a frame and talk to it by window messages
//                 (§37, docs/contracts/embedding): https://trainings.example.com, comma-separated; unset, none
//   SESSION_COOKIE  the sign-in cookie's name (default mes_session): another for a second instance on
//                 the same machine, whose sign-ins would otherwise replace this one's (npm run training)
//   SETUP=1       a new installation being set up (§5.15, server/setup.js): at its first start, a designer's
//                 change executes on their signature, without review or approval, until People & departments
//                 ends it. Ignored, and said so, where changes were already reviewed and approved
//   Sign-in (§8.2; auth.js, sign-in.js). Whoever signs in must be in People & departments, and active.
//   PASSWORDS=0   no passwords of OpenCore MES's own (on otherwise, except on the demo): a person gets one
//                 through a one-time link, `node app/mes/db/password.mjs <sign-in id>`
//   LDAP_URL      the plant's directory (LDAP or Active Directory), ldaps://host[:636] (ldap:// sends
//                 passwords in the clear: on this machine only). LDAP_USER_DN names whom a sign-in id
//                 binds as, with {user} for it: "{user}@plant.local" (AD), or
//                 "uid={user},ou=people,dc=plant,dc=example". LDAP_CA_FILE: the directory's CA, if not a
//                 public one. LDAP_LABEL: what the sign-in page calls it
//   OIDC_ISSUER   single sign-on through the plant's identity provider (OpenID Connect), with
//                 OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (none for a public client), OIDC_REDIRECT_URI
//                 (default: this site's /login/sso/callback, as the request names it), OIDC_CLAIM (the
//                 claim holding the sign-in id, default preferred_username), OIDC_LABEL, OIDC_SCOPES
//   PICKER=1      the sign-in picker (anyone as anyone) in production too: never on a reachable instance.
//                 It is on in development and on the demo
//   The plant's sign-in policy (§8.2, §7.4: Part 11 §11.200, §11.300). Defaults are a regulated plant's;
//   a picker instance (development, the demo) asks for none of it:
//   SIGN_WITH_PASSWORD=0   a signature (a transaction signed by one, an approval) does not ask its
//                 signer's password or a fresh single sign-on (on by default). Two signers always do
//   PASSWORD_MAX_DAYS  how long a password of OpenCore MES's own, or a signing password, lasts before it
//                 must be changed (default 90; 0 for ever). PASSWORD_HISTORY: earlier ones a new one may
//                 not repeat (default 5)
//   MFA           a second factor (an authenticator app) at a password sign-in, theirs or the directory's:
//                 "required", "optional" (each person may set one up; the default) or "off". Single
//                 sign-on's is the identity provider's
//   SESSION_IDLE_MINUTES  a session ends after this long with nothing done in it (default 30; 0 never).
//   PASSWORD_LINK_DAYS  how long a one-time password link lasts unless its maker says (1 to 14; default 3)
//                 It ends after 12 hours in any case
//   SIMPLE_LISTS=1  lists of people (the sign-in picker, People & departments, Person) show people at
//                 once, as in development and on the demo; elsewhere they start with a search box
//   AI_PROVIDER   the designer's copilot: "anthropic" (Claude; ANTHROPIC_API_KEY, AI_MODEL, AI_EFFORT)
//                 or "openai" (any OpenAI-compatible API: AI_BASE_URL, AI_API_KEY, AI_MODEL); unset, no AI.
//                 ANTHROPIC_WORKSPACE_ID names the workspace for a key that is not scoped to one
//   MES_SECRET_<NAME>  the value of a connection's secret <name> (§15.2), e.g. MES_SECRET_ERP_TOKEN
//                 for the secret erp_token: set here, never in a design
//   OUTBOX=0      this instance runs no triggers (the outbox worker is off); others on the database do
//   SCHEDULER=0   this node plans no schedules (§15.3); others on the database do. A run is planned
//                 once however many nodes plan, so several may, for redundancy
//   NODE_TAGS     this node's tags, comma-separated (e.g. erp,plant1): a service whose design says
//                 runOn: "erp" is run only by nodes tagged erp (the ones that can reach ERP, say)
//   PLANT_TZ      the plant's time zone, for a schedule that names none (default: this server's)
//   SCRIPT_RUNNER_WRAP  the command the script runner starts under, for the operating system's walls
//                 (§12.4): on Linux `ops/script-runner-sandbox.sh` (bubblewrap: no network, nothing to
//                 read but the app's code). Unset, scripts have Node's walls only; /healthz says which.
//   SCRIPT_ISOLATION=required  refuse to start unless the script runner reports no network of its own
//                 (what a regulated plant's production should set, once the wrapper is in place)
//   SUITES_DIR    where the installed suites are (default: suites/ beside the app; the npm package's
//                 `opencore-mes start` sets the plant folder's)
//   SUITES_REGISTRY  the registry `opencore-mes suite` installs from (default the suites store's,
//                 https://suites.opencoremes.com/; §29.7): a mirror inside the plant, say
//   EVENT_LOG_DIR where this instance writes its event log (default .local/events at the repository
//                 root): event.log, or event.<INSTANCE>.log. One process per instance name and directory
//                 (set aside past 50 MB, its chain carried on into the next file)
//   ALERT_WEBHOOK_URL  where events at or above ALERT_MIN_SEVERITY are posted (server/alerts.js, COMPLIANCE.md
//                 G9): a chat channel's incoming webhook, an on-call service. Each is also one JSON line in
//                 the journal, `alert {…}`, for whatever ships logs off the machine
//   ALERT_MIN_SEVERITY  info, warning, error (the default) or critical
//
// Development reload: `npm run dev` runs this under `node --watch`, which restarts it when any code
// it imports changes (the server, the framework, the client modules it renders with); every open
// page then reloads, since the reload stream it listens to answers from a new process. A change to
// what only browsers load (the stylesheet, the browser entry, the rule worker) reloads the pages
// without a restart.
import "./env.mjs"; // first: the settings file, before any module reads the environment
import os from "node:os";
import { readFileSync } from "node:fs";
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "./app.mjs";
import { checkAuditInWorker } from "./server/audit.js";
import { probeScriptRunner } from "./server/rules.js";
import { createRouting } from "./server/routing.js";
import { createSqlStats } from "./server/sql-stats.js";
import { gateDb } from "./server/db-gate.js";
import { createEventLog, watchDb } from "./server/event-log.js";
import { createAlerts } from "./server/alerts.js";
import { openSetupAtInstall } from "./server/setup.js";
import { linkDaysOf } from "./server/sign-in.js";
import { migrate } from "./db/migrate.mjs";
import { loadSuites, SUITES_DIR } from "./suites.mjs";
import { watchUpdates, REGISTRY, installed as suitesOnDisk } from "./suite-install.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPgOutboxBus } from "@opencore-mes/juris-kit/server/bus/pg-outbox.js";
import { createProvider } from "./server/ai-gateway.js";
import { devReload } from "@opencore-mes/juris-kit/server/dev-reload.js";
import { parseOrigins } from "./client/embed.js";

const dev = process.env.PROD !== "1";
const demo = process.env.DEMO === "1";
const instance = process.env.INSTANCE ?? null;
const build = dev ? `dev-${Date.now()}` : (process.env.BUILD ?? "b1");
// The event log (event-log.js), first: it is where this process says it started, stopped or crashed,
// and where an outage of the database is written while it lasts.
const alerts = createAlerts({ url: process.env.ALERT_WEBHOOK_URL || null, minSeverity: process.env.ALERT_MIN_SEVERITY || "error", instance });
const events = createEventLog({ dir: process.env.EVENT_LOG_DIR ?? fileURLToPath(new URL("../../.local/events", import.meta.url)), instance, build, pid: process.pid, runtime: `node ${process.version}`, onEvent: alerts.onEvent });
events.start();
process.on("uncaughtException", (error) => {
    events.emit("instance.crash", { severity: "critical", message: `Crashed: ${error?.message ?? error}`, details: { stack: String(error?.stack ?? error).slice(0, 4000) } });
    console.error(error);
    process.exit(1);
});
const dbWatch = watchDb(events);
// A pool that fails fast rather than hangs: waiting for a connection gives up after 5 s, and the
// database ends a transaction left idle for 15 s (so no mistake can hold row locks for good).
const POOL = { max: 10, connectionTimeoutMillis: 5000, options: "-c idle_in_transaction_session_timeout=15000 -c statement_timeout=30000" };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc", ...POOL });
const replicaPool = process.env.REPLICA_URL ? new pg.Pool({ connectionString: process.env.REPLICA_URL, ...POOL }) : null;
// The write database behind its gate (db-gate.js): while it is unreachable, calls are refused at once,
// in words, and a probe notices when it is back.
// Whether the database answers on a connection of its own: what tells a full pool from an outage.
const reaches = async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc", connectionTimeoutMillis: 2000, statement_timeout: 2000 });
    try { await client.connect(); await client.query("SELECT 1"); return true; } catch { return false; } finally { client.end().catch(() => {}); }
};
// At most two short of the pool in transactions at once: what a transaction reads through the pool (who the person
// is) always finds a connection (db-gate.js).
const gate = gateDb(fromPg(pool), { onDown: dbWatch.onDown, onUp: dbWatch.onUp, reaches, transactions: POOL.max - 2 });
// Every statement the platform sends, measured (sql-stats.js, §38): the primary and the replica, before the
// read routing, so a transaction's statements and a replica's reads are counted too.
const sqlStats = createSqlStats();
const routing = createRouting({ primary: sqlStats.wrap(gate), replica: replicaPool && sqlStats.wrap(fromPg(replicaPool), "replica"), fence: process.env.REPLICA_FENCE !== "0" });
const bus = process.env.BUS === "1" ? createPgOutboxBus({ pool, targets: {}, onError: (error) => console.error("bus:", error.message) }) : null;
await bus?.start();
const env = process.env;
const ai = await createProvider({ AI_PROVIDER: env.AI_PROVIDER, AI_MODEL: env.AI_MODEL, AI_EFFORT: env.AI_EFFORT, AI_BASE_URL: env.AI_BASE_URL, AI_API_KEY: env.AI_API_KEY, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_WORKSPACE_ID: env.ANTHROPIC_WORKSPACE_ID });
// Node marks the process it runs under --watch (the flag itself is not passed on to it).
const watched = process.env.WATCH_REPORT_DEPENDENCIES === "1";
const reload = dev
    ? devReload({
        root: new URL(".", import.meta.url),
        restartOn: ["app.mjs", "server", "client/app.js", "client/shell.js", "client/records.js", "client/designer.js", "client/definition.js", "client/pipe.js", "client/expr.js", "client/rules-client.js", "client/editor-kit.js", "client/integration-editor.js", "client/code-editor.js", "client/db-status.js", "client/schedule.js", "client/integration-monitor.js", "client/analytics.js", "client/query.js", "client/updates.js", "client/transfer.js", "client/form-layout.js", "client/compare.js", "client/transaction.js", "client/transaction-editor.js", "client/screen.js", "client/screen-editor.js", "client/organization-editor.js", "client/dialog.js", "client/pick.js", "client/approvals.js", "client/requests.js"],
        reloadOn: ["client/app.css", "client/boot.js", "client/rule-worker.js"],
        // Under --watch, Node itself replaces this process; otherwise say what to do.
        onRestart: (file) => { if (!watched) console.log(`${file} changed: restart the server to run it (npm run dev restarts by itself)`); },
    })
    : null;
// TRUST_PROXY=1: one proxy in front (Caddy, the balancer) writes X-Forwarded-For, and a caller's address
// is read from it (2: two of them, and so on). Unset, the address is the connection's own, and that
// header is never read: anyone can write it. A desktop's page at sign-in (§6.8) goes by this address.
// A value that is not a number of proxies stops the start: read as "none", every sign-in would come from the proxy.
if (process.env.TRUST_PROXY && !/^(0|[1-9]\d?)$/.test(process.env.TRUST_PROXY)) throw new Error(`TRUST_PROXY is the number of proxies in front of this server (1, 2, up to 99), or unset for none: not "${process.env.TRUST_PROXY}".`);
const trustProxy = /^[1-9]\d?$/.test(process.env.TRUST_PROXY ?? "") ? { hops: Number(process.env.TRUST_PROXY) } : false;
// The hosts connections may be sent to, when IT lists them: MES_CONNECTION_HOSTS=erp.plant.local,*.lims.plant.local
// (none listed: any host, but never a link-local address, where a cloud keeps its metadata service).
const connectionHosts = (process.env.MES_CONNECTION_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
// The sites that may show OpenCore MES in a frame and talk to it (§37, client/embed.js): EMBED_ORIGINS=https://trainings.example.com
// (none: no frame at all). A value that is not an origin stops the start.
const embedOrigins = parseOrigins(process.env.EMBED_ORIGINS ?? "");
const secrets = (name) => (/^[a-z][a-z0-9_]{0,47}$/.test(name) ? process.env[`MES_SECRET_${name.toUpperCase()}`] : undefined);
// The database upgrades itself before anything uses it (db/migrate.mjs): what is new or changed runs,
// once, whichever instance starts first. If the database is not answering yet, it is tried again every
// 10 s until it is.
// The suites installed under suites/ (§29, suites.mjs): their migrations run with the platform's.
const suites = await loadSuites();
const upgrade = async () => {
    const done = await migrate(routing.db, { log: { info: (m) => console.log(m) }, suites });
    if (done.length) events.emit("db.migrated", { message: `Database upgraded: ${done.map((d) => `${d.name} (${d.action})`).join(", ")}.`, details: { migrations: done } });
    // Setup (§5.15), when IT asked for it for a new installation: opened once, as the platform.
    if (process.env.SETUP === "1") await openSetupAtInstall(routing.db, { events, log: console });
};
await upgrade().catch((error) => {
    if (error?.code !== "db.unavailable") throw error;
    const retry = setInterval(() => upgrade().then(() => clearInterval(retry), () => {}), 10_000);
    retry.unref();
});
const node = { tags: (process.env.NODE_TAGS ?? "").split(",").map((t) => t.trim()).filter(Boolean), scheduler: process.env.SCHEDULER !== "0" };
const plantTz = process.env.PLANT_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
function guestLimitsOf(text) {
    const n = String(text).split("/").map(Number);
    if (n.length !== 3 || !n.every((x) => Number.isInteger(x) && x > 0)) throw new Error(`DEMO_GUEST_LIMITS is <per address an hour>/<an hour>/<until the reset>, three whole numbers (e.g. 60/600/3000): not "${text}".`);
    return { perAddress: n[0], perHour: n[1], total: n[2] };
}
// How people sign in (§8.2).
const signIn = {
    picker: dev || demo || env.PICKER === "1",
    passwords: !demo && env.PASSWORDS !== "0",
    // The public demo: each visitor a guest of their own (DEMO_GUESTS=session, db/guest.mjs).
    guests: demo && env.DEMO_GUESTS === "session" ? "session" : null,
    // (DEMO_GUESTS_FOLLOW=1: the guests take up the roles of each object a change makes live, app.mjs; a
    // training plant's, where a learner's own object must open for them.)
    // Their limits (auth.js): DEMO_GUEST_LIMITS=<per address an hour>/<an hour>/<until the reset>, e.g.
    // 60/600/3000 for a training plant a classroom reaches from one address; unset, 20/300/3000.
    ...(env.DEMO_GUEST_LIMITS ? { guestLimits: guestLimitsOf(env.DEMO_GUEST_LIMITS) } : {}),
    ldap: env.LDAP_URL ? { url: env.LDAP_URL, userDn: env.LDAP_USER_DN ?? "{user}", label: env.LDAP_LABEL ?? null, ca: env.LDAP_CA_FILE ? readFileSync(env.LDAP_CA_FILE) : null } : null,
    sso: env.OIDC_ISSUER ? { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET ?? null, redirectUri: env.OIDC_REDIRECT_URI ?? null, claim: env.OIDC_CLAIM ?? "preferred_username", label: env.OIDC_LABEL ?? null, ...(env.OIDC_SCOPES ? { scopes: env.OIDC_SCOPES } : {}) } : null,
};
// The plant's policy (sign-in.js policyOf): a regulated plant's unless the environment says otherwise.
// A picker instance asks for none of it (anyone is anyone there).
const whole = (name, fallback) => { const v = env[name]; return v === undefined || v === "" ? fallback : Number.parseInt(v, 10); };
Object.assign(signIn, signIn.picker ? { signWithPassword: false, passwordMaxDays: 0, passwordHistory: 0, mfa: "off", idleMinutes: 0 } : {
    signWithPassword: env.SIGN_WITH_PASSWORD !== "0",
    passwordMaxDays: whole("PASSWORD_MAX_DAYS", 90), passwordHistory: whole("PASSWORD_HISTORY", 5),
    mfa: ["required", "optional", "off"].includes(env.MFA) ? env.MFA : "optional",
    idleMinutes: whole("SESSION_IDLE_MINUTES", 30),
});
// How long a password link lasts unless its maker says (1 to 14 days; 3 unless set).
signIn.linkDays = linkDaysOf(env);
if (signIn.sso && !signIn.sso.clientId) throw new Error("OIDC_ISSUER is set without OIDC_CLIENT_ID: single sign-on needs both.");
if (signIn.ldap && !/^ldaps?:\/\//.test(signIn.ldap.url)) throw new Error(`LDAP_URL is ldaps://host or ldap://host, not ${signIn.ldap.url}.`);
// The test sandbox (§5.13) is served beside this instance: on TEST_SANDBOX_PORT (this port + 1000 unless
// said), on the same address; TEST_SANDBOX_URL when a proxy in front gives it an address of its own.
const testAt = { port: Number(process.env.TEST_SANDBOX_PORT ?? Number(process.env.PORT ?? 9090) + 1000), host: process.env.HOST ?? "0.0.0.0", url: process.env.TEST_SANDBOX_URL ?? null };
// Newer suite versions on the registry (§29.7), for About and the designer: asked where the plant has signed in to
// it (its work folder beside the suites', <plant>/.local/suites), never on the public demo.
const suiteUpdates = demo ? null : watchUpdates({ dir: SUITES_DIR, work: join(dirname(SUITES_DIR), ".local", "suites"), registry: process.env.SUITES_REGISTRY ?? REGISTRY });
// The versions each suite keeps on disk (suites/.versions), which `opencore-mes suite use` brings back (§29.7).
const suiteKept = () => Object.fromEntries(suitesOnDisk(SUITES_DIR).map((x) => [x.name, x.kept]));
// The audit chain's quarter-hourly check in a thread of its own (§7.3), on the primary.
const auditCheck = () => checkAuditInWorker(process.env.DATABASE_URL ?? "postgres:///openmes_poc");
const app = await createApp({ auditCheck, sqlStats, suiteUpdates: () => suiteUpdates?.list() ?? [], suiteKept, testAt, db: routing.db, dbState: gate.state, events, dbWatch, node, plantTz, routing, bus, instance, ai, dev, devReload: reload, secrets, outboxEveryMs: process.env.OUTBOX === "0" ? 0 : 1000, mail: { smtpUrl: env.SMTP_URL || null, from: env.MAIL_FROM || null, publicUrl: env.PUBLIC_URL || null }, build, sessionCookie: process.env.SESSION_COOKIE ?? null, suites, demo, signIn, simpleLists: dev || demo || env.SIMPLE_LISTS === "1", demoAs: env.DEMO_AS ?? null, connectionHosts: connectionHosts.length ? connectionHosts : null, trustProxy, embedOrigins, guestsFollow: env.DEMO_GUESTS_FOLLOW === "1" });
const host = process.env.HOST ?? "0.0.0.0";
const { url, port } = await app.listen({ port: Number(process.env.PORT ?? 9090), host });
// Listening on every address: say which, so people on the network know where to go.
const everywhere = host === "0.0.0.0" || host === "::";
const reachable = everywhere
    ? Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal && (host === "::" || a.family === "IPv4")).map((a) => `http://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${port}`)
    : [];
console.log(`OpenCore MES POC${instance ? ` ${instance}` : ""} listening on ${everywhere ? `http://127.0.0.1:${port}` : url} (${dev ? "development" : "production"}${demo ? ", public demo" : ""}${replicaPool ? `, reads from a replica${routing.stats.fence ? " behind the replay fence" : " WITHOUT the fence"}` : ""}${bus ? ", on the change bus" : ""}${ai.available ? `, copilot: ${ai.name} ${ai.model}` : ", no copilot"})`);
if (suites.length) console.log(`  suites: ${suites.map((x) => `${x.label} ${x.version}`).join(", ")}`);
if (reachable.length) console.log(`  also on this network at ${reachable.join(", ")}`);
console.log(`  sign-in: ${[signIn.sso && `single sign-on (${signIn.sso.issuer})`, signIn.ldap && `directory (${signIn.ldap.url})`, signIn.passwords && "passwords", signIn.picker && "the picker"].filter(Boolean).join(", ") || "nobody can sign in"}`);
if (signIn.picker && !demo && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.log("  ⚠ reachable from other machines with the picker on: anyone who can reach it can sign in as any user. HOST=127.0.0.1 keeps it to this machine; PROD=1 turns the picker off.");
}
if (signIn.ldap?.url.startsWith("ldap://") && !/^ldap:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(signIn.ldap.url)) console.log("  ⚠ LDAP_URL is ldap://: passwords cross the network in the clear. Use ldaps://.");
// The script runner says how walled in it is (§12.4): in the log, the event log (a warning when a
// production instance's scripts could reach the network) and /healthz. SCRIPT_ISOLATION=required makes
// it a condition of starting, so a plant that relies on the walls never runs without them unnoticed.
const scripts = await probeScriptRunner();
const walls = scripts.network === "none" ? `isolated${scripts.sandbox ? ` (${scripts.sandbox})` : ""}: no network, Node's permission model` : scripts.failed ? `the runner did not start (${scripts.failed})` : `Node's permission model only${scripts.network === "host" ? ": the operating system gives scripts the host's network (SCRIPT_RUNNER_WRAP walls them in, §12.4)" : ""}`;
console.log(`  scripts: ${walls}`);
if (scripts.network !== "none") {
    if (!dev) events.emit("scripts.unisolated", { severity: "warning", message: `Scripts run with Node's permission model only: ${scripts.failed ?? "the operating system gives the script runner the host's network"}. Set SCRIPT_RUNNER_WRAP (ops/script-runner-sandbox.sh) to wall it in.`, details: scripts });
    if (env.SCRIPT_ISOLATION === "required") {
        console.error("  SCRIPT_ISOLATION=required, and the script runner is not isolated: not starting. See app/mes/README.md, \"Scripts: the runner's walls\".");
        await app.close();
        events.stop("script isolation required");
        await events.flush(routing.db).catch(() => {});
        process.exit(1);
    }
}

const stop = async (signal) => {
    await app.close();
    events.stop(signal);
    await events.flush(routing.db).catch(() => {}); // the database may be the reason it stops: the file keeps it
    gate.stop();
    await pool.end();
    await replicaPool?.end();
    process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
