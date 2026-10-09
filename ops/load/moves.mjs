// A load test of lot moves: an open-loop load of moves a second against one server or several, through the
// HTTP API as people would send them (no browser), until it is stopped, measured every interval: steady (a
// soak), stepped up until it no longer keeps up (a ramp: where the knee is), or a baseline with bursts (a
// shift's start and end).
//
// What a move is comes from a profile (ops/load/profiles/<name>.mjs): its setup makes what the load works on
// through the API (lots, tools), and its move takes one lot one step, each transaction timed. `machines` (the
// default): the seed's Move in, Track in, Track out, Move out. `cmos`: one step of the fab's CMOS route, as the
// open shift's crew works it (run on a copy of the fab: --copy-from). Moves start on the clock whether or not
// the earlier ones are done (open loop); a move that finds no lot (or tool) free is counted as behind.
//
//   DATABASE_URL=postgres:///openmes_loadtest node ops/load/moves.mjs --reset
//   PROFILE     machines | cmos (default machines)
//   RATE        moves a second, steady (default 100)
//   RAMP        from:step:seconds:to  e.g. 100:50:120:600: 100 a second, 50 more every 120 s, up to 600; it
//               stops after the first step it does not keep up with (RAMP_STOP=0: on to the top), and says
//               the last it did: kept up is, over the step's second half (once it has settled), at least 95%
//               of the rate done, none behind, p95 under 1 s; its stalls (intervals with p95 over 1 s) are said apart
//   BURST       base:peak:seconds:every  e.g. 20:150:120:1800: 20 a second, 150 for 120 s every 30 min
//               (the first burst after one `every`; BURST_FIRST seconds to start it sooner)
//   INSTANCES   servers, on PORT, PORT+1, … (default 1); more than one join the change bus (BUS=1) on the one
//               database, each move sent to one of them in turn
//   PORT        the first server's (default 9095)     INTERVAL         seconds between reports (default 10)
//   MIN_FREE_GB stop when the disk has less free (default 5)            DURATION seconds (default: until stopped)
//   --reset     drop and seed the database first
//   --copy-from <url>  drop it and make it a copy of that database instead (pg_dump; the source is only read),
//               its sign-in sessions cleared
//   Either is refused unless the database's name says test (openmes_loadtest). openmes_load keeps the data the
//   first soak left, for trying the system as people would with it: never reset.
//
// It starts the servers itself (node app/mes/server.mjs, PROD=1, on 127.0.0.1, signatures without a password,
// no idle sign-out: its people are scripts) and stops them when it stops (Ctrl-C, kill, DURATION, the disk).
// SUITES_DIR and the rest of the environment pass through. Reports go to stdout, and one JSON line per
// interval to .local/load/moves-<start>.jsonl. Nothing here is a contract: it reads the API as the browser does.
import pg from "pg";
import { spawn, execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, appendFileSync, statfsSync } from "node:fs";

