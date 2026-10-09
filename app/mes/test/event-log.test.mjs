// The event log (server/event-log.js), on a temporary directory and a fake database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventLog, verifyEvents, readEvents, watchDb } from "../server/event-log.js";
import { createAlerts } from "../server/alerts.js";

const dirOf = () => mkdtempSync(path.join(tmpdir(), "opencore-mes-events-"));
const quiet = { error() {} };

// A database that takes event rows, or refuses while `down`.
function fakeDb() {
    const rows = new Map();
    return {
        rows, down: false,
        async query(sql, params) {
            if (this.down) throw Object.assign(new Error("down"), { code: "db.unavailable" });
            if (/SELECT COALESCE\(max\(seq\)/.test(sql)) return [{ max: Math.max(0, ...[...rows.values()].filter((r) => r.instance === params[0]).map((r) => r.seq)) }];
            for (const r of JSON.parse(params[0])) if (!rows.has(`${r.instance}:${r.seq}`)) rows.set(`${r.instance}:${r.seq}`, r);
            return [];
        },
    };
}

test("events are appended as JSON lines, in a chain that verifies", () => {
    const events = createEventLog({ dir: dirOf(), build: "b1", log: quiet });
    events.emit("a.one", { message: "one" });
    events.emit("a.two", { severity: "warning", details: { n: 2 } });
    const lines = readEvents(events.file);
    assert.deepEqual(lines.map((e) => [e.seq, e.kind, e.severity, e.instance]), [[1, "a.one", "info", "local"], [2, "a.two", "warning", "local"]]);
    assert.equal(lines[1].prev, lines[0].hash);
    assert.deepEqual(verifyEvents(events.file), { ok: true, checked: 2, brokenAt: null });
    assert.throws(() => events.emit("x", { severity: "loud" }), /severity/);
});

test("a restart continues the chain; an edited line breaks it", () => {
    const dir = dirOf();
    createEventLog({ dir, log: quiet }).emit("first");
    const again = createEventLog({ dir, log: quiet });
    assert.equal(again.emit("second").seq, 2);
    assert.equal(verifyEvents(again.file).ok, true);
    const text = readFileSync(again.file, "utf8").replace('"message":"first"', '"message":"edited"');
    writeFileSync(again.file, text);
    assert.deepEqual(verifyEvents(again.file), { ok: false, checked: 2, brokenAt: 1 });
});

test("start and stop; a start that finds no clean stop says so", () => {
    const dir = dirOf();
    const one = createEventLog({ dir, instance: "web-1", pid: 11, log: quiet });
    assert.match(one.file, /event\.web-1\.log$/);
    one.start();
    assert.ok(existsSync(`${one.file}.running`));
    one.emit("work.done");
    // It dies here: no stop.
    const two = createEventLog({ dir, instance: "web-1", pid: 12, log: quiet });
    two.start();
    const kinds = readEvents(two.file).map((e) => e.kind);
    assert.deepEqual(kinds, ["instance.start", "work.done", "instance.unclean_stop", "instance.start"]);
    assert.match(readEvents(two.file)[2].message, /pid 11.*did not stop cleanly.*work\.done/);
    two.stop("SIGTERM");
    assert.equal(existsSync(`${two.file}.running`), false);
    const three = createEventLog({ dir, instance: "web-1", log: quiet });
    three.start();
    assert.equal(readEvents(three.file).filter((e) => e.kind === "instance.unclean_stop").length, 1, "a clean stop is not reported");
    assert.equal(verifyEvents(three.file).ok, true);
});

test("the forwarder copies what the database lacks, keeps what it could not copy, and never duplicates", async () => {
    const dir = dirOf();
    const db = fakeDb();
    const events = createEventLog({ dir, instance: "web-2", log: quiet });
    events.emit("one");
    assert.equal(await events.flush(db), 1);
    db.down = true;
    events.emit("two");
    events.emit("three");
    await assert.rejects(events.flush(db));
    assert.equal(events.state().pending, 2);
    db.down = false;
    assert.equal(await events.flush(db), 2);
    assert.equal(await events.flush(db), 0);
    assert.deepEqual([...db.rows.values()].map((r) => r.seq), [1, 2, 3]);
    // A new process, whose predecessor wrote two events the database never got.
    events.emit("four");
    events.emit("five");
    const next = createEventLog({ dir, instance: "web-2", log: quiet });
    assert.equal(await next.flush(db), 2, "caught up from the file");
    assert.deepEqual([...db.rows.values()].map((r) => r.seq), [1, 2, 3, 4, 5]);
    assert.equal([...db.rows.values()][1].prev_hash, [...db.rows.values()][0].hash);
});

test("an outage: one incident, refused calls per service, each unknown outcome on its own", () => {
    const events = createEventLog({ dir: dirOf(), log: quiet });
    const watch = watchDb(events);
    watch.onDown(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
    watch.onRefused("records.update", { code: "db.unavailable" }, { object: "lot", id: "1", data: { qty: 5 }, key: "k1" });
    watch.onRefused("records.update", { code: "db.unavailable" }, {});
    watch.onRefused("records.create", { code: "db.unknown" }, { object: "lot", data: { secret: "x" }, key: "k2" });
    watch.onUp({ downForMs: 4200 });
    const [down, unknown, up] = readEvents(events.file);
    assert.equal(down.kind, "db.down");
    assert.equal(down.severity, "critical");
    assert.equal(unknown.kind, "db.unknown_outcome");
    assert.deepEqual(unknown.details, { service: "records.create", object: "lot", id: null, action: null, key: "k2" }, "what finds it again, never the data");
    assert.equal(up.kind, "db.up");
    assert.deepEqual(up.details, { downForMs: 4200, refused: { "records.update": 2, "records.create": 1 }, unknown: 1 });
    assert.match(up.message, /after 4 s: 3 call\(s\) refused, 1 with an unknown outcome/);
    assert.ok(down.incident && down.incident === unknown.incident && down.incident === up.incident);
});

test("the file lost, the database ahead: said as a critical event, and this run's events still arrive, numbered on from the database's", async () => {
    const db = fakeDb();
    const first = createEventLog({ dir: dirOf(), instance: "web-3", log: quiet });
    for (const kind of ["a", "b", "c", "d"]) first.emit(kind);
    assert.equal(await first.flush(db), 4);
    // A new disk: the same instance, an empty directory.
    const said = [];
    const again = createEventLog({ dir: dirOf(), instance: "web-3", log: { error: (m) => said.push(m) } });
    again.emit("after the loss");
    assert.equal(await again.flush(db), 2);
    again.emit("and on");
    assert.equal(await again.flush(db), 1);
    const mine = [...db.rows.values()].filter((r) => r.instance === "web-3");
    assert.deepEqual(mine.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(mine.slice(4).map((r) => [r.kind, r.severity]), [["event_log.reset", "critical"], ["after the loss", "info"], ["and on", "info"]]);
    assert.match(said[0], /the file was lost/);
});

test("a file grown too large is set aside once the database holds it all; the next carries the chain on, and verifies", async () => {
    const db = fakeDb();
    const dir = dirOf();
    const events = createEventLog({ dir, log: quiet, maxBytes: 600 });
    for (let i = 0; i < 4; i++) events.emit("filler", { details: { pad: "x".repeat(100) } });
    events.emit("before the first flush"); // not yet set aside: the database has not been asked
    assert.equal(readdirSync(dir).filter((f) => /\.log\./.test(f)).length, 0);
    await events.flush(db);
    events.emit("after");
    const aside = readdirSync(dir).filter((f) => /^event\.log\.\d/.test(f));
    assert.equal(aside.length, 1);
    const now = readEvents(events.file);
    assert.deepEqual(now.map((e) => [e.seq, e.kind]), [[6, "event_log.rotated"], [7, "after"]]);
    assert.equal(now[0].prev, readEvents(path.join(dir, aside[0])).at(-1).hash);
    assert.deepEqual(verifyEvents(events.file), { ok: true, checked: 2, brokenAt: null });
    assert.equal(verifyEvents(path.join(dir, aside[0])).ok, true);
    await events.flush(db);
    assert.deepEqual([...db.rows.values()].map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7]);
    // A restart reads on from the new file.
    assert.equal(createEventLog({ dir, log: quiet }).emit("again").seq, 8);
});

test("alerts: at or above the floor, a JSON line in the journal and a webhook post; the same kind held back for ten minutes", async () => {
    const posts = [];
    const said = [];
    let t = 0;
    const fetchFn = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
    const alerts = createAlerts({ url: "https://hooks.example/x", instance: "web-1", fetchFn, now: () => t, log: { error: (m) => said.push(m) } });
    const events = createEventLog({ dir: dirOf(), instance: "web-1", log: quiet, onEvent: alerts.onEvent });
    events.emit("quiet", { severity: "warning" });
    events.emit("db.down", { severity: "error", message: "The database is unreachable." });
    events.emit("db.down", { severity: "error" });
    events.emit("db.down", { severity: "error" });
    t = 11 * 60_000;
    events.emit("db.down", { severity: "error", message: "Still down." });
    events.emit("audit.broken", { severity: "critical", message: "Broken." });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(posts.map((p) => p.body.text), [
        "[ERROR] web-1: The database is unreachable.",
        "[ERROR] web-1: Still down. (and 2 more like it in the last minutes)",
        "[CRITICAL] web-1: Broken.",
    ]);
    assert.equal(posts[0].body.event.kind, "db.down");
    assert.equal(said.filter((m) => m.startsWith("alert {")).length, 5);
    assert.throws(() => createAlerts({ minSeverity: "loud" }), /ALERT_MIN_SEVERITY/);
    assert.throws(() => createAlerts({ url: "ftp://x" }), /ALERT_WEBHOOK_URL/);
    // A webhook that fails is said, and nothing more.
    const failing = createAlerts({ url: "https://hooks.example/x", fetchFn: async () => { throw new Error("refused"); }, log: { error: (m) => said.push(m) } });
    failing.onEvent({ kind: "x", severity: "critical", message: "m", instance: "local" });
    await new Promise((r) => setImmediate(r));
    assert.match(said.at(-1), /webhook failed for x: refused/);
});
