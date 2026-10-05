// OpenCore MES developer's guide, printable: installing OpenCore MES, services
// and integration; what the platform offers today, how to build on it, and
// what is planned.
// The lists a design may hold (record events, what a service may do, authentication kinds, methods,
// token scopes, schedule values) are read from the code that checks them, so they never drift.
//   node docs/developers/build.mjs          → docs/developers/developers-guide.html
//   node docs/developers/build.mjs --pdf    → and .pdf (headless Chrome; CHROME=<path> if not on macOS)
import { writeFileSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RECORD_EVENTS, SERVICE_OPS, AUTH_KINDS, HTTP_METHODS, RUN_AS, FIELD_TYPES, SERVICE_TEMPLATE } from "../../app/mes/client/definition.js";
import { DAYS, MISSED, OVERLAP, MAX_CATCH_UP } from "../../app/mes/client/schedule.js";
import { SCOPES } from "../../app/mes/server/ai-api.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = "OMES-DEV-001";
const REVISION = "D";
const ISSUED = "2026-10-05";
const NAME = "developers-guide";

// ---- helpers ----
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const code = (s) => `<code${String(s ?? "").length <= 26 ? ' class="n"' : ""}>${esc(s)}</code>`;
const list = (xs) => xs.map(code).join(", ");
const pre = (s, lang = "") => `<pre class="${lang}">${esc(s.replace(/^\n/, ""))}</pre>`;
const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
const kv = (pairs) => `<table class="kv"><tbody>${pairs.filter(Boolean).map(([k, v]) => `<tr><th>${k}</th><td>${v ?? "—"}</td></tr>`).join("")}</tbody></table>`;
const note = (html, kind = "note") => `<div class="callout ${kind}"><strong>${{ note: "Note", warn: "Caution", planned: "Planned" }[kind]}.</strong> ${html}</div>`;
const toc = [];
let part = 0;
let section = 0;
function h1(title, id) { part++; section = 0; toc.push({ level: 1, id, title: `${part}. ${title}` }); return `<h1 id="${id}" class="part">${part}. ${esc(title)}</h1>`; }
function h2(title, id) { section++; toc.push({ level: 2, id, title: `${part}.${section} ${title}` }); return `<h2 id="${id}">${part}.${section} ${esc(title)}</h2>`; }
const h3 = (title) => `<h3>${esc(title)}</h3>`;
// A reference to a section or procedure is written [[see:<its id>]]: resolved to its number, as a
// link, once every heading is in (numbered, below).
function proc({ id, title, who, purpose, before = [], steps, after = "" }) {
    toc.push({ level: 3, id: `p-${id}`, title: `${id} ${title}` });
    return `<section class="proc" id="p-${id}">
  <div class="proc-head"><span class="proc-id">${id}</span><span class="proc-title">${esc(title)}</span></div>
  ${kv([["Purpose", purpose], ["Done by", who], before.length ? ["Before you start", `<ul>${before.map((b) => `<li>${b}</li>`).join("")}</ul>`] : null])}
  <table class="steps"><thead><tr><th class="n">#</th><th>Do this</th><th>You should see</th><th class="ok">Done</th></tr></thead><tbody>
  ${steps.map(([a, r], i) => `<tr><td class="n">${i + 1}</td><td>${a}</td><td>${r ?? ""}</td><td class="ok"></td></tr>`).join("")}
  </tbody></table>${after ? `<div class="proc-after">${after}</div>` : ""}
</section>`;
}

// ---- the worked example: an ERP integration on the seed's work orders and lots ----
// (the same designs app/mes/test/integration.mjs proves end to end, against a fake ERP)
const connectionJson = `{
  "name": "erp", "label": "ERP",
  "baseUrl": "https://erp.plant.local/api",
  "auth": { "kind": "bearer", "secret": "erp_token" },
  "allow": [{ "method": "POST", "path": "/confirmations" }],
  "timeoutMs": 3000,
  "stewards": ["engineering"]
}`;
const inboundJson = `{
  "name": "erp_work_order_in", "label": "Work order from ERP",
  "description": "ERP sends a planned work order.",
  "input": {
    "wo_no": { "label": "Work order no.", "type": "string", "required": true },
    "item":  { "type": "string", "required": true },
    "qty":   { "type": "decimal", "required": true },
    "line":  { "type": "enum", "values": ["L1", "L2", "L3"], "required": true }
  },
  "http": { "enabled": true },
  "callers": { "users": ["erp"], "groups": [] },
  "on": [],
  "runAs": "service",
  "roles": { "work_order": ["planner"] },
  "uses": { "connections": [], "objects": { "work_order": ["create"] } },
  "stewards": ["production"]
}`;
const inboundScript = `// ERP sends a work order; it is created as this service, through the work order's policy and rule pipe.
export default async function erp_work_order_in(ctx) {
  const wo = await ctx.records.create("work_order", {
    wo_no: ctx.input.wo_no, item: ctx.input.item, qty: ctx.input.qty, line: ctx.input.line,
  });
  ctx.output = { id: wo.id, wo_no: wo.wo_no, state: wo.state };
  return ctx;
}`;
const outboundJson = `{
  "name": "erp_lot_released", "label": "Lot released → ERP",
  "description": "Confirms a released lot to ERP.",
  "input": {}, "http": { "enabled": false },
  "callers": { "users": [], "groups": [] },
  "on": [{ "object": "lot", "event": "transition:release" }],
  "runAs": "erp",
  "uses": { "connections": ["erp"], "objects": { "lot": ["read"] } },
  "stewards": ["production"]
}`;
const outboundScript = `// A released lot is confirmed to ERP.
export default async function erp_lot_released(ctx) {
  const lot = await ctx.records.get("lot", ctx.event.id);
  const res = await ctx.http("erp", {
    method: "POST", path: "/confirmations",
    body: { lot_no: lot.lot_no, item: lot.item, qty: lot.qty, uom: lot.uom, event: ctx.event.id },
  });
  if (res.status >= 500) throw Object.assign(new Error("ERP is unavailable"), { retry: true });
  if (!res.ok) throw new Error(\`ERP refused the confirmation (\${res.status})\`);
  ctx.output = { confirmation: res.body.id };
  return ctx;
}`;
const scheduleJson = `"on": [{
  "schedule": { "every": { "minutes": 15 }, "between": ["06:00", "22:00"],
                "days": ["mon", "tue", "wed", "thu", "fri"], "tz": "Europe/Berlin" },
  "missed": "last", "overlap": "skip"
}]`;
const pollScript = `// Every 15 minutes: the orders ERP changed since the last successful run, a page at a time.
export default async function erp_orders_pull(ctx) {
  const since = ctx.event.previous?.output?.cursor ?? "2026-01-01T00:00:00Z";
  const res = await ctx.http("erp", { method: "GET", path: "/orders", query: { changedSince: since } });
  if (res.status >= 500) throw Object.assign(new Error("ERP is unavailable"), { retry: true });
  if (!res.ok) throw new Error(\`ERP refused the order list (\${res.status})\`);
  for (const order of res.body.orders) {
    const [known] = await ctx.records.list("work_order", { wo_no: order.wo_no });
    if (known) await ctx.records.update("work_order", known.id, { qty: order.qty });
    else await ctx.records.create("work_order", { wo_no: order.wo_no, item: order.item, qty: order.qty, line: order.line });
  }
  ctx.output = { cursor: res.body.until, more: res.body.hasMore === true };
  return ctx;
}`;

const body = [];
const add = (...xs) => body.push(...xs);