const DB = process.env.DATABASE_URL ?? "postgres:///openmes_loadtest";
const PROFILE = process.env.PROFILE ?? "machines";
const RATE = Number(process.env.RATE ?? 100);
const RAMP = process.env.RAMP ? process.env.RAMP.split(":").map(Number) : null;
const BURST = process.env.BURST ? process.env.BURST.split(":").map(Number) : null;
const BURST_FIRST = process.env.BURST_FIRST !== undefined ? Number(process.env.BURST_FIRST) : null;
const RAMP_STOP = process.env.RAMP_STOP !== "0";
if ((RAMP && (RAMP.length !== 4 || RAMP.some((v) => !(v > 0)))) || (BURST && (BURST.length !== 4 || BURST.some((v) => !(v >= 0)) || !(BURST[3] > BURST[2])))) {
    console.error("RAMP is from:step:seconds:to, BURST base:peak:seconds:every (every longer than the burst)."); process.exit(2);
}
// The rate wanted at second t of the load, and the highest it will want.
const rateAt = (t) => {
    if (RAMP) { const [from, step, secs, to] = RAMP; return Math.min(to, from + step * Math.floor(t / secs)); }
    if (BURST) { const [b, peak, secs, every] = BURST; const into = (t - (BURST_FIRST ?? every) + every) % every; return t >= (BURST_FIRST ?? every) && into < secs ? peak : b; }
    return RATE;
};
const PEAK = RAMP ? RAMP[3] : BURST ? Math.max(BURST[0], BURST[1]) : RATE;
const PORT = Number(process.env.PORT ?? 9095);
const INSTANCES = Number(process.env.INSTANCES ?? 1);
const INTERVAL = Number(process.env.INTERVAL ?? 10);
const MIN_FREE_GB = Number(process.env.MIN_FREE_GB ?? 5);
const DURATION = process.env.DURATION ? Number(process.env.DURATION) : Infinity;
const dbName = new URL(DB).pathname.slice(1);
const copyFrom = process.argv.includes("--copy-from") ? process.argv[process.argv.indexOf("--copy-from") + 1] : null;
const profile = await import(`./profiles/${PROFILE}.mjs`).catch(() => null);
if (!profile) { console.error(`No profile ${PROFILE} (ops/load/profiles/).`); process.exit(2); }

const root = new URL("../../", import.meta.url).pathname;
if ((process.argv.includes("--reset") || copyFrom) && !/test/.test(dbName)) { console.error(`Refused: this drops ${dbName}, and only a database whose name says test is dropped here (openmes_loadtest).`); process.exit(2); }
if (copyFrom) {
    // A copy of the source as it is (pg_dump reads it in one snapshot, and nothing else), its people's sign-ins left behind.
    const admin = new URL(DB); admin.pathname = "/postgres";
    const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "inherit", "inherit"], shell: "/bin/zsh" });
    const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    sh(`psql ${quote(admin.href)} -qc ${quote(`DROP DATABASE IF EXISTS "${dbName}"`)} -c ${quote(`CREATE DATABASE "${dbName}"`)}`);
    sh(`pg_dump --no-owner --no-privileges ${quote(copyFrom)} | psql -q -v ON_ERROR_STOP=1 ${quote(DB)} > /dev/null`);
    sh(`psql ${quote(DB)} -qc "DELETE FROM mes.sessions"`);
    console.log(`Copied ${new URL(copyFrom).pathname.slice(1)} into ${dbName}.`);
} else if (process.argv.includes("--reset")) execFileSync("node", ["app/mes/db/reset.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: DB }, stdio: "inherit" });

const pool = new pg.Pool({ connectionString: DB, max: 2 });
const q = async (sql, args) => (await pool.query(sql, args)).rows;

// ---- the servers, processes of their own ----
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(`${root}.local/load`, { recursive: true });
const report = `${root}.local/load/moves-${stamp}.jsonl`;
const serverLog = `${root}.local/load/server-${stamp}.log`;
let stopping = false;
let ticker = null, tick = null;
const servers = Array.from({ length: INSTANCES }, (_, i) => {
    const proc = spawn("node", ["app/mes/server.mjs"], {
        cwd: root, env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT + i), HOST: "127.0.0.1", PROD: "1", BUILD: `load-${stamp}`, INSTANCE: `load-${i + 1}`, ...(INSTANCES > 1 ? { BUS: "1" } : {}),
            // Its people are scripts sending API calls: no page keeps their sessions alive, and none types a password to sign.
            SESSION_IDLE_MINUTES: "0", SIGN_WITH_PASSWORD: "0" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    for (const s of [proc.stdout, proc.stderr]) s.on("data", (d) => appendFileSync(serverLog, `[${i + 1}] ${d}`));
    proc.on("exit", (code) => { if (!stopping) { console.error(`Server ${i + 1} stopped (exit ${code}); see ${serverLog}.`); finish(1); } });
    return { proc, base: `http://127.0.0.1:${PORT + i}` };
});
const base = servers.map((x) => x.base).join(", ");
for (const sv of servers) for (let i = 0; ; i++) {
    try { if ((await fetch(`${sv.base}/healthz`)).ok) break; } catch { /* not yet */ }
    if (i > 120) { console.error(`${sv.base} did not answer in a minute; see ${serverLog}.`); await finish(1); }
    await new Promise((r) => setTimeout(r, 500));
}

// ---- who sends: anyone the profile names, signed in as the tests are, once each ----
// (The promise is kept, so calls made at once as someone new all wait for the one session made for them.)
const sessions = {};
const sessionOf = (user) => (sessions[user] ??= (async () => {
    const id = `load-${randomBytes(12).toString("hex")}`;
    await q("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [id, user]);
    return id;
})());
const call = async (user, name, args, to = 0) => {
    const res = await fetch(`${servers[to % INSTANCES].base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${await sessionOf(user)}` }, body: JSON.stringify([args]) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, code: body.code });
    return body;
};
const inBatches = async (n, make, size = 25) => { const out = []; for (let i = 0; i < n; i += size) out.push(...await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, k) => make(i + k)))); return out; };

