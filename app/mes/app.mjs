// OpenCore MES, the server: one createJurisServer call (Juris README, "Your first app"). The database is
// passed in, so a test can pass its own.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJurisServer } from "@opencore-mes/juris-kit/server/kernel.js";
import { clientIp } from "@opencore-mes/juris-kit/server/http.js";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";
import { title, guard, withSuites, designPath } from "./client/app.js";
import { createStore } from "./server/store.js";
import { keepGuestsWhole } from "./db/guest.mjs";
import { createServices } from "./server/services.js";
import { createDesign } from "./server/design.js";
import { createPresence } from "./server/presence.js";
import { authHandler, methodsOf, sessionIdOf, setSessionCookie } from "./server/auth.js";
import { signInSettings } from "./server/sign-in.js";
import { PICKER_SHOWN, searchWords } from "./client/people-file.js";
import { aiApi, createTokens, SCOPES } from "./server/ai-api.js";
import { apiContract } from "./server/api-contract.js";
import { createDesktops } from "./server/desktops.js";
import { createReports } from "./server/reports.js";
import { createBlobs } from "./server/blobs.js";
import { createAttachments } from "./server/attachments.js";
import { createCopilot } from "./server/copilot.js";
import { createIntegration, createTriggers } from "./server/integration.js";
import { createFitness } from "./server/fitness.js";
import { createAnalytics } from "./server/analytics.js";
import { createQuery } from "./server/query.js";
import { createTransfer } from "./server/transfer.js";
import { createModelFile } from "./server/model-file.js";
import { createTransactions } from "./server/transactions.js";
import { createSignatures } from "./server/signatures.js";
import { createAccount } from "./server/account.js";
import { createTitles } from "./server/titles.js";
import { createScreens } from "./server/screens.js";
import { createRecordRequests } from "./server/record-requests.js";
import { createMail } from "./server/mail.js";
import { createSqlStats } from "./server/sql-stats.js";
import { createCallStats, channelOf } from "./server/call-stats.js";
import { createDatabase } from "./server/database.js";
import { fail, ServiceError } from "@opencore-mes/juris-kit/errors.js";
import { appendAudit, checkAudit, deferAudit } from "./server/audit.js";
import { mask, decide } from "./server/policy.js";
import { servicePrefix } from "./suites.mjs";
import { suiteClashes } from "./client/builtins.js";
import { createSamples, samplesTouches, forInstalled } from "./server/packs.js";
import { createSandboxes } from "./server/sandbox.js";
import { createFlows } from "./server/flows.js";
import { createGuides } from "./server/guides.js";
import { FLOW_EXTENDABLE } from "./client/definition.js";
import { runServiceScript, scriptRunnerIsolation } from "./server/rules.js";
import { organizationSettings } from "./server/organization.js";
import { createRetention, RUN_EVERY_MS as RETENTION_EVERY_MS } from "./server/retention.js";
import { createIntegrity, SCAN_EVERY_MS as INTEGRITY_EVERY_MS } from "./server/integrity.js";
import { formatsOf } from "./client/format.js";
import { themeCss, schemeOf, personalChoice } from "./client/theme.js";
// The chart library (§34.9): from this installation's node_modules (a checkout), else the copy an npm
// package of the app carries beside it (app/mes/vendor), since its dependencies sit outside its root.
// The PDF library (§35.4): Mozilla's pdf.js, Apache-2.0, its legacy build (for the browsers a plant's
// tablets run), from node_modules here and vendored into the server's package (ops/npm/build.mjs).
const vendored = (from, packaged) => [from, packaged].find((f) => existsSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)))) ?? from;
const PDFJS = vendored("node_modules/pdfjs-dist/legacy/build/pdf.min.mjs", "app/mes/vendor/pdf.min.mjs");
const PDFJS_WORKER = vendored("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "app/mes/vendor/pdf.worker.min.mjs");
const ECHARTS = ["node_modules/echarts/dist/echarts.esm.min.mjs", "app/mes/vendor/echarts.esm.min.mjs"].find((f) => existsSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)))) ?? "node_modules/echarts/dist/echarts.esm.min.mjs";