// ---- 1 ----
add(h1("About this guide", "about"));
add(h2("Who it is for", "who"), `<p>For IT, who installs OpenCore MES; for developers who connect OpenCore MES to other systems (ERP, a LIMS, a label printer, a data platform), for the designers who write service scripts, and for IT, who issues tokens, sets secrets and runs the nodes. It describes what OpenCore MES offers today, with the limits the code holds, and marks what is <b>planned</b>.</p>
<p>The ground rule: <b>integration is designed, not deployed.</b> A web service, a trigger, a schedule and the outside systems they reach are design elements, drafted in a change request, reviewed, approved by the stewards of everything they reach, and live the moment the change executes: no build, no deploy, no restart. Nothing reaches the plant around that lifecycle, and every record a service reads or writes goes through the same policies, rule pipe and audit trail as a person at a form.</p>`);
add(h2("What is built, and what is planned", "status"), table(["Way in or out", "What", "Status"], [
    ["Web services", `Outside systems call ${code("POST /svc/v1/<service>")} with a bearer token; ${code("GET /svc/v1/openapi.json")} describes what the token's user may call`, "built"],
    ["Connections", "Outside systems services call, with only the requests their design allows, credentials kept as server secrets", "built"],
    ["Record triggers", `A record event (${RECORD_EVENTS.join(", ")}, or a transition) sets a service off after its commit, retried while the other system is down`, "built"],
    ["Schedules", "The clock sets a service off: every N minutes or hours, at times of day, in a window, on days, or at the times a kind of schedule an installed suite adds works out; catch-up and overlap rules", "built"],
    ["The integration monitor", "Nodes, schedules, inbound and outbound calls, triggers; pause, resume, run now", "built"],
    ["The AI design API", `${code("/ai/v1")}: an AI drafts and tests designs as a person, never approves`, "built"],
    ["Excel import and export", "Records in and out as spreadsheets, through the forms' checks", "built"],
    ["Authentication", "Single sign-on (OpenID Connect), the plant's directory (LDAP, Active Directory), or a password of OpenCore MES's own; lockout; only people in People & departments ([[see:sign-in]])", "built"],
    ["Versioned HTTP APIs", `${code("/svc/v1")} and ${code("/ai/v1")} written down as a contract (${code("docs/contracts/http-apis")}): ${code("API-Version")} on every answer, notice before a change (Deprecation, Sunset), the API kit; a plant's web services held to notice before they break their callers ([[see:versions]])`, "built"],
    ["The equipment adapter contract", `What an adapter for one machine protocol implements (${code("docs/contracts/equipment-adapter")}): its specification, schema and conformance kit (§31.4)`, "built"],
    ["The extension API", "A narrow, versioned surface for suites, with its conformance kit (§31.3)", "planned"],
    ["Equipment data collection", "High-rate machine data handled outside the MES, which receives only derived events (§15.1)", "planned"],
]));
add(h2("Conventions", "conventions"), `<ul><li>${code("Code")} is typed as it stands. JSON designs are shown as the designer's <b>JSON</b> tab stores them.</li><li>§n refers to a section of the design document, kept by the maintainers.</li><li>The examples use the seed's <b>work order</b> and <b>lot</b>, and a made-up ERP at <code>https://erp.plant.local/api</code>. The same designs are proved end to end by <code>app/mes/test/integration.mjs</code>, against a fake ERP.</li><li>Procedures (DV-…) have a <b>Done</b> box per step, for a printed copy.</li></ul>`);

// ---- installing ----
add(h1("Installing OpenCore MES", "install"), `<p>OpenCore MES is plain JavaScript on Node and PostgreSQL: no build step, two runtime packages (<code>pg</code>, and the Anthropic SDK for the copilot). One Node process is one instance; instances share one database.</p>
${note(`In development (and on a public demo, <code>DEMO=1</code>, reset every night) sign-in is a <b>picker</b>: a person picks who they are, so anyone who can reach that instance can act as anyone. Keep development on <code>HOST=127.0.0.1</code> or a network you trust. With <code>PROD=1</code> the picker is off and people sign in as [[see:sign-in]] describes.`, "warn")}`);
add(h2("What you need", "needs"), table(["What", "Version", "Why"], [
    ["Node", "24 or later", "the server, the script runner, the tools"],
    ["PostgreSQL", "16 or later (the pipeline runs on 16)", "everything that is kept: designs, records, audit, outbox, sessions"],
    ["Google Chrome or Chromium", "any recent", "only to build the printable guides (<code>--pdf</code>)"],
]));
add(proc({
    id: "IN-01", title: "Install for development", who: "Developer",
    purpose: "A working instance on your machine, with the seed's plant to try things on.",
    before: ["Node 24 and PostgreSQL are installed; your user can create databases over the local socket."],
    steps: [
        ["Get the code and run <code>npm install</code>.", "Two packages installed."],
        ["<code>npm run db:reset</code>", "The database <code>openmes_poc</code> is made (when missing), its schema loaded and migrated, and the seed loaded: people, departments, objects, records. It says what it loaded."],
        ["Optionally, copy <code>.env.example</code> to <code>.env</code> and set what you need (the copilot's provider, a port).", "<code>.env</code> is never committed."],
        ["<code>npm run dev</code>", "“listening on http://127.0.0.1:9090”. It restarts when a file under <code>app/mes</code> or <code>src</code> changes, and every open page reloads."],
        ["Open it and pick a person to sign in as (Dana designs; Olga works the floor).", "The navigator, the designer, the screens."],
        ["<code>npm run test:all</code>", "Every stage passes. It resets <code>openmes_test</code> (<code>TEST_DATABASE_URL</code>) and refuses any database whose name lacks “test”, so your development database is safe."],
    ],
    after: `${code("DATABASE_URL")} names another database; ${code("npm run db:reset -- --blank")} makes one with people only (every model designed from nothing), as the training instance does (${code("npm run training:reset")}, ${code("npm run training")}, port 9091).`,
}));
add(proc({
    id: "IN-02", title: "Install on a server", who: "IT",
    purpose: "One instance behind HTTPS, run by systemd, as the public demo is (ops/demo).",
    before: ["A fresh Ubuntu 24.04 server, root access, a DNS name pointing at it."],
    steps: [
        ["As root, run <code>ops/demo/provision.sh</code> (safe to run again).", "PostgreSQL, Caddy, Node (its checksum checked); the system user <code>openmes</code>; its database role over the local socket (peer authentication, no password); the role <code>mes_query</code> the query page reads as, granted to <code>openmes</code>."],
        ["Unpack a release in <code>/srv/open-mes/releases/&lt;build&gt;</code>, owned by <code>openmes</code>, and run <code>npm ci --omit=dev</code> there.", "—"],
        [`Write its settings in an environment file (as <code>ops/demo/demo.env</code>): ${code("PROD=1")}, ${code("HOST=127.0.0.1")}, ${code("PORT=3000")}, ${code("DATABASE_URL=postgres:///openmes")}, ${code("PGHOST=/var/run/postgresql")}, ${code("PLANT_TZ")}, ${code("EVENT_LOG_DIR=/var/lib/open-mes/events")}. Secrets (the copilot's key, ${code("MES_SECRET_…")}) go in a file of their own under <code>/etc/open-mes</code>, mode 0640, root:openmes.`, "No secret is in the release or its settings file."],
        ["The first time only, as <code>openmes</code> with those settings: <code>node app/mes/db/reset.mjs</code> (add <code>--blank</code> for people only).", "The database is made and seeded. Later releases migrate it at start."],
        ["Point <code>/srv/open-mes/current</code> at the release; install the systemd unit (as <code>ops/demo/open-mes.service</code>: <code>ExecStart=/usr/local/bin/node app/mes/server.mjs</code>, the environment files, <code>ProtectSystem=strict</code>, <code>ReadWritePaths=/var/lib/open-mes</code>); <code>systemctl enable --now open-mes</code>.", "<code>systemctl status open-mes</code> shows it running."],
        ["Put Caddy in front (as <code>ops/demo/Caddyfile</code>: your name, <code>reverse_proxy 127.0.0.1:3000</code>, HSTS), and reload it.", "Caddy fetches the certificate by itself."],
        ["<code>curl -fsS http://127.0.0.1:3000/healthz</code>, then open <code>https://&lt;name&gt;/</code>.", "The health answer; the sign-in page over HTTPS."],
    ],
    after: "<code>ops/demo/deploy.sh</code> does all of this from a workstation for the public demo (<code>--provision</code> the first time), runs the test pipeline on the server before switching, and keeps the last five releases. It is the demo's: it also installs the timer that erases the demo's database every night, and the landing page. Take the steps from it for a plant, not the script as it is.",
}));
add(proc({
    id: "IN-03", title: "Upgrade to a new release", who: "IT",
    purpose: "A new version of OpenCore MES, with its database changes.",
    steps: [
        ["Unpack the release beside the current one and run <code>npm ci --omit=dev</code>.", "—"],
        ["Optionally run the pipeline there against a test database: <code>TEST_DATABASE_URL=postgres:///openmes_test npm run test:all</code>.", "Every stage passes."],
        ["Point <code>current</code> at it and restart the service.", "At start the server runs every new or changed migration, in order, under one lock: several instances starting together run each once. Nothing is run by hand."],
        ["<code>/healthz</code>, and the event log.", "<code>db.migrated</code> names what ran."],
    ],
    after: "Designs are never part of a release: they live in the database and change only through change requests, so an upgrade leaves the plant's designs as they were. <code>npm run db:migrate</code> migrates without starting a server.",
}));
add(h2("Settings", "settings"), table(["Setting", "What"], [
    [code("DATABASE_URL"), "the database (default <code>postgres:///openmes_poc</code>, the local socket)"],
    [code("PORT") + ", " + code("HOST"), "where it listens (9090; every IPv4 address, <code>::</code> for IPv6 too, <code>127.0.0.1</code> for this machine only)"],
    [code("PROD=1") + ", " + code("BUILD"), "production: a snapshot of the pages, minified, Secure cookies; this release's name"],
    [code("DEMO=1") + ", " + code("DEMO_AS"), "a public demo: no sign-in page, a visitor is the demo person (DEMO_AS, or the first who designs) and becomes anyone from the top bar; every page says so; services call no outside system"],
    [code("REPLICA_URL"), "a streaming replica for reads, behind the replay fence ([[see:scaling]])"],
    [code("BUS=1") + ", " + code("INSTANCE"), "join the change bus, to run several instances on one database; this instance's name"],
    [code("SESSION_COOKIE"), "the sign-in cookie's name, for a second instance on the same machine"],
    [code("SIMPLE_LISTS=1"), "lists of people show everyone at once, as in development and on the demo (a test instance); otherwise they start with a search box"],
    [code("OIDC_ISSUER") + ", " + code("LDAP_URL") + ", " + code("PASSWORDS=0") + ", " + code("PICKER=1"), "how people sign in ([[see:sign-in]])"],
    [code("AI_PROVIDER") + " …", "the copilot: <code>anthropic</code> (Claude: <code>ANTHROPIC_API_KEY</code>, <code>AI_MODEL</code>, <code>AI_EFFORT</code>) or <code>openai</code> (any OpenAI-compatible model: <code>AI_BASE_URL</code>, <code>AI_API_KEY</code>, <code>AI_MODEL</code>); unset, no copilot"],
    [code("MES_SECRET_<NAME>"), "a connection's secret ([[see:ref-security]])"],
    [code("SCRIPT_RUNNER_WRAP") + ", " + code("SCRIPT_ISOLATION=required"), "the script runner's operating-system walls (<code>ops/script-runner-sandbox.sh</code>, Linux), and refusing to start without them ([[see:ref-security]])"],
    [code("OUTBOX=0") + ", " + code("SCHEDULER=0") + ", " + code("NODE_TAGS") + ", " + code("PLANT_TZ"), "what this node runs for integration ([[see:ref-ops]])"],
    [code("EVENT_LOG_DIR"), "where the event log is written (default <code>.local/events</code>)"],
    [code("SEED_BLANK=1"), "for <code>db/reset.mjs</code>: people only"],
]));
add(h2("Sign-in", "sign-in"), `<p>Who may sign in is People & departments' to say: a person active there, nobody else. Someone the plant's identity provider or directory knows, but People & departments does not, is refused by name and told to ask whoever keeps it. How people prove who they are is any of these, together:</p>`
    + table(["Way", "Settings", "Notes"], [
        ["Single sign-on (OpenID Connect)", `${code("OIDC_ISSUER")}, ${code("OIDC_CLIENT_ID")}, ${code("OIDC_CLIENT_SECRET")}`, `Register <code>https://&lt;this site&gt;/login/sso/callback</code> with the provider, or set ${code("OIDC_REDIRECT_URI")}. The authorization code flow with PKCE; the ID token's signature, issuer, audience, expiry and nonce are checked. The sign-in id is the <code>preferred_username</code> claim, or ${code("OIDC_CLAIM")}. ${code("OIDC_LABEL")} names the button. Multi-factor is the provider's.`],
        ["The plant's directory (LDAP, Active Directory)", `${code("LDAP_URL")}, ${code("LDAP_USER_DN")}`, `A bind as the person with the password they typed: <code>ldaps://dc.plant:636</code>, and <code>{user}@plant.local</code> (AD) or <code>uid={user},ou=people,dc=plant,dc=example</code>. ${code("LDAP_CA_FILE")} for a plant CA. <code>ldap://</code> sends passwords in the clear: the server warns.`],
        ["A password of OpenCore MES's own", `on unless ${code("PASSWORDS=0")}`, `For plants without either. IT gives a one-time link, valid 72 hours: <code>node app/mes/db/password.mjs olga --url https://mes.plant</code>. The person sets it there (12 characters at least) and changes it from their name at the top right; a change signs them out elsewhere.`],
        ["The picker", `development, ${code("DEMO=1")}, or ${code("PICKER=1")}`, "Anyone as anyone, no password. Never on an instance others can reach."],
    ])
    + `<p>A person with a password here signs in with it, anyone else through the directory. Five wrong passwords in a row lock the sign-in id for 15 minutes. Sign-ins (and the way), refusals (and why), sign-outs, links and passwords set are in the audit trail under <code>$auth</code>. At start, the server prints the ways that are on. Planned: password ageing, SAML.</p>`);