// ---- measuring ----
const fresh = () => ({ wanted: 0, started: 0, done: 0, behind: 0, failed: 0, lat: {}, moveMs: [], errors: {} });
let cur = fresh();
const total = { started: 0, done: 0, behind: 0, failed: 0, calls: 0, errors: 0, lost: 0 };
let inFlight = 0;
const timed = async (name, fn) => {
    const s0 = performance.now();
    try { const out = await fn(); (cur.lat[name] ??= []).push(performance.now() - s0); total.calls++; return out; }
    catch (error) { total.calls++; throw Object.assign(error, { step: error.step ?? name }); }
};
const refused = (step, error) => {
    total.errors++;
    const why = `${step}: ${error.code ?? error.status}: ${String(error.message).slice(0, 90)}`;
    cur.errors[why] = (cur.errors[why] ?? 0) + 1;
};
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? null }; };
const ms = (v) => (v === null || v === undefined ? "—" : `${Math.round(v)}`);

const run = `${Date.now() % 1e6}`;
console.log(`Setting up ${PROFILE} in ${dbName}…`);
const made = await profile.setup({ call, q, peak: PEAK, run, inBatches }).catch(async (error) => { console.error(`Setup failed: ${error.message}`); await finish(1); });
const ctx = { call, timed, refused };
async function move(n) {
    cur.started++; total.started++; inFlight++;
    const t0 = performance.now();
    const r = await profile.move(ctx, n).catch((error) => { refused("move", error); return { ok: false }; });
    inFlight--;
    if (r === "behind") { cur.started--; total.started--; cur.behind++; total.behind++; return; }
    if (r.notAMove) { cur.started--; total.started--; return; }
    if (r.ok) { cur.done++; total.done++; cur.moveMs.push(performance.now() - t0); }
    else { cur.failed++; total.failed++; if (r.lost) total.lost++; }
}

// ---- the clock: the profile's rate, open loop ----
const shape = RAMP ? `a ramp from ${RAMP[0]} moves a second, ${RAMP[1]} more every ${RAMP[2]} s, up to ${RAMP[3]}`
    : BURST ? `${BURST[0]} moves a second, bursts of ${BURST[1]} for ${BURST[2]} s every ${BURST[3]} s (the first at ${BURST_FIRST ?? BURST[3]} s)`
    : `${RATE} moves a second`;
console.log(`Load: ${profile.label}; ${shape}; ${made}; ${INSTANCES} server${INSTANCES > 1 ? "s" : ""} on ${base} (log ${serverLog}).`);
console.log(`Reports every ${INTERVAL} s to ${report}. Stop with Ctrl-C (or kill ${process.pid}).\n`);
const t0 = performance.now();
let n = 0, owed = 0, lastTick = t0;
ticker = setInterval(() => {
    const now = performance.now();
    owed += ((now - lastTick) / 1000) * rateAt((now - t0) / 1000);
    lastTick = now;
    for (; owed >= 1; owed--) { cur.wanted++; move(n++); }
}, 5);
// A ramp's steps: each judged on its intervals but the first (the one it changed in).
const rampSteps = [];
let lastGood = null;

