// Regressions from the security and edge-case audit that need no database: each is a hostile or
// odd input to a pure function, and what it must answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { badConnectionPath, connectionUrl } from "../server/integration.js";
import { pathAllowed } from "../client/definition.js";
import { INLINE_FILE, fileTypeOf } from "../client/input-flow.js";

test("a connection's path is sent as it was checked: no encoded dot segment, tab or backslash slips past the allow list", () => {
    const base = "https://erp.example/api/v1";
    for (const path of ["/orders/%2e%2e/admin/users", "/orders/.%2E/%2e%2e/%2e%2e/internal", "/orders/.\t./admin", "/orders/..%2fadmin", "/orders/%5c..%5cadmin", "/orders/../admin", "/orders//x", "/orders?x=1", "/orders/a b", "/orders/\n", "orders", 5, null]) {
        assert.equal(badConnectionPath(path), true, JSON.stringify(path));
    }
    for (const path of ["/orders/42", "/orders/A-1.2_b~c", "/orders/42/lines", "/orders/caf%C3%A9"]) {
        assert.equal(badConnectionPath(path), false, path);
        assert.equal(pathAllowed("/orders/*", path), true, path);
        assert.equal(connectionUrl(base, path).pathname, `/api/v1${path}`);
    }
    // Whatever the first check lets by, the address built is the path that was asked for, or nothing.
    assert.equal(connectionUrl(base, "/orders/%2e%2e/admin"), null);
    assert.equal(connectionUrl(base, "/orders/.\t./admin"), null);
    assert.equal(connectionUrl(base, "/orders/café").pathname, "/api/v1/orders/caf%C3%A9");
    assert.equal(connectionUrl("https://erp.example", "/orders/1").href, "https://erp.example/orders/1");
});

test("a collected file opens beside the page only as a picture, a PDF or text; anything else is bytes to save", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]) { assert.equal(fileTypeOf(type), type); assert.ok(INLINE_FILE.test(type)); }
    for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/html; charset=utf-8", "TEXT/HTML", "text/plain\ntext/html", "application/javascript", "", null, undefined, { toString: () => "text/html" }]) assert.equal(fileTypeOf(type), "application/octet-stream", String(type));
});

// ---- definitions, policies, values ----
import { validateDefinition, footprint, routeOf } from "../client/definition.js";
import { objectChanges } from "../client/compare.js";
import { decide, mask } from "../server/policy.js";
import { viewSql } from "../server/query.js";
import { validate } from "../server/services.js";
import { PERSON } from "../client/builtins.js";
import { definitions } from "../db/seed.mjs";

const lot = definitions.find((d) => d.object === "lot");
const known = { objects: ["lot", "work_order", "deviation", "machine", "person"], scripts: (lot.rules ?? []).map((r) => r.script), departments: ["production", "quality", "engineering"] };
const edit = (fn, from = lot) => { const d = JSON.parse(JSON.stringify(from)); fn(d); return d; };
const problemsOf = (d) => validateDefinition(d, known).map((p) => `${p.path}: ${p.message}`);

test("a policy's condition is checked when it is designed: an unknown operator or a wrong shape is a problem, not an outage", () => {
    for (const when of [{ bogus: [1, 2] }, { eq: 5 }, { all: [{ eq: [{ record: "state" }, "created"] }, { nope: 1 }] }]) {
        const found = problemsOf(edit((d) => { d.policies[0].when = when; }));
        assert.ok(found.some((p) => p.startsWith("policies.0.when")), JSON.stringify({ when, found }));
    }
    assert.deepEqual(problemsOf(lot), []);
});

