// Memory of the soak run's server (ops/load/moves.mjs), for leaks: its V8 heap after a full collection,
// sampled every few minutes, so what is still kept is all that is counted (a heap that only grows after
// collections, hour after hour, keeps something it should not). Through the inspector, opened on the
// running server with SIGUSR1 (127.0.0.1 only; nothing restarted), Node's own protocol:
//   node ops/load/heap.mjs [--every <minutes>] [--snapshot-every <hours>]   sample until stopped
//   node ops/load/heap.mjs --snapshot                                      one heap snapshot now
//   node ops/load/heap.mjs --report                                        the samples so far, and the trend
// Samples to .local/load/heap-<pid>.jsonl; snapshots to .local/load/heap-<pid>-<time>.heapsnapshot (open
// two in Chrome DevTools, Memory, Comparison: what grew between them, by constructor).
// A forced collection pauses the server for a moment (tens of milliseconds at this size): it shows in that
// interval's p99, and is why samples are minutes apart.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, createWriteStream } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const PORT = Number(process.env.PORT ?? 9095);
const dir = new URL("../../.local/load/", import.meta.url).pathname;
const pid = Number(execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n")[0]);
if (!pid) { console.error(`No server listening on ${PORT}.`); process.exit(1); }
const samples = `${dir}heap-${pid}.jsonl`;

if (args.includes("--report")) {
    if (!existsSync(samples)) { console.log("No samples yet."); process.exit(0); }
    const rows = readFileSync(samples, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    console.log("at        heap after GC  heap total  rss   external  arrayBuffers");
    for (const r of rows) console.log(`${r.at.slice(11, 19)}  ${String(r.heapUsedMb).padStart(10)} MB ${String(r.heapTotalMb).padStart(8)} MB ${String(r.rssMb).padStart(5)} ${String(r.externalMb).padStart(8)} ${String(r.arrayBuffersMb).padStart(10)}`);
    // The trend: a least-squares line through the post-GC heap, per hour, after the first ten minutes (warm-up).
    const t0 = Date.parse(rows[0].at);
    const pts = rows.map((r) => [(Date.parse(r.at) - t0) / 3.6e6, r.heapUsedMb]).filter(([h]) => h >= 1 / 6);
    if (pts.length >= 3) {
        const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
        console.log(`\nTrend after warm-up: ${slope >= 0 ? "+" : ""}${slope.toFixed(1)} MB an hour over ${(pts.at(-1)[0] - pts[0][0]).toFixed(1)} h (${pts.length} samples). `
            + (Math.abs(slope) < 2 ? "Flat: no sign of a leak." : slope > 0 ? "Growing: take a snapshot now and another later, and compare." : "Falling."));
    } else console.log("\nToo few samples after the first ten minutes for a trend.");
    process.exit(0);
}

// The inspector: opened by SIGUSR1 if it is not already, then its WebSocket.
const list = async () => { try { return await (await fetch("http://127.0.0.1:9229/json/list")).json(); } catch { return null; } };
let targets = await list();
if (!targets) {
    process.kill(pid, "SIGUSR1");
    for (let i = 0; i < 40 && !(targets = await list()); i++) await new Promise((r) => setTimeout(r, 250));
}
if (!targets?.length) { console.error("The server's inspector did not open."); process.exit(1); }
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let next = 1;
const waiting = new Map();
const chunks = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(msg.params.chunk);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((ok) => { const id = next++; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });

async function sample() {
    const t = performance.now();
    await send("HeapProfiler.collectGarbage");
    const gcMs = Math.round(performance.now() - t);
    const r = await send("Runtime.evaluate", { expression: "JSON.stringify(process.memoryUsage())", returnByValue: true });
    const m = JSON.parse(r.result.result.value);
    const mb = (v) => Math.round((v / 2 ** 20) * 10) / 10;
    const row = { at: new Date().toISOString(), pid, gcMs, heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), rssMb: mb(m.rss), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) };
    appendFileSync(samples, JSON.stringify(row) + "\n");
    return row;
}
async function snapshot() {
    await send("HeapProfiler.enable");
    chunks.length = 0;
    await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    const file = `${dir}heap-${pid}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.heapsnapshot`;
    await new Promise((ok) => { const w = createWriteStream(file); w.on("finish", ok); for (const c of chunks) w.write(c); w.end(); });
    chunks.length = 0;
    await send("HeapProfiler.disable");
    return file;
}

if (args.includes("--snapshot")) {
    console.log(`Snapshot: ${await snapshot()}`);
    ws.close();
    process.exit(0);
}
const every = opt("--every", 5) * 60_000;
const snapEvery = opt("--snapshot-every", 0) * 3.6e6;
console.log(`Sampling the heap of ${pid} after a full collection every ${every / 60_000} min to ${samples}${snapEvery ? `, a snapshot every ${snapEvery / 3.6e6} h` : ""}.`);
const line = (r) => console.log(`${r.at.slice(11, 19)} heap after GC ${r.heapUsedMb} MB (total ${r.heapTotalMb}, rss ${r.rssMb}, external ${r.externalMb}; GC took ${r.gcMs} ms)`);
line(await sample());
setInterval(async () => line(await sample()), every);
if (snapEvery) { console.log(`Snapshot: ${await snapshot()}`); setInterval(async () => console.log(`Snapshot: ${await snapshot()}`), snapEvery); }
ws.onclose = () => { console.log("The inspector closed (the server stopped)."); process.exit(0); };
