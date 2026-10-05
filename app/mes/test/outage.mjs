// A write-database outage, end to end, against a running server (server/db-gate.js):
//   1. The database stops answering: a save is refused at once, in words, and saves nothing;
//      status.db and /healthz say it is down. It comes back: the probe notices, and saving works.
//   2. The database dies after committing a create, before the answer: the caller is told the outcome
//      is unknown. Sent again with the same idempotency key, it answers the first result: one lot,
//      not two.
//   3. The same for an update: sent again, the first result, one audit row, no stale refusal.
//   4. The event log has it all: the outage as one incident (down, each unknown outcome, up, with
//      the refused calls per service), in a chain that verifies, copied into mes.event_log.
//
// The outage is simulated by an adapter in front of the real database, switched by the test.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/outage.mjs
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { gateDb } from "../server/db-gate.js";
import { createEventLog, watchDb, readEvents, verifyEvents } from "../server/event-log.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const real = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = `${Date.now() % 100000}`;

// The switch: `down` refuses every connection; `loseNextCommit` commits the next transaction, then
// loses the answer (and the database with it).
const sim = { down: false, loseNextCommit: false };
const refused = (code = "ECONNREFUSED") => Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), { code });
const flaky = {
    query: (sql, params) => (sim.down ? Promise.reject(refused()) : real.query(sql, params)),
    async transaction(fn) {
        if (sim.down) throw refused();
        const out = await real.transaction(fn);
        if (sim.loseNextCommit) {
            sim.loseNextCommit = false;
            sim.down = true;
            throw refused("ECONNRESET");
        }
        return out;
    },
};
const events = createEventLog({ dir: mkdtempSync(path.join(tmpdir(), "openmes-outage-")), instance: `outage-${tag}`, build: "test" });
const dbWatch = watchDb(events);
const gate = gateDb(flaky, { probeMs: 100, log: { warn() {} }, onDown: dbWatch.onDown, onUp: dbWatch.onUp });
const app = await createApp({ db: gate, dbState: gate.state, events, dbWatch, dev: false, build: "test", outboxEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const session = `og-${randomBytes(8).toString("hex")}`;
await real.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'sam', now() + interval '1 hour')", [session]);
const call = async (name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${session}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const attempt = (name, args) => call(name, args).then((value) => ({ ok: true, value }), (e) => ({ ok: false, status: e.status, code: e.body?.code, message: e.message }));
const heal = async () => {
    sim.down = false;
    for (let i = 0; i < 50 && gate.state().state === "down"; i++) await sleep(50);
    return gate.state().state === "up";
};
const key = () => `og-${randomBytes(8).toString("hex")}`;

const made = [];
try {
    const [wo] = await real.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    const lotNo = (n) => `OG${tag}${n}`;
    let lot = await call("records.create", { object: "lot", data: { lot_no: lotNo(1), item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" }, key: key() });
    made.push(lot.id);

    // ---- 1. down, refused at once, back ----
    sim.down = true;
    const first = await attempt("records.update", { object: "lot", id: lot.id, rowVersion: lot.row_version, data: { qty: 11 }, key: key() });
    step("the database stops answering: the save is refused in words (503 db.unavailable)", !first.ok && first.status === 503 && first.code === "db.unavailable" && /not saved/.test(first.message), first);
    const t = Date.now();
    const second = await attempt("records.update", { object: "lot", id: lot.id, rowVersion: lot.row_version, data: { qty: 11 }, key: key() });
    step("the next call is refused at once, without waiting for a connection", !second.ok && second.code === "db.unavailable" && Date.now() - t < 1000, { ms: Date.now() - t });
    const status = await call("status.db", {});
    const health = await (await fetch(`${mes}/healthz`)).json();
    step("status.db (no sign-in, no database) and /healthz say it is down", status.state === "down" && health.db?.state === "down", { status, db: health.db });
    step("the probe notices it is back", await heal() && (await call("status.db", {})).state === "up");
    const [row] = await real.query("SELECT row_version, data->>'qty' AS qty FROM mes.records WHERE object = 'lot' AND id = $1", [lot.id]);
    step("nothing was saved while it was down", Number(row.row_version) === lot.row_version && Number(row.qty) === 10, row);
    lot = await call("records.update", { object: "lot", id: lot.id, rowVersion: lot.row_version, data: { qty: 11 }, key: key() });
    step("saving works again", lot.qty === 11);

    // ---- 2. a create whose answer was lost ----
    const createKey = key();
    const createArgs = { object: "lot", data: { lot_no: lotNo(2), item: "PA66-NAT-25", work_order: wo.id, qty: 5, uom: "kg" }, key: createKey };
    sim.loseNextCommit = true;
    const lostCreate = await attempt("records.create", createArgs);
    step("committed, but the answer was lost: the caller is told the outcome is unknown (db.unknown)", !lostCreate.ok && lostCreate.status === 503 && lostCreate.code === "db.unknown" && /not known whether/.test(lostCreate.message), lostCreate);
    await heal();
    const again = await call("records.create", createArgs);
    made.push(again.id);
    const count = await real.query("SELECT id FROM mes.records WHERE object = 'lot' AND data->>'lot_no' = $1", [lotNo(2)]);
    step("sent again with the same key: the first result, and one lot, not two", count.length === 1 && count[0].id === again.id, { lots: count.length });

    // ---- 3. an update whose answer was lost ----
    const updateArgs = { object: "lot", id: lot.id, rowVersion: lot.row_version, data: { qty: 12 }, key: key() };
    sim.loseNextCommit = true;
    const lostUpdate = await attempt("records.update", updateArgs);
    await heal();
    const replay = await attempt("records.update", updateArgs);
    const audits = await real.query("SELECT seq FROM mes.audit_log WHERE record_id = $1 AND action = 'update' AND after->>'qty' = '12'", [lot.id]);
    const logged = readEvents(events.file);
    const kinds = logged.map((e) => e.kind);
    const ups = logged.filter((e) => e.kind === "db.up");
    step("the event log: three outages, each down…up with one incident", kinds.filter((k) => k === "db.down").length === 3 && ups.length === 3 && logged.filter((e) => e.kind === "db.down").every((d, i) => d.incident === ups[i].incident), kinds);
    step("the first outage counts its refused calls per service", ups[0].details.refused["records.update"] === 2 && ups[0].details.unknown === 0, ups[0].details);
    const lostOnes = logged.filter((e) => e.kind === "db.unknown_outcome");
    step("each unknown outcome is logged on its own, with its key, never its data", lostOnes.length === 2 && lostOnes[0].details.key === createKey && lostOnes[0].details.service === "records.create" && lostOnes[1].details.key === updateArgs.key && !JSON.stringify(lostOnes).includes('"qty"'), lostOnes.map((e) => e.details));
    step("the file's chain verifies", verifyEvents(events.file).ok);
    await events.flush(gate);
    const copied = await real.query("SELECT seq, kind, incident FROM mes.event_log WHERE instance = $1 ORDER BY seq", [`outage-${tag}`]);
    step("everything written during the outages is copied into mes.event_log once it is over", copied.length === logged.length && copied.every((r, i) => Number(r.seq) === logged[i].seq && r.kind === logged[i].kind), { file: logged.length, table: copied.length });
    step("an update the same way: unknown, then the first result on the same key (not a stale refusal), audited once", lostUpdate.code === "db.unknown" && replay.ok && replay.value.qty === 12 && replay.value.row_version === lot.row_version + 1 && audits.length === 1, { lostUpdate: lostUpdate.code, replay: replay.ok ? "ok" : replay, audits: audits.length });
} catch (error) {
    step("unexpected", false, { message: error.message, body: error.body });
} finally {
    sim.down = false;
    gate.stop();
    await app.close();
    if (made.length) await real.query("DELETE FROM mes.records WHERE object = 'lot' AND id = ANY($1::uuid[])", [made]);
    await real.query("DELETE FROM mes.idempotency WHERE key LIKE 'og-%'");
    await real.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(session)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