test("a deny list is a list: one name written alone is a problem, and the engine never reads it letter by letter", () => {
    for (const deny of [{ read: "qty" }, { fields: "qty" }, { actions: "hold" }, "qty", { read: [5] }]) {
        assert.ok(problemsOf(edit((d) => { d.policies[0].deny = deny; })).some((p) => p.startsWith("policies.0.deny")), JSON.stringify(deny));
    }
    assert.ok(problemsOf(edit((d) => { d.policies[0].record = { read: "yes" }; })).some((p) => p.startsWith("policies.0.record")));
    assert.ok(problemsOf(edit((d) => { d.policies[0].actions = { hold: "deny" }; })).some((p) => p.startsWith("policies.0.actions")));
    // The engine, on such a design that was published before the check: nothing is denied by a letter,
    // and nothing throws.
    const odd = edit((d) => { d.policies.push({ id: "odd", roles: ["viewer"], deny: { read: "qty", fields: "qty", actions: "hold" } }); });
    const seen = decide(odd, { id: "vera", roles: ["viewer"] }, { state: "created" });
    assert.equal(seen.read, true);
    assert.doesNotThrow(() => viewSql(odd));
});

test("names a record keeps for itself are not fields; labels are text; a choice lists each value once", () => {
    for (const name of ["created_by", "created_at", "updated_by", "updated_at"]) {
        assert.ok(problemsOf(edit((d) => { d.fields[name] = { type: "string" }; })).some((p) => /reserved/.test(p)), name);
    }
    // A record's author is the one who made it, whatever its data says.
    const out = mask(lot, { id: "sam", roles: ["supervisor"] }, { id: "1", state: "created", created_by: "sam", data: { created_by: "someone else", lot_no: "L1" } });
    assert.equal(out.created_by, "sam");
    for (const bad of [{ trim: 1 }, 5, null, "  "]) {
        assert.doesNotThrow(() => problemsOf(edit((d) => { d.label = bad; d.area = bad; })));
        assert.ok(problemsOf(edit((d) => { d.label = bad; })).some((p) => p.startsWith("label")));
    }
    assert.ok(problemsOf(edit((d) => { d.fields.lot_no.label = { a: 1 }; })).some((p) => p.startsWith("fields.lot_no.label")));
    assert.ok(problemsOf(edit((d) => { d.fields.kind = { type: "enum", values: ["a", "b", "a"] }; })).some((p) => /listed twice/.test(p)));
});

test("nothing in a definition goes live outside the footprint: whether the platform keeps it, its part in flows, a key nobody named", () => {
    const person = { ...JSON.parse(JSON.stringify(PERSON)), stewards: { object: ["engineering"] } };
    const freed = edit((d) => { delete d.builtIn; }, person);
    assert.deepEqual(footprint(person, freed).map((e) => e.element), ["object.builtIn"]);
    assert.deepEqual(routeOf(footprint(person, freed)).map((r) => r.department), ["engineering"]);
    assert.deepEqual(objectChanges(person, freed).map((c) => c.element), ["builtIn"]);
    assert.ok(validateDefinition(freed, known).some((p) => p.path === "builtIn"), "builtIn is the platform's to say");
    assert.ok(problemsOf(edit((d) => { d.builtIn = true; })).some((p) => p.startsWith("builtIn")));
    const flowed = edit((d) => { d.flow = { as: ["reference"] }; d.madeUp = { x: 1 }; d.states.madeUp = 1; });
    const elements = footprint(lot, flowed);
    for (const e of ["object.flow", "object.madeUp", "states.madeUp"]) assert.deepEqual(elements.find((x) => x.element === e)?.stewards, [...lot.stewards.object].sort(), e);
    assert.deepEqual(objectChanges(lot, flowed).map((c) => c.element).sort(), ["flow", "madeUp"]);
    assert.deepEqual(footprint(lot, edit(() => {})), []);
});

test("a condition SQL cannot say takes no view down: its rule grants nothing to a query, and what it hides stays hidden", () => {
    const sums = edit((d) => {
        d.policies.push({ id: "sum-read", roles: ["viewer"], record: { read: true }, fields: { "*": "read" }, when: { gt: [{ add: [{ record: "qty" }, 1] }, 5] } });
        d.policies.push({ id: "sum-hide", roles: ["viewer"], when: { gt: [{ add: [{ record: "qty" }, 1] }, 5] }, deny: { read: ["qty"] } });
    });
    assert.deepEqual(problemsOf(sums), [], "arithmetic is the policy language's own");
    let sql;
    assert.doesNotThrow(() => { sql = JSON.stringify(viewSql(sums)); });
    assert.match(sql, /ARRAY\['viewer'\]::text\[\] AND false\)/);
    assert.match(sql, /ARRAY\['viewer'\]::text\[\] AND true\)/);
});