add(h2("Scaling out", "scaling"), `<ul>
<li><b>A read replica.</b> Writes go to the primary; reads a replica can serve go to it once it has replayed every write this process committed (the replay fence), waiting at most 250 ms before the primary answers instead. Sessions, idempotency keys, the write path and the designer stay on the primary.</li>
<li><b>Several instances.</b> <code>BUS=1</code> on each: every change's targets reach every instance, so a save on one re-runs the open lists on all. Put a balancer in front that keeps a browser on one instance (its live stream and its calls must meet): <code>app/mes/lb.mjs</code> for a trial (<code>LB_PORT</code>, <code>BACKENDS</code>), HAProxy, nginx or a cloud balancer in production, with the same rule. <code>/healthz</code> answers 503 while an instance drains.</li>
<li><b>Nodes for integration.</b> Every instance is a node: it may plan schedules and run triggers. Tag the ones inside the network that reaches ERP (<code>NODE_TAGS=erp</code>) and keep those services to them ([[see:ref-ops]]).</li></ul>
<p><code>app/mes/README.md</code> has the commands and the measurements (a replica took 8.6 times fewer commits off the primary; three instances shared 100 saves a second evenly).</p>`);

// ---- 2 ----
add(h1("How integration works", "concepts"));
add(h2("The two elements", "elements"), table(["Element", "What it is", "Holds"], [
    ["<b>Connection</b>", "An outside system", `its base URL; its authentication (${list(AUTH_KINDS)}) naming a <b>secret</b>; <b>allow</b>, the only requests services may send it; its timeout; its stewards`],
    ["<b>Service</b>", "A script, and what may set it off", "its input; whether it is a web service; its callers; its triggers (record events, schedules); who it acts as; what it may reach (objects and connections); the node tag its runs keep to; its stewards"],
]), `<p>A service is set off four ways, all running the same script the same way: an outside system calls it over HTTP; a person calls it from the designer (<b>Try it</b>); a record event; the clock. Whichever, it runs as the identity its design names, and reaches only what its design declares.</p>`);
add(h2("Data flows", "flows"), `<div class="flow">
<div><b>Inbound</b> ERP → <code>POST /svc/v1/erp_work_order_in</code> (token: user <code>erp</code>) → callers checked → input checked → script → <code>ctx.records.create("work_order", …)</code> as the service's identity → work order's policy, rule pipe, audit → <code>{ output }</code></div>
<div><b>Outbound</b> a lot released (any form, transaction, service or import) → in the same database transaction, an outbox row → after the commit, a node's outbox worker → script → <code>ctx.http("erp", …)</code>: allowed request, secret added on the server → ERP → done, or retried while ERP is down</div>
<div><b>Scheduled</b> the clock → the scheduler plans the run once, whatever the number of nodes → outbox → script with <code>ctx.event.previous.output</code> (its cursor) → its next page at once if it asks for more</div></div>`);
add(h2("Identity: who a service acts as", "identity"), `<p>Its design's <b>Identity</b> tab (${code("runAs")}) says who it acts as. Whoever it is, every record it touches is checked as that identity, exactly as at a form, and the audit names on whose behalf it acted.</p>
${table(["runAs", "Acts as", "Use it when"], [
    [code("service") + " (the default)", `its own identity, ${code("service:<name>")}, holding exactly the object roles its design grants (${code('"roles": { "work_order": ["planner"] }')}), on behalf of its caller or the event`, "almost always: a service can do no more than was approved, whoever calls it; granting a role is approved by that object's stewards"],
    [code("caller"), "whoever called it, with their own rights", "a service people call to do what they could do themselves; never with triggers or schedules (they have no caller)"],
    ["a user id (" + code("erp") + ")", "that integration user, with that user's roles", "an outside system whose rights are managed as a person's"],
])}`);
add(h2("Governance: deny by default, approved by whoever answers", "governance"), `<ul>
<li><b>Callers.</b> Nobody calls a service until its <b>callers</b> name them (users, groups). A refused caller reads who may call and which stewards decide.</li>
<li><b>Reach.</b> A service touches only the objects and operations in ${code("uses.objects")} (${list(SERVICE_OPS)}), only the connections in ${code("uses.connections")}, and runs only the transactions in ${code("uses.transactions")}; it sends a connection only what the connection allows. Anything else is a fault: logged, refused.</li>
<li><b>Approval.</b> A service answers to its own stewards and to the stewards of what it reaches: every object it may write, reacts to, or holds a role on, and every connection it uses. An ERP confirmation of lot releases is approved by whoever stewards the connection and the lot.</li>
<li><b>Audit.</b> Every run, refused or not: who, how (web, UI, trigger, schedule), the input, the output, each request sent (connection, method, path, status, time; never a secret), and any refusal. Every record write inside it is audited as its identity, on behalf of the caller or the event.</li></ul>`);

