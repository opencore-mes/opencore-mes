// Read-your-writes through a replica: save a lot, then read it straight back the way a live re-run
// does (records.get), and count the answers older than the save. Run against a server that has a
// REPLICA_URL, with the fence on and off:
//
//   node app/mes/test/stale.mjs [rounds=200]    (BASE, DATABASE_URL select the server and primary)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { sessionKey } from "../server/store.js";

const rounds = Number(process.argv[2] ?? 200);
const BASE = process.env.BASE ?? "http://127.0.0.1:3300";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sid = `stale-${randomBytes(8).toString("hex")}`;
await pool.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'olga', now() + interval '1 hour')", [sid]);
const cookie = `mes_session=${sid}`;
const call = async (name, arg) => {
    const res = await fetch(`${BASE}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify([arg]) });
    return { status: res.status, body: await res.json() };
};
const [wo] = (await pool.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'")).rows;
const created = await call("records.create", { object: "lot", data: { lot_no: `S${Date.now() % 100000}`, item: "X", work_order: wo.id, qty: 1, uom: "kg" } });
let { id, row_version: rowVersion } = created.body;

let stale = 0;
const readMs = [];
for (let i = 0; i < rounds; i++) {
    const qty = 100 + i;
    const saved = await call("records.update", { object: "lot", id, rowVersion, data: { qty } });
    if (saved.status !== 200) throw new Error(JSON.stringify(saved.body));
    rowVersion = saved.body.row_version;
    const began = performance.now();
    const read = await call("records.get", { object: "lot", id, as: "olga" });
    readMs.push(performance.now() - began);
    if (read.body?.qty !== qty) stale += 1;
}
readMs.sort((a, b) => a - b);
const health = await (await fetch(`${BASE}/healthz`)).json();
console.log(JSON.stringify({
    rounds, staleReads: stale,
    readBackMs: { p50: readMs[Math.floor(rounds / 2)].toFixed(1), p95: readMs[Math.floor(rounds * 0.95)].toFixed(1) },
    routing: health.reads,
}, null, 2));
await pool.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(sid)]);
await pool.end();