test("a value the database cannot keep or cast is refused at the field, not later for everyone", () => {
    const def = { fields: { n: { type: "integer" }, d: { type: "date" }, s: { type: "string" }, t: { type: "text", max: 20 } } };
    assert.equal(validate(def, { n: 12, d: "2028-02-29", s: "ok é 😀", t: "x" }), null);
    for (const n of [1e300, 2 ** 53, -(2 ** 53), 1.5, "1", NaN, Infinity]) assert.ok(validate(def, { n })?.n, String(n));
    for (const d of ["2026-02-31", "2026-13-01", "2026-00-10", "2027-02-29", "2026-1-1", "0000-00-00", 20260101]) assert.ok(validate(def, { d })?.d, String(d));
    for (const s of ["a\u0000b", "half \ud83d", "\udc00 half"]) assert.ok(validate(def, { s })?.s, JSON.stringify(s));
    assert.match(validate(def, { t: "x".repeat(21) }).t, /at most 20/);
});

// ---- schedules, files, the session cookie ----
import { runsOf } from "../client/schedule.js";
import { peopleCsv, importPeople } from "../client/people-file.js";
import { setSessionCookie, sessionCookieFor, sessionIdOf } from "../server/auth.js";
import { readFileSync } from "node:fs";

test("the day the clocks go forward: planned tick by tick, every run of the day is queued", () => {
    // What the planner does (integration.js plan): from the last tick to this one, in ticks (every 5 s there; 30 s here).
    const planned = (trigger, tz, from, to) => {
        const out = [];
        for (let last = from, at = from + 30_000; at <= to; last = at, at += 30_000) out.push(...runsOf(trigger, last, { untilMs: at, limit: 20_000, tz }));
        return out.map((t) => new Date(t).toISOString());
    };
    const whole = (trigger, tz, from, to) => runsOf(trigger, from, { untilMs: to, limit: 20_000, tz }).map((t) => new Date(t).toISOString());
    const cases = [
        [{ schedule: { at: ["02:30", "03:00"] } }, "Europe/Berlin", Date.UTC(2026, 2, 29, 0, 0), Date.UTC(2026, 2, 29, 3, 0)],
        [{ schedule: { at: ["02:15", "03:00", "03:10"] } }, "America/New_York", Date.UTC(2026, 2, 8, 5, 0), Date.UTC(2026, 2, 8, 9, 0)],
        [{ schedule: { every: { minutes: 45 } } }, "Europe/Berlin", Date.UTC(2026, 2, 29, 0, 0), Date.UTC(2026, 2, 29, 3, 0)],
    ];
    for (const [trigger, tz, from, to] of cases) {
        const all = whole(trigger, tz, from, to);
        assert.ok(all.length >= 2, JSON.stringify(all));
        assert.deepEqual(planned(trigger, tz, from, to), all, JSON.stringify(trigger));
    }
    assert.deepEqual(whole(cases[0][0], "Europe/Berlin", cases[0][2], cases[0][3]), ["2026-03-29T01:00:00.000Z", "2026-03-29T01:30:00.000Z"]);
});

test("a name a spreadsheet would run as a formula is written as text, and read back as it was", () => {
    const org = { users: { eve: { name: '=HYPERLINK("http://x","y")' }, max: { name: "@SUM(A1)" }, ann: { name: "Ann-Marie" } }, departments: {} };
    const csv = peopleCsv(org);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""y"")"`) && csv.includes("'@SUM(A1)") && csv.includes("Ann-Marie"), csv);
    assert.ok(!/(^|,|\n)[=@+-]/.test(csv.replace(/^﻿/, "")), "no cell starts a formula");
    const back = importPeople(org, csv);
    assert.deepEqual(back.problems, []);
    assert.deepEqual(back.changes.renamed, [], "the same names come back");
});

test("a call this process makes to its own sandbox carries the session under the instance's cookie name", () => {
    assert.equal(sessionCookieFor("abc"), "mes_session=abc");
    setSessionCookie("mes_training_session");
    try { assert.equal(sessionIdOf({ headers: { cookie: sessionCookieFor("abc") } }), "abc"); } finally { setSessionCookie("mes_session"); }
    assert.ok(!readFileSync(new URL("../server/sandbox.js", import.meta.url), "utf8").includes("mes_session="), "the sandbox names no cookie of its own");
});

