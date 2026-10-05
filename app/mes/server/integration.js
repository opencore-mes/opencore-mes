// Integration (DESIGN.md §15.2): services and connections the designer creates, injected into the
// running plant when their change executes, with no deploy and no restart.
//
// A service is a script, named as the service, with the rule-script contract: context in, context
// out, throw to reject. It is set off three ways, all by the same `run`:
//   - over HTTP, by an outside system (a web service): POST /svc/v1/<name> with a bearer token;
//   - from the UI, by a signed-in person (`integration.call`);
//   - by a record event (a trigger): the event's transaction writes a row to the outbox, and the
//     worker runs the service after, as the service's integration user, retrying while the outside
//     system is down.
//
// The governance is an object's (§5, §9): nobody may call a service or reach a connection until an
// approved change names them. A service acts as whoever set it off (the caller, or its integration
// user): every record it reads or writes goes through the generic services, so the policy engine,
// the object's rule pipe and the audit trail apply to it exactly as to a person at a form. It may
// only touch the objects and connections its design declares, and send a connection only the
// requests the connection allows. Every run is audited, refused or not.
//
// Scripts run in the script runner (script-runner.mjs, §12.4), a process of its own with no credentials,
// as rule scripts do; running it as an OS user without network is the deployment's part, not done yet.
import { CALL_KIND } from "../../../src/live-protocol.js";
import { ServiceError, fail } from "../../../src/errors.js";
import { isFault } from "../client/pipe.js";
import { pathAllowed, IDENTIFIER, serviceIdentity } from "../client/definition.js";
import { runServiceScript, runDryScript } from "./rules.js";
import { isSchedule, isSuiteSchedule, suiteSettings, suiteOf, scheduleProblems, runsOf, describeSchedule, MAX_CATCH_UP } from "../client/schedule.js";
import { appendAudit } from "./audit.js";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { apiContract } from "./api-contract.js";

// A path a script may not ask a connection for: the allow list is matched on the path as written,
// and the URL parser then reads "%2e%2e" as "..", drops tabs and newlines, and reads "\" as "/", so
// "/orders/%2e%2e/admin" would pass a list that allows /orders/* and be sent to /admin, with the
// connection's credential. None of those is written in a path; the query goes in req.query.
export const badConnectionPath = (path) => typeof path !== "string" || !path.startsWith("/") || path.includes("..") || path.includes("//") || /[?#\\]|%2e|%2f|%5c|[\u0000-\u0020\u007f]/i.test(path);
// The address a path names under a connection's base, or null when it is not under it: what is sent
// is the path that was checked, read by the parser that sends it.
export function connectionUrl(baseUrl, path) {
    const base = new URL(baseUrl);
    const root = base.pathname.replace(/\/+$/, "");
    const url = new URL(baseUrl.replace(/\/+$/, "") + path);
    const plain = (text) => { try { return decodeURI(text); } catch { return null; } };
    return url.origin === base.origin && plain(url.pathname) !== null && plain(url.pathname) === plain(root + path) ? url : null;
}

// ---- where a connection may lead (COMPLIANCE.md G14) -------------------------------------------
// What kind of address this is: "link-local" (169.254.0.0/16, fe80::/10: a cloud's metadata service
// lives there, and hands out the machine's credentials), "unspecified" (0.0.0.0, ::), "loopback",
// "private" or "public". An IPv4 address written as IPv6 (::ffff:a.b.c.d) is read as the IPv4 one.
export function addressKind(ip) {
    let a = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) a = mapped[1];
    if (isIP(a) === 4) {
        const [x, y] = a.split(".").map(Number);
        if (x === 0) return "unspecified";
        if (x === 127) return "loopback";
        if (x === 169 && y === 254) return "link-local";
        if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127)) return "private";
        return "public";
    }
    if (isIP(a) === 6) {
        if (a === "::") return "unspecified";
        if (a === "::1") return "loopback";
        if (/^fe[89ab]/.test(a)) return "link-local";
        if (/^f[cd]/.test(a)) return "private";
        return "public";
    }
    return null;
}
// Whether a host is on the plant's list: its name as written, or "*.plant.local" for every name under one.
export const hostListed = (host, list) => (list ?? []).some((entry) => {
    const [h, want] = [String(host).toLowerCase(), String(entry).trim().toLowerCase()];
    return want.startsWith("*.") ? h.endsWith(want.slice(1)) && h.length > want.length - 1 : h === want;
});
// May a connection be sent to this address? → null, or why not. `hosts` is the plant's list
// (MES_CONNECTION_HOSTS): given, only those hosts are reached; not given, any host is, as a plant's
// systems sit on its own network. Either way a host that leads to a link-local or unspecified address
// is refused unless the list names it: no ERP lives there, a cloud's metadata service does.
export async function addressProblem(url, options = {}) {
    return (await addressOf(url, options)).problem;
}
// The same, with the address the request is then sent to: { problem, address, family }. The host is
// looked up once, here, and the request goes to the address that was checked (sendTo), so a name that
// answers one address to the check and another to the request gains nothing.
export async function addressOf(url, { hosts = null, resolve = (host) => lookup(host, { all: true }) } = {}) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const listed = hostListed(host, hosts);
    if (hosts && !listed) return { problem: `${host} is not among the hosts this server's connections may reach (MES_CONNECTION_HOSTS)` };
    let addresses;
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host); } catch { return { problem: null }; } // unknown to DNS: the request says so itself
    const bad = listed ? null : addresses.map((x) => addressKind(x.address)).find((kind) => kind === "link-local" || kind === "unspecified");
    if (bad) return { problem: `${host} is a ${bad} address, where no outside system is: a connection is not sent there unless this server's list of hosts names it (MES_CONNECTION_HOSTS)` };
    const first = addresses[0];
    return { problem: null, address: first?.address ?? null, family: first?.family ?? (first ? isIP(first.address) : null) };
}
// One request, sent to `address` when given (the one that was checked), under the host's own name (its
// certificate, its Host header). Never follows a redirect. → { status, type, body: the response to read }.
export function sendTo(url, { method, headers, body, timeoutMs, address = null, family = null }) {
    return new Promise((resolve, reject) => {
        const pinned = address ? { lookup: (_host, options, done) => (options?.all ? done(null, [{ address, family: family ?? isIP(address) }]) : done(null, address, family ?? isIP(address))) } : {};
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers: { ...headers, ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}) }, signal: AbortSignal.timeout(timeoutMs), ...pinned }, (res) => {
            resolve({ status: res.statusCode, type: String(res.headers["content-type"] ?? ""), body: res });
        });
        req.on("error", reject);
        req.end(body);
    });
}

const PREFIX = "/svc/v1";
const MAX_BODY = 256 * 1024;
const MAX_RESPONSE = 1024 * 1024;
// A fault is tried again after 2, 4, 8… seconds, at most 5 minutes apart: ten attempts span about a
// quarter of an hour, so an outside system that is down for a few minutes does not leave every trigger
// dead (six attempts gave up after one minute).
const MAX_ATTEMPTS = 10;
export const retryWait = (attempts) => Math.min(300, 2 ** Math.min(attempts, 10));
const MAX_CHAIN = 3;
// Schedules (§15.3): a run due longer ago than this was missed (not merely noticed a little late);
// runs further back than the catch-up window are counted, not run; a scheduled run that asks for
// more (ctx.output.more) gets at most this many pages; a node unseen this long is gone.
const ON_TIME_MS = 60_000;
const CATCH_UP_WINDOW_MS = 7 * 86_400_000;
// How long a suite's kind of schedule may take to give its times (§30.11): past it, it gave none, so
// one slow suite never holds the scheduler up.
const SUITE_RUNS_MS = 5000;
const MAX_PAGES = 100;
const NODE_GONE_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// A mistake in the design or the script, not the caller's: its words go to the log, not to them.
const fault = (message, extra = {}) => Object.assign(new Error(message), { fault: true, ...extra });

// ---- the triggers' side of a record write ----------------------------------------------------------
// Called inside a record write's transaction (services.js): one outbox row per service whose trigger
// matches. `origin` is set when the write was a service's own, so it never sets itself off.
export function createTriggers(store) {
    return {
        async enqueue(tx, { object, event, id, by, origin }) {
            const chain = origin?.chain ?? [];
            if (chain.length >= MAX_CHAIN) return;
            for (const [name, s] of await store.services()) {
                if (!(s.body.on ?? []).some((t) => t.object === object && t.event === event)) continue;
                if (chain.includes(name) || serviceIdentity(s.body) === "caller") continue;
                await tx.query(
                    "INSERT INTO mes.integration_outbox (service, event, run_as, chain, run_on) VALUES ($1, $2, $3, $4, $5)",
                    [name, JSON.stringify({ kind: event, object, id, by }), serviceIdentity(s.body), JSON.stringify(chain), s.body.runOn ?? null],
                );
            }
        },
    };
}