// ---- 3 ----
add(h1("A first integration, step by step", "tutorial"), `<p>ERP sends work orders to OpenCore MES, and OpenCore MES confirms each released lot to ERP. Four designs in one change request: a connection, a web service, a trigger, their scripts. Then a token for ERP and the secret for the connection.</p>`);
add(proc({
    id: "DV-01", title: "Give ERP an identity and a token", who: "IT",
    purpose: "ERP calls as an integration user; its token says who is calling.",
    before: [`The user ${code("erp")} exists and is active (People &amp; departments). The seed has one.`],
    steps: [
        [`On the server: ${code('node app/mes/db/token.mjs erp "ERP production"')} (with ${code("DATABASE_URL")} set to the plant's database).`, `A token ${code("mes_…")}, scope ${code("service:call")}, printed once. Only its hash is kept.`],
        ["Give the token to ERP's administrators through your secrets process.", "—"],
    ],
    after: "The token only says who calls. Which services that user may call is each service's design (its callers), approved like any change.",
}));
add(proc({
    id: "DV-02", title: "Describe ERP as a connection", who: "Designer",
    purpose: "The outside system, the only requests services may send it, and its credential by name.",
    steps: [
        ["<b>Designer → Services &amp; connections → New connection</b>, name <code>erp</code>, or <b>Add to this change → + connection</b> in an open change.", "The connection's tabs: General, Authentication, Allowed requests, Activity, Stewards."],
        [`<b>General</b>: label, <b>base URL</b> ${code("https://erp.plant.local/api")}; timeout 3000 ms.`, "A URL with a user, a password, a query or a fragment is refused: credentials go in a secret."],
        [`<b>Authentication</b>: ${code("bearer")}, secret ${code("erp_token")}.`, "Only the secret's name is in the design."],
        [`<b>Allowed requests</b>: ${code("POST /confirmations")}.`, "Nothing else may be sent to ERP."],
        ["<b>Stewards</b>: Engineering.", "—"],
    ],
    after: pre(connectionJson),
}));
add(proc({
    id: "DV-03", title: "Write the web service ERP calls", who: "Designer",
    purpose: "ERP sends a work order; it is created through the work order's own policy and rule pipe.",
    before: ["The change from DV-02 is open."],
    steps: [
        [`<b>Add to this change → + service</b>, name ${code("erp_work_order_in")}.`, "Its tabs: General, Input, Identity, Triggers, Reaches, Script, Try it, Activity, Stewards. A script is made with it."],
        ["<b>General</b>: label, description; tick <b>web service</b>.", `Its address will be ${code("POST /svc/v1/erp_work_order_in")}.`],
        ["<b>Input</b>: <code>wo_no</code> string, <code>item</code> string, <code>qty</code> decimal, <code>line</code> choice of L1, L2, L3, all required.", "Each input is checked before the script runs; a bad one answers 400 with the field named."],
        [`<b>Identity</b>: its own service role, holding ${code("work_order")} ${code("planner")}; callers: the user ${code("erp")}.`, "It plans work orders, whoever calls it."],
        [`<b>Reaches</b>: ${code("work_order")}: create.`, "—"],
        ["<b>Script</b>: as below.", "Checked as you type: a syntax error on its line; a call it will not have (a typo, <code>fetch</code>) as a warning."],
        ["<b>Stewards</b>: Production.", "<b>Will need approval from</b> adds the work order's stewards."],
    ],
    after: `${pre(inboundJson)}${pre(inboundScript)}`,
}));
add(proc({
    id: "DV-04", title: "Write the trigger that confirms a released lot", who: "Designer",
    purpose: "After a lot's release commits, ERP is told; retried while ERP is down.",
    steps: [
        [`<b>Add to this change → + service</b>, name ${code("erp_lot_released")}; not a web service.`, "—"],
        [`<b>Triggers</b>: <b>Add trigger</b>, object ${code("lot")}, event ${code("transition:release")}.`, `The events are ${list(RECORD_EVENTS)}, or ${code("transition:<action>")} of the object.`],
        [`<b>Identity</b>: the user ${code("erp")}. <b>Reaches</b>: ${code("lot")}: read; connection ${code("erp")}.`, "A trigger has no caller: it cannot run as its caller."],
        ["<b>Script</b>: as below. A 5xx from ERP throws with <code>retry: true</code>; any other refusal throws with words.", "—"],
    ],
    after: `${pre(outboundJson)}${pre(outboundScript)}`,
}));
add(proc({
    id: "DV-05", title: "Dry-run the scripts and keep test cases", who: "Designer",
    purpose: "Run the drafts as they will run, change nothing, and keep the runs as their evidence.",
    steps: [
        [`Under <code>erp_lot_released</code>'s script, <b>Dry run</b> with an event ${code('{ "kind": "transition:release", "object": "lot", "id": "<a lot id>" }')} and responses ${code('{ "POST /confirmations": { "status": 201, "body": { "id": "DRY-1" } } }')}.`, `Its output ${code('{ "confirmation": "DRY-1" }')}, the lot it read, and the request it would send, with the credential marked “not sent”. Nothing reaches ERP.`],
        [`Again with ${code('{ "POST /confirmations": { "status": 503 } }')}.`, "The error “ERP is unavailable”, marked as asking for a retry."],
        ["Name each run and press <b>Save as test case</b>.", "The script's test cases list them."],
        [`Under <code>erp_work_order_in</code>, dry-run with ${code('{ "wo_no": "WO-2001", "item": "PA66", "qty": 0, "line": "L1" }')}.`, "Refused by the work order's own rule: “The quantity must be more than zero.” A real create goes through the same pipe."],
        ["Again with a quantity of 10; save both as test cases.", "The work order it would create, and nothing created."],
    ],
    after: "A dry run runs as the service will: its own service role with the draft's roles, its user, or its caller (you, or one of its callers standing in). Acting with anyone's rights but your own is audited (<code>dry-run-as</code>).",
}));
add(proc({
    id: "DV-06", title: "Submit, approve, and set the secret", who: "Designer; reviewer; department representatives; IT",
    purpose: "Nothing answers until the change is approved and executed; the outbound call needs its secret.",
    steps: [
        [`Before approval, call ${code("POST /svc/v1/erp_work_order_in")}.`, "404: nothing answers before it is published."],
        ["Write the reason, run the fitness test, submit.", "It passes: the scripts compile and call only what they will have; their test cases pass. <b>Will need approval from</b>: Engineering, Production and Quality: the stewards of the connection, of the services, and of the work order and the lot they reach."],
        ["Review, then approve for each department.", "Executed: the services are live at once, on every node."],
        [`IT sets the secret on every node that may run the trigger: ${code("MES_SECRET_ERP_TOKEN=<ERP's credential>")}, then restarts the node.`, "Secret names are lower case letters, digits and _, up to 48; the variable is the name in upper case after <code>MES_SECRET_</code>."],
    ],
}));
add(proc({
    id: "DV-07", title: "Call it from ERP, and watch it", who: "ERP's developer; designer",
    purpose: "The inbound call, the outbound confirmation, and where to see both.",
    steps: [
        [`${code("GET /svc/v1/openapi.json")} with ERP's token.`, "An OpenAPI 3.1 description of exactly the services this user may call."],
        [`Call it:<br>${code('curl -X POST https://mes.plant.local/svc/v1/erp_work_order_in -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: order-2001" -d \'{"wo_no":"WO-2001","item":"PA66","qty":10,"line":"L1"}\'')}`, `200 ${code('{ "output": { "id": "…", "wo_no": "WO-2001", "state": "planned" } }')}.`],
        ["Send the same request again, same <code>Idempotency-Key</code>.", "The first answer again; no second work order."],
        ["Release a lot (a person, a transaction, anything).", "Within seconds ERP receives <code>POST /confirmations</code>, with the bearer credential."],
        ["Open <b>Design → Integration monitor</b>, and the services' <b>Activity</b> tabs.", "The inbound calls, the outbound requests, the trigger's runs. A failed one can be <b>Send again</b> once ERP is back."],
    ],
}));

