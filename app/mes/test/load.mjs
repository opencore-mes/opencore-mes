// A shift-change load test: operators saving records at a fixed rate (open loop: a slow answer does
// not slow the next request), while users watch live lists. Run against a server of its own:
//
//   DATABASE_URL=postgres:///openmes_load npm run db:reset
//   DATABASE_URL=postgres:///openmes_load PORT=3200 PROD=1 BUILD=load node app/mes/server.mjs
//   node app/mes/test/load.mjs [rate=100] [seconds=30] [lots=60] [watchers=10]
//
// Reports latency percentiles, failures, the live patches the watchers received, and the database's
// transaction rate.
import pg from "pg";
import { randomBytes } from "node:crypto";
import { liveKey } from "@opencore-mes/juris-kit/live-protocol.js";

const [rate = 100, seconds = 30, lotCount = 60, watcherCount = 10] = process.argv.slice(2).map(Number);
const BASE = process.env.BASE ?? "http://127.0.0.1:3200";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_load" });

// Sessions straight in the database: the load is the operators' work, not the sign-in.
async function session(user) {
    const id = `load-${user}-${randomBytes(8).toString("hex")}`;
    await pool.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '2 hours')", [id, user]);
    return `mes_session=${id}`;
}
async function call(cookie, name, arg) {
    const started = performance.now();
    const res = await fetch(`${BASE}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify([arg]) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, ms: performance.now() - started };
}

// ---- setup: lots to work on ----
const olga = await session("olga");
const sam = await session("sam");
const [wo] = (await pool.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'")).rows;
const lots = [];
for (let i = 0; i < lotCount; i++) {
    const r = await call(olga, "records.create", { object: "lot", data: { lot_no: `L${9000 + i}`, item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" } });
    if (r.status !== 200) throw new Error(`setup failed: ${JSON.stringify(r.body)}`);
    lots.push({ id: r.body.id, rowVersion: r.body.row_version, busy: false });
}

// ---- watchers: live lists open while the load runs ----
const watchers = [];
const users = ["olga", "sam", "quinn", "vera", "dana"];
for (let i = 0; i < watcherCount; i++) {
    const user = users[i % users.length];
    const cookie = await session(user);
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { headers: { cookie }, signal: controller.signal });
    // Behind the balancer: keep the instance it pinned this stream to, so the subscribe lands there too.
    const pinned = (res.headers.get("set-cookie") ?? "").match(/mes_node=([^;]+)/)?.[1];
    const stickyCookie = pinned ? `${cookie}; mes_node=${pinned}` : cookie;
    const reader = res.body.getReader();
    const watcher = { user, patches: 0, controller, clientId: null };
    watchers.push(watcher);
    let buffer = "";
    const decoder = new TextDecoder();
    const ready = new Promise((resolve) => {
        (async () => {
            for (;;) {
                const { value, done } = await reader.read().catch(() => ({ done: true }));
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                let at;
                while ((at = buffer.indexOf("\n\n")) >= 0) {
                    const event = buffer.slice(0, at);
                    buffer = buffer.slice(at + 2);
                    if (event.startsWith("event: hello")) { watcher.clientId = JSON.parse(event.split("data: ")[1]).client; resolve(); }
                    else if (event.includes("data: ")) watcher.patches += 1;
                }
            }
        })();
    });
    await ready;
    const args = [{ object: "lot", as: user }];
    const sub = await fetch(`${BASE}/api/_live`, { method: "POST", headers: { "content-type": "application/json", cookie: stickyCookie }, body: JSON.stringify({ client: watcher.clientId, subscribe: { key: liveKey("records.list", args), name: "records.list", args } }) });
    if (!sub.ok) throw new Error(`subscribe failed: ${await sub.text()}`);
}
await new Promise((r) => setTimeout(r, 500));
for (const w of watchers) w.patches = 0;

// ---- the load ----
const [{ xact_commit: commitsBefore }] = (await pool.query("SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()")).rows;
const results = [];
let skipped = 0;
let next = 0;
const started = performance.now();
const total = rate * seconds;
await new Promise((resolve) => {
    let sent = 0;
    const timer = setInterval(() => {
        const due = Math.floor(((performance.now() - started) / 1000) * rate);
        while (sent < Math.min(due, total)) {
            sent += 1;
            // One save per lot at a time, as one operator would: a lot still saving is skipped.
            let lot = null;
            for (let tries = 0; tries < lots.length && !lot; tries++) { const l = lots[next++ % lots.length]; if (!l.busy) lot = l; }
            if (!lot) { skipped += 1; continue; }
            lot.busy = true;
            const who = sent % 2 ? olga : sam;
            call(who, "records.update", { object: "lot", id: lot.id, rowVersion: lot.rowVersion, data: { qty: 10 + (sent % 90) + 0.5 }, key: randomBytes(12).toString("hex") })
                .then((r) => { results.push(r); if (r.status === 200) lot.rowVersion = r.body.row_version; })
                .catch((e) => results.push({ status: 0, ms: 0, error: e.message }))
                .finally(() => { lot.busy = false; });
        }
        if (sent >= total) { clearInterval(timer); setTimeout(resolve, 3000); }
    }, 5);
});
const elapsed = (performance.now() - started) / 1000 - 3;
const [{ xact_commit: commitsAfter }] = (await pool.query("SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()")).rows;

// ---- report ----
const ok = results.filter((r) => r.status === 200).map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => (ok.length ? ok[Math.min(ok.length - 1, Math.floor((p / 100) * ok.length))].toFixed(0) : "-");
const byStatus = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
console.log(JSON.stringify({
    target: `${rate}/s for ${seconds}s on ${lotCount} lots, ${watcherCount} live list watchers`,
    sent: results.length, skippedBecauseLotBusy: skipped, statuses: byStatus,
    achievedPerSecond: +(ok.length / elapsed).toFixed(1),
    latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: ok.length ? ok[ok.length - 1].toFixed(0) : "-" },
    livePatchesReceived: watchers.reduce((n, w) => n + w.patches, 0),
    postgresCommitsPerSecond: +((Number(commitsAfter) - Number(commitsBefore)) / elapsed).toFixed(0),
    routing: (await (await fetch(`${BASE}/healthz`)).json().catch(() => ({}))).reads ?? "primary only",
}, null, 2));
for (const w of watchers) w.controller.abort();
await pool.query("DELETE FROM mes.sessions WHERE id LIKE 'load-%'");
await pool.end();
process.exit(0);
