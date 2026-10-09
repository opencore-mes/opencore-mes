// Analytics, phase 1 (DESIGN.md §22), end to end against the database:
//   1. The write path records each stay: create, transitions, archive (ends it), restore (a new one),
//      with the dimensions the record had; at most one open stay per record.
//   2. Rebuilt from the audit trail, the stays are the same as those written live.
//   3. On known stays (three lots, released after 1, 2 and 4 hours): lead time, time in each state and
//      entries per day, overall and by a dimension.
//   4. Who may see: a role on the object; a dimension only if readable in every state.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/analytics.mjs
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createStore } from "../server/store.js";
import { createServices } from "../server/services.js";
import { createAnalytics, rebuildIntervals } from "../server/analytics.js";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const store = createStore(db);
const records = createServices({ store });
const analytics = createAnalytics({ store, plantTz: "UTC" }).services;
const sessions = {};
const as = (user) => ({ sessionId: sessions[user] });
const internal = (user) => ({ [CALL_KIND]: "internal", reason: "analytics test", user });
const key = () => `an-${randomBytes(8).toString("hex")}`;
const H = 3_600_000;
const synthetic = [randomUUID(), randomUUID(), randomUUID()];
let lotId = null;

try {
    for (const user of ["sam", "quinn", "olga", "dana"]) {
        sessions[user] = `an-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const sam = await store.user("sam");
    const quinn = await store.user("quinn");
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");

    // ---- 1. the write path ----
    let lot = await records.services["records.create"].call(internal(sam), { object: "lot", data: { lot_no: `AN${tag}`, item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" }, key: key() });
    lotId = lot.id;
    lot = await records.services["records.action"].call(internal(sam), { object: "lot", id: lotId, action: "hold", rowVersion: lot.row_version, key: key() });
    lot = await records.services["records.update"].call(internal(quinn), { object: "lot", id: lotId, rowVersion: lot.row_version, data: { disposition: "reject" }, key: key() });
    lot = await records.services["records.archive"].call(internal(sam), { object: "lot", id: lotId, rowVersion: lot.row_version, key: key() });
    lot = await records.services["records.restore"].call(internal(sam), { object: "lot", id: lotId, rowVersion: lot.row_version, key: key() });
    const live = await db.query("SELECT state, enter_action, leave_action, entered_by, left_by, left_at IS NULL AS open, dims, entered_at, left_at FROM mes.state_intervals WHERE object = 'lot' AND record_id = $1 ORDER BY entered_at, id", [lotId]);
    step("each write records the stay: created → on hold, ended by archive, a new one on restore", JSON.stringify(live.map((s) => [s.state, s.enter_action, s.leave_action, s.open])) === JSON.stringify([["created", "create", "hold", false], ["on_hold", "hold", "archive", false], ["on_hold", "restore", null, true]]), live.map((s) => [s.state, s.enter_action, s.leave_action, s.open]));
    step("…with the dimensions the record had (item, uom)", live.every((s) => s.dims.item === "PA66-NAT-25" && s.dims.uom === "kg"), live[0].dims);

    // ---- 2. rebuilt from the audit trail ----
    const definitions = (await db.query("SELECT body FROM mes.definitions WHERE status = 'published'")).map((r) => r.body);
    await rebuildIntervals(db, definitions, { only: "lot" });
    const rebuilt = await db.query("SELECT state, enter_action, leave_action, entered_by, left_by, left_at IS NULL AS open, dims, entered_at, left_at FROM mes.state_intervals WHERE object = 'lot' AND record_id = $1 ORDER BY entered_at, id", [lotId]);
    const shape = (list) => JSON.stringify(list.map((s) => [s.state, s.enter_action, s.leave_action, s.entered_by, s.left_by, s.open, s.dims]));
    const close = rebuilt.every((s, i) => Math.abs(new Date(s.entered_at) - new Date(live[i].entered_at)) < 1000);
    step("rebuilt from the audit trail, the stays are the same (times within a second)", shape(rebuilt) === shape(live) && close, { live: live.length, rebuilt: rebuilt.length });
    const [{ open }] = await db.query("SELECT count(*)::int AS open FROM mes.state_intervals WHERE object = 'lot' AND record_id = $1 AND left_at IS NULL", [lotId]);
    step("at most one open stay per record", open === 1);

    // ---- 3. known stays ----
    // Three lots created 2020-01-10 00:00 UTC, released after 1, 2 and 4 hours; items A, A, B.
    const t0 = Date.UTC(2020, 0, 10);
    const rows = [];
    for (const [i, id] of synthetic.entries()) {
        const released = t0 + [1, 2, 4][i] * H;
        const dims = JSON.stringify({ item: ["A", "A", "B"][i] });
        rows.push([id, "created", new Date(t0).toISOString(), "create", new Date(released).toISOString(), "release", dims]);
        rows.push([id, "released", new Date(released).toISOString(), "release", new Date(released + 24 * H).toISOString(), "consume", dims]);
    }
    for (const r of rows) {
        await db.query(
            "INSERT INTO mes.state_intervals (object, record_id, state, entered_at, entered_by, enter_action, left_at, left_by, leave_action, dims) VALUES ('lot', $1, $2, $3, 'test', $4, $5, 'test', $6, $7)",
            r,
        );
    }
    const period = { from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z" };
    const leadTime = await analytics["analytics.leadTime"].call(as("sam"), { object: "lot", fromState: "created", toState: "released", ...period, by: "item" });
    const a = leadTime.groups.find((g) => g.value === "A");
    const b = leadTime.groups.find((g) => g.value === "B");
    step("lead time created → released: 3 lots, average 2 h 20 min, median 2 h, 90th percentile 3 h 36 min", leadTime.all.count === 3 && leadTime.all.avg === 8400 && leadTime.all.p50 === 7200 && leadTime.all.p90 === 12960 && leadTime.all.min === 3600 && leadTime.all.max === 14400, leadTime.all);
    step("…by item: A (2 lots, average 1 h 30 min), B (1 lot, 4 h)", a?.count === 2 && a.avg === 5400 && b?.count === 1 && b.avg === 14400, leadTime.groups);
    const states = await analytics["analytics.states"].call(as("sam"), { object: "lot", ...period });
    const created = states.stays.find((s) => s.state === "created");
    const released = states.stays.find((s) => s.state === "released");
    step("time in each state: 3 stays in created (average 2 h 20 min), 3 in released (24 h each)", created?.count === 3 && created.avg === 8400 && released?.count === 3 && released.avg === 86400, { created, released });
    step("…and now: records in each state at this moment, with their age", states.now.some((n) => n.state === "on_hold" && n.count >= 1 && n.avgAge >= 0), states.now);
    const entries = await analytics["analytics.entries"].call(as("sam"), { object: "lot", state: "released", bucket: "day", ...period });
    step("entries: 3 lots released on 2020-01-10 (buckets in the plant's time zone)", entries.rows.length === 1 && entries.rows[0].bucket === "2020-01-10" && entries.rows[0].count === 3, entries.rows);
    const timeline = await analytics["analytics.timeline"].call(as("olga"), { object: "lot", id: lotId });
    step("a record's timeline, for anyone who may read it", timeline.length === 3 && timeline[2].open && timeline[0].secs >= 0, timeline.map((s) => s.state));

    // ---- 4. who may see ----
    const refused = (p) => p.then(() => null, (e) => ({ status: e.status, message: e.message }));
    // Dana (engineering) holds no role on deviations.
    const noRole = await refused(analytics["analytics.states"].call(as("dana"), { object: "deviation" }));
    step("no role on the object: refused as unknown", noRole?.status === 404, noRole);
    const notDim = await refused(analytics["analytics.states"].call(as("sam"), { object: "lot", by: "disposition" }));
    step("grouping by a field that is not a dimension: refused, naming the dimensions", notDim?.status === 400 && /item, uom/.test(notDim.message), notDim);
    const badState = await refused(analytics["analytics.leadTime"].call(as("sam"), { object: "lot", fromState: "created", toState: "shipped" }));
    step("a state that does not exist: refused", badState?.status === 400 && /not a state/.test(badState.message), badState);
    const tooLong = await refused(analytics["analytics.states"].call(as("sam"), { object: "lot", from: "2020-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }));
    step("a period over 400 days: refused", tooLong?.status === 400, tooLong);
} catch (error) {
    step("unexpected", false, { message: error.message, stack: error.stack?.split("\n").slice(0, 4) });
} finally {
    await db.query("DELETE FROM mes.state_intervals WHERE object = 'lot' AND record_id = ANY($1::uuid[])", [[...synthetic, ...(lotId ? [lotId] : [])]]);
    if (lotId) await db.query("DELETE FROM mes.records WHERE object = 'lot' AND id = $1", [lotId]);
    await db.query("DELETE FROM mes.idempotency WHERE key LIKE 'an-%'");
    await db.query("DELETE FROM mes.sessions WHERE id = ANY($1)", [Object.values(sessions).map(sessionKey)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
