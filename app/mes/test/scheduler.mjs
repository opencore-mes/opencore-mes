// Schedules (DESIGN.md §15.3), end to end, against the database, on a clock the test moves:
//   1. Two nodes plan the same time due at once: one run is queued, not two.
//   2. A service kept to nodes tagged erp-zone is run by that node only.
//   3. A run reads the last successful run's output (ctx.event.previous); a run that asks for more
//      gets its next page at once.
//   4. Runs missed while nothing planned: with missed "last", the latest runs, the others are counted
//      and logged.
//   5. overlap "skip": nothing is queued while a run is still waiting.
//   6. Pause, resume (planned from now on, nothing caught up) and run now, audited and logged.
//   7. The monitor: nodes, each schedule's state, next run and last runs.
//
// The services are published straight into the tables: the change lifecycle that publishes them is
// test/integration.mjs's.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/scheduler.mjs
import pg from "pg";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromPg } from "../../../src/server/db.js";
import { createStore } from "../server/store.js";
import { createServices } from "../server/services.js";
import { createIntegration, createTriggers } from "../server/integration.js";
import { createTokens } from "../server/ai-api.js";
import { createEventLog, readEvents } from "../server/event-log.js";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const TICK = `sched_t${tag}`;
const PIN = `sched_pin_t${tag}`;
const MIN = 60_000;

// The clock the scheduler reads: 7 minutes past a quarter hour, so the next time due is 8 minutes on.
const quarter = 15 * MIN;
let clock = Math.floor(Date.now() / quarter) * quarter + 7 * MIN;
const due0 = Math.floor(clock / quarter) * quarter + quarter;

const tickScript = `// Counts its runs, from the last successful run's output; the second run asks for a second page.
export default async function ${TICK}(ctx) {
  const n = (ctx.event.previous?.output?.n ?? 0) + 1;
  ctx.output = { n, page: ctx.event.page ?? 1, more: n === 2 };
  return ctx;
}`;
const pinScript = `export default async function ${PIN}(ctx) {
  ctx.output = { ran: true };
  return ctx;
}`;
const body = (name, extra = {}) => ({
    name, label: `Test ${name}`, description: "", input: {}, http: { enabled: false }, callers: { users: [], groups: [] },
    on: [{ schedule: { every: { minutes: 15 }, tz: "UTC" }, missed: "last", overlap: "skip" }],
    runAs: "erp", roles: {}, uses: { connections: [], objects: {} }, stewards: ["production"], ...extra,
});

const events = createEventLog({ dir: mkdtempSync(path.join(tmpdir(), "openmes-sched-")), instance: `sched-${tag}` });
const store = createStore(db);
const records = createServices({ store, triggers: createTriggers(store) });
const tokens = createTokens(db);
const nodeOf = (name, tags) => createIntegration({ store: createStore(db), records: records.services, tokens, events, plantTz: "UTC", now: () => clock, node: { name, tags, scheduler: true, outbox: true, build: "test" } });
const a = nodeOf(`a-${tag}`, []);
const b = nodeOf(`b-${tag}`, ["erp-zone"]);
const session = `sc-${randomBytes(8).toString("hex")}`;
const asDana = { sessionId: session };

const rowsOf = (service) => db.query("SELECT id, event, state, scheduled_at, result FROM mes.integration_outbox WHERE service = $1 ORDER BY id", [service]);
const stateOf = async (service) => (await db.query("SELECT * FROM mes.schedule_state WHERE service = $1", [service]))[0];
const drainAll = async (node) => { let n = 0; for (let i = 0; i < 5; i++) { const k = await node.drain(); n += k; if (!k) break; } return n; };