const cpuOf = (pid) => { try { const [cpu, rss] = execFileSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number); return { cpu, rssMb: Math.round(rss / 1024) }; } catch { return {}; } };
let last = performance.now();
let cpuLast = process.cpuUsage();
tick = setInterval(async () => {
    const now = performance.now();
    const secs = (now - last) / 1000;
    last = now;
    const c = cur;
    cur = fresh();
    const cpuNow = process.cpuUsage();
    const clientCpu = Math.round(((cpuNow.user - cpuLast.user + cpuNow.system - cpuLast.system) / 1e6 / secs) * 1000) / 10;
    cpuLast = cpuNow;
    const per = servers.map((x) => cpuOf(x.proc.pid));
    const [db] = await q(`SELECT pg_database_size(current_database()) AS bytes,
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS conns,
        (SELECT coalesce(max(seq), 0) FROM mes.audit_log)::bigint AS audit`).catch(() => [{}]);
    // What the database's busy connections wait on, now (a stall names its cause: a lock, I/O, the client).
    const waits = Object.fromEntries((await q(`SELECT coalesce(wait_event_type || ':' || wait_event, 'running') AS w, count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state IN ('active', 'idle in transaction') AND pid <> pg_backend_pid() GROUP BY 1 ORDER BY 2 DESC`).catch(() => [])).map((r) => [r.w, r.n]));
    const fs = statfsSync(root);
    const freeGb = (fs.bavail * fs.bsize) / 2 ** 30;
    const steps = Object.fromEntries(Object.entries(c.lat).map(([k, v]) => [k, stats(v)]));
    const line = {
        at: new Date().toISOString(), elapsedS: Math.round((now - t0) / 1000), seconds: Math.round(secs * 10) / 10, profile: PROFILE,
        target: rateAt((now - t0) / 1000 - secs / 2), wantedPerS: Math.round((c.wanted / secs) * 10) / 10, movesPerS: Math.round((c.done / secs) * 10) / 10,
        txPerS: Math.round((Object.values(c.lat).reduce((a, l) => a + l.length, 0) / secs) * 10) / 10,
        started: c.started, done: c.done, behind: c.behind, failed: c.failed, inFlight,
        move: stats(c.moveMs), steps, errors: c.errors, waits,
        server: { cpu: Math.round(per.reduce((a, x) => a + (x.cpu ?? 0), 0) * 10) / 10, rssMb: per.reduce((a, x) => a + (x.rssMb ?? 0), 0), each: per }, clientCpu,
        db: { mb: Math.round(Number(db.bytes ?? 0) / 2 ** 20), conns: db.conns, auditRows: Number(db.audit ?? 0) }, diskFreeGb: Math.round(freeGb * 10) / 10,
        total: { ...total },
    };
    appendFileSync(report, JSON.stringify(line) + "\n");
    // The transactions it ran most this interval, each at its p95.
    const busiest = Object.entries(steps).sort((a, b) => b[1].n - a[1].n).slice(0, 4).map(([k, v]) => `${k} ${ms(v.p95)}`).join(" ");
    console.log(`${line.at.slice(11, 19)}  +${String(line.elapsedS).padStart(6)}s  target ${String(line.target).padStart(4)}  moves/s ${String(line.movesPerS).padStart(6)}  tx/s ${String(line.txPerS).padStart(6)}  `
        + `move p50/p95/p99 ${ms(line.move.p50)}/${ms(line.move.p95)}/${ms(line.move.p99)} ms  ${busiest} (p95)  `
        + `inflight ${inFlight}  behind ${c.behind}  failed ${c.failed}  cpu ${line.server.cpu ?? "?"}%${INSTANCES > 1 ? ` (${per.map((x) => Math.round(x.cpu ?? 0)).join("+")})` : ""} rss ${line.server.rssMb ?? "?"}MB  client ${clientCpu}%  waits ${Object.entries(waits).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(",") || "none"}  db ${line.db.mb}MB  audit ${line.db.auditRows}  free ${line.diskFreeGb}GB`);
    for (const [why, k] of Object.entries(c.errors)) console.log(`          ${k}× ${why}`);
    if (RAMP) {
        const step = Math.floor(((now - t0) / 1000 - secs / 2) / RAMP[2]);
        (rampSteps[step] ??= []).push(line);
        const prev = rampSteps[step - 1];
        if (prev && !prev.judged) {
            prev.judged = true;
            const rs = prev.slice(Math.floor(prev.length / 2));
            const done = rs.reduce((a, r) => a + r.done, 0) / rs.reduce((a, r) => a + r.seconds, 0);
            const target = rs[0].target, behind = rs.reduce((a, r) => a + r.behind, 0), p95 = Math.max(...rs.map((r) => r.move.p95 ?? 0));
            const p50 = rs.map((r) => r.move.p50 ?? 0).sort((a, b) => a - b)[Math.floor(rs.length / 2)];
            const kept = done >= 0.95 * target && behind === 0 && p95 < 1000;
            const stalls = prev.filter((r) => (r.move.p95 ?? 0) > 1000).length, worst = Math.max(...prev.map((r) => r.move.p99 ?? 0));
            const best = Math.max(...prev.map((r) => r.movesPerS));
            console.log(`\n  STEP ${target}/s: ${kept ? "kept up" : "did NOT keep up"}: settled ${done.toFixed(1)} moves/s done, move p50 ${Math.round(p50)} ms, p95 up to ${Math.round(p95)} ms, ${behind} behind; `
                + `${stalls ? `${stalls} stalled interval${stalls > 1 ? "s" : ""} (p99 up to ${Math.round(worst)} ms)` : "no stall"}; at most ${best} moves/s in an interval; server cpu up to ${Math.round(Math.max(...prev.map((r) => r.server.cpu)))}%, client ${Math.round(Math.max(...prev.map((r) => r.clientCpu)))}%\n`);
            appendFileSync(report, JSON.stringify({ step: target, kept, done, p50, behind, p95, stalls, worst, best }) + "\n");
            if (kept) lastGood = target;
            else if (RAMP_STOP) { console.log(`Stopping: the knee is between ${lastGood ?? "—"} and ${target} moves a second (${INSTANCES} server${INSTANCES > 1 ? "s" : ""}).`); finish(0); }
        }
        if ((now - t0) / 1000 >= RAMP[2] * (Math.ceil((RAMP[3] - RAMP[0]) / RAMP[1]) + 1) + secs) { console.log(`\nStopping: the ramp reached ${RAMP[3]} moves a second; the last step kept up with: ${lastGood ?? "none"}.`); finish(0); }
    }
    if (freeGb < MIN_FREE_GB) { console.log(`\nStopping: ${line.diskFreeGb} GB free on the disk, under ${MIN_FREE_GB} GB.`); finish(0); }
    if ((now - t0) / 1000 >= DURATION) { console.log(`\nStopping: ${DURATION} s done.`); finish(0); }
}, INTERVAL * 1000);

async function finish(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    clearInterval(tick);
    console.log(`\nTotals: ${total.started} moves started, ${total.done} done, ${total.behind} behind, ${total.failed} failed, ${total.calls} calls, ${total.errors} refused, ${total.lost} lots lost from the pool. Report: ${report}`);
    for (const x of servers) x.proc.kill("SIGTERM");
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(code), 1500);
}
process.on("SIGINT", () => finish(0));
process.on("SIGTERM", () => finish(0));