// ---- 4 ----
add(h1("Reference", "reference"));
add(h2("Connection", "ref-connection"), table(["Key", "What", "Rules"], [
    [code("name"), "its name", "lower case letters, digits and _"],
    [code("label"), "what people read", "required"],
    [code("baseUrl"), "the system's address", "http:// or https://; no user, password, query or fragment"],
    [code("auth.kind"), "how it authenticates", `${list(AUTH_KINDS)}. <b>bearer</b>: ${code("Authorization: Bearer <secret>")}; <b>basic</b>: the secret is ${code("user:password")}, sent base64; <b>header</b>: the secret in the header ${code("auth.header")} (not host, cookie, content-length, transfer-encoding, connection)`],
    [code("auth.secret"), "the secret's name", `lower case, digits, _; its value is ${code("MES_SECRET_<NAME>")} on the server`],
    [code("allow"), "the only requests services may send", `each ${code('{ "method", "path" }')}: ${list(HTTP_METHODS)}; a path starts with /, a trailing ${code("*")} allows what follows (${code("/orders/*")}), nothing else is a pattern`],
    [code("timeoutMs"), "how long a request may take", "100 to 30 000; 5 000 when left out"],
    [code("stewards"), "the departments that answer for it", "at least one; they approve every service that starts using it"],
]));
add(h2("Service", "ref-service"), table(["Key", "What", "Rules"], [
    [code("name"), "its name; its script has the same", "lower case letters, digits and _"],
    [code("input"), "what a caller sends, typed like fields", `types ${list(FIELD_TYPES)}; ${code("required")}; an enum's ${code("values")}; a ref's ${code("to")}. Text is at most 2 000 characters (or the input's ${code("max")}); a date is ${code("YYYY-MM-DD")}; a ref is a record id`],
    [code("http.enabled"), "a web service", `${code("POST /svc/v1/<name>")}`],
    [code("callers"), "who may call it", `${code('{ "users": [], "groups": [] }')}: nobody until named`],
    [code("on"), "its triggers", `${code('{ "object", "event" }')} with ${list(RECORD_EVENTS)} or ${code("transition:<action>")}; or a schedule ([[see:ref-schedules]])`],
    [code("runAs"), "who it acts as", `${list(RUN_AS)} or a user id ([[see:identity]]); triggers and schedules need ${code("service")} or a user`],
    [code("roles"), "its service role", `${code('{ "<object>": ["<role>"] }')}, roles the object declares; it needs one on every object it reaches`],
    [code("uses.objects"), "what it may do to records", `${code('{ "<object>": [ops] }')}, ops of ${list(SERVICE_OPS)} (<code>archive</code> is archiving and restoring)`],
    [code("uses.transactions"), "the transactions it may run", `${code('["<transaction>"]')}; run as its own service role, each transaction's ${code("callers.services")} names it too, and its stewards approve. Not a signed transaction`],
    [code("uses.connections"), "the connections it may call", "published connections, or ones in the same change"],
    [code("runOn"), "keeps its triggers and scheduled runs to nodes with this tag", "lower case letters, digits, _ and -"],
    [code("stewards"), "the departments that answer for it", "at least one"],
]));
add(h2("The script contract", "ref-script"), `<p>One file, one function of the service's name, context in, context out. Nothing else in the file: no <code>import</code>, no other statement. The new script the designer makes:</p>${pre(SERVICE_TEMPLATE("my_service"))}
${table(["ctx", "What"], [
    [code("ctx.input"), "what the caller sent, checked against the input; empty for a trigger or a schedule"],
    [code("ctx.event"), `a trigger's ${code('{ kind, object, id, by }')} (${code("kind")} is the event, ${code('"transition:release"')}); a schedule's ${code('{ kind: "schedule", scheduledAt, previous: { at, output }, page }')}; ${code("null")} for a call`],
    [code("ctx.user"), `who it acts as: ${code("{ id, name, onBehalfOf }")}`],
    [code("ctx.now"), "the time it started (ISO); use it, not the system clock"],
    [code("ctx.service"), "its name"],
    [code("ctx.output"), "what the caller gets back (a web service answers <code>{ output }</code>); a scheduled run's is kept for the next (its cursor)"],
    [code("ctx.records.get(object, id)"), "a record, or null; needs <code>read</code>"],
    [code("ctx.records.list(object, where)"), "records whose fields equal <code>where</code>'s values; needs <code>read</code>. Found in the database among every record in use its identity may read, the 200 changed last of them; a field it may not read is never filtered on. Without <code>where</code>: the 200 changed last"],
    [code("ctx.records.create(object, data)"), "a new record; needs <code>create</code>"],
    [code("ctx.records.update(object, id, data)"), "changed fields; needs <code>update</code>"],
    [code("ctx.records.action(object, id, action)"), "a transition (<code>release</code>); needs <code>action</code>"],
    [code("ctx.records.archive / restore(object, id)"), "needs <code>archive</code>"],
    [code("ctx.http(connection, { method, path, query, body })"), `a request; answers ${code("{ status, ok, body }")} whatever the status (the script decides what a 404 means)`],
    [code("ctx.transactions.run(name, input, { key })"), `a transaction its design lists in ${code("uses.transactions")}, run as ${code("ctx.user")}: its callers (the service in ${code("callers.services")}, when it runs as its own role), its checks, its steps through each object's policies and rule pipe, all or nothing; answers ${code("{ run, changes, records }")}. A refusal throws with the transaction's words and fields. ${code("key")} (at most 60 characters: the lot's number, the event's id) makes a retried run answer the first. A transaction a person signs is never run by a service. In a dry run it is planned, not run`],
])}
<p>Every record call goes through the object's policies and rule pipe as <code>ctx.user</code>, and is audited. A refused write throws with the object's own words. About <code>ctx.http</code>:</p>
<ul><li>The path is relative to the connection's base URL, starts with /, has no <code>..</code>, <code>//</code>, <code>?</code>, <code>#</code> or backslash; parameters go in <code>query</code>.</li><li>The body is sent as JSON (not with GET); the answer is parsed when it says it is JSON. Answers over 1 MB are refused.</li><li>Redirects are never followed. The connection's credential is added on the server; the script never sees it.</li><li>An unreachable system or a timeout throws a fault that asks for a retry.</li></ul>`);
add(h2("Refusals, faults and retries", "ref-errors"), table(["The script…", "It is", "A caller gets", "A trigger's run is"], [
    [`throws ${code('new Error("words")')}, optionally with ${code("field")} or ${code("fields")}`, "a refusal", "422 with the words and fields", "<b>rejected</b>: retrying would say the same"],
    ["has a record write refused (policy, rule pipe, state)", "a refusal", "422 (403, 404 or 409 as the records said)", "rejected"],
    [`throws with ${code("{ retry: true }")}, or a connection is unreachable`, "the other system is down", "502", "<b>retry</b>, with a growing wait, then <b>dead</b>"],
    ["throws anything else (a TypeError, a call it may not make, a missing secret)", "a fault: a mistake in the design or script", "500 (the words go to the log, not the caller)", "retry, then dead"],
    ["returns its context", "done", `200 ${code("{ output }")}`, "<b>done</b>"],
]), `<p>A trigger's run is claimed for 2 minutes (a node that dies mid-run leaves it to another), and retried after 2, 4, 8, … seconds (at most 5 minutes apart), up to 10 attempts; then it is <b>dead</b>, and the event log says so (<code>trigger.dead</code>). <b>Send again</b> on the service's <b>Activity</b> tab runs a retrying, dead or rejected one again.</p>`);
add(h2("Triggers: exactly once to enqueue, at least once to run", "ref-triggers"), `<ul>
<li>A record write that matches a trigger writes its outbox row <b>in its own database transaction</b>: a committed release always sets the trigger off, a rolled-back one never.</li>
<li>Every node's outbox worker claims due rows with <code>FOR UPDATE SKIP LOCKED</code>, ten at a time: several nodes share the work, none runs a row twice at once.</li>
<li>The service runs as its <b>current</b> published version, as its identity, after the event.</li>
<li>A service never sets itself off; a chain of services setting each other off stops at three.</li>
<li><b>Make the other side idempotent.</b> A run may, rarely, reach it twice (a node dies after ERP answered). Send the event's id (<code>ctx.event.id</code> with the event kind) as the other system's key.</li></ul>`);
add(h2("Schedules", "ref-schedules"), `<p>A schedule is a trigger the clock sets off: structured, not cron.</p>${pre(scheduleJson)}
${table(["Key", "Values"], [
    [code("every"), `${code('{ "minutes": 1–720 }')} or ${code('{ "hours": 1–24 }')}, counted from midnight`],
    [code("at"), `times of day, ${code('["06:00", "14:00"]')}`],
    [code("between"), "narrows <code>every</code> to a window; it may cross midnight"],
    [code("days"), `${list(DAYS)}; all when left out`],
    [code("tz"), `an IANA time zone; the plant's (${code("PLANT_TZ")}) when left out. A time daylight saving skips runs once when it would have been; one that happens twice runs once`],
    [code("missed"), `${list(MISSED)} (the default is <code>last</code>): runs that could not start within a minute of their time; <code>all</code> runs up to ${MAX_CATCH_UP}`],
    [code("overlap"), `${list(OVERLAP)} (the default is <code>skip</code>: nothing is queued while a run is waiting or running)`],
    [code("from"), `instead of <code>every</code>, <code>at</code>, <code>between</code> and <code>days</code>: ${code('"<suite>.<kind>"')}, a kind of schedule an installed suite adds, whose times the suite works out (a shift calendar it keeps, say), with the settings that kind names beside it (${code('{ "from": "<suite>.<kind>", "<setting>": value, "tz": "…" }')}). The designer lists the kinds installed. With the suite removed the service stays published, nothing is planned for that schedule, and the monitor says which suite it needs`],
])}
<p>A run is planned once, however many nodes plan; a schedule seen for the first time is planned from then on. <code>ctx.event.previous</code> is the last successful run (<code>{ at, output }</code>), so a script keeps its cursor in its output. A run that answers <code>output.more: true</code> gets its next page at once (<code>ctx.event.page</code>), up to 100 pages. Pause, resume and <b>Run now</b> are operations in the monitor: audited, not design changes.</p>
<p>A sync by the clock: its connection allows <code>GET /orders</code>, and it reaches <code>work_order</code> with read, create and update.</p>
${pre(pollScript)}`);
add(h2("The web service API", "ref-http"), kv([
    ["Call", `${code("POST /svc/v1/<service>")}, ${code("Content-Type: application/json")}, the input as the body (at most 256 KB)`],
    ["Authenticate", `${code("Authorization: Bearer mes_…")}: a token with the scope ${code("service:call")}`],
    ["Describe", `${code("GET /svc/v1/openapi.json")}: OpenAPI 3.1, only the web services this token's user may call; it changes as changes execute`],
    ["Retry safely", `${code("Idempotency-Key")}: 8 to 100 characters. The same key from the same caller answers the first successful answer again, without running it`],
    ["Answer", `${code('{ "output": … }')}; refused: ${code('{ "error", "fields"?, "code" }')}`],
]), table(["Status", "Means", "code"], [
    ["200", "done", "—"],
    ["400", "bad input (each field named), or a body that is not JSON", code("service.input")],
    ["401", "no token, or a token that is not valid", code("token.missing")],
    ["403", "the token lacks <code>service:call</code>, or its user is not among the service's callers", `${code("scope.missing")}, ${code("service.denied")}`],
    ["404", "no such web service (not published, or not a web service)", "—"],
    ["413 · 415", "the body is over 256 KB · not <code>application/json</code>", "—"],
    ["422", "refused by the script, a rule or a policy: its words, and the fields", code("service.rejected") + " or the rule's"],
    ["500 · 502", "the service failed · a system it depends on could not be reached", code("service.fault")],
]));
add(h2("Limits", "ref-limits"), table(["What", "Limit"], [
    ["A web service request body", "256 KB"],
    ["An answer from a connection", "1 MB"],
    ["A connection's timeout", "100 ms to 30 s (default 5 s)"],
    ["A service run", "200 ms of CPU at a time, 15 s in all, 64 MB of memory; past them it is stopped and fails closed"],
    ["A dry run", "5 s"],
    ["Trigger attempts", "10, waiting 2, 4, 8, … s, at most 5 minutes"],
    ["A chain of services", "3"],
    ["Schedule catch-up", `up to ${MAX_CATCH_UP} missed runs, from the last 7 days`],
    ["Pages of a scheduled run", "100"],
    [code("ctx.records.list"), "with <code>where</code>, the 200 changed last of the matching records its identity may read, among all of them; without, the 200 changed last"],
]));
add(h2("Security", "ref-security"), `<ul>
<li><b>Scripts run apart.</b> Every rule and service script runs in the script runner: a process of its own beside each web process, started with Node's permission model (it reads only the app's files, writes none, starts no process) and an empty environment, so it holds no database address, secret or key. Jobs run in worker threads with a memory limit; one past its deadline is terminated. A script reaches records and systems only through <code>ctx</code>.</li>
<li><b>No network from a script</b> but <code>ctx.http</code>, through a connection's allow list. No <code>fetch</code>, no <code>Math.random</code>: the editor warns about both.</li>
<li><b>Secrets</b> are set on the server (${code("MES_SECRET_<NAME>")}), never in a design, a review, the copilot's context or the audit. Changing a value is operations; changing which secret a connection uses is a design change.</li>
<li><b>Tokens</b> are shown once and kept as a hash; a designer revokes an AI token in <b>AI access</b>.</li>
<li><b>Public demos and sandboxes</b> reach no outside system: a call is refused, saying so.</li></ul>
<p><b>The operating system's walls are each installation's to turn on.</b> What the product does everywhere stops at Node's walls and the script's context. On Linux, add the kernel's: install bubblewrap (<code>apt-get install bubblewrap</code>) and, on Ubuntu 23.10 and later, its AppArmor profile (<code>install -m 0644 ops/script-runner-sandbox.apparmor /etc/apparmor.d/open-mes-bwrap &amp;&amp; apparmor_parser -r /etc/apparmor.d/open-mes-bwrap</code>: those versions refuse user namespaces without one, which is also why <code>unshare -r -n</code> fails there); then set ${code("SCRIPT_RUNNER_WRAP=ops/script-runner-sandbox.sh")}. The runner then has a network namespace with loopback only, a read-only file system of the libraries, Node and the app's code, and no capabilities.</p>
<p><b>Check it by what the runner finds.</b> At start it reports whether it sees any network and the sandbox it is in: the start log says <code>scripts: isolated (bwrap): no network, …</code>, and <code>/healthz</code> shows <code>"scripts": {"network": "none", "sandbox": "bwrap", …}</code>. <code>"network": "host"</code> means the walls are not there (a production instance also writes <code>scripts.unisolated</code> to its event log). Once they hold, set ${code("SCRIPT_ISOLATION=required")}: the instance refuses to start without them.</p>
${note("Until <code>SCRIPT_RUNNER_WRAP</code> is set, and <code>/healthz</code> shows <code>\"network\": \"none\"</code>, a script that found a way out of its context would have the host's network (though no credentials). Off Linux there is no wrapper.", "warn")}`);
add(h2("Testing", "ref-testing"), `<ul>
<li><b>As you type:</b> the script is parsed in the browser (never run there); syntax errors are marked on their line anywhere; calls the script will not have are warned about.</li>
<li><b>Dry run:</b> executed on the server as the service will run: real reads; writes through policy and the rule pipe, not saved; requests checked and answered from <code>responses</code> (<code>{ "POST /confirmations": { status, body } }</code>), never sent. A runtime error is marked on its line.</li>
<li><b>Test cases</b> (<b>Save as test case</b>, or written): ${code('{ name, run: { input } | { event, responses }, as?, expect: { ok?, output?, error?, writes?, requests? } }')}. A new or changed script without one, or with a failing one, fails the fitness test, which runs them all on submit.</li>
<li><b>End to end:</b> <code>app/mes/test/integration.mjs</code> designs, approves and calls an ERP integration against a fake ERP (wrong caller, bad input, a rule's refusal, a retry by key, a confirmation while ERP is down); <code>app/mes/test/scheduler.mjs</code> proves the schedules. Both run in <code>npm run test:all</code>.</li></ul>`);
add(h2("Running it: nodes, settings, the monitor", "ref-ops"), table(["Setting", "What"], [
    [code("MES_SECRET_<NAME>"), "a connection's secret, on every node that runs its services"],
    [code("NODE_TAGS=erp,plant1"), "this node's tags; a service with <code>runOn: \"erp\"</code> has its triggers and scheduled runs run only on nodes tagged <code>erp</code> (inside the network that reaches ERP). Calls from outside run wherever they arrive"],
    [code("SCHEDULER=0"), "this node plans no schedules"],
    [code("OUTBOX=0"), "this node runs no triggers or scheduled runs"],
    [code("PLANT_TZ"), "the plant's time zone, for schedules that name none"],
]), `<p>Every node reports itself every 10 s. The <b>integration monitor</b> (<code>/design/integration</code>) shows the nodes (and warns when none plans schedules or runs the outbox, or none has a service's tag), the schedules (next and last run, totals, queue; Pause, Resume, Run now), inbound calls and outbound requests of the last 24 hours, and the record triggers' queues. The event log has <code>trigger.dead</code>, <code>schedule.missed</code>, <code>schedule.skipped</code>, <code>schedule.paused</code>, <code>schedule.resumed</code>, <code>schedule.suite_missing</code> (a schedule from a suite that is not installed) and <code>schedule.suite_failed</code> (an installed suite could not give a schedule's times: nothing was planned for it then).</p>`);