test("the service worker keeps only what the server calls immutable", () => {
    const sw = readFileSync(new URL("../pwa/sw.js", import.meta.url), "utf8");
    assert.match(sw, /answer\.ok && \/\\bimmutable\\b\/\.test\(answer\.headers\.get\("cache-control"\)/);
});

// ---- the browser's rule runner ----
import { createRunner, RULE_WAIT_MS } from "../client/rules-client.js";

test("a rule worker that never answers, or fails, does not hold the page: the run rejects and the next one starts afresh", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const made = [];
    const api = { call: async () => ({}) };
    const fake = (behave) => () => { const w = { posted: [], terminated: false, postMessage(m) { this.posted.push(m); behave(this, m); }, terminate() { this.terminated = true; } }; made.push(w); return w; };
    // Never answers (a rule that loops; a browser that could not start it).
    const silent = createRunner(api, "lot", fake(() => {}));
    const hung = silent.run([], {});
    const outcome = hung.then(() => "resolved", (e) => e.message);
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(RULE_WAIT_MS + 1);
    assert.equal(await outcome, "the rules took too long");
    assert.equal(made[0].terminated, true);
    // Fails outright.
    const broken = createRunner(api, "lot", fake((w, m) => { if (m.type === "run") queueMicrotask(() => w.onerror({ message: "boom" })); }));
    await assert.rejects(broken.run([], {}), /rule worker failed/);
    // Answers: resolved, and a later run reuses the worker.
    const good = createRunner(api, "lot", fake((w, m) => { if (m.type === "run") queueMicrotask(() => w.onmessage({ data: { seq: m.seq, ctx: {}, error: null, trace: [] } })); }));
    const before = made.length;
    assert.deepEqual((await good.run([], {})).trace, []);
    assert.deepEqual((await good.run([], {})).trace, []);
    assert.equal(made.length, before + 1);
    // After a failure the next run makes a new worker.
    await assert.rejects(broken.run([], {}), /rule worker failed/);
    assert.equal(made.filter((w) => w.terminated).length >= 3, true);
});

import { scriptFootprint } from "../client/definition.js";
test("a script a flow runs at a node answers to that flow's stewards", () => {
    const flows = { deviation_response: { stewards: ["quality"], nodes: { start: { kind: "start", onEnter: "hold_lot" }, end: { kind: "end" } } }, other: { stewards: ["it"], nodes: { a: { kind: "start", onExit: "something_else" } } } };
    const [e] = scriptFootprint("hold_lot", "old", "new", [], {}, { flows });
    assert.deepEqual(e.stewards, ["quality"]);
    assert.deepEqual(e.usedBy, ["flow:deviation_response"]);
    assert.deepEqual(scriptFootprint("orphan", "old", "new", [], {}, { flows })[0].stewards, []);
});

test("a policy on the user's departments is not guessed at in a query: negated or not, its rule grants nothing there", () => {
    for (const when of [{ contains: [{ user: "departments" }, { record: "station" }] }, { not: { contains: [{ user: "departments" }, { record: "station" }] } }]) {
        const dept = edit((d) => { d.policies = [{ id: "by-dept", roles: ["viewer"], record: { read: true }, fields: { "*": "read" }, when }]; });
        const sql = JSON.stringify(viewSql(dept));
        assert.match(sql, /ARRAY\['viewer'\]::text\[\] AND false\)/, JSON.stringify(when));
        assert.ok(!sql.includes("NULL::jsonb @>") && !/NOT \(?NULL/.test(sql));
    }
});

import { validateScript } from "../client/definition.js";
import { safePart } from "../client/app.js";
import { retryWait } from "../server/integration.js";

test("a script that imports is refused where it is written", () => {
    const ok = () => {};
    for (const source of ['export default async function s(ctx) { const m = await import("https://x/y.js"); }', "export default function s(ctx) { return import ( 'x' ); }", "export default function s(ctx) { return import.meta.url; }"]) {
        assert.match(validateScript("s", source, ok)[0]?.message ?? "", /imports nothing/);
    }
    assert.deepEqual(validateScript("s", "export default function s(ctx) { ctx.data.important = 1; return ctx; }", ok), []);
});