try {
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'dana', now() + interval '1 hour')", [session]);
    for (const [name, source, extra] of [[TICK, tickScript, {}], [PIN, pinScript, { runOn: "erp-zone" }]]) {
        await db.query("INSERT INTO mes.scripts (name, version, status, source) VALUES ($1, 1, 'published', $2)", [name, source]);
        await db.query("INSERT INTO mes.services (name, version, status, body) VALUES ($1, 1, 'published', $2)", [name, JSON.stringify(body(name, extra))]);
    }

    // ---- 0. first seen: planned from now on ----
    await a.plan();
    step("first seen: nothing is planned backwards", (await rowsOf(TICK)).length === 0 && (await stateOf(TICK)) !== undefined);

    // ---- 1. two nodes plan the same time due ----
    clock = due0 + 2000;
    await Promise.all([a.plan(), b.plan(), a.plan()]);
    const planned = await rowsOf(TICK);
    step("three plans at once, from two nodes: one run queued for the time due", planned.length === 1 && new Date(planned[0].scheduled_at).getTime() === due0, planned.map((r) => r.scheduled_at));

    // ---- 2. runOn ----
    await drainAll(a);
    const [pinAfterA] = await rowsOf(PIN);
    step("node a (no tags) runs the tick, and leaves the service kept to erp-zone", (await rowsOf(TICK))[0].state === "done" && pinAfterA.state === "pending", { pin: pinAfterA.state });
    await drainAll(b);
    const [pinAfterB] = await rowsOf(PIN);
    const [pinAudit] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$service' AND action = $1 ORDER BY seq DESC LIMIT 1", [`called:${PIN}`]);
    step("node b (tagged erp-zone) runs it; the audit says which node, and that a schedule set it off", pinAfterB.state === "done" && pinAudit?.after.via.node === `b-${tag}` && pinAudit.after.via.schedule, pinAudit?.after.via);
    await a.services["integration.schedule.pause"].call(asDana, { name: PIN });

    // ---- 3. previous output, and more pages ----
    const first = await stateOf(TICK);
    step("its state: done, one run, its output kept for the next run", first.last_state === "done" && first.runs_ok === 1 && first.last_output?.n === 1, { state: first.last_state, output: first.last_output });

    // ---- 4. missed runs ----
    clock = due0 + 4 * quarter + 5000;
    await a.plan();
    const afterGap = (await rowsOf(TICK)).filter((r) => r.state === "pending");
    const missedState = await stateOf(TICK);
    const missedEvent = readEvents(events.file).find((e) => e.kind === "schedule.missed" && e.details.service === TICK);
    step("an hour without planning: the latest time due runs, the three before it are missed, counted and logged", afterGap.length === 1 && new Date(afterGap[0].scheduled_at).getTime() === due0 + 4 * quarter && missedState.missed === 3 && missedEvent?.details.missed === 3, { queued: afterGap.map((r) => r.scheduled_at), missed: missedState.missed });
    await drainAll(a);
    const pages = (await rowsOf(TICK)).filter((r) => r.event.scheduledAt === new Date(due0 + 4 * quarter).toISOString());
    const paged = await stateOf(TICK);
    step("it read the previous output (n 2), asked for more, and page 2 ran at once, reading page 1's (n 3)", pages.length === 2 && pages[1].event.page === 2 && pages.every((r) => r.state === "done") && paged.last_output?.n === 3 && paged.last_output?.page === 2, pages.map((r) => ({ page: r.event.page ?? 1, state: r.state, n: r.result?.n })));

    // ---- 5. overlap skip ----
    clock = due0 + 5 * quarter + 3000;
    await a.plan();
    clock = due0 + 6 * quarter + 3000;
    await a.plan();
    const waiting = (await rowsOf(TICK)).filter((r) => r.state === "pending");
    const skippedState = await stateOf(TICK);
    step("overlap skip: while a run still waits, the next time due is skipped, counted and logged", waiting.length === 1 && skippedState.skipped === 1 && readEvents(events.file).some((e) => e.kind === "schedule.skipped" && e.details.service === TICK), { waiting: waiting.length, skipped: skippedState.skipped });
    await drainAll(a);

    // ---- 6. pause, resume, run now ----
    await a.services["integration.schedule.pause"].call(asDana, { name: TICK });
    clock = due0 + 7 * quarter + 3000;
    const beforePause = (await rowsOf(TICK)).length;
    await a.plan();
    step("paused: nothing is planned", (await rowsOf(TICK)).length === beforePause && (await stateOf(TICK)).paused === true);
    clock = due0 + 8 * quarter + 3000;
    await a.services["integration.schedule.resume"].call(asDana, { name: TICK });
    await a.plan();
    clock = due0 + 9 * quarter + 3000;
    await a.plan();
    const resumed = (await rowsOf(TICK)).slice(beforePause);
    step("resumed: planned from then on, what fell due while paused is not caught up", resumed.length === 1 && new Date(resumed[0].scheduled_at).getTime() === due0 + 9 * quarter, resumed.map((r) => r.scheduled_at));
    await drainAll(a);
    const now = await a.services["integration.schedule.runNow"].call(asDana, { name: TICK });
    await drainAll(a);
    const [manual] = await db.query("SELECT event, state FROM mes.integration_outbox WHERE id = $1", [now.outbox]);
    const audits = (await db.query("SELECT action FROM mes.audit_log WHERE object = '$service' AND action LIKE 'schedule:%' AND after->>'service' = ANY($1) ORDER BY seq", [[TICK, PIN]])).map((r) => r.action.split(":").slice(0, 2).join(":"));
    step("run now: one run outside the schedule, done; pause, resume and run now are audited", manual.event.manual === true && manual.state === "done" && ["schedule:pause", "schedule:resume", "schedule:run-now"].every((x) => audits.includes(x)), { manual: manual.state, audits });
    step("the event log has the pauses and the resume", readEvents(events.file).filter((e) => ["schedule.paused", "schedule.resumed"].includes(e.kind)).length === 3);

    // ---- 7. the monitor ----
    await a.heartbeat();
    await b.heartbeat();
    const m = await a.services["integration.monitor"].call(asDana, {});
    const tick = m.schedules.find((s) => s.service === TICK);
    const pin = m.schedules.find((s) => s.service === PIN);
    const nodeB = m.nodes.find((n) => n.name === `b-${tag}`);
    step("the monitor: each schedule's state, totals, next run and last runs", tick && tick.lastState === "done" && tick.totals.ok >= 5 && tick.totals.missed === 3 && tick.totals.skipped === 1 && tick.nextRunAt && tick.runs.length > 0 && tick.when[0].text === "every 15 min (UTC)", tick && { lastState: tick.lastState, totals: tick.totals, next: tick.nextRunAt });
    step("…the paused one, kept to erp-zone and reachable (node b is alive with that tag)", pin && pin.paused && pin.pausedBy === "dana" && pin.runOn === "erp-zone" && pin.reachable && nodeB?.alive && nodeB.tags.includes("erp-zone"), pin && { paused: pin.paused, reachable: pin.reachable });
} catch (error) {
    step("unexpected", false, { message: error.message, stack: error.stack?.split("\n").slice(0, 3) });
} finally {
    await db.query("DELETE FROM mes.integration_outbox WHERE service = ANY($1)", [[TICK, PIN]]);
    await db.query("DELETE FROM mes.schedule_state WHERE service = ANY($1)", [[TICK, PIN]]);
    await db.query("DELETE FROM mes.services WHERE name = ANY($1)", [[TICK, PIN]]);
    await db.query("DELETE FROM mes.scripts WHERE name = ANY($1)", [[TICK, PIN]]);
    await db.query("DELETE FROM mes.nodes WHERE name = ANY($1)", [[`a-${tag}`, `b-${tag}`]]);
    await db.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(session)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