// ---- 5 ----
add(h1("Recipes", "recipes"));
add(h2("Inbound without duplicates", "r-idempotent"), `<p>Have the caller send an <code>Idempotency-Key</code> per business message (the order number and its revision). Inside the script, guard on the natural key too, for a message sent again under another key:</p>${pre(`const [known] = await ctx.records.list("work_order", { wo_no: ctx.input.wo_no });
if (known) { ctx.output = { id: known.id, state: known.state, existed: true }; return ctx; }`)}`);
add(h2("Saying no with the right field", "r-fields"), `<p>Throw with the input it is about; a caller reads 422 with the field named, as a form does:</p>${pre(`if (ctx.input.qty > 10000) throw Object.assign(new Error("At most 10 000 per order."), { field: "qty" });`)}`);
add(h2("Down is not no", "r-retry"), `<p>Tell a system that is down (5xx, unreachable) from one that refuses (4xx). Throw with <code>retry: true</code> only for the first: a trigger is retried; a refusal is final, and its words are kept.</p>`);
add(h2("Choosing the identity", "r-identity"), `<p>Prefer the service's own role: what it may do is on the service, approved by the stewards of each object it touches, and does not grow when someone gives the integration user another role. Use a named user when your plant manages the outside system's rights as a person's. Use the caller only for services people call to do, faster, what they may do anyway.</p>`);
add(h2("Keeping a run inside the right network", "r-runon"), `<p>Give the nodes inside the network that reaches ERP a tag (<code>NODE_TAGS=erp</code>) and the service <code>runOn: "erp"</code>; the monitor warns when no live node has the tag.</p>`);