// `routing` (routing.js) routes replica-safe reads and holds the replay fence; without it the primary
// serves all. `bus` (Juris pg-outbox.js) carries every change to the other instances; without it this
// instance is alone. `instance` names it in /healthz.
// `ai` is the AI gateway's provider (ai-gateway.js) the copilot uses; without one the copilot says so.
// `devReload` (Juris dev-reload.js, development only) reloads the open pages when the code changes.
// `secrets(name)` answers a connection's credential (§15.2), which only the entry reads.
// `outboxEveryMs` paces the trigger worker (0: this instance runs no triggers).
// `node` is this instance as the others see it (§15.3): { tags, scheduler } (its name is `instance`);
// `schedulerEveryMs` paces its scheduler (0, or node.scheduler false: it plans no schedules);
// `plantTz` is the time zone of a schedule that names none; `now` the scheduler's clock (ms), which a
// test moves itself.
// `dbState()` says whether the write database is reachable (db-gate.js): { state: "up" | "down", … }.
// `events` (event-log.js) is the event log: copied into the database by a job, told of triggers given
// up on; `dbWatch` (event-log.js watchDb) is told of every call refused because the database was down.
export async function createApp({ auditCheck = null, sqlStats = null, suiteUpdates = () => [], suiteKept = () => ({}), db, dbState = () => ({ state: "up", since: null }), events = null, dbWatch = null, node = {}, schedulerEveryMs = 5000, plantTz = "UTC", now = () => Date.now(), routing = null, bus = null, instance = null, ai = null, dev = false, build = "dev", secure = !dev, devReload = null, secrets = () => undefined, outboxEveryMs = 1000, mail: mailSettings = {}, sessionCookie = null, suites = [], demo = false, sandbox = false, signIn = null, fetchFn = fetch, simpleLists = dev || demo, demoAs = null, connectionHosts = null, trustProxy = false, embedOrigins = [], guestsFollow = false, testSandbox = false, testAt = { port: 0, host: "127.0.0.1", url: null } }) {
    setSessionCookie(sessionCookie);
    // A transaction's audit entries are chained as it commits (§7.3): the chain's head is held for that alone.
    deferAudit(db);
    // How people sign in (§8.2, auth.js): the picker only on a development or demo instance; a
    // password of their own unless this is the demo; the directory and single sign-on as configured.
    // The demo has no sign-in page: a visitor is the demo person (demoAs, or the first who designs) and
    // switches from the top bar.
    const signInWith = { picker: dev || demo, passwords: !demo, auto: demo, as: demoAs, ...(signIn ?? {}) };
    // Every statement measured (sql-stats.js, §38): server.mjs measures the primary and the replica before
    // the read routing; a database given as it is (tests, sandboxes) is measured here.
    const stats = sqlStats ?? createSqlStats();
    if (!sqlStats) db = stats.wrap(db);
    // Every call measured (call-stats.js, §38.1): the platform's services by how they were called, and each design
    // that answers one (a service, a transaction, a named query) by its own name, its statements put down to it.
    const calls = createCallStats({ within: stats.within });
    const store = createStore(db, routing ? { read: routing.read } : {});
    const records = createServices({ store, triggers: createTriggers(store), plantTz, now });
    const design = createDesign({ store, plantTz });
    // Every emergency change goes into the event log, and an overdue review afterwards (§5.7).
    if (events) design.useEvents(events);
    const presence = createPresence({ store });
    // AI access (§16): tokens a designer issues so an AI can work in the designer as them, through
    // the REST API at /ai/v1/ (ai-api.js). Managed here from the designer's own page.
    const tokens = createTokens(db);
    const tokenOwner = async (self) => {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        const roles = await store.rolesFor(user.id, "design");
        if (!roles.length) fail("The designer is not shared with you.", { status: 403 });
        return { user, designer: roles.includes("designer") };
    };
    const aiServices = {
        async "ai.tokens"() {
            const { user } = await tokenOwner(this);
            return (await tokens.list(user.id)).map((t) => ({ ...t, created_at: t.created_at?.toISOString?.() ?? t.created_at, last_used: t.last_used?.toISOString?.() ?? t.last_used, revoked_at: t.revoked_at?.toISOString?.() ?? t.revoked_at, expires_at: t.expires_at?.toISOString?.() ?? t.expires_at }));
        },
        async "ai.token.create"({ name, agent, scopes, days } = {}) {
            const { user, designer } = await tokenOwner(this);
            const wanted = Array.isArray(scopes) && scopes.length ? scopes : ["design:read", "design:draft"];
            // A reviewer's AI may read and check designs; only a designer's may draft them.
            if (!designer && wanted.some((s) => s !== "design:read")) fail("Only a designer may give an AI drafting scopes.", { status: 403 });
            if (!wanted.every((s) => SCOPES.includes(s))) fail(`Scopes are ${SCOPES.join(", ")}.`);
            const issued = await tokens.issue(user.id, { name, agent, scopes: wanted, ...(days !== undefined ? { days: Number(days) } : {}) });
            return { ...issued, created_at: issued.created_at?.toISOString?.() ?? issued.created_at };
        },
        async "ai.token.revoke"({ id } = {}) {
            const { user } = await tokenOwner(this);
            if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) fail("A bad token id.");
            const [done] = await tokens.revoke(user.id, id);
            if (!done) fail("No such token of yours, or it is already revoked.", { status: 404 });
            return { ok: true };
        },
    };
    const designAndRecords = { ...records.services, ...design.services };
    // Services and connections the designer creates (§15.2). Their writes happen outside any page's
    // call, so they reach the pages through the server's own invalidate, bound once it exists.
    let server = null;
    const invalidate = async (targets) => server?.invalidate(routing ? [...targets, { name: "$lsn", args: [routing.lsn()] }] : targets);
    const scheduler = node.scheduler !== false && schedulerEveryMs > 0;
    // The audit chain, verified every quarter of an hour by the instance that schedules (COMPLIANCE.md G3):
    // what it found is in /healthz, and a break is a critical event, once, until it is put right.
    let auditState = null;
    const verifyAuditChain = async () => {
        // In a worker thread where the server gives one (auditCheck: server.mjs), else here, giving way between batches.
        const r = await (auditCheck ?? checkAudit)(db);
        if (!r.ok && auditState?.brokenAt !== r.brokenAt) events?.emit?.("audit.broken", { severity: "critical", message: `The audit trail's chain is broken: ${r.problem}. Run node app/mes/db/verify-audit.mjs, find what changed it, and tell whoever answers for the system's integrity.`, details: { brokenAt: r.brokenAt } });
        auditState = { ok: r.ok, verifiedTo: r.verifiedTo, at: r.at, ...(r.ok ? {} : { brokenAt: r.brokenAt, problem: r.problem }) };
    };
    const integration = createIntegration({
        store, records: records.services, recordTargets: records.recordTargets, tokens, secrets, invalidate, events, plantTz, now,
        // A public demo calls no outside system: nobody uses it to reach the rest of the internet; nor
        // does a sandbox (sandbox.js), which works on copies and must touch nothing real.
        outbound: !demo && !sandbox,
        // The hosts connections may reach, when the plant lists them (server.mjs MES_CONNECTION_HOSTS).
        connectionHosts,
        node: { name: instance ?? "local", tags: node.tags ?? [], scheduler, outbox: outboxEveryMs > 0, build },
    });
    // Sandboxes (§5.11): a change's draft on copies of real records, each in a database of its own,
    // with an app of its own (this one, made again on it); none inside a sandbox.
    const sandboxes = sandbox ? null : createSandboxes({
        store, design, records, suites, instance,
        // (`test`: the test sandbox, §5.13: people sign in to it, with the picker where this instance has it.)
        makeApp: (sdb, { test = false } = {}) => createApp({ db: sdb, dev: false, build: `${build}-${test ? "test" : "sandbox"}`, plantTz, outboxEveryMs: 0, schedulerEveryMs: 0, suites, sandbox: true, testSandbox: test, secure, signIn: signInWith }),
        test: testSandbox ? undefined : testAt,
    });
    sandboxes?.sweepLeftovers().catch(() => {});
    // The fitness test (§5.9): run on demand, and by every submit, which it can refuse.
    // (Named queries, §23.1: run as the submitter by the query module made below.)
    const fitness = createFitness({ store, design, integration, records: records.services, sandboxes, queries: { runNamed: (...args) => query.runNamed(...args), describeNamed: (...args) => query.describeNamed(...args) } });
    design.useFitness(fitness.run);
    // The page a desktop opens at sign-in, by the address it comes from (§6.8).
    const desktops = createDesktops({ store });
    // Pictures and documents (§35, §34.10): the file store, and what the copilots are given of it.
    // A record's file (§35.4): served only to someone the record services let read that record and that field
    // (its policies, what its access requires), the field a file or a picture.
    const fileOf = async (user, object, id, field) => {
        const def = await store.definition(object);
        if (!["file", "image"].includes(def?.body.fields?.[field]?.type)) return null;
        const x = records.internals;
        const row = await x.loadRow(x.reader, object, id);
        const seen = row && mask(def.body, await x.actorFor(user, object), x.rowOut(row));
        return seen && typeof seen[field] === "string" ? seen[field] : null;
    };
    const blobs = createBlobs({ store, fileOf });
    const attachments = createAttachments({ blobs });
    const copilot = createCopilot({ store, attachments, services: { ...designAndRecords, "design.dryRun": integration.services["design.dryRun"], ...fitness.services, ...(sandboxes ? { "sandbox.tryScenario": sandboxes.services["sandbox.tryScenario"] } : {}) }, provider: ai ?? { name: "none", model: null, available: false, hint: "No AI is configured on this server.", complete: async () => { throw new Error("no AI"); } } });
    // Whether the write database answers (db-gate.js), for the banner a page shows while it does not.
    // It touches no database and needs no sign-in, so it answers during an outage.
    const statusServices = {
        async "status.db"() {
            const { state, since } = dbState();
            return { state, since };
        },
    };
    // Analytics (§22): state intervals and what they answer.
    const analytics = createAnalytics({ store, plantTz, certificationsOf: (id) => records.internals.certificationsOf(id) });
    // Queries (§23): SQL and JSON over views with each object's policies compiled in.
    const query = createQuery({ store, certificationsOf: (id) => records.internals.certificationsOf(id) });
    // What a design naming a query's columns is checked against (§23.1).
    design.useQueryDescribe(query.describeNamed);
    records.useQuery(query);
    // Reports and the analytics copilot (§34): a report's queries run as whoever opens it, over those
    // views; the copilot reads the schema and queries as the person, and draws.
    // What people call a record, never its id (§34.9): every answer a person or the copilot reads.
    const titles = createTitles({ store, records });
    const reports = createReports({ instance: instance ?? "local", events, store, records: records.services, requireViewer: records.internals.requireViewer, query, titles, blobs, attachments, plantTz, provider: ai ?? { name: "none", model: null, available: false, hint: "No AI is configured on this server.", complete: async () => { throw new Error("no AI"); } } });
    // Excel import and export (§24): through the record services, as the person.
    const transfer = createTransfer({ store, records: records.services, recordTargets: records.recordTargets, invalidate, actorFor: records.internals.actorFor });
    // A model file (§24.1): the whole model to another installation: its designs as a change there, then
    // its records through the record services.
    const modelFile = createModelFile({ store, design, transfer, records, secrets, suites: suites.map((x) => x.name), invalidate, instance, build: typeof build === "function" ? build() : build });
    // Transactions (§25): designed screens that change several records as one, all or nothing.
    // Signatures by two people (§7.4): a second person beside the first, passwords at each signature.
    const signatures = createSignatures({ store, signIn: signInWith, sandbox });
    // The person's own sign-in, and its administration (§8.2); how long a session may sit idle.
    const account = createAccount({ store, signIn: signInWith });
    store.sessionIdle = account.policy.idleMinutes;
    // Approvals of changes and of record changes are signatures too (§7.4).
    design.useSignatures(signatures);
    const transactions = createTransactions({ store, records, outbound: !demo && !sandbox, signatures });
    transactions.useQuery(query);
    // A transaction input's choices read the inputs and the records they name, as a pop-up's scope does (§23.1).
    records.useTransactionScope((user, name, values) => transactions.scopeFor(user, name, values));
    transactions.useSuiteSteps(() => design.suiteExtensions().steps);
    // A service's script runs the transactions its design names (§15.2): through the same service.
    integration.useTransactions(transactions);
    // …and an outside system reads the named queries published over HTTP (§23.3).
    integration.useQuery(query);
    // Flows (§32): a route's runs. They place a traveler's transactions (the gate), move it on once a run
    // has committed, start it when it is made, and take up travelers already there when a route is published.
    const flows = createFlows({ store, records, design, query, sandbox, plantTz });
    transactions.useFlows(flows);
    // Calls counted by design (call-stats.js, §38.1): who a call is for, a transaction's and a service's runs, a query's.
    for (const m of [records, transactions, integration, query]) m.useCallStats(calls);
    flows.useTransactions(transactions.services);
    records.useAfterCreate((made) => flows.afterCreate(made));
    flows.useInvalidate((targets) => invalidate(targets));
    records.useAfterWrite((written) => flows.afterWrite(written));
    design.onFlowsPublished((names) => flows.adopt(names));
    // A training plant's guests (§6.9, §37: DEMO_GUESTS_FOLLOW=1) take up the roles of an object a change makes
    // live, so a learner's own copy of Lot opens for them at once; the public demo's wait for the reset.
    if (demo && guestsFollow) design.onExecuted(async () => { if ((await keepGuestsWhole(db)).length) store.forget(); });
    // Screens (§26): designed pages of fixed building blocks, read with each viewer's own rights.
    const screens = createScreens({ store, records, design, transactions, query, titles, plantTz });
    // Approval of record changes (§28): what an object's design says waits, waits here.
    // Mail to approving departments (§28.6): sent by the instance that runs the outbox; logged with no SMTP_URL.
    const mail = createMail({ db, smtpUrl: mailSettings.smtpUrl ?? null, from: mailSettings.from ?? null, publicUrl: mailSettings.publicUrl ?? null, ...(mailSettings.send ? { send: mailSettings.send } : {}), ...(mailSettings.log ? { log: mailSettings.log } : {}) });
    const requests = createRecordRequests({ store, records, mail });
    // How long each kind of data is kept, its purge, and erasure of a person's data (§27.8, G11).
    const retention = createRetention({ store, records, events, instance });
    // The data integrity review (§7.7): changes made around the platform, found and reported.
    const integrity = createIntegrity({ store, records, signatures, events });
    requests.useSignatures(signatures);
    records.useApprovals(requests);
    // What waits for the viewer, beside their name (§5.3, §28): changes they may review, the steps of
    // changes and of record changes they may sign now. Live: every review, signature and request
    // re-runs it.
    const inbox = {
        async "inbox.mine"({ as } = {}) {
            const user = await records.internals.requireViewer(this, as);
            const designs = (await design.waitingFor())[user.id] ?? { review: [], sign: [] };
            const recordsWaiting = (await requests.waitingFor())[user.id]?.sign ?? [];
            const items = [
                // Plans waiting for them (§32.5): a decision to make, a screen to fill in, a wait to acknowledge.
                ...(await flows.tasksFor(user.id)),
                // (`emergency`: one to approve at once, or to review or confirm afterwards, §5.7.)
                ...designs.review.map((c) => ({ kind: "review", id: c.id, title: c.title, link: `/design/c/${c.id}`, ...(c.emergency ? { emergency: c.emergency, overdue: Boolean(c.overdue) } : {}) })),
                ...designs.sign.map((c) => ({ kind: "sign", id: c.id, title: c.title, department: c.department, step: c.step, link: `/design/c/${c.id}`, ...(c.emergency ? { emergency: c.emergency, overdue: Boolean(c.overdue) } : {}) })),
                ...recordsWaiting.map((c) => ({ kind: "sign", record: true, id: c.id, title: c.title, department: c.department, step: c.step, link: `/request/${c.id}` })),
                ...(await suiteAlerts(user)),
                // A sign-in administrator's: ids locked, wrong passwords spread over many ids (G9).
                ...(await account.inboxOf(user).catch(() => [])),
            ];
            return { count: items.length, items };
        },
    };
    // What the suites have for a person (§29): alerts of their own, from each part's `inbox(user)` →
    // [{ id, title, what?, link }] (20 at most each), live as the suite invalidates "inbox.mine". A suite
    // whose alerts fail is left out of the inbox, never the inbox itself.
    async function suiteAlerts(user) {
        const each = await Promise.all(suites.map(async (s, i) => {
            const inboxOf = suiteParts[i]?.inbox;
            if (typeof inboxOf !== "function") return [];
            const items = await Promise.resolve().then(() => inboxOf(user)).catch(() => []);
            return (Array.isArray(items) ? items : []).filter((x) => x && x.id != null && typeof x.title === "string" && typeof x.link === "string" && x.link.startsWith("/")).slice(0, 20)
                .map((x) => ({ kind: "alert", suite: s.name, id: `${s.name}:${x.id}`, title: x.title.slice(0, 200), what: typeof x.what === "string" ? x.what.slice(0, 200) : null, link: x.link }));
        }));
        return each.flat();
    }
    // Suites (§29, suites.mjs): each registers its server part with what it is handed here, the
    // platform's own services and engines, and adds services, live queries, HTTP handlers and jobs
    // named after itself. It writes through the record services like everything else, so its writes
    // are checked, audited and, where a design says so, approved.
    const suiteContext = {
        store, db, fail, ServiceError, appendAudit, mask, decide, sessionIdOf, plantTz, instance,
        invalidate: (targets) => invalidate(targets),
        records: { services: records.services, internals: records.internals },
        design: { designUser: design.designUser },
        // The published design elements of the suite's own kinds (§30.11): [{ name, version, body }].
        elements: { published: async (kind) => [...(await store.elements()).entries()].filter(([, e]) => e.body?.kind === kind).map(([name, e]) => ({ name, version: e.version, body: e.body })) },
        transfer: { importTables: transfer.importTables, exportTables: transfer.exportTables, readXlsx: transfer.readXlsx, writeXlsx: transfer.writeXlsx, cellValue: transfer.cellValue, models: transfer.services["transfer.models"] },
        requests: { waitingFor: requests.waitingFor },
        // A published script a suite's part of a design names (§29.4), run in the scripts' sandbox:
        // its input in, its output out; it throws to refuse.
        scripts: {
            async run(name, input) {
                const script = (await store.scripts()).get(name);
                if (!script) throw Object.assign(new Error(`The script ${name} is not published.`), { fault: true });
                return runServiceScript({ name, version: script.version, source: script.source, ctx: { now: new Date().toISOString(), ...input }, deadlineMs: 2000 });
            },
        },
    };
    const suiteParts = [];
    for (const suite of suites) {
        // What only this suite may do: act as an identity of its own (`<suite>:<name>`, never a person),
        // holding the roles it names, through the record services, so policies, the rule pipe, the
        // audit trail and idempotency apply as for a service's own identity (§15.2); and read the
        // secrets named after it (MES_SECRET_<SUITE>_<NAME>), never another's.
        const own = suite.name.replace(/-/g, "_");
        const actingAs = ({ name, label, roles = {}, reason } = {}) => {
            if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`suite ${suite.name}: an identity of its own is named in letters, digits, ., _ and -`);
            // A suite's own identity (a machine) is not held to what access requires (§9.9): it reports what it does.
            return { [CALL_KIND]: "internal", reason: String(reason ?? `${suite.name} suite`), user: { id: `${suite.name}:${name}`, name: String(label ?? name), serviceRoles: roles, unrestricted: true } };
        };
        const ownSecret = (name) => (typeof name === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(name) ? secrets(`${own}_${name}`) : undefined);
        // Keep a file it was handed from outside (a shipping label, a certificate a supplier sends) in the file
        // store, by its own name (`suite:<name>`), under the checks an upload has (a kind the store keeps, its
        // size): → { blob, type, size, name }, or { status, error } when it is refused. Records then name it.
        const files = { keep: async (bytes, name = null) => (Buffer.isBuffer(bytes) ? blobs.put({ id: `suite:${suite.name}` }, bytes, name) : { status: 400, error: "A file is its bytes (a Buffer)." }) };
        const part = (await suite.register?.({ ...suiteContext, records: { ...suiteContext.records, actingAs }, secrets: ownSecret, files, outbound: !demo && !sandbox, suite: { name: suite.name, label: suite.label, version: suite.version } })) ?? {};
        const prefix = servicePrefix(suite.name);
        for (const name of [...Object.keys(part.services ?? {}), ...(part.queries ?? [])]) {
            if (!name.startsWith(prefix)) throw new Error(`suite ${suite.name}: "${name}" is not named after it ("${prefix}…")`);
        }
        suiteParts.push(part);
    }
    // Each suite's check of its part of an object's design, for the designer's checks.
    design.useSuiteDesigns(Object.fromEntries(suites.flatMap((x, i) => (suiteParts[i].designs?.object?.validate ? [[x.name, suiteParts[i].designs.object.validate]] : []))));
    // Their flow node kinds (§32.9), each named after its suite and extending a core kind.
    const flowNodes = {};
    suites.forEach((x, i) => {
        for (const [kind, spec] of Object.entries(suiteParts[i].flowNodes ?? {})) {
            if (!kind.startsWith(`${x.name}.`)) throw new Error(`suite ${x.name}: the flow node kind "${kind}" is not named after it ("${x.name}.…")`);
            if (!FLOW_EXTENDABLE.includes(spec?.extends)) throw new Error(`suite ${x.name}: ${kind} extends one of ${FLOW_EXTENDABLE.join(", ")}`);
            flowNodes[kind] = { ...spec, suite: x.name };
        }
    });
    design.useSuiteFlowNodes(flowNodes);
    // What else a suite adds (§30.11), each named after it: what a service's script may ask of it
    // (`capabilities`: name → fn(args, info) or { run, dry }), transaction step kinds (`steps`),
    // screen block kinds (`blocks`), kinds of design element (`elements`) and kinds of schedule a service
    // may run on (`schedules`: times only the suite can work out), "<suite>.<kind>". With the suite gone, a design that names one
    // says so where it is used; nothing else stops.
    const capabilities = {};
    const stepKinds = {};
    const blockKinds = {};
    const elementKinds = {};
    const scheduleKinds = {};
    const SUITE_NAME = /^[a-z][a-z0-9_]{0,47}$/;
    suites.forEach((x, i) => {
        for (const [name, spec] of Object.entries(suiteParts[i].capabilities ?? {})) {
            if (!SUITE_NAME.test(name) || !(typeof spec === "function" || typeof spec?.run === "function")) throw new Error(`suite ${x.name}: the capability "${name}" is a function, or { run, dry }, named in lower case`);
            (capabilities[x.name] ??= {})[name] = spec;
        }
        for (const [what, into] of [["steps", stepKinds], ["blocks", blockKinds], ["elements", elementKinds], ["schedules", scheduleKinds]]) {
            for (const [kind, spec] of Object.entries(suiteParts[i][what] ?? {})) {
                if (!kind.startsWith(`${x.name}.`) || !SUITE_NAME.test(kind.slice(x.name.length + 1))) throw new Error(`suite ${x.name}: "${kind}" (${what}) is not named after it ("${x.name}.<kind>")`);
                // A kind of schedule is its times: without runs it has none to give.
                if (what === "schedules" && typeof spec?.runs !== "function") throw new Error(`suite ${x.name}: the schedule kind "${kind}" has runs(settings, afterMs, { untilMs, limit, tz }) → [ms]`);
                into[kind] = { ...spec, suite: x.name };
            }
        }
    });
    integration.useSuiteCapabilities(capabilities);
    integration.useSuiteSchedules(scheduleKinds, (trigger) => design.scheduleCheck(trigger));
    design.useSuiteExtensions({ capabilities: Object.fromEntries(Object.entries(capabilities).map(([suite, given]) => [suite, Object.keys(given)])), steps: stepKinds, blocks: blockKinds, elements: elementKinds, schedules: scheduleKinds });
    // Each suite version this installation runs, and what it gives designs, kept for good (§29.5, §29.10): the AI
    // and the designer read what an earlier version gave, and which one gave what an update dropped. A sandbox or a
    // test copy records nothing of its own; a version first run here is audited.
    const givesOf = (x) => ({
        capabilities: Object.keys(capabilities[x.name] ?? {}), steps: Object.keys(stepKinds).filter((k) => k.startsWith(`${x.name}.`)),
        blocks: Object.keys(blockKinds).filter((k) => k.startsWith(`${x.name}.`)), schedules: Object.keys(scheduleKinds).filter((k) => k.startsWith(`${x.name}.`)),
        elements: Object.keys(elementKinds).filter((k) => k.startsWith(`${x.name}.`)), flowNodes: Object.keys(flowNodes).filter((k) => k.startsWith(`${x.name}.`)),
        designPart: Boolean(suiteParts[suites.indexOf(x)].designs?.object?.validate),
    });
    if (!sandbox && suites.length) {
        await db.transaction(async (tx) => {
            for (const x of suites) {
                const [row] = await tx.query(`INSERT INTO mes.suite_versions (name, version, label, gives, pack_version) VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (name, version) DO UPDATE SET label = EXCLUDED.label, gives = EXCLUDED.gives, pack_version = EXCLUDED.pack_version, last_run = now()
                    RETURNING (xmax = 0) AS first`, [x.name, x.version, x.label, JSON.stringify(givesOf(x)), x.designs?.version ? String(x.designs.version) : null]);
                if (row?.first) await appendAudit(tx, { actor: "platform", object: "$suites", action: "suite:first run", after: { name: x.name, version: x.version } });
            }
        }).catch((error) => console.error("suites: their versions not recorded", error));
    }
    design.useSuiteHistory({ read: () => db.query("SELECT name, version, label, gives, pack_version, first_run, last_run FROM mes.suite_versions ORDER BY name, last_run DESC"), kept: suiteKept });
    // The suites' design packs (§29.6): offered to the designers, loaded as samples through the records.
    const packs = Object.fromEntries(suites.filter((x) => x.designs).map((x) => [x.name, forInstalled(x.designs, suites.map((y) => y.name))]));
    // Each pack as offered here: what it brings only with a suite installed, only where that one is (§29.6).
    design.useSuitePacks(Object.fromEntries(suites.filter((x) => x.designs).map((x) => [x.name, forInstalled({ suite: x.label, name: x.name, ...x.designs }, suites.map((y) => y.name))])));
    // Their set-up guides (§29.8), shown in the designer.
    design.useSuiteUpdates(suiteUpdates);
    design.useSuitesInstalled(suites);
    design.useSuiteGuides(Object.fromEntries(suites.filter((x) => x.guide).map((x) => [x.name, { suite: x.label, version: x.version, ...x.guide }])));
    // Several suites at once (§29): each its own prefix, and none locking what another locks differently.
    const clash = suiteClashes(suites.filter((x) => x.designs).map((x) => ({ name: x.name, label: x.label, pack: x.designs })));
    if (clash.length) throw new Error(`suites: ${clash.join("; ")}`);
    const samples = createSamples({ store, records, packs: () => packs });
    const suiteServices = Object.assign({}, ...suiteParts.map((p) => p.services ?? {}));
    const suiteTouches = Object.assign({}, ...suiteParts.map((p) => p.touches ?? {}));
    // The UI guides a panel's "?" opens (§33).
    const guides = createGuides({ records });
    const services = { ...suiteServices, ...guides.services, ...modelFile.services, ...designAndRecords, ...samples, ...(sandboxes?.services ?? {}), ...flows.services, ...presence.services, ...aiServices, ...copilot.services, ...integration.services, ...fitness.services, ...statusServices, ...analytics.services, ...query.services, ...reports.services, ...transfer.services, ...transactions.services, ...screens.services, ...requests.services, ...retention.services, ...integrity.services, ...inbox, ...signatures.services };
    // Every change that says what it touches also says where the primary's WAL had reached once it
    // committed ($lsn): an instance that hears of it on the bus waits for its replica to replay that far
    // before it re-runs anything (routing.js). A service that changes nothing adds nothing.
    const withPosition = (touched) => {
        if (!routing || (Array.isArray(touched) && !touched.length)) return touched;
        return async function (...args) {
            const targets = typeof touched === "function" ? await touched.apply(this, args) : touched;
            const list = Array.isArray(targets) ? targets : [targets];
            return list.length ? [...list, { name: "$lsn", args: [routing.lsn()] }] : list;
        };
    };
    const touches = Object.fromEntries(Object.entries({ ...records.touches, ...design.touches, ...presence.touches, "ai.tokens": [], "ai.token.create": [], "ai.token.revoke": [], "status.db": [], ...analytics.touches, ...query.touches, ...reports.touches, ...transfer.touches, ...modelFile.touches, ...transactions.touches, ...screens.touches, ...requests.touches, ...retention.touches, ...integrity.touches, "inbox.mine": [], ...suiteTouches, ...samplesTouches, ...guides.touches, ...flows.touches, ...(sandboxes?.touches ?? {}), ...copilot.touches, ...integration.touches, ...fitness.touches }).map(([name, t]) => [name, withPosition(t)]));

    // Told of every invalidation, local or off the bus, before anything re-runs (Juris onInvalidate):
    // a remote write moves the fence; a published definition empties every instance's cache of them.
    const onInvalidate = (targets, { remote }) => {
        for (const target of targets) {
            const name = typeof target === "string" ? target : target?.name;
            if (name === "$lsn" && remote) routing?.advance(target.args?.[0]);
            if (name === "defs.get" || name === "defs.list" || name === "transactions.list" || name === "screens.list") store.forget();
        }
    };
    const queries = [...records.queries, ...design.queries, ...presence.queries, ...transactions.queries, ...flows.queries, ...screens.queries, ...reports.queries, ...requests.queries, ...integrity.queries, "inbox.mine", ...(sandboxes?.queries ?? []), ...suiteParts.flatMap((p) => p.queries ?? [])];
    // Each family of live queries decides who may hold one.
    const authorize = function (name, args, info) {
        return (name.startsWith("design.") ? design.authorize : records.authorize).call(this, name, args, info);
    };

    // What the sign-in page offers, to anyone: nothing secret in it (and the plant's policy, which the
    // pages follow: how long a session may idle, whether a signature asks for a password).
    const methods = { ...methodsOf(signInWith), idleMinutes: account.policy.idleMinutes, signWithPassword: signatures.asksProof, mfa: account.policy.mfa };
    // What People & departments calls the sign-in id, and its hint (§8.2): read each time, so a change approved shows at once.
    services["auth.methods"] = async () => {
        const said = await signInSettings(db);
        return { ...methods, ...(said.idLabel ? { idLabel: said.idLabel } : {}), ...(said.idHint ? { idHint: said.idHint } : {}) };
    };
    // About (the navigator's About, §29.9): the platform's version and build, the framework's, and every suite
    // installed with its version and its design pack's. To anyone signed in: nothing in it is secret, and a
    // person reporting a problem says what they run.
    const about = {
        product: "OpenCore MES", edition: "Community edition", licence: "Apache-2.0",
        version: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version,
        framework: { name: "Juris", version: JSON.parse(readFileSync(new URL("package.json", import.meta.resolve("@opencore-mes/juris-kit/errors.js")), "utf8")).version },
        node: process.version,
        suites: suites.map((x) => ({ name: x.name, label: x.label, version: x.version, ...(x.designs ? { designs: { label: x.designs.label ?? x.label, version: String(x.designs.version ?? "") } } : {}) })),
    };
    services["about.get"] = async function () {
        if (!(await store.userForSession(this?.sessionId))) fail("Sign in first.", { status: 401 });
        // A newer version of a suite on the registry (§29.7), where the server asks it: said beside the suite.
        const newer = new Map((suiteUpdates() ?? []).map((u) => [u.name, u.newest]));
        return { ...about, suites: about.suites.map((x) => (newer.has(x.name) ? { ...x, newest: newer.get(x.name) } : x)), build: typeof build === "function" ? build() : build, instance: instance ?? null };
    };
    // The person's own account and its administration (account.js).
    Object.assign(services, account.services);
    // The Database area (§38): the statements measured, plans, tables, indexes; for its administrators.
    const database = createDatabase({ store, sqlStats: stats, callStats: calls, ai, instance: instance ?? "local" });
    Object.assign(services, database.services);
    // The picker lists the people to pick from: a development or demo instance only (the demo says so on
    // every page). Elsewhere the list is empty: who is a person here is not for anyone to read.
    const all = signInWith.picker
        ? {
            ...services,
            // Each person with the roles they hold, directly or through a group, per object, and what
            // waits for them in the designer (design.js waitingFor).
            async "auth.users"({ q = "", recent = [] } = {}) {
                // Ready to switch to, nothing typed (§5.3): those picked lately in this browser (`recent`, the
                // latest first),
                // whoever has something waiting to review or sign, and everyone who reviews or approves
                // (a department's approvers, the designer's designers and reviewers); on a simple-lists
                // instance, everyone else after them. Anyone else by search, as People & departments
                // searches (people-file.js personFits): each word the start of a word of the name, or
                // anywhere in the sign-in id; at least two letters. Never everyone at once, since a plant
                // has thousands: one more than shown says there are more.
                const words = searchWords(q).slice(0, 5);
                const lately = (Array.isArray(recent) ? recent : []).filter((id) => typeof id === "string" && id.length <= 64).slice(0, 10);
                // Changes to designs and changes to records (§28), together.
                const waiting = await design.waitingFor();
                for (const [u, w] of Object.entries(await requests.waitingFor())) (waiting[u] ??= { review: [], sign: [] }).sign.push(...w.sign);
                const waits = Object.entries(waiting).filter(([, w]) => w.review.length || w.sign.length).map(([u]) => u);
                // Each person's subjects (themselves and their groups) joined to the assignments: a plain
                // join, since a correlated OR per person took minutes at 30K people.
                const users = await db.query(
                    `WITH approvers AS (SELECT user_id AS id FROM mes.department_reps
                                        UNION SELECT subject_id FROM mes.assignments WHERE object = 'design' AND subject_kind = 'user'
                                        UNION SELECT m.user_id FROM mes.assignments a JOIN mes.group_members m ON a.subject_kind = 'group' AND m.group_id = a.subject_id WHERE a.object = 'design'),
                          shown AS (SELECT id, name, id = ANY($2) AS recent, array_position($2::text[], id) AS lately, id = ANY($3) AS waits, id IN (SELECT id FROM approvers) AS approves FROM mes.users
                                    WHERE active AND (left(id, 6) <> 'guest_' OR id = ANY($2)) AND (SELECT bool_and(lower(id) LIKE '%' || w || '%' OR EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(lower(name), '[^[:alnum:]]+')) part WHERE part LIKE w || '%')) FROM unnest($1::text[]) w) IS NOT FALSE
                                      AND (cardinality($1::text[]) > 0 OR $4 OR id = ANY($2) OR id = ANY($3) OR id IN (SELECT id FROM approvers))
                                    ORDER BY lately NULLS LAST, waits DESC, approves DESC, name LIMIT ${PICKER_SHOWN + 1}),
                          subject AS (SELECT id AS user_id, 'user' AS kind, id AS subject_id FROM shown
                                      UNION ALL SELECT m.user_id, 'group', m.group_id FROM mes.group_members m JOIN shown ON shown.id = m.user_id)
                     SELECT u.id, u.name, u.recent,
                            COALESCE(array_agg(DISTINCT a.role ORDER BY a.role) FILTER (WHERE a.role IS NOT NULL), '{}') AS roles,
                            COALESCE(array_agg(DISTINCT a.object || ': ' || a.role) FILTER (WHERE a.role IS NOT NULL), '{}') AS grants
                     FROM shown u
                     LEFT JOIN subject s ON s.user_id = u.id
                     LEFT JOIN mes.assignments a ON a.subject_kind = s.kind AND a.subject_id = s.subject_id
                     GROUP BY u.id, u.name, u.recent, u.lately, u.waits, u.approves ORDER BY u.lately NULLS LAST, u.waits DESC, u.approves DESC, u.name`,
                    [words.map((w) => w.replace(/[%_\\]/g, "")), lately, waits, simpleLists],
                );
                // Who reads every record (§27.7), said with the rest of what each holds.
                const readers = new Set((await db.query(
                    `SELECT u.id FROM mes.users u, mes.organization o, jsonb_array_elements_text(coalesce(o.body->'readers', '[]'::jsonb)) r
                     WHERE o.status = 'published' AND (r = 'user:' || u.id OR r IN (SELECT 'group:' || group_id FROM mes.group_members WHERE user_id = u.id))`,
                )).map((r) => r.id));
                // With what waits for each: the changes they would sign next, or may review.
                return users.map((u) => ({ ...u, ...(readers.has(u.id) ? { roles: [...u.roles, "reads every record"], grants: [...u.grants, "every record: read"] } : {}), waiting: waiting[u.id] ?? { review: [], sign: [] } }));
            },
        }
        : { ...services, async "auth.users"() { return []; } };

    // Every call a browser makes that the database's outage refused is counted, per service, and one
    // whose outcome is unknown is logged on its own (event-log.js watchDb).
    const served = dbWatch
        ? Object.fromEntries(Object.entries(all).map(([name, fn]) => [name, async function (...args) {
            try {
                return await fn.apply(this, args);
            } catch (error) {
                if (error?.code === "db.unavailable" || error?.code === "db.unknown") dbWatch.onRefused(name, error, args[0]);
                throw error;
            }
        }]))
        : all;
    // Each statement put down to the service (or live query) that sent it (sql-stats.js), and each call counted by
    // how it came (call-stats.js).
    const measured = Object.fromEntries(Object.entries(served).map(([name, fn]) => [name, function (...args) { return calls.measure({ kind: "platform", name, channel: channelOf(this) }, () => stats.within(name, () => fn.apply(this, args))); }]));

    // The pages and components of the platform and of every suite, in one router (app.js).
    const composed = withSuites(suites.map((x) => x.client).filter(Boolean));
    server = await createJurisServer({
        root: new URL("../..", import.meta.url),
        dev,
        // The proxies in front (Caddy, a balancer), so a caller's address is the one they came from.
        ...(trustProxy ? { trustProxy } : {}),
        build,
        devReload,
        services: measured,
        // The pages and components, the suites' among them (app.js withSuites).
        routes: composed.routes,
        setup: composed.register,
        router: { guard },
        // An <iframe> is drawn only by the media view (client/media.js): a PDF of this site's file store
        // (/blob/, /file/), never anything a design or a record names (§35.4). The browser's is the same.
        juris: { allowTags: ["iframe"] },
        api: {
            context: (req) => ({ sessionId: sessionIdOf(req) }),
            // A design is saved whole: People & departments with a plant's people (30K is about 2 MB)
            // must fit, with room to grow. Above it, 413.
            maxBody: 8_000_000,
            live: {
                queries,
                strictQueries: true,
                touches: { ...touches, "auth.methods": [], "auth.users": [], "about.get": [], ...account.touches, ...signatures.touches, ...database.touches },
                // One answer may be megabytes (People & departments with a plant's people): a stream is
                // dropped as too far behind only past what a request may carry too.
                maxBufferBytes: 8_000_000,
                authorize,
                identify: async function () { return (await store.userForSession(this?.sessionId))?.id ?? null; },
                // The ceilings on streams and subscriptions are per sign-in, not per person: on the demo
                // every visitor is one person (and in a plant a person has several screens), and the
                // thirteenth of them would get no live updates at all.
                clientKey: (req, owner) => { const sid = sessionIdOf(req); return sid ? `s:${sid}` : owner ?? `ip:${clientIp(req, { trustProxy }) ?? "?"}`; },
                onInvalidate,
                ...(bus ? { bus } : {}),
            },
        },
        handlers: [aiApi({ store, services, tokens, invalidate, contract: apiContract({ onDeprecatedUse: (api, operation, who, notice) => events?.emit("api.deprecated", { severity: "warning", message: `${who} called ${api} ${operation}, deprecated since ${notice.since}; its sunset is ${notice.sunset}.`, details: { api, operation, who, ...notice } }) }) }), integration.handler, transfer.handler, modelFile.handler, blobs.handler, ...suiteParts.flatMap((p) => p.handlers ?? []), authHandler({ store, secure, signIn: signInWith, fetchFn, homeFor: desktops.homeFor, trustProxy, events })],
        // The trigger outbox (§15.2): every instance drains it; SKIP LOCKED keeps a row to one of them.
        jobs: [
            ...suiteParts.flatMap((p) => p.jobs ?? []),
            ...(outboxEveryMs > 0 ? [{ name: "integration-outbox", every: outboxEveryMs, run: () => integration.drain() }] : []),
            // The statements and calls this instance counted, written once a minute (every instance its own).
            { name: "sql-stats", every: 60_000, run: () => stats.within("sql-stats", () => database.flush()).catch((error) => { if (error?.code !== "db.unavailable") throw error; }) },
            ...(outboxEveryMs > 0 ? [{ name: "mail-outbox", every: Math.max(outboxEveryMs, 2000), run: () => mail.drain().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
            // Schedules (§15.3): planned into the outbox, once per time due, whichever nodes plan.
            ...(scheduler ? [{ name: "scheduler", every: schedulerEveryMs, atStart: true, run: () => integration.plan().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
            // Plans' waits whose time is up (§32.5), on by their wire.
            // Kept prompts whose time has come (§34.7): asked as their owner, the report kept as theirs.
            ...(scheduler ? [{ name: "report-prompts", every: schedulerEveryMs * 6, run: () => reports.tick().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
            ...(scheduler ? [{ name: "flow-waits", every: schedulerEveryMs, run: () => flows.tick().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
            // This node, as the monitor and the other nodes see it.
            // What is past the plant's retention periods (§27.8), removed; never at start, so a test's app does not.
            ...(scheduler ? [{ name: "retention", every: RETENTION_EVERY_MS, run: () => retention.purge().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
            // The data integrity scan (§7.7): never at start, so a test's app does not.
            ...(scheduler ? [{ name: "integrity", every: INTEGRITY_EVERY_MS, run: () => integrity.scan().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
            ...(scheduler ? [{ name: "audit-verify", every: 15 * 60_000, atStart: true, run: () => verifyAuditChain().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
            // Emergency changes whose review afterwards is overdue (§5.7): flagged once each, on the change,
            // in the audit trail and the event log.
            ...(scheduler ? [{ name: "emergency-reviews", every: 60_000, atStart: true, run: async () => {
                const flagged = await design.emergencyTick().catch((error) => { if (error?.code !== "db.unavailable") throw error; return []; });
                if (flagged.length) await invalidate([{ name: "design.home" }, { name: "design.change" }, { name: "design.approvals" }, { name: "inbox.mine" }]);
            } }] : []),
            { name: "node-heartbeat", every: 10_000, atStart: true, run: () => integration.heartbeat().catch((error) => { if (error?.code !== "db.unavailable") throw error; }) },
            // The event log's file, copied into mes.event_log whenever the database takes it.
            ...(events ? [{ name: "event-log", every: 5000, atStart: true, run: () => events.flush(db).catch((error) => { if (error?.code !== "db.unavailable") throw error; }) }] : []),
        ],
        // /healthz shows where reads went: replica, primary, waits for replay, fall-backs.
        instance,
        // The instance stays in rotation while the database is down (every instance shares it); /healthz
        // says so.
        // `scripts`: how walled in the script runner said it is when it last started (§12.4).
        health: { details: () => ({ db: dbState(), ...(auditState ? { audit: auditState } : {}), ...(integrity.state() ? { integrity: integrity.state() } : {}), ...(events ? { events: events.state() } : {}), ...(scriptRunnerIsolation() ? { scripts: scriptRunnerIsolation() } : {}), ...(routing ? { reads: { ...routing.stats } } : {}), ...(bus ? { bus: bus.stats() } : {}) }) },
        onShutdown: bus ? [() => bus.stop()] : [],
        modules: {
            // A suite's browser module is mounted from wherever it is installed (`outside`: the plant
            // folder's suites/ for an npm installation, beside a package nothing writes to; §29).
            mounts: [{ url: "/app/mes/client/", dir: "app/mes/client", only: [".js", ".css"] }, ...suites.filter((x) => x.clientDir).map((x) => ({ url: `/${x.clientDir}/`, dir: x.clientHome, only: [".js", ".css"], outside: true }))],
            // The installable app (§14): at the root, so the service worker's scope is the whole site.
            rootFiles: {
                "/sw.js": { file: "app/mes/pwa/sw.js", headers: { "service-worker-allowed": "/" } },
                "/manifest.webmanifest": "app/mes/pwa/manifest.webmanifest",
                "/offline.html": { file: "app/mes/pwa/offline.html", type: "text/html; charset=utf-8" },
                "/icons/icon.svg": { file: "app/mes/pwa/icon.svg", type: "image/svg+xml" },
                "/icons/icon-192.png": { file: "app/mes/pwa/icon-192.png", type: "image/png" },
                "/icons/icon-512.png": { file: "app/mes/pwa/icon-512.png", type: "image/png" },
                "/icons/icon-maskable-512.png": { file: "app/mes/pwa/icon-maskable-512.png", type: "image/png" },
                "/icons/apple-touch-icon.png": { file: "app/mes/pwa/apple-touch-icon.png", type: "image/png" },
                // The chart library (§34.9): Apache ECharts, Apache-2.0, its own licence in the file; one module,
                // loaded by the first chart shown (chart-view.js).
                "/vendor/echarts.js": { file: ECHARTS, type: "text/javascript; charset=utf-8" },
                // PDF pages drawn one at a time with their step controls (media.js PdfPages), and its worker.
                "/vendor/pdf.js": { file: PDFJS, type: "text/javascript; charset=utf-8" },
                "/vendor/pdf.worker.js": { file: PDFJS_WORKER, type: "text/javascript; charset=utf-8" },
            },
            entry: "/app/mes/client/boot.js",
        },
        page: {
            title,
            // What a page may load and where it may be shown (COMPLIANCE.md G6): its own scripts and
            // the loader by its hash, never an inline script or one from elsewhere; requests, workers,
            // forms and fonts to this site only; pictures from here or held in the page (a preview, a
            // collected file); in no frame, but those of the sites the plant names (EMBED_ORIGINS, §37). Styles are inline in server-drawn markup. Only the designer's
            // pages may build a function from text ('unsafe-eval'): its editors parse a script that way,
            // never calling it. Where people work on records, nothing may (client/app.js guard loads the
            // designer afresh when it is come to from there).
            headers: ({ scriptHashes, url }) => ({
                "content-security-policy": [
                    "default-src 'self'", `script-src 'self' ${designPath(url.pathname) ? "'unsafe-eval' " : ""}${scriptHashes.join(" ")}`.trim(), "style-src 'self' 'unsafe-inline'",
                    "img-src 'self' data: blob:", "connect-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", `frame-ancestors ${embedOrigins.length ? embedOrigins.join(" ") : "'none'"}`,
                ].join("; "),
                // X-Frame-Options names no site: it is left out when some may frame the app (the policy decides).
                ...(embedOrigins.length ? {} : { "x-frame-options": "DENY" }),
                "x-content-type-options": "nosniff",
                "referrer-policy": "same-origin",
            }),
            viewer: async (req) => {
                const user = await store.userForSession(sessionIdOf(req));
                // A page opened is something the person did: their idle clock starts again (§8.2).
                if (user) await store.touchSession(sessionIdOf(req)).catch(() => {});
                // `home`: the page this desktop opens (§6.8), kept with the session at sign-in; `since`,
                // when that was (what a page remembers of this sign-in is told apart by it). `designer`:
                // may start a change (`design` is any role on the designer: a reviewer, an approver).
                const designRoles = user ? await design.designRolesOf(user.id) : [];
                return user ? { ...(testSandbox ? { test: true } : {}), id: user.id, name: user.name, design: designRoles.length > 0, designer: designRoles.includes("designer"), signInAdmin: (await store.rolesFor(user.id, "auth")).includes("administrator"), databaseAdmin: (await store.rolesFor(user.id, "database")).includes("administrator"), privacy: (await store.rolesFor(user.id, "privacy")).includes("officer"), integrity: (await store.rolesFor(user.id, "integrity")).includes("reviewer"), query: (await store.rolesFor(user.id, "query")).length > 0, reports: (await store.rolesFor(user.id, "query")).length > 0 || (await store.rolesFor(user.id, "report")).length > 0, ...(user.home ? { home: user.home, homeLabel: user.home_label ?? null } : {}), since: user.since, second: user.second ?? null } : null;
            },
            extra: (viewer) => ({ viewer: viewer?.id ?? null }),
            // The instance's name, for the header: a training instance says so on every page.
            // The suites installed: their names and navigator entries (shell.js draws them).
            // How the plant writes dates, times and numbers (§27.6): its setting, on its clock (the
            // server's PLANT_TZ unless the setting names one). Read per page, so a change shows when
            // a page is next opened.
            // The plant's theme (§10.8): the top bar's name and label, and whether each person picks light
            // or dark (theme.scheme "choice") or the plant decides for everyone.
            state: async ({ viewer }) => {
                const settings = await organizationSettings(db).catch(() => null);
                const theme = settings?.theme ?? {};
                return {
                    // Lists of people start with a search box; development, the demo and test instances
                    // (SIMPLE_LISTS) list them at once.
                    me: viewer, instance, demo, simpleLists, picker: Boolean(signInWith.picker),
                    // The sites that may show this one in a frame and talk to it (§37, embed.js).
                    ...(embedOrigins.length ? { embed: embedOrigins } : {}),
                    // The plant's sign-in policy the pages follow (§8.2, §7.4): a signature asks its signer's
                    // password (or a fresh single sign-on); a session ends after so long idle.
                    signing: { password: signatures.asksProof, sso: Boolean(signInWith.sso), idleMinutes: account.policy.idleMinutes, linkDays: signInWith.linkDays ?? 3, idLabel: settings?.signIn?.idLabel ?? null, idHint: settings?.signIn?.idHint ?? null }, suites: suites.map((x) => ({ name: x.name, label: x.label, version: x.version, nav: x.nav })),
                    formats: formatsOf({ timeZone: plantTz, ...(settings?.formats ?? {}) }),
                    theme: { scheme: theme.scheme ?? "choice", name: theme.name ?? null, scope: theme.scope ?? null },
                };
            },
            // The build that wrote the page (updates.js compares it with /version), and what makes it an
            // installable app (pwa/: the manifest, icons and service worker, served from the root).
            // A suite's browser module and stylesheets: named in the page (mes-suites), which the browser
            // entry imports before it starts (boot.js).
            // The scheme it is drawn in, before the first paint (no flash of the other one): the plant's when
            // its theme decides, else the person's; neither, the device's (app.css). The plant's colours
            // follow the stylesheet as its tokens (only #rrggbb values, checked: theme.js themeCss).
            head: async ({ versioned, viewer }) => {
                const theme = (await organizationSettings(db).catch(() => null))?.theme ?? {};
                const [mine] = viewer && personalChoice(theme) ? await db.query("SELECT prefs->>'scheme' AS scheme FROM mes.user_prefs WHERE user_id = $1", [viewer.id]).catch(() => []) : [];
                const scheme = schemeOf(theme, mine?.scheme);
                const colors = themeCss(theme);
                return {
                    lang: "en",
                    ...(scheme ? { htmlAttrs: { "data-theme": scheme } } : {}),
                    styles: [{ href: await versioned("/app/mes/client/app.css") }, ...await Promise.all(suites.flatMap((x) => (x.client?.styles ?? []).map(async (css) => ({ href: await versioned(`/${x.clientDir}/${css}`) })))), ...(colors ? [{ text: colors }] : [])],
                    buildMeta: { name: "mes-build", content: typeof build === "function" ? build() : build },
                    links: [
                        { rel: "manifest", href: "/manifest.webmanifest" },
                        { rel: "icon", href: "/icons/icon.svg", type: "image/svg+xml" },
                        { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
                    ],
                    meta: [
                        { name: "theme-color", content: theme.colors?.light?.accent ?? "#2b303a" },
                        { name: "apple-mobile-web-app-capable", content: "yes" },
                        { name: "mobile-web-app-capable", content: "yes" },
                        { name: "apple-mobile-web-app-title", content: "OpenCore MES" },
                        { name: "mes-suites", content: JSON.stringify(await Promise.all(suites.filter((x) => x.clientUrl).map((x) => versioned(x.clientUrl)))) },
                    ],
                };
            },
        },
    });
    // What it keeps of people (their certifications, a few seconds), read anew: a sandbox writes a scenario's
    // records straight into its database, not through the services that would say so.
    server.forgetPeople = () => records.internals.forgetCertifications();
    // Closing the app closes its sandboxes (their databases dropped) first.
    const closeServer = server.close.bind(server);
    server.close = async (...a) => { await sandboxes?.closeAll(); return closeServer(...a); };
    return server;
}