test("a part of an address that would be read as a state path of its own names nothing", () => {
    for (const bad of ["a.b", "__proto__", "constructor", "toString", "x*"]) assert.equal(safePart(bad), "_", bad);
    for (const fine of ["lot", "8c24e6ff-d8bb-4aab-bbb4-64f619927b70", "work_order", undefined, null]) assert.equal(safePart(fine), fine);
});

test("a trigger that faults is tried again for about a quarter of an hour, never more than five minutes apart", () => {
    const waits = Array.from({ length: 9 }, (_, i) => retryWait(i + 1));
    assert.deepEqual(waits, [2, 4, 8, 16, 32, 64, 128, 256, 300]);
    assert.ok(waits.reduce((a, b) => a + b, 0) > 10 * 60);
});

test("what a removed suite left in an object stays, and the object can still be changed; its part cannot", () => {
    const withPart = edit((d) => { d.suites = { gone_suite: { mappings: [{ a: 1 }] } }; });
    const installed = { ...known, suiteDesigns: {} };
    // Unchanged from what is live: no problem, though its suite is not installed.
    assert.deepEqual(validateDefinition(edit((d) => { d.description = "Edited."; }, withPart), { ...installed, live: withPart }).filter((p) => p.path.startsWith("suites")), []);
    // Changed, or new: said.
    assert.ok(validateDefinition(edit((d) => { d.suites.gone_suite.mappings.push({ b: 2 }); }, withPart), { ...installed, live: withPart }).some((p) => p.path === "suites.gone_suite"));
    assert.ok(validateDefinition(withPart, { ...installed, live: lot }).some((p) => p.path === "suites.gone_suite"));
});

import { addressKind, hostListed, addressProblem } from "../server/integration.js";
test("where a connection may lead: never a link-local address unless the plant lists it; only the listed hosts when it lists any", async () => {
    assert.deepEqual(["169.254.169.254", "fe80::1", "::ffff:169.254.169.254", "0.0.0.0", "::", "127.0.0.1", "::1", "10.1.2.3", "172.20.0.5", "192.168.1.9", "fd00::5", "8.8.8.8", "erp.plant.local"].map(addressKind),
        ["link-local", "link-local", "link-local", "unspecified", "unspecified", "loopback", "loopback", "private", "private", "private", "private", "public", null]);
    assert.equal(hostListed("erp.plant.local", ["ERP.plant.local"]), true);
    assert.equal(hostListed("a.lims.plant.local", ["*.lims.plant.local"]), true);
    assert.equal(hostListed("lims.plant.local", ["*.lims.plant.local"]), false);
    assert.equal(hostListed("evil-lims.plant.local", ["*.lims.plant.local"]), false);
    const resolve = async (host) => ({ "meta.example": [{ address: "169.254.169.254" }], "erp.plant.local": [{ address: "10.0.0.5" }], "both.example": [{ address: "8.8.8.8" }, { address: "fe80::2" }] })[host] ?? [];
    const why = (url, hosts = null) => addressProblem(new URL(url), { hosts, resolve });
    assert.equal(await why("https://erp.plant.local/api"), null);
    assert.equal(await why("http://127.0.0.1:8080/api"), null);
    assert.match(await why("http://169.254.169.254/latest/meta-data"), /link-local/);
    assert.match(await why("http://[fe80::1]/x"), /link-local/);
    assert.match(await why("https://meta.example/x"), /link-local/);
    assert.match(await why("https://both.example/x"), /link-local/);
    assert.match(await why("http://0.0.0.0/x"), /unspecified/);
    // Listed by the plant: reached, whatever it is; anything not listed is not.
    assert.equal(await why("http://169.254.169.254/x", ["169.254.169.254"]), null);
    assert.equal(await why("https://erp.plant.local/api", ["erp.plant.local"]), null);
    assert.match(await why("https://other.plant.local/api", ["erp.plant.local"]), /not among the hosts/);
});