// Who a service acts as (§15.2), resolved the same way for a real run, a dry run and a test case:
//   "service"  its own identity, service:<name>, holding exactly the roles its design grants, on
//              behalf of its caller (or of the event that set it off);
//   "caller"   whoever called it (a record event has no caller: refused);
//   a user id  that user, on behalf of the caller or the event.
// `store` resolves a user; `caller` is the person or system that set it off, or null for an event.
export async function resolveIdentity(store, body, { caller = null, event = null } = {}) {
    const mode = serviceIdentity(body);
    const onBehalfOf = caller?.id ?? onBehalfOfEvent(event);
    if (mode === "service") return { id: `service:${body.name}`, name: `${body.label ?? body.name} (service)`, serviceRoles: isPlain(body.roles) ? body.roles : {}, onBehalfOf };
    if (mode === "caller") {
        if (!caller) throw fault(`service ${body.name} runs as its caller, and a record event has none: give it its own service role, or a user`);
        return caller;
    }
    const user = await store.user(mode);
    if (!user) throw fault(`service ${body.name} runs as ${mode}, who is not an active user`, { permanent: true });
    return { ...user, onBehalfOf };
}

// Whom a run set off by an event acts for: the record event, or the schedule and the time it was due.
const onBehalfOfEvent = (event) => (!event ? null : event.kind === "schedule" ? `schedule:${event.scheduledAt ?? "?"}${event.manual ? " (run now)" : ""}` : `event:${event.object ?? "?"} ${event.kind ?? ""}`.trim());

// Input as the service declares it (the object field types): { values, problems }.
function checkInput(spec, input) {
    const values = {};
    const fields = {};
    for (const [name, field] of Object.entries(spec ?? {})) {
        const value = input?.[name];
        if (value === undefined || value === null || value === "") {
            if (field.required) fields[name] = `${field.label ?? name} is required.`;
            continue;
        }
        const bad = {
            integer: !Number.isInteger(value), decimal: typeof value !== "number" || !Number.isFinite(value), boolean: typeof value !== "boolean",
            date: typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value), enum: !(field.values ?? []).includes(value),
            ref: typeof value !== "string" || !UUID.test(value),
        }[field.type] ?? (typeof value !== "string" || value.length > (field.max ?? 2000));
        if (bad) fields[name] = `${field.label ?? name}: ${field.type === "enum" ? `one of ${field.values.join(", ")}` : `a ${field.type}`}.`;
        else values[name] = value;
    }
    return { values, fields: Object.keys(fields).length ? fields : null };
}