// ---- 6 ----
add(h1("Other ways in", "other"));
add(h2("The AI design API", "ai"), `<p>An AI works in the designer as the person whose token it holds (§16.8): it reads, drafts, checks, tests and dry-runs, and never reviews or approves. Tokens are issued in <b>Designer → AI access</b>, with scopes of ${list(SCOPES.filter((s) => s !== "service:call"))} (submitting is optional). ${code("GET /ai/v1/openapi.json")} describes it; ${code("node app/mes/test/ai-agent.mjs")} is an agent's whole loop.</p>
${table(["Route", "Does"], [
    ["GET /me · /contract · /catalog", "who the token is; the design contract (and the published contracts' names); the plant's model"],
    ["GET /contracts/{name}", "a published contract (<code>docs/contracts</code>: <code>equipment-adapter</code>), its specification, schema and conformance kit"],
    ["GET /objects/{name} · /scripts/{name} · /flows/{name}", "a live design"],
    ["GET · POST /changes; GET · PUT /changes/{id}", "list and start changes; read and save a draft"],
    ["GET /model · POST /model/preview · /model/changes", "every published design as one model file (no records, secrets or history); what a model file would change here; one change request from it"],
    ["POST /changes/{id}/include", "bring a live object, transaction, screen, flow, service or connection into a change, to change several together (one review, one approval per department)"],
    ["POST /validate · /scripts/{name}/test · /pipe/run · /access/simulate · /dry-run", "check a draft; run a script's tests; run a rule pipe; simulate access; dry-run a service"],
    ["POST /flows/check · /flows/layout · /flows/explain · /flows/walk · /scenarios/try", "flow templates and their scenarios; an input flow walked with sample values"],
    ["POST /changes/{id}/fitness · /changes/{id}/submit", "run the fitness test; submit (with the scope)"],
])}<p>Requests are JSON; a token sending too many is answered 429.</p>`);
add(h2("Versions and notice", "versions"), `<p>${code("/ai/v1")} and ${code("/svc/v1")} keep what they promise for as long as ${code("/v1")} runs: the contract ${code("docs/contracts/http-apis")} writes it down (every ${code("/ai/v1")} operation with its scope and the fields it reads; the ${code("/svc/v1")} envelope, its statuses and its error body ${code("{ error, code?, fields? }")}). A new version may add; nothing promised leaves ${code("/v1")} (that is ${code("/v2")}, beside it).</p>
<ul><li><b>Every answer</b> carries ${code("API-Version: 1.0")}.</li>
<li><b>Notice first.</b> What ${code("/v1")} will lose is marked deprecated at least 180 days before it goes; each answer to it then carries ${code("Deprecation")} (when it was deprecated), ${code("Sunset")} (the date after which it may go) and ${code("Link")} (its successor). Log them, and move before the sunset. Nothing is deprecated today.</li>
<li><b>A plant's web services</b> are the plant's promise to you. A change that would break a caller who called in the last 30 days is refused at the plant's review unless the plant gave notice first: the service then answers you with the same headers until its sunset, and its OpenAPI description says until when and what to use instead.</li></ul>
<p>Check an instance yourself, changing nothing: ${code("node docs/contracts/http-apis/kit.mjs --url <the MES> --token <a token>")} (add ${code("--service <name> --input <json>")} to try a call and its retry; ${code("--json")} for a program).</p>`);
add(h2("Excel import and export", "excel"), `<p>Records go in and out as spreadsheets from <b>Data → Import / export</b>, through the same forms' checks, as the person importing: what an object's design allows (create, update, the key rows are matched by). See the user guide, section 13.</p>`);
add(h2("What is not an interface", "internals"), `<p>The browser's own calls (<code>/api/…</code>) and the database are internals: they change without notice and are not to be built on. Integrate through web services, connections, the AI API, or files.</p>`);
add(h2("Planned", "planned"), note(`<b>Versioned contracts</b> (§31): <code>/svc/v1</code> and <code>/ai/v1</code> versioned with notice before anything they promise changes, an extension API for suites (<code>core-api</code>), and a conformance kit and machine-readable schema for each. <b>Equipment integration</b> (§30): adapters (SECS/GEM over HSMS first, then OPC UA and MQTT) turning machine events into records' states through the same rules and audit, with an adapter contract and a simulator. <b>Equipment data collection</b> (§15.1): high-rate machine data outside the MES, which receives only derived events. None of these is built.`, "planned"));