import { addressOf, sendTo } from "../server/integration.js";
import { createServer } from "node:http";
test("a connection's request goes to the address that was checked, under the host's own name; a redirect is not followed", async () => {
    const seen = [];
    const server = createServer((req, res) => {
        seen.push({ host: req.headers.host, url: req.url, method: req.method });
        if (req.url === "/away") { res.writeHead(302, { location: "http://169.254.169.254/latest" }); return res.end(); }
        let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ got: body })); });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
        // The name resolves to this machine when it is checked; whatever it would answer later, the
        // request is sent to the address that was checked, and carries the name.
        let asked = 0;
        const where = await addressOf(new URL(`http://erp.plant.example:${port}/orders`), { resolve: async () => { asked += 1; return [{ address: "127.0.0.1", family: 4 }]; } });
        assert.deepEqual([where.problem, where.address, asked], [null, "127.0.0.1", 1]);
        const res = await sendTo(new URL(`http://erp.plant.example:${port}/orders`), { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}', timeoutMs: 2000, address: where.address, family: where.family });
        let text = ""; for await (const c of res.body) text += c;
        assert.deepEqual([res.status, JSON.parse(text).got, seen[0].host, seen[0].method], [200, '{"a":1}', `erp.plant.example:${port}`, "POST"]);
        const away = await sendTo(new URL(`http://erp.plant.example:${port}/away`), { method: "GET", headers: {}, timeoutMs: 2000, address: "127.0.0.1", family: 4 });
        away.body.resume();
        assert.equal(away.status, 302, "answered as it came, never followed");
        assert.equal(seen.length, 2);
    } finally {
        server.close();
    }
});

import { freshLoadFor, designPath } from "../client/app.js";
test("a link into the designer from a page that may not build code is loaded afresh; any other link is the router's", () => {
    const no = () => false, yes = () => true;
    assert.equal(freshLoadFor("/design/c/abc?tab=fields#x", "/o/lot", no), "/design/c/abc?tab=fields#x");
    assert.equal(freshLoadFor("/design", "/", no), "/design");
    for (const [href, at, may] of [["/o/lot", "/", no], ["/design", "/design/people", no], ["/design", "/o/lot", yes], ["/designer-notes", "/", no], ["https://elsewhere.example/design", "/", no], ["//elsewhere.example/design", "/", no]]) assert.equal(freshLoadFor(href, at, may), null, href);
    assert.deepEqual(["/design", "/design/c/1", "/designs", "/o/design", null].map(designPath), [true, true, false, false, false]);
});

import { createStore } from "../server/store.js";
test("a read of what is published that began before a forget never puts the old list back", async () => {
    // The database answers slowly; what is published changes while a read is on its way.
    let published = [{ name: "old", version: 1, body: {} }];
    const waiting = [];
    const db = { query: (sql) => new Promise((resolve) => { const rows = /FROM mes\.flows/.test(sql) ? published : /FROM mes\.definitions/.test(sql) ? published.map((r) => ({ version: r.version, body: { object: r.name } })) : []; waiting.push(() => resolve(rows)); }) };
    const store = createStore(db);
    const early = store.flows();                      // begun before the change commits
    const earlyDef = store.definition("thing");
    published = [{ name: "old", version: 1, body: {} }, { name: "new", version: 1, body: {} }];
    store.forget();                                   // the change executed
    const fresh = store.flows();                      // read again, after it
    const freshDef = store.definition("thing");
    waiting[2](); waiting[3]();                       // the later reads answer first…
    assert.deepEqual([...(await fresh).keys()], ["old", "new"]);
    assert.equal((await freshDef).version, 1);
    waiting[0](); waiting[1]();                       // …then the early ones, with what was there before
    assert.deepEqual([...(await early).keys()], ["old"], "its own caller reads what it asked for");
    await earlyDef;
    assert.deepEqual([...(await store.flows()).keys()], ["old", "new"], "and what is kept is the later read");
    assert.equal(waiting.length, 4, "nothing was read again");
    // Two callers at once share one read.
    store.forget();
    const [a, b] = [store.screens(), store.screens()];
    assert.equal(a, b);
    waiting[4](); await a;
});
