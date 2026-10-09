// Several instances, one database, the change bus between them: does a change made on one instance
// reach the others, correctly and quickly? Run against instances started with BUS=1 (and, to test
// the fence, REPLICA_URL behind a delayed replica):
//
//   A=http://127.0.0.1:3401 B=http://127.0.0.1:3402 C=http://127.0.0.1:3403 DATABASE_URL=… node app/mes/test/cluster.mjs [writes=100]
//
//   1. live across instances: a record open on B follows every save made on A (and the value it
//      shows is the one saved, never an older one read from a replica not yet caught up)
//   2. presence across instances: someone on A is seen from C
//   3. a design change executed on A is the definition B and C serve at once
import pg from "pg";
import { randomBytes } from "node:crypto";
import { liveKey } from "@opencore-mes/juris-kit/live-protocol.js";

const writes = Number(process.argv[2] ?? 100);
const [A, B, C] = [process.env.A ?? "http://127.0.0.1:3401", process.env.B ?? "http://127.0.0.1:3402", process.env.C ?? "http://127.0.0.1:3403"];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sessions = {};
async function cookieFor(user) {
    if (!sessions[user]) {
        const id = `cl-${user}-${randomBytes(8).toString("hex")}`;
        await pool.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [id, user]);
        sessions[user] = `mes_session=${id}`;
    }
    return sessions[user];
}
async function call(base, user, name, arg) {
    const res = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor(user) }, body: JSON.stringify([arg]) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${name} on ${base}: ${res.status} ${JSON.stringify(body)}`);
    return body;
}
const report = {};

// ---- 1. live across instances ----
const [wo] = (await pool.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'")).rows;
let lot = await call(A, "olga", "records.create", { object: "lot", data: { lot_no: `C${Date.now() % 100000}`, item: "X", work_order: wo.id, qty: 1, uom: "kg" } });
const seen = { qty: null, at: 0 };
const watch = async () => {
    const res = await fetch(`${B}/api/events`, { headers: { cookie: await cookieFor("quinn") } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let hello;
    const ready = new Promise((resolve) => { hello = resolve; });
    (async () => {
        for (;;) {
            const { value, done } = await reader.read().catch(() => ({ done: true }));
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let at;
            while ((at = buffer.indexOf("\n\n")) >= 0) {
                const event = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                const data = event.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
                if (!data) continue;
                const msg = JSON.parse(data);
                if (event.startsWith("event: hello")) { hello(msg.client); continue; }
                const qty = msg.full ? msg.full.qty : msg.set?.find(([path]) => path === "qty")?.[1];
                if (qty !== undefined) { seen.qty = qty; seen.at = performance.now(); }
            }
        }
    })();
    const client = await ready;
    const args = [{ object: "lot", id: lot.id, as: "quinn" }];
    const sub = await fetch(`${B}/api/_live`, { method: "POST", headers: { "content-type": "application/json", cookie: await cookieFor("quinn") }, body: JSON.stringify({ client, subscribe: { key: liveKey("records.get", args), name: "records.get", args } }) });
    if (!sub.ok) throw new Error(`subscribe on B: ${await sub.text()}`);
    return () => reader.cancel();
};
const stop = await watch();
await new Promise((r) => setTimeout(r, 300));
const latencies = [];
let missed = 0;
for (let i = 0; i < writes; i++) {
    const qty = 1000 + i;
    const began = performance.now();
    lot = await call(A, "olga", "records.update", { object: "lot", id: lot.id, rowVersion: lot.row_version, data: { qty } });
    while (seen.qty !== qty && performance.now() - began < 1500) await new Promise((r) => setTimeout(r, 2));
    if (seen.qty === qty) latencies.push(seen.at - began); else missed += 1;
}
stop();
latencies.sort((a, b) => a - b);
report.liveAcrossInstances = {
    writesOnA: writes, seenOnB: latencies.length, missedOrStale: missed,
    msFromSaveOnAToScreenOnB: latencies.length ? { p50: latencies[Math.floor(latencies.length / 2)].toFixed(1), p95: latencies[Math.floor(latencies.length * 0.95)].toFixed(1), max: latencies[latencies.length - 1].toFixed(1) } : null,
};

// ---- 2. presence across instances ----
await call(A, "olga", "presence.join", { object: "lot", id: lot.id, editing: true });
const others = await call(C, "quinn", "presence.get", { object: "lot", id: lot.id, as: "quinn" });
report.presenceAcrossInstances = { joinedOnA: "olga (editing)", seenFromC: others.map((o) => `${o.name}${o.editing ? " (editing)" : ""}`) };
await call(A, "olga", "presence.leave", { object: "lot", id: lot.id });

// ---- 3. a design change executed on A, served by B and C ----
const label = `Work order (${Date.now() % 10000})`;
const { id: change } = await call(A, "dana", "design.start", { object: "work_order" });
const draft = await call(A, "dana", "design.change", { id: change, as: "dana" });
const body = draft.content.definitions.work_order;
body.label = label;
await call(A, "dana", "design.save", { id: change, reason: "Cluster test: rename.", definitions: { work_order: body } });
await call(A, "dana", "design.submit", { id: change });
await call(A, "eli", "design.review", { id: change, decision: "pass" });
const outcome = await call(A, "sam", "design.approve", { id: change, department: "production", decision: "approve", meaning: "Approved" });
await new Promise((r) => setTimeout(r, 200));
report.designChangeAcrossInstances = {
    executedOnA: outcome.state,
    labelOnB: (await call(B, "sam", "defs.get", { object: "work_order", as: "sam" })).label === label,
    labelOnC: (await call(C, "sam", "defs.get", { object: "work_order", as: "sam" })).label === label,
};

// ---- the instances' own view ----
report.instances = {};
for (const [name, base] of Object.entries({ A, B, C })) {
    const h = await (await fetch(`${base}/healthz`)).json();
    report.instances[name] = { instance: h.instance, bus: h.bus && { delivered: h.bus.delivered, ownEchoes: h.bus.ownEchoes, errors: h.bus.errors }, reads: h.reads && { replica: h.reads.replicaReads, primary: h.reads.primaryReads, waited: h.reads.waited, fellBack: h.reads.fellBack, maxWaitMs: h.reads.maxWaitMs } };
}
console.log(JSON.stringify(report, null, 2));
await pool.query("DELETE FROM mes.sessions WHERE id LIKE 'cl-%'");
await pool.end();
process.exit(0);