// createIntegration({ store, records, tokens, secrets, invalidate, log, events, node, plantTz, now })
// `events` (event-log.js) is told of a trigger given up on, and of schedules missed, skipped, paused.
//   node        this instance: { name, tags, scheduler, outbox, build }. It plans schedules only when
//               `scheduler`; it claims only outbox rows with no `run_on`, or one of its `tags`
//   plantTz     the plant's time zone, for a schedule that names none
//   now         the clock (ms), for the scheduler; a test passes its own
//   records     the generic record services (services.js), called as the service's caller
//   tokens      the bearer tokens (ai-api.js createTokens): an outside caller's, with scope service:call
//   secrets     (name) → the credential's value, or undefined: the entry reads them from its environment
//   invalidate  (targets) → the server's own (Juris), so a service's writes reach every open page
// `outbound: false` (a public demo): services reach no outside system; a call is refused, said why.
export function createIntegration({ store, records, recordTargets = ({ object, id }) => [{ name: "records.list", where: { object } }, { name: "records.get", where: { object, id } }], tokens, secrets = () => undefined, invalidate = async () => {}, log = console, events = null, node = {}, plantTz = "UTC", now = () => Date.now(), outbound = true, connectionHosts = null, contract = apiContract({ onDeprecatedUse: (api, operation, who, notice) => events?.emit("api.deprecated", { severity: "warning", message: `${who} called ${api} ${operation}, deprecated since ${notice.since}; its sunset is ${notice.sunset}.`, details: { api, operation, who, ...notice } }) }) }) {
    const { db } = store;
    const self = { name: node.name ?? "local", tags: Array.isArray(node.tags) ? node.tags : [], scheduler: node.scheduler !== false, outbox: node.outbox !== false, build: node.build ?? null, startedAt: new Date().toISOString() };

    async function mayCall(service, user) {
        const callers = service.body.callers ?? {};
        if ((callers.users ?? []).includes(user.id)) return true;
        if (!(callers.groups ?? []).length) return false;
        const groups = await db.query("SELECT group_id FROM mes.group_members WHERE user_id = $1", [user.id]);
        return groups.some((g) => callers.groups.includes(g.group_id));
    }

    // A request to a connection, checked as the service's design and the connection's allow it:
    // { conn, method, path, url, body }. The same checks for a real run and a dry run.
    function prepare(service, name, req, connectionOf) {
        if (!(service.body.uses?.connections ?? []).includes(name)) throw fault(`service ${service.body.name} may not use connection "${name}": add it to the service's uses.connections`);
        const conn = connectionOf(name);
        if (!conn) throw fault(`connection "${name}" is not published`);
        const method = String(req?.method ?? "GET").toUpperCase();
        const path = String(req?.path ?? "/");
        if (badConnectionPath(path)) throw fault(`a bad path for connection ${name}: ${path} (the query goes in req.query)`);
        if (!(conn.body.allow ?? []).some((a) => a.method === method && pathAllowed(a.path, path))) throw fault(`${method} ${path} is not allowed on connection ${name}`);
        const url = connectionUrl(conn.body.baseUrl, path);
        if (!url) throw fault(`${path} leaves connection ${name}`);
        if (isPlain(req?.query)) for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
        return { conn, method, path, url, body: req?.body !== undefined && method !== "GET" ? req.body : undefined };
    }

    // One request to a connection, sent.
    async function request(service, name, req, calls) {
        const connections = await store.connections();
        const { conn, method, path, url, body: payload } = prepare(service, name, req, (n) => connections.get(n));
        if (!outbound) {
            calls.push({ connection: name, method, path, status: null, ms: 0 });
            throw fault(`connection ${name}: calls to outside systems are off in this public demo`);
        }
        const headers = { accept: "application/json" };
        const auth = conn.body.auth ?? { kind: "none" };
        if (auth.kind !== "none") {
            const secret = secrets(auth.secret);
            if (!secret) throw fault(`the secret "${auth.secret}" of connection ${name} is not set on this server`);
            if (auth.kind === "bearer") headers.authorization = `Bearer ${secret}`;
            else if (auth.kind === "basic") headers.authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
            else headers[auth.header] = secret;
        }
        let body;
        if (payload !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(payload);
        }
        const where = await addressOf(url, { hosts: connectionHosts });
        if (where.problem) throw fault(`connection ${name}: ${where.problem}`);
        const started = Date.now();
        let res;
        try {
            // Never followed: a redirect could lead anywhere, and the allow list names this system's paths.
            res = await sendTo(url, { method, headers, body, timeoutMs: conn.body.timeoutMs ?? 5000, address: where.address, family: where.family });
        } catch (error) {
            calls.push({ connection: name, method, path, status: null, ms: Date.now() - started });
            throw fault(`connection ${name} could not be reached (${error?.code ?? error?.cause?.code ?? error?.name ?? "error"})`, { retry: true });
        }
        // Read only as far as the limit: an answer without end is dropped there, not held in memory first.
        let text = "";
        let size = 0;
        const decoder = new TextDecoder();
        try {
            for await (const chunk of res.body) {
                size += chunk.length;
                if (size > MAX_RESPONSE) { res.body.destroy(); break; }
                text += decoder.decode(chunk, { stream: true });
            }
            text += decoder.decode();
        } catch (error) {
            calls.push({ connection: name, method, path, status: res.status, ms: Date.now() - started });
            throw fault(`connection ${name} stopped answering part-way (${error?.code ?? error?.name ?? "error"})`, { retry: true });
        }
        calls.push({ connection: name, method, path, status: res.status, ms: Date.now() - started });
        if (size > MAX_RESPONSE) throw fault(`connection ${name} answered more than ${MAX_RESPONSE} bytes`);
        let parsed = text;
        if (res.type.includes("json")) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
        }
        // Not an exception: the script decides what a 404 or a 409 from the other system means.
        return { status: res.status, ok: res.status >= 200 && res.status < 300, body: parsed };
    }

    // What the installed suites give a service's script (§30.11): suite → { name: fn | { run, dry } },
    // reached as ctx.<suite> (a - in its name written _) by a service whose design allows it,
    // `uses.suites: { <suite>: [names] }`, and only those it names. `info` says who it runs as, for
    // which service, and whether this instance reaches outside itself (`outbound`: a sandbox and a
    // public demo do not, and a suite then acts on nothing outside the database either). A suite that is not installed, or a capability it no longer has, is a refusal in
    // words, audited with the call like any other: the service's other work is not what stops.
    let suiteCapabilities = {};
    const suiteKey = (suite) => suite.replace(/-/g, "_");
    function suitesFor(service, info, done) {
        const out = {};
        for (const [suite, names] of Object.entries(isPlain(service.body.uses?.suites) ? service.body.uses.suites : {})) {
            const given = suiteCapabilities[suite];
            out[suiteKey(suite)] = Object.fromEntries((Array.isArray(names) ? names : []).map((cap) => [cap, async (args) => {
                const spec = given?.[cap];
                const at = Date.now();
                const entry = { suite, call: cap, args: clone(args ?? null) };
                done.push(entry);
                try {
                    if (!given) throw new ServiceError(`The ${suite} suite is not installed here, so ${service.body.label ?? service.body.name} cannot use its ${cap}: ask IT to install it.`, { status: 409, code: "suite.missing" });
                    if (!spec) throw new ServiceError(`The ${suite} suite has no "${cap}" for a service to use: change the service's design (what it may touch).`, { status: 409, code: "suite.capability" });
                    // A dry run acts on nothing outside (§15.2, §31.7): what the suite says a dry run of it
                    // answers, or nothing, with the call it would have made in the report.
                    const run = info.dry ? (typeof spec === "function" ? null : spec.dry ?? null) : typeof spec === "function" ? spec : spec.run;
                    const answer = run ? clone((await run(clone(args ?? null), info)) ?? null) : null;
                    if (info.dry) entry.simulated = true;
                    return answer;
                } catch (e) {
                    entry.error = String(e.message);
                    throw e;
                } finally {
                    entry.ms = Date.now() - at;
                }
            }]));
        }
        return out;
    }

    // Transactions a service may run (§15.2, §25): `uses.transactions`, and only those, each through the
    // transaction's own service (transactions.js): its callers (the service among them, when it runs as
    // its own role), its checks, its steps through each object's policies and rule pipe, all or nothing,
    // audited as a run by whoever the service acts as. A signed one is refused there. `key` makes a retry
    // of the same run (a trigger sent again) answer the first; it is the service's own, under its name.
    // In a dry run it is planned, as its preview is: what it would change, nothing written; as drafted in
    // the change being tested (`drafts`), where it is, so a service and its transaction's callers naming
    // it are tested together.
    let transactionsApi = null;
    function transactionsFor(service, self, { touched = null, dry = false, done, drafts = {} }) {
        return {
            async run(name, input = {}, { key } = {}) {
                if (!(service.body.uses?.transactions ?? []).includes(name)) throw fault(`service ${service.body.name} may not run ${name}: add it to the service's uses.transactions`);
                if (!transactionsApi) throw fault("transactions are not available here");
                if (key !== undefined && (typeof key !== "string" || !key || key.length > 60)) throw new ServiceError("A transaction's key is text, at most 60 characters (the lot's number, the event's id).", { status: 400, code: "service.key" });
                const entry = { transaction: name, input: clone(input ?? {}), ...(key ? { key } : {}) };
                done.push(entry);
                try {
                    if (dry) {
                        const plan = await transactionsApi.planFor(self, name, clone(input ?? {}), isPlain(drafts[name]) ? drafts[name] : null);
                        entry.simulated = true;
                        entry.changes = plan.changes.length;
                        return clone({ ok: true, simulated: true, transaction: name, changes: plan.changes, records: [] });
                    }
                    const r = await transactionsApi.services["transactions.run"].call(self, { name, input: clone(input ?? {}), ...(key ? { key: `svc:${service.body.name}:${key}` } : {}) });
                    entry.run = r.run;
                    for (const t of r.records ?? []) for (const target of recordTargets(t)) if (touched && !touched.some((have) => JSON.stringify(have) === JSON.stringify(target))) touched.push(target);
                    return clone(r);
                } catch (e) {
                    entry.error = String(e.message);
                    throw e;
                }
            },
        };
    }

    // Records, as the caller: the generic services, so policy, rule pipe and audit apply.
    function recordsFor(service, self, touched) {
        const may = (object, op) => {
            if (!(service.body.uses?.objects?.[object] ?? []).includes(op)) throw fault(`service ${service.body.name} may not ${op} ${object}: add it to the service's uses.objects`);
        };
        const call = (name, args) => records[name].call(self, args);
        const current = async (object, id) => {
            const row = await call("records.get", { object, id });
            if (!row) throw new ServiceError(`No ${object} ${id} that you can see.`, { status: 404 });
            return row;
        };
        // Everything a record write changes (services.js recordTargets): its screens, pop-ups, route and inbox too.
        const wrote = (object, id) => { for (const t of recordTargets({ object, id })) if (!touched.some((have) => JSON.stringify(have) === JSON.stringify(t))) touched.push(t); };
        return {
            async get(object, id) { may(object, "read"); return clone(await call("records.get", { object, id })); },
            async list(object, where = {}) {
                may(object, "read");
                // Found in the database among every record (records.list where), then held to exact equality.
                const { rows } = await call("records.list", { object, ...(isPlain(where) ? { where } : {}) });
                return clone(rows.filter((r) => Object.entries(isPlain(where) ? where : {}).every(([k, v]) => r[k] === v)));
            },
            async create(object, data) { may(object, "create"); const r = await call("records.create", { object, data }); wrote(object, r.id); return clone(r); },
            async update(object, id, data) {
                may(object, "update");
                const row = await current(object, id);
                const r = await call("records.update", { object, id, rowVersion: row.row_version, data });
                wrote(object, id);
                return clone(r);
            },
            async action(object, id, action) {
                may(object, "action");
                const row = await current(object, id);
                const r = await call("records.action", { object, id, action, rowVersion: row.row_version });
                wrote(object, id);
                return clone(r);
            },
            // Archiving and restoring (uses.objects: archive): through policy and the rule pipe, as above.
            async archive(object, id) { return archived(object, id, "records.archive"); },
            async restore(object, id) { return archived(object, id, "records.restore"); },
        };
        async function archived(object, id, name) {
            may(object, "archive");
            const row = await current(object, id);
            const r = await call(name, { object, id, rowVersion: row.row_version });
            wrote(object, id);
            return clone(r);
        }
    }

    // Runs a published service: { output } or a thrown ServiceError (a refusal, with words for the
    // caller) or a fault (status 500; the words are logged). `event` is a trigger's; `via` says how
    // it was set off, for the audit.
    async function run(name, { user, input = {}, event = null, via, chain = [] }) {
        let service = (await store.services()).get(name);
        if (!service) {
            // Published since this instance last read them (by another instance, off the bus)?
            store.forgetIntegration();
            service = (await store.services()).get(name);
        }
        if (!service) throw new ServiceError("No such service.", { status: 404 });
        const calls = [];
        const touched = [];
        const started = Date.now();
        let values = {};
        let outcome;
        let error = null;
        let actor = null;
        try {
            // Who may call, and what they sent: refused like anything else, and audited too.
            if (!event) {
                if (!(await mayCall(service, user))) {
                    const c = service.body.callers ?? {};
                    throw new ServiceError(`You may not call ${service.body.label}: its callers are ${[...(c.users ?? []), ...(c.groups ?? []).map((g) => `group ${g}`)].join(", ") || "nobody yet"}. Its stewards (${(service.body.stewards ?? []).join(", ")}) approve who may.`, { status: 403, code: "service.denied" });
                }
                const checked = checkInput(service.body.input, input);
                if (checked.fields) throw new ServiceError("Some inputs need attention.", { status: 400, fields: checked.fields, code: "service.input" });
                values = checked.values;
            }
            const script = (await store.scripts()).get(name);
            if (!script) throw fault(`service ${name} has no published script`);
            actor = await resolveIdentity(store, service.body, { caller: event ? null : user, event });
            const self = { [CALL_KIND]: "internal", reason: `service ${name}`, user: actor, origin: { chain: [...chain, name] } };
            const ctx = {
                service: name, input: values, event, now: new Date().toISOString(),
                user: { id: actor.id, name: actor.name, ...(actor.onBehalfOf ? { onBehalfOf: actor.onBehalfOf } : {}) }, output: null,
                records: recordsFor(service, self, touched),
                http: (connection, req) => request(service, connection, req, calls),
                transactions: transactionsFor(service, self, { touched, done: calls }),
                ...suitesFor(service, { user: { id: actor.id, name: actor.name }, service: name, self, dry: false, outbound }, calls),
            };
            const result = await runServiceScript({ name, version: script.version, source: script.source, ctx });
            if (!isPlain(result)) throw fault(`${name} must return its context`);
            outcome = { output: clone(result.output ?? null) };
        } catch (e) {
            error = e;
        }
        // A refusal the script meant (a throw with words, or a record refused by policy or a rule):
        // the caller's to read. Anything else is a fault. A script that throws with { retry: true }
        // says the other system is down, not that it refuses.
        const refused = error && !error.retry && (error.expose === true || (!error.fault && !isFault(error)));
        const entry = {
            service: name, version: service.version, via, event, as: actor?.id ?? null, input: error?.code === "service.input" ? input : values, ms: Date.now() - started, calls,
            ...(error ? { error: { message: String(error.message), refused, ...(error.fields ? { fields: error.fields } : {}) } } : { output: outcome.output }),
        };
        try {
            // The call's own row names who set it off: the caller, or for an event, the service.
            await db.transaction((tx) => appendAudit(tx, { actor: user?.id ?? actor?.id ?? `service:${name}`, onBehalfOf: onBehalfOfEvent(event), object: "$service", action: `${error ? (refused ? "rejected" : "failed") : "called"}:${name}`, after: entry }));
        } catch (e) {
            log.error?.("service audit", e);
        }
        if (touched.length) invalidate(touched).catch((e) => log.error?.("service invalidate", e));
        if (!error) return outcome;
        if (refused) {
            const fields = error.fields ?? (error.field ? { [error.field]: error.message } : undefined);
            // 400: what was sent is malformed; 403/404/409 as the records said; any other refusal
            // (a rule, the script's own) is 422: understood, and refused.
            const status = error.code === "service.input" ? 400 : [403, 404, 409].includes(error.status) ? error.status : 422;
            throw new ServiceError(error.message, { status, fields, code: error.code ?? "service.rejected" });
        }
        if (!error.retry) log.error?.(`service ${name} fault: ${error.message}`);
        throw Object.assign(new Error(`The service ${name} failed.`), { expose: true, status: error.retry ? 502 : 500, code: "service.fault", retry: Boolean(error.retry), permanent: Boolean(error.permanent), detail: String(error.message) });
    }

    // ---- dry runs: a draft script executed with everything it may call callable, nothing changed ----
    // Reads are real (the person's rights). Creates, updates and actions go through the object's
    // policy and rule pipe and are not saved. Requests are checked against the connection and
    // answered from `responses` ({ "POST /confirmations": { status, body } }), never sent. `user` is
    // who it acts as, resolved by the caller of this (resolveIdentity): as in production.
    async function dryRunService({ user, service: body, source, connections: drafts = {}, transactions: draftTransactions = {}, input = {}, event = null, responses = {} }) {
        const started = Date.now();
        const service = { body, version: "draft" };
        const published = await store.connections();
        const connectionOf = (n) => (isPlain(drafts[n]) ? { body: drafts[n] } : published.get(n));
        const reads = [];
        const writes = [];
        const requests = [];
        const suiteCalls = []; // what it asked of a suite (ctx.<suite>): said, never done
        const transactionRuns = []; // the transactions it would run (ctx.transactions): planned, never run
        const made = new Map(); // records the dry run "created": id -> record
        const report = (extra) => ({ ...extra, reads, writes, requests, ...(suiteCalls.length ? { suites: suiteCalls } : {}), ...(transactionRuns.length ? { transactions: transactionRuns } : {}), ms: Date.now() - started });
        let values = {};
        if (!event) {
            const checked = checkInput(body.input, input);
            if (checked.fields) return report({ ok: false, output: null, error: { message: "Some inputs need attention.", fields: checked.fields, fault: false, stage: "input" } });
            values = checked.values;
        }
        const self = { [CALL_KIND]: "internal", reason: `dry run ${body.name}`, user, dryRun: true, origin: { chain: [body.name] } };
        const identity = { id: user.id, name: user.name, ...(user.onBehalfOf ? { onBehalfOf: user.onBehalfOf } : {}) };
        const may = (object, op) => {
            if (!(body.uses?.objects?.[object] ?? []).includes(op)) throw fault(`service ${body.name} may not ${op} ${object}: add it to the service's uses.objects`);
        };
        const call = (name, args) => records[name].call(self, args);
        const existing = async (object, id) => {
            if (made.has(id)) return made.get(id);
            const row = await call("records.get", { object, id });
            if (!row) throw new ServiceError(`No ${object} ${id} that you can see.`, { status: 404 });
            return row;
        };
        async function dryArchived(object, id, archive) {
            may(object, "archive");
            const row = await existing(object, id);
            const stamp = archive ? { archived_at: new Date().toISOString(), archived_by: user.id } : { archived_at: null, archived_by: null };
            const r = made.has(id) ? { ...row, ...stamp } : await call(archive ? "records.archive" : "records.restore", { object, id, rowVersion: row.row_version });
            if (made.has(id)) made.set(id, r);
            writes.push({ op: archive ? "archive" : "restore", object, id, result: clone(r) });
            return clone(r);
        }
        const ctx = {
            service: body.name, input: values, event, now: new Date().toISOString(),
            user: identity, output: null,
            records: {
                async get(object, id) {
                    may(object, "read");
                    const row = made.get(id) ?? await call("records.get", { object, id });
                    reads.push({ op: "get", object, id, found: Boolean(row) });
                    return clone(row);
                },
                async list(object, where = {}) {
                    may(object, "read");
                    const { rows } = await call("records.list", { object, ...(isPlain(where) ? { where } : {}) });
                    const found = rows.filter((r) => Object.entries(isPlain(where) ? where : {}).every(([k, v]) => r[k] === v));
                    reads.push({ op: "list", object, where, count: found.length });
                    return clone(found);
                },
                async create(object, data) {
                    may(object, "create");
                    const r = await call("records.create", { object, data });
                    made.set(r.id, r);
                    writes.push({ op: "create", object, data: clone(data), result: clone(r) });
                    return clone(r);
                },
                async update(object, id, data) {
                    may(object, "update");
                    const row = await existing(object, id);
                    const r = made.has(id) ? { ...row, ...data } : await call("records.update", { object, id, rowVersion: row.row_version, data });
                    if (made.has(id)) made.set(id, r);
                    writes.push({ op: "update", object, id, data: clone(data), result: clone(r) });
                    return clone(r);
                },
                async action(object, id, action) {
                    may(object, "action");
                    const row = await existing(object, id);
                    const r = made.has(id) ? row : await call("records.action", { object, id, action, rowVersion: row.row_version });
                    writes.push({ op: "action", object, id, action, result: clone(r) });
                    return clone(r);
                },
                archive: (object, id) => dryArchived(object, id, true),
                restore: (object, id) => dryArchived(object, id, false),
            },
            http: async (name, req) => {
                const { conn, method, path, url, body: payload } = prepare(service, name, req, connectionOf);
                const canned = (isPlain(responses) ? responses[`${method} ${path}`] ?? responses[path] : null) ?? { status: 200, body: null };
                const status = Number.isInteger(canned.status) ? canned.status : 200;
                const auth = conn.body.auth ?? { kind: "none" };
                requests.push({ connection: name, method, path, url: url.toString(), body: clone(payload), auth: auth.kind === "none" ? "none" : `${auth.kind} (secret ${auth.secret}, not sent)`, response: { status, body: clone(canned.body ?? null) } });
                return { status, ok: status >= 200 && status < 300, body: clone(canned.body ?? null), simulated: true };
            },
        };
        ctx.transactions = transactionsFor(service, self, { dry: true, done: transactionRuns, drafts: isPlain(draftTransactions) ? draftTransactions : {} });
        Object.assign(ctx, suitesFor(service, { user: { id: user.id, name: user.name }, service: body.name, self, dry: true, outbound: false }, suiteCalls));
        const outcome = await runDryScript({ name: body.name, source, ctx });
        if (outcome.error) return report({ ok: false, output: null, error: outcome.error });
        if (!isPlain(outcome.result)) return report({ ok: false, output: null, error: { message: `${body.name} must return its context.`, fault: true } });
        return report({ ok: true, output: clone(outcome.result.output ?? null), error: null });
    }

    // A rule script's dry run: the pipe's context, with real lookups (the person's rights); the
    // fields it changed, and whether its binding declares them.
    async function dryRunRule({ user, name, source, writes = [], ctx: given = {} }) {
        const started = Date.now();
        const reads = [];
        const self = { [CALL_KIND]: "internal", reason: `dry run ${name}`, user };
        const data = isPlain(given.data) ? clone(given.data) : {};
        const ctx = {
            event: { kind: "change", object: null, action: null, changed: [], source: "dry run", prev: {}, ...(isPlain(given.event) ? given.event : {}) },
            user: { id: user.id, name: user.name, roles: [] },
            record: isPlain(given.record) ? given.record : {},
            data: clone(data),
            now: new Date().toISOString(),
            lookup: async (object, id) => {
                const row = await records["records.get"].call(self, { object, id });
                reads.push({ op: "lookup", object, id, found: Boolean(row) });
                return clone(row);
            },
        };
        const outcome = await runDryScript({ name, source, ctx });
        const report = (extra) => ({ ...extra, reads, ms: Date.now() - started });
        if (outcome.error) return report({ ok: false, error: outcome.error });
        if (!isPlain(outcome.result)) return report({ ok: false, error: { message: `${name} must return its context.`, fault: true } });
        const after = outcome.result.data ?? {};
        const changed = [...new Set([...Object.keys(data), ...Object.keys(after)])].filter((k) => JSON.stringify(data[k]) !== JSON.stringify(after[k]));
        const undeclared = changed.filter((k) => !writes.includes(k));
        return report({
            ok: !undeclared.length, data: clone(after), changed,
            error: undeclared.length ? { message: `It changes ${undeclared.join(", ")}, which its binding does not declare (writes); the pipe would stop here.`, fault: true } : null,
        });
    }

    // ---- the outbox worker: triggers, after their event committed --------------------------------
    // Claimed with SKIP LOCKED, so several instances share the work and none runs a row twice; a row
    // whose instance died mid-run is claimed again once its lease (next_at) has passed.
    async function drain() {
        const rows = await db.query(
            `UPDATE mes.integration_outbox SET state = 'running', attempts = attempts + 1, next_at = now() + interval '2 minutes'
             WHERE id IN (SELECT id FROM mes.integration_outbox WHERE state IN ('pending', 'retry', 'running') AND next_at <= now()
                          AND (run_on IS NULL OR run_on = ANY($1::text[]))
                          ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
             RETURNING *`,
            [self.tags],
        );
        // What is published now, not what this instance last heard of: a trigger runs the service's
        // current version, on whichever instance claimed it.
        if (rows.length) store.forgetIntegration();
        // In the order they were queued: RETURNING keeps no order, and two runs of one schedule claimed
        // together must run in turn (a script's cursor reads the previous run's output).
        rows.sort((a, b) => Number(a.id) - Number(b.id));
        for (const row of rows) {
            const scheduled = row.event?.kind === "schedule";
            // Its lease, taken again before it runs: the rows before it in this batch may each have
            // taken as long as a service may, and one whose lease ran out meanwhile is another
            // instance's now (it would otherwise run on both).
            const [mine] = await db.query("UPDATE mes.integration_outbox SET next_at = now() + interval '2 minutes' WHERE id = $1 AND state = 'running' AND attempts = $2 RETURNING id", [row.id, row.attempts]);
            if (!mine) continue;
            try {
                // A scheduled run reads what the last successful one answered (its cursor, say). Which
                // attempt this is goes with the event: a script that writes, then calls out, can tell a
                // retry from the first run.
                const event = scheduled ? { ...row.event, previous: await previousRun(row.service), attempt: row.attempts } : { ...row.event, attempt: row.attempts };
                const via = scheduled ? { schedule: row.event.scheduledAt, outbox: Number(row.id), node: self.name } : { trigger: row.event.kind, outbox: Number(row.id), node: self.name };
                // Who it acts as is the service's current design (its service role, or a user).
                const result = await run(row.service, { user: null, event, via, chain: row.chain });
                await db.query("UPDATE mes.integration_outbox SET state = 'done', result = $2, last_error = NULL, done_at = now() WHERE id = $1 AND attempts = $3", [row.id, JSON.stringify(result.output), row.attempts]);
                if (scheduled) await scheduledRunEnded(row, "done", null, result.output);
            } catch (error) {
                const message = String(error.detail ?? error.message);
                // Refused (by its script, a rule or a policy): retrying says the same. A fault is
                // retried with a growing wait, then left for a person (dead).
                const state = error.code === "service.fault" && !error.permanent ? (row.attempts >= MAX_ATTEMPTS ? "dead" : "retry") : error.permanent ? "dead" : "rejected";
                await db.query(
                    `UPDATE mes.integration_outbox SET state = $2, last_error = $3, next_at = now() + make_interval(secs => $4) WHERE id = $1 AND attempts = $5`,
                    [row.id, state, message.slice(0, 1000), retryWait(row.attempts), row.attempts],
                );
                if (state === "dead") events?.emit("trigger.dead", { severity: "error", message: `The ${scheduled ? "scheduled run" : "trigger"} of ${row.service} was given up on after ${row.attempts} attempt(s): ${message.slice(0, 300)}`, details: { service: row.service, outbox: Number(row.id), attempts: row.attempts } });
                if (scheduled) await scheduledRunEnded(row, state, message.slice(0, 1000), null).catch((e) => log.error?.("schedule state", e));
            }
        }
        return rows.length;
    }

    // ---- schedules (§15.3) ----------------------------------------------------------------------
    // Kinds of schedule the installed suites add (§30.11): "<suite>.<kind>" → { label, runs, describe, … }.
    // A schedule from one is given its times by the suite, the instants after `afterMs` up to
    // `untilMs`; what the suite answers is taken only as far as it is such a list. A suite that throws,
    // or takes too long, gave no times (logged): the scheduler goes on with every other service. One
    // whose suite is not installed has no times, and the monitor says which suite it needs.
    let suiteSchedules = {};
    // The suite's own check of a schedule's settings, against the designs (design.js scheduleCheck): [words].
    let scheduleCheck = async () => [];
    const saidMissing = new Set();
    // (A kind that keeps failing is said once, and again once it has worked or fails otherwise: not at every tick.)
    const failing = new Map();
    async function suiteRuns(t, afterMs, { untilMs = Infinity, limit = 5 } = {}) {
        const s = t.schedule;
        const spec = suiteSchedules[s.from];
        if (!spec) {
            if (!saidMissing.has(s.from)) {
                saidMissing.add(s.from);
                log.warn?.(`schedule ${s.from}: the ${suiteOf(s.from)} suite is not installed here; nothing is planned for it`);
                events?.emit("schedule.suite_missing", { severity: "warning", message: `A schedule needs the ${suiteOf(s.from)} suite (${s.from}), which is not installed here: nothing is planned for it until the suite is back.`, details: { kind: s.from, suite: suiteOf(s.from) } });
            }
            return [];
        }
        if (scheduleProblems(t, { suiteSchedules }).length) return [];
        let timer;
        try {
            const given = await Promise.race([
                Promise.resolve().then(() => spec.runs(suiteSettings(t), afterMs, { untilMs, limit, tz: s.tz ?? plantTz })),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${SUITE_RUNS_MS} ms`)), SUITE_RUNS_MS); }),
            ]);
            const out = [...new Set((Array.isArray(given) ? given : []).map(Number).filter((ms) => Number.isFinite(ms) && ms > afterMs && ms <= untilMs))].sort((a, b) => a - b);
            failing.delete(s.from);
            return out.slice(0, limit);
        } catch (error) {
            const words = String(error?.message ?? error);
            if (failing.get(s.from) === words) return [];
            failing.set(s.from, words);
            log.error?.(`schedule ${s.from}: the ${spec.suite} suite gave no times`, error);
            events?.emit("schedule.suite_failed", { severity: "error", message: `The ${spec.suite} suite could not work out the times of ${s.from}: ${words.slice(0, 300)}`, details: { kind: s.from, suite: spec.suite } });
            return [];
        } finally {
            clearTimeout(timer);
        }
    }
    // A trigger's times: the clock's (schedule.js), or its suite's.
    const runsDue = (t, afterMs, opts) => (isSuiteSchedule(t) ? suiteRuns(t, afterMs, opts) : runsOf(t, afterMs, { ...opts, tz: plantTz }));
    // The next run of a service's schedules after `afterMs`, or null.
    async function nextRun(triggers, afterMs) {
        const next = [];
        for (const t of (Array.isArray(triggers) ? triggers : []).filter(isSchedule)) next.push((await runsDue(t, afterMs, { limit: 1 }))[0]);
        const due = next.filter(Number.isFinite);
        return due.length ? Math.min(...due) : null;
    }
    // A schedule in words, and the suite it needs when that is not installed.
    const scheduleWords = (t) => ({ text: describeSchedule(t, plantTz, suiteSchedules), ...(isSuiteSchedule(t) && !suiteSchedules[t.schedule.from] ? { needs: suiteOf(t.schedule.from) } : {}) });
    // The last successful run of a scheduled service: { at, output }, or null.
    async function previousRun(service) {
        const [st] = await db.query("SELECT last_ok_at, last_output FROM mes.schedule_state WHERE service = $1", [service]);
        return st?.last_ok_at ? { at: iso(st.last_ok_at), output: st.last_output ?? null } : null;
    }

    // A scheduled run has ended (or will be retried): its service's state follows. A run that asks for
    // more (ctx.output.more) queues its next page at once.
    async function scheduledRunEnded(row, state, error, output) {
        const done = state === "done";
        const final = done || state === "rejected" || state === "dead";
        await db.query(
            "INSERT INTO mes.schedule_state (service) VALUES ($1) ON CONFLICT DO NOTHING",
            [row.service],
        );
        await db.query(
            `UPDATE mes.schedule_state SET last_run_at = now(), last_state = $2, last_error = $3,
                    last_ok_at = CASE WHEN $4 THEN now() ELSE last_ok_at END, last_output = CASE WHEN $4 THEN $5::jsonb ELSE last_output END,
                    runs_ok = runs_ok + (CASE WHEN $4 THEN 1 ELSE 0 END), runs_failed = runs_failed + (CASE WHEN $6 AND NOT $4 THEN 1 ELSE 0 END), updated_at = now()
             WHERE service = $1`,
            [row.service, state, error, done, JSON.stringify(output ?? null), final],
        );
        const page = row.event.page ?? 1;
        if (done && output?.more === true) {
            if (page >= MAX_PAGES) {
                events?.emit("schedule.too_many_pages", { severity: "warning", message: `${row.service} asked for more after ${page} pages; it stops here until its next run.`, details: { service: row.service, scheduledAt: row.event.scheduledAt, page } });
                return;
            }
            await db.query(
                "INSERT INTO mes.integration_outbox (service, event, run_as, chain, run_on) VALUES ($1, $2, $3, '[]', $4)",
                [row.service, JSON.stringify({ ...row.event, page: page + 1 }), row.run_as, row.run_on],
            );
        }
    }

    // Plans what is due: for each published service with a schedule, the runs due since it was last
    // planned, as outbox rows keyed by (service, time due), so a run is planned once however many nodes
    // plan. One node plans a service at a time (its state row, locked with SKIP LOCKED). A run not
    // noticed within ON_TIME_MS was missed: the trigger's `missed` decides what happens to it. With
    // `overlap: "skip"`, nothing is queued while a run of the service is still waiting or running.
    async function plan() {
        if (!self.scheduler) return 0;
        let queued = 0;
        const at = now();
        for (const [name, s] of await store.services()) {
            const triggers = (s.body.on ?? []).filter(isSchedule);
            if (!triggers.length || serviceIdentity(s.body) === "caller") continue;
            queued += await db.transaction(async (tx) => {
                // First seen: planned from now on, never backwards.
                await tx.query("INSERT INTO mes.schedule_state (service, last_planned_at) VALUES ($1, $2) ON CONFLICT DO NOTHING", [name, new Date(at).toISOString()]);
                const [st] = await tx.query("SELECT * FROM mes.schedule_state WHERE service = $1 FOR UPDATE SKIP LOCKED", [name]);
                if (!st || st.paused) return 0;
                // Its state was made before it was ever planned (a run now, a pause): planned from now
                // on, like one first seen. Left empty, it would be "from now" at every tick, for ever.
                if (!st.last_planned_at) { await tx.query("UPDATE mes.schedule_state SET last_planned_at = $2, updated_at = now() WHERE service = $1", [name, new Date(at).toISOString()]); return 0; }
                const from = Math.max(new Date(st.last_planned_at).getTime(), at - CATCH_UP_WINDOW_MS);
                if (from >= at) return 0;
                const [busy] = await tx.query("SELECT 1 FROM mes.integration_outbox WHERE service = $1 AND event->>'kind' = 'schedule' AND state IN ('pending', 'running', 'retry') LIMIT 1", [name]);
                let missed = 0;
                let skipped = 0;
                let added = 0;
                const modes = new Set();
                for (const t of triggers) {
                    const due = await runsDue(t, from, { untilMs: at, limit: 20_000 });
                    if (!due.length) continue;
                    const onTime = due.filter((d) => at - d <= ON_TIME_MS);
                    const late = due.filter((d) => at - d > ON_TIME_MS);
                    const mode = t.missed ?? "last";
                    const catchUp = mode === "all" ? late.slice(-MAX_CATCH_UP) : mode === "last" && !onTime.length ? late.slice(-1) : [];
                    if (late.length > catchUp.length) { missed += late.length - catchUp.length; modes.add(mode); }
                    const toRun = [...catchUp, ...onTime];
                    if (busy && (t.overlap ?? "skip") === "skip") { skipped += toRun.length; continue; }
                    for (const d of toRun) {
                        const [row] = await tx.query(
                            `INSERT INTO mes.integration_outbox (service, event, run_as, chain, run_on, scheduled_at) VALUES ($1, $2, $3, '[]', $4, $5)
                             ON CONFLICT (service, scheduled_at) WHERE scheduled_at IS NOT NULL DO NOTHING RETURNING id`,
                            [name, JSON.stringify({ kind: "schedule", scheduledAt: new Date(d).toISOString() }), serviceIdentity(s.body), s.body.runOn ?? null, new Date(d).toISOString()],
                        );
                        if (row) added += 1;
                    }
                }
                await tx.query("UPDATE mes.schedule_state SET last_planned_at = $2, missed = missed + $3, skipped = skipped + $4, updated_at = now() WHERE service = $1", [name, new Date(at).toISOString(), missed, skipped]);
                if (missed) events?.emit("schedule.missed", { severity: "warning", message: `${name}: ${missed} run(s) could not start on time (missed: ${[...modes].join(", ")}).`, details: { service: name, missed, since: new Date(from).toISOString() } });
                if (skipped) events?.emit("schedule.skipped", { severity: "warning", message: `${name}: ${skipped} run(s) not queued, since the previous one is still waiting or running (overlap: skip).`, details: { service: name, skipped } });
                return added;
            });
        }
        return queued;
    }

    // This node, as the others (and the monitor) see it. A node unseen for a day is forgotten.
    async function heartbeat() {
        await db.query("DELETE FROM mes.nodes WHERE last_seen < now() - interval '1 day'");
        await db.query(
            `INSERT INTO mes.nodes (name, tags, scheduler, outbox, build, started_at, last_seen) VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (name) DO UPDATE SET tags = EXCLUDED.tags, scheduler = EXCLUDED.scheduler, outbox = EXCLUDED.outbox, build = EXCLUDED.build, started_at = EXCLUDED.started_at, last_seen = now()`,
            [self.name, self.tags, self.scheduler, self.outbox, self.build, self.startedAt],
        );
    }

    // ---- the web services: POST /svc/v1/<name>, and their OpenAPI description ---------------------
    async function describe(origin, user) {
        const paths = {};
        for (const [name, s] of await store.services()) {
            if (!s.body.http?.enabled || !(await mayCall(s, user))) continue;
            const properties = Object.fromEntries(Object.entries(s.body.input ?? {}).map(([k, f]) => [k, {
                type: { integer: "integer", decimal: "number", boolean: "boolean" }[f.type] ?? "string",
                ...(f.type === "enum" ? { enum: f.values } : {}), ...(f.type === "date" ? { format: "date" } : {}), ...(f.type === "ref" ? { format: "uuid" } : {}),
                description: f.label ?? k,
            }]));
            // A deprecated service says so, with its sunset and successor (docs/contracts/http-apis).
            const d = s.body.deprecated;
            paths[`/${name}`] = {
                post: {
                    summary: s.body.label, description: `${s.body.description ?? ""}${d ? `${s.body.description ? " " : ""}Deprecated since ${d.since}; it may change or go after ${d.sunset}${d.successor ? `: use ${d.successor}` : ""}.${d.note ? ` ${d.note}` : ""}` : ""}`, security: [{ bearer: [] }],
                    ...(d ? { deprecated: true } : {}),
                    parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" }, description: "Send the same key to retry safely: the first answer is returned again." }],
                    requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties, required: Object.entries(s.body.input ?? {}).filter(([, f]) => f.required).map(([k]) => k) } } } },
                    responses: { 200: { description: "{ output }" }, 400: { description: "Bad input: { error, fields }" }, 401: { description: "No or bad token" }, 403: { description: "Not among its callers" }, 422: { description: "Refused by the service, a rule or a policy: { error, fields }" }, 500: { description: "The service failed" }, 502: { description: "A system it depends on could not be reached" } },
                },
            };
        }
        return {
            openapi: "3.1.0",
            info: { title: "OpenCore MES services", version: contract.version, description: "The services published in this plant's designer that this token's user may call. They change as changes are approved and executed; a change that would break a caller comes with notice first (a deprecated service answers with Deprecation, Sunset and Link headers)." },
            servers: [{ url: `${origin}${PREFIX}` }],
            components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
            paths,
        };
    }
    // Every answer says which version of the contract it keeps; a deprecated service's also when it was
    // deprecated, its sunset and its successor.
    const send = (res, status, body, headers = contract.headers(PREFIX, null)) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
        res.end(JSON.stringify(body));
        return true;
    };
    const noticeOf = (service) => (service?.body?.deprecated ? { ...service.body.deprecated, ...(service.body.deprecated.successor ? { successor: `${PREFIX}/${service.body.deprecated.successor}` } : {}) } : null);
    const readJson = (req) => new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
        req.on("end", () => {
            if (size > MAX_BODY) return resolve({ error: 413 });
            try { resolve({ value: size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {} }); } catch { resolve({ error: 400 }); }
        });
        req.on("error", () => resolve({ error: 400 }));
    });
    const handler = async (req, res, url) => {
        if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
        const auth = req.headers.authorization ?? "";
        const who = auth.startsWith("Bearer ") ? await tokens.resolve(auth.slice(7).trim()) : null;
        if (!who) return send(res, 401, { error: "A bearer token is required.", code: "token.missing" });
        if (!who.scopes.includes("service:call")) return send(res, 403, { error: "This token lacks the scope service:call.", code: "scope.missing" });
        const user = { id: who.user_id, name: who.user_name };
        const path = url.pathname.slice(PREFIX.length);
        if (req.method === "GET" && path === "/openapi.json") return send(res, 200, await describe(`http://${req.headers.host}`, user));
        const name = path.slice(1);
        if (req.method !== "POST" || !IDENTIFIER.test(name)) return send(res, 404, { error: `POST ${PREFIX}/<service>; see ${PREFIX}/openapi.json.` });
        const service = (await store.services()).get(name);
        if (!service?.body.http?.enabled) return send(res, 404, { error: "No such web service." });
        const notice = noticeOf(service);
        const said = contract.headers(PREFIX, null, notice);
        if (notice) contract.used(PREFIX, `POST /${name}`, `${user.id} (token ${who.name})`, notice);
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "Send JSON (application/json)." });
        const body = await readJson(req);
        if (body.error) return send(res, body.error, { error: body.error === 413 ? "The body is too large." : "The body is not JSON." });
        // A retried request (same Idempotency-Key, same caller) gets the first answer, not a second run.
        const key = req.headers["idempotency-key"];
        const idem = typeof key === "string" && key.length >= 8 && key.length <= 100 ? `svc:${name}:${key}` : null;
        // The key is claimed before the service runs (a retry sent while the first call still runs would
        // otherwise find nothing, and run it again): whoever holds the claim runs; a retry meanwhile is
        // told to come back; afterwards it reads the first answer. A claim whose run never ended (the
        // process went away) lapses.
        if (idem) {
            await db.query("DELETE FROM mes.idempotency WHERE key = $1 AND user_id = $2 AND result ? '$pending' AND at < now() - interval '2 minutes'", [idem, user.id]);
            const [claim] = await db.query(`INSERT INTO mes.idempotency (key, user_id, result) VALUES ($1, $2, '{"$pending": true}') ON CONFLICT DO NOTHING RETURNING key`, [idem, user.id]);
            if (!claim) {
                const [done] = await db.query("SELECT result FROM mes.idempotency WHERE key = $1 AND user_id = $2", [idem, user.id]);
                if (done && !done.result?.$pending) return send(res, 200, done.result, said);
                res.setHeader("retry-after", "2");
                return send(res, 409, { error: "The first request with this Idempotency-Key is still running: ask again in a moment.", code: "idempotency.running" });
            }
        }
        let result;
        try {
            result = await run(name, { user, input: body.value, via: { http: who.name } });
        } catch (error) {
            if (idem) await db.query("DELETE FROM mes.idempotency WHERE key = $1 AND user_id = $2 AND result ? '$pending'", [idem, user.id]).catch(() => {});
            // Only words written for the caller (a ServiceError) are answered: a driver's stay in the log.
            const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
            if (error?.expose !== true) { log.error?.(`svc ${name}:`, error); return send(res, status >= 500 ? status : 400, { error: status >= 500 ? "The request failed." : "The request was refused." }, said); }
            return send(res, status, { error: error.message, ...(error.fields ? { fields: error.fields } : {}), ...(error.code ? { code: error.code } : {}) }, said);
        }
        // The service ran: a failure to keep its answer is logged, never answered as a failure of the call.
        if (idem) await db.query("UPDATE mes.idempotency SET result = $2 WHERE key = $1 AND user_id = $3", [idem, JSON.stringify(result), user.id]).catch((error) => log.error?.(`svc ${name}: its answer was not kept for retries`, error));
        return send(res, 200, result, said);
    };

    // ---- the services pages call ----------------------------------------------------------------
    const personOf = async (self) => {
        // The design tools (an AI working for a person) call as that person.
        const user = self?.[CALL_KIND] === "direct" && self?.apiUser ? self.apiUser : await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        return user;
    };
    const designerOf = async (self) => {
        const user = await personOf(self);
        if (!(await store.rolesFor(user.id, "design")).length) fail("The designer is not shared with you.", { status: 403 });
        return user;
    };
    const iso = (v) => (v instanceof Date ? v.toISOString() : v);
    const services = {
        // A person sets a service off from the UI (a designer trying it, or a form's button).
        async "integration.call"({ name, input } = {}) {
            const user = await personOf(this);
            if (typeof name !== "string" || !IDENTIFIER.test(name)) fail("No such service.", { status: 404 });
            try {
                return await run(name, { user, input: isPlain(input) ? input : {}, via: { ui: true } });
            } catch (error) {
                // What went wrong inside (a script's line, a connection's answer) is for those who design
                // it; whoever only calls it reads that it failed, and the rest is in the monitor.
                if (error.code === "service.fault") fail((await store.rolesFor(user.id, "design")).length ? `${error.message} ${error.detail}` : error.message, { status: error.status, code: error.code });
                throw error;
            }
        },
        // What the services did: the last calls (from the audit trail) and the trigger outbox.
        async "integration.activity"({ name } = {}) {
            await designerOf(this);
            const one = typeof name === "string" && IDENTIFIER.test(name) ? name : null;
            const calls = await db.query(
                `SELECT seq, at, actor, action, after FROM mes.audit_log WHERE object = '$service'
                 ${one ? "AND after->>'service' = $1" : ""} ORDER BY seq DESC LIMIT 30`, one ? [one] : [],
            );
            const outbox = await db.query(
                `SELECT id, service, event, run_as, state, attempts, next_at, last_error, result, created_at, done_at FROM mes.integration_outbox
                 ${one ? "WHERE service = $1" : ""} ORDER BY id DESC LIMIT 30`, one ? [one] : [],
            );
            return {
                calls: calls.map((c) => ({ seq: Number(c.seq), at: iso(c.at), actor: c.actor, action: c.action, ...c.after })),
                outbox: outbox.map((o) => ({ ...o, id: Number(o.id), next_at: iso(o.next_at), created_at: iso(o.created_at), done_at: iso(o.done_at) })),
            };
        },
        // A dry run of a draft service or rule script, from the editor (§15.2).
        async "design.dryRun"({ kind, name, source, service, connections, transactions, run } = {}) {
            const user = await designerOf(this);
            if (typeof name !== "string" || !IDENTIFIER.test(name)) fail("Name the script.");
            if (typeof source !== "string" || source.length > 50000) fail("Give the script's source.");
            const given = isPlain(run) ? run : {};
            if (kind === "service") {
                if (!isPlain(service) || service.name !== name) fail("Give the draft service this script belongs to.");
                // As in production: its service role (the draft's roles), its user, or, running as the
                // caller, you or one of its declared callers. Acting with anyone's rights but your
                // own (a draft service role included, which nobody has approved yet) is audited.
                let caller = user;
                if (typeof given.as === "string" && given.as !== user.id) {
                    if (!(service.callers?.users ?? []).includes(given.as)) fail(`Only one of its callers (${(service.callers?.users ?? []).join(", ") || "none yet"}) may stand in as its caller.`, { status: 403 });
                    caller = await store.user(given.as);
                    if (!caller) fail(`No active user ${given.as}.`);
                }
                const event = isPlain(given.event) ? given.event : null;
                let as;
                try { as = await resolveIdentity(store, service, { caller: event ? null : caller, event }); } catch (e) { fail(e.message, { status: 409 }); }
                // An AI acts as its person, never as more (§16): its dry run reads with their rights only,
                // not a draft service role's or another caller's, which nobody has approved for it.
                if (this?.via && as.id !== user.id) fail(`A dry run by an AI runs as its person (${user.id}), and this service would run as ${as.id}: ask ${user.id} to dry-run it in the designer.`, { status: 403, code: "dryrun.identity" });
                if (as.id !== user.id) await db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$service", action: `dry-run-as:${name}`, after: { service: name, as: as.id, ...(as.serviceRoles ? { roles: as.serviceRoles } : {}) } }));
                return { ...(await dryRunService({ user: as, service, source, connections: isPlain(connections) ? connections : {}, transactions: isPlain(transactions) ? transactions : {}, input: isPlain(given.input) ? given.input : {}, event, responses: given.responses })), as: as.id, onBehalfOf: as.onBehalfOf ?? null };
            }
            if (kind === "rule") return dryRunRule({ user, name, source, writes: Array.isArray(given.writes) ? given.writes : [], ctx: given });
            // A script a suite's part of a design names (§29.4): the given input in, its output out.
            if (kind === "plain") {
                const started = Date.now();
                const r = await runDryScript({ name, source, ctx: { ...given, now: new Date().toISOString() } });
                return r.error ? { ok: false, error: r.error, ms: Date.now() - started } : { ok: true, output: r.result, ms: Date.now() - started };
            }
            fail("A dry run is of a service, a rule script, or a suite's script.");
        },
        // ---- the monitor (§15.3): nodes, schedules, web services called in, connections called out,
        // record triggers; the last 24 hours of calls, from the audit trail and the outbox.
        async "integration.monitor"() {
            await designerOf(this);
            const at = now();
            const nodes = (await db.query("SELECT name, tags, scheduler, outbox, build, started_at, last_seen, now() - last_seen < make_interval(secs => $1) AS alive FROM mes.nodes ORDER BY name", [NODE_GONE_MS / 1000]))
                .map((n) => ({ ...n, started_at: iso(n.started_at), last_seen: iso(n.last_seen) }));
            const alive = nodes.filter((n) => n.alive);
            const published = await store.services();
            const connections = await store.connections();
            const states = new Map((await db.query("SELECT * FROM mes.schedule_state")).map((r) => [r.service, r]));
            const calls = await db.query(
                `SELECT at, action, after FROM mes.audit_log WHERE object = '$service' AND at > now() - interval '24 hours'
                 AND (action LIKE 'called:%' OR action LIKE 'rejected:%' OR action LIKE 'failed:%') ORDER BY seq`,
            );
            const outbox = await db.query(
                `SELECT service, event->>'kind' = 'schedule' AS scheduled, state, count(*)::int AS n, max(done_at) AS last_done
                 FROM mes.integration_outbox WHERE created_at > now() - interval '24 hours' OR state IN ('pending', 'running', 'retry', 'dead')
                 GROUP BY 1, 2, 3`,
            );
            const outboxOf = (service, scheduled) => {
                const out = { pending: 0, running: 0, retry: 0, done: 0, rejected: 0, dead: 0, lastDone: null };
                for (const r of outbox) if (r.service === service && r.scheduled === scheduled) {
                    out[r.state] += r.n;
                    if (r.last_done && (!out.lastDone || r.last_done > out.lastDone)) out.lastDone = r.last_done;
                }
                return { ...out, lastDone: iso(out.lastDone) };
            };
            const outcomeOf = (action) => action.split(":")[0];
            const warnings = [];
            if (!alive.some((n) => n.scheduler)) warnings.push("No node that plans schedules has been seen in the last 30 s: schedules are not being planned.");
            if (!alive.some((n) => n.outbox)) warnings.push("No node that runs the outbox has been seen in the last 30 s: triggers and scheduled runs wait.");
            const reachable = (tag) => !tag || alive.some((n) => n.outbox && n.tags.includes(tag));

            const schedules = [];
            const inbound = [];
            const triggers = [];
            for (const [name, s] of published) {
                const on = s.body.on ?? [];
                const mine = calls.filter((c) => c.after?.service === name);
                if (on.some(isSchedule)) {
                    const st = states.get(name);
                    const runs = await db.query(
                        `SELECT id, event, state, attempts, last_error, created_at, done_at, run_on FROM mes.integration_outbox
                         WHERE service = $1 AND event->>'kind' = 'schedule' ORDER BY id DESC LIMIT 10`, [name],
                    );
                    schedules.push({
                        service: name, label: s.body.label, version: s.version, runOn: s.body.runOn ?? null, reachable: reachable(s.body.runOn),
                        when: on.filter(isSchedule).map((t) => ({ ...scheduleWords(t), missed: t.missed ?? "last", overlap: t.overlap ?? "skip" })),
                        // The suites its schedules need that are not installed: nothing is planned for those.
                        needs: [...new Set(on.filter((t) => isSuiteSchedule(t) && !suiteSchedules[t.schedule.from]).map((t) => suiteOf(t.schedule.from)))],
                        paused: Boolean(st?.paused), pausedBy: st?.paused_by ?? null, pausedAt: iso(st?.paused_at ?? null),
                        nextRunAt: st?.paused ? null : await nextRun(on, at).then((next) => (Number.isFinite(next) ? new Date(next).toISOString() : null)),
                        lastRunAt: iso(st?.last_run_at ?? null), lastState: st?.last_state ?? null, lastError: st?.last_error ?? null, lastOkAt: iso(st?.last_ok_at ?? null),
                        totals: { ok: st?.runs_ok ?? 0, failed: st?.runs_failed ?? 0, missed: st?.missed ?? 0, skipped: st?.skipped ?? 0 },
                        queue: outboxOf(name, true),
                        runs: runs.map((r) => ({ id: Number(r.id), scheduledAt: r.event.scheduledAt ?? null, page: r.event.page ?? 1, manual: Boolean(r.event.manual), state: r.state, attempts: r.attempts, error: r.last_error, createdAt: iso(r.created_at), doneAt: iso(r.done_at) })),
                    });
                }
                if (s.body.http?.enabled) {
                    const viaHttp = mine.filter((c) => c.after?.via?.http);
                    const last = viaHttp.at(-1);
                    inbound.push({
                        service: name, label: s.body.label, path: `${PREFIX}/${name}`, callers: s.body.callers ?? {},
                        calls24h: { called: viaHttp.filter((c) => outcomeOf(c.action) === "called").length, rejected: viaHttp.filter((c) => outcomeOf(c.action) === "rejected").length, failed: viaHttp.filter((c) => outcomeOf(c.action) === "failed").length },
                        last: last ? { at: iso(last.at), outcome: outcomeOf(last.action), by: last.after.via.http, error: last.after.error?.message ?? null } : null,
                    });
                }
                if (on.some((t) => !isSchedule(t))) {
                    triggers.push({ service: name, label: s.body.label, on: on.filter((t) => !isSchedule(t)).map((t) => `${t.object} ${t.event}`), runOn: s.body.runOn ?? null, reachable: reachable(s.body.runOn), queue: outboxOf(name, false) });
                }
            }
            // Connections called out: every request any service sent them.
            const outbound = [...connections].map(([name, c]) => {
                const requests = calls.flatMap((call) => (call.after?.calls ?? []).filter((r) => r.connection === name).map((r) => ({ ...r, at: call.at, service: call.after.service })));
                const last = requests.at(-1);
                const timed = requests.filter((r) => Number.isFinite(r.ms));
                return {
                    connection: name, label: c.body.label, baseUrl: c.body.baseUrl, allow: (c.body.allow ?? []).map((a) => `${a.method} ${a.path}`),
                    requests24h: { ok: requests.filter((r) => r.status >= 200 && r.status < 300).length, failed: requests.filter((r) => r.status >= 300).length, unreachable: requests.filter((r) => r.status === null).length },
                    avgMs: timed.length ? Math.round(timed.reduce((n, r) => n + r.ms, 0) / timed.length) : null,
                    last: last ? { at: iso(last.at), status: last.status, method: last.method, path: last.path, service: last.service } : null,
                    usedBy: [...published].filter(([, s]) => (s.body.uses?.connections ?? []).includes(name)).map(([n]) => n),
                };
            });
            return { now: new Date(at).toISOString(), plantTz, node: self.name, warnings, nodes, schedules, inbound, outbound, triggers };
        },
        // A schedule's next runs, for the designer's preview of one a suite's kind gives the times of
        // (§30.11): the browser cannot ask the suite. Nothing is written; a clock schedule is answered
        // the same way, though the designer works those out itself. { trigger, limit? } → { runs: [ISO],
        // text, tz, problems }.
        async "integration.scheduleRuns"({ trigger, limit = 5 } = {}) {
            await designerOf(this);
            if (!isSchedule(trigger)) fail("Give a schedule trigger: { schedule: { … } }.");
            const tz = trigger.schedule?.tz ?? plantTz;
            const problems = scheduleProblems(trigger, { suiteSchedules });
            if (!problems.length && isSuiteSchedule(trigger)) problems.push(...(await scheduleCheck(trigger)).map((m) => `${suiteSchedules[trigger.schedule.from]?.label ?? trigger.schedule.from}: ${m}`));
            if (problems.length) return { runs: [], text: describeSchedule(trigger, plantTz, suiteSchedules), tz, problems };
            const runs = await runsDue(trigger, now(), { untilMs: Infinity, limit: Math.min(Math.max(Number.isInteger(limit) ? limit : 5, 1), 20) });
            return { runs: runs.map((ms) => new Date(ms).toISOString()), text: describeSchedule(trigger, plantTz, suiteSchedules), tz, problems: [] };
        },
        // Pausing and resuming a schedule are operations, not design: audited, and in the event log.
        // A run already queued still runs; a resumed schedule is planned from now on (what fell due
        // while it was paused is not caught up).
        async "integration.schedule.pause"({ name } = {}) {
            const user = await designerOf(this);
            const service = await scheduledService(name);
            await db.transaction(async (tx) => {
                await tx.query(
                    `INSERT INTO mes.schedule_state (service, paused, paused_by, paused_at) VALUES ($1, true, $2, now())
                     ON CONFLICT (service) DO UPDATE SET paused = true, paused_by = $2, paused_at = now(), updated_at = now()`,
                    [name, user.id],
                );
                await appendAudit(tx, { actor: user.id, object: "$service", action: `schedule:pause:${name}`, after: { service: name, version: service.version } });
            });
            events?.emit("schedule.paused", { message: `${name} paused by ${user.id}.`, details: { service: name, by: user.id } });
            return { ok: true };
        },
        async "integration.schedule.resume"({ name } = {}) {
            const user = await designerOf(this);
            const service = await scheduledService(name);
            await db.transaction(async (tx) => {
                await tx.query(
                    `INSERT INTO mes.schedule_state (service, last_planned_at) VALUES ($1, $2)
                     ON CONFLICT (service) DO UPDATE SET paused = false, paused_by = NULL, paused_at = NULL, last_planned_at = $2, updated_at = now()`,
                    [name, new Date(now()).toISOString()],
                );
                await appendAudit(tx, { actor: user.id, object: "$service", action: `schedule:resume:${name}`, after: { service: name, version: service.version } });
            });
            events?.emit("schedule.resumed", { message: `${name} resumed by ${user.id}.`, details: { service: name, by: user.id } });
            return { ok: true };
        },
        // One run now, outside the schedule (a person asks), as the schedule's identity.
        async "integration.schedule.runNow"({ name } = {}) {
            const user = await designerOf(this);
            const service = await scheduledService(name);
            const [row] = await db.transaction(async (tx) => {
                const inserted = await tx.query(
                    "INSERT INTO mes.integration_outbox (service, event, run_as, chain, run_on) VALUES ($1, $2, $3, '[]', $4) RETURNING id",
                    [name, JSON.stringify({ kind: "schedule", scheduledAt: new Date(now()).toISOString(), manual: true, by: user.id }), serviceIdentity(service.body), service.body.runOn ?? null],
                );
                await appendAudit(tx, { actor: user.id, object: "$service", action: `schedule:run-now:${name}`, after: { service: name, outbox: Number(inserted[0].id) } });
                return inserted;
            });
            return { ok: true, outbox: Number(row.id) };
        },
        // A person sends a failed trigger again (after fixing the other system, or its secret).
        async "integration.retry"({ id } = {}) {
            const user = await designerOf(this);
            const [row] = await db.query("UPDATE mes.integration_outbox SET state = 'pending', next_at = now(), attempts = 0 WHERE id = $1 AND state IN ('retry', 'dead', 'rejected') RETURNING id", [id]);
            if (!row) fail("Only a failed or refused trigger is sent again.", { status: 409 });
            await db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$service", action: "outbox:retry", after: { outbox: Number(id) } }));
            return { ok: true };
        },
    };
    // A published service with a schedule, or a refusal.
    async function scheduledService(name) {
        const service = typeof name === "string" && IDENTIFIER.test(name) ? (await store.services()).get(name) : null;
        if (!service || !(service.body.on ?? []).some(isSchedule)) fail("No published service with a schedule by that name.", { status: 404 });
        return service;
    }
    const touches = { "integration.call": [], "integration.activity": [], "integration.retry": [], "design.dryRun": [], "integration.monitor": [], "integration.schedule.pause": [], "integration.schedule.resume": [], "integration.schedule.runNow": [], "integration.scheduleRuns": [] };
    return { run, drain, plan, heartbeat, dryRunService, dryRunRule, handler, services, touches, useTransactions(given) { transactionsApi = given; }, useSuiteCapabilities(given) { suiteCapabilities = { ...given }; }, useSuiteSchedules(given, check) { suiteSchedules = { ...given }; if (check) scheduleCheck = check; } };
}