// ---- appendix ----
add(h1("Appendix", "appendix"));
add(h2("Review checklist for a service change", "checklist"), `<table class="steps"><thead><tr><th class="n">#</th><th>Check</th><th class="ok">OK</th></tr></thead><tbody>${[
    "Its identity is the least that works: its own role with only the roles it needs, or a user whose roles are known.",
    "Its callers name exactly who may call it.",
    "<code>uses</code> holds only the objects, operations, connections and transactions the script uses.",
    "Each connection allows only the requests the services send.",
    "Down (retry) and no (words) are told apart; refusals name the field.",
    "The other side is idempotent for triggers: the event's id is sent.",
    "Its test cases cover a good run, a refusal, and the other system down.",
    "No secret, address or credential is in the script or the design.",
    "<code>runOn</code> keeps it to nodes that can reach its systems, and some live node has that tag.",
].map((c, i) => `<tr><td class="n">${i + 1}</td><td>${c}</td><td class="ok"></td></tr>`).join("")}</tbody></table>`);
add(h2("Where it is in the code", "code-map"), table(["File", "What"], [
    ["app/mes/server/integration.js", "running services, the outbox worker, schedules, the /svc/v1 handler, the monitor"],
    ["app/mes/client/definition.js", "validateConnection, validateService, the footprint (who approves)"],
    ["app/mes/client/schedule.js", "the schedule format, its checks, next runs"],
    ["app/mes/server/script-runner.mjs, script-worker.mjs", "where scripts run, and their limits"],
    ["app/mes/server/fitness.js", "test cases and the fitness test"],
    ["app/mes/server/ai-api.js", "tokens, the /ai/v1 API"],
    ["app/mes/db/token.mjs", "issuing an integration user's token"],
    ["app/mes/test/integration.mjs, scheduler.mjs", "the end-to-end proof"],
]));
add(h2("Revision history", "history"), table(["Revision", "Date", "What changed"], [["A", "2026-10-02", "First issue: services and integration."], ["B", "2026-10-03", "Installing OpenCore MES: development, a server, upgrades, settings, scaling."], ["C", "2026-10-03", "A service's ctx.records.list(object, where) finds matching records among all of them, not only the 200 changed last."], [REVISION, ISSUED, "OpenCore MES is no longer described as a proof of concept: the guide applies to the platform as built."]]));

// ---- the page ----
const tocHtml = `<nav class="toc"><h2>Contents</h2><ol>${toc.filter((t) => t.level < 3).map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.title)}</a></li>`).join("")}</ol>
<h3>Procedures</h3><ol class="procs">${toc.filter((t) => t.level === 3).map((t) => `<li><a href="#${t.id}">${esc(t.title)}</a></li>`).join("")}</ol></nav>`;
const cover = `<section class="cover">
  <p class="doc-no">${DOC} · Revision ${REVISION}</p>
  <h1 class="title">OpenCore MES</h1>
  <p class="subtitle">Developer's guide<br>Installation, services and integration</p>
  ${kv([["Document", DOC], ["Revision", `${REVISION}, issued ${ISSUED}`], ["Applies to", "OpenCore MES, the platform as built on the issue date"]])}
</section>`;
const css = `
@page { size: A4; margin: 16mm 14mm 18mm; }
:root { --ink: #141821; --muted: #5b6474; --line: #d6dbe3; --soft: #f3f5f8; --accent: #2b303a; --warn: #8a4b00; --warn-soft: #fff4e0; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 900px; padding: 24px 16px; color: var(--ink); background: #fff; font: 10.5pt/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
h1.part { font-size: 20pt; margin: 0 0 10px; padding-top: 4px; border-bottom: 2px solid var(--ink); break-before: page; }
h2 { font-size: 14pt; margin: 22px 0 8px; break-after: avoid; }
h3 { font-size: 12pt; margin: 18px 0 6px; break-after: avoid; }
p, ul { margin: 0 0 8px; }
li { margin: 2px 0; }
code { font: 8.6pt/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--soft); padding: 0 3px; border-radius: 3px; overflow-wrap: anywhere; }
code.n { white-space: nowrap; overflow-wrap: normal; }
pre { font: 8.4pt/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; break-inside: avoid; margin: 6px 0 10px; }
a { color: var(--accent); text-decoration: none; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; font-size: 9pt; }
th, td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
thead th { background: var(--soft); }
tr { break-inside: avoid; }
table.kv th { width: 24%; background: var(--soft); font-weight: 600; }
.callout { border-left: 4px solid var(--accent); background: var(--soft); padding: 6px 10px; margin: 8px 0; font-size: 9.5pt; break-inside: avoid; }
.callout.warn, .callout.planned { border-left-color: var(--warn); background: var(--warn-soft); }
.flow { display: grid; gap: 6px; margin: 6px 0 12px; }
.flow div { border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 4px; padding: 6px 10px; font-size: 9.5pt; background: var(--soft); }
.proc { border: 1.5px solid var(--ink); border-radius: 6px; padding: 10px 12px; margin: 14px 0; }
.proc-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 6px; break-after: avoid; }
.proc-id { font-weight: 700; background: var(--ink); color: #fff; padding: 1px 8px; border-radius: 4px; font-size: 9.5pt; }
.proc-title { font-weight: 700; font-size: 12pt; }
table.steps td.n, table.steps th.n { width: 26px; text-align: center; }
table.steps td.ok, table.steps th.ok { width: 52px; }
.proc-after { font-size: 9.5pt; }
.cover { min-height: 250mm; display: flex; flex-direction: column; justify-content: center; }
.cover .doc-no { color: var(--muted); letter-spacing: .06em; }
.cover .title { font-size: 34pt; margin: 6px 0; border: 0; break-before: auto; }
.cover .subtitle { font-size: 15pt; color: var(--muted); margin-bottom: 26px; }
.toc { break-before: page; }
.toc ol { padding-left: 18px; }
.toc li.l1 { font-weight: 700; margin-top: 6px; }
.toc li.l2 { margin-left: 14px; font-weight: 400; }
@media screen { body { padding-top: 32px; } h1.part { margin-top: 48px; } }
@media print { a { color: var(--ink); } }
`;
const numbered = (text) => text.replace(/\[\[see:([\w-]+)\]\]/g, (_, id) => { const t = toc.find((x) => x.id === id); if (!t) throw new Error(`see(${id}): no such section`); return `<a href="#${id}">${esc(t.title.split(" ")[0].replace(/\.$/, ""))}</a>`; });
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCore MES developer's guide</title><style>${css}</style></head>
<body>${cover}${tocHtml}${numbered(body.join("\n"))}</body></html>`;
const out = path.join(HERE, `${NAME}.html`);
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024).toFixed(0)} KB, ${toc.filter((t) => t.level === 3).length} procedures`);

if (process.argv.includes("--pdf")) {
    const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const port = 9700 + Math.floor(Math.random() * 200);
    const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "devguide-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let target = null;
    for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {} }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0; const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id, method, params })); });
    try {
        await cdp("Page.enable");
        await cdp("Page.navigate", { url: pathToFileURL(out).href });
        await sleep(1500);
        const footer = `<div style="font: 7.5pt sans-serif; color: #666; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;"><span>${DOC} rev. ${REVISION} · OpenCore MES developer's guide</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
        const pdf = await cdp("Page.printToPDF", { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer });
        writeFileSync(path.join(HERE, `${NAME}.pdf`), Buffer.from(pdf.data, "base64"));
        console.log(`${path.join(HERE, `${NAME}.pdf`)}: ${(Buffer.from(pdf.data, "base64").length / 1024).toFixed(0)} KB`);
    } finally { ws.close(); chrome.kill(); }
}
