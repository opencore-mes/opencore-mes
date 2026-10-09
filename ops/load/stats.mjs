// What a soak run of ops/load/moves.mjs has measured so far: its .jsonl report summed up by window.
//   node ops/load/stats.mjs [report.jsonl] [--window <minutes>] [--last <minutes>] [--line]
// Without a file, the newest in .local/load/. --line: one line, the latest window and the run so far
// (for a watch that prints it now and then).
import { readFileSync, readdirSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const dir = new URL("../../.local/load/", import.meta.url).pathname;
const file = args.find((a) => a.endsWith(".jsonl")) ?? dir + readdirSync(dir).filter((f) => /^moves-.*\.jsonl$/.test(f)).sort((a, b) => statSync(dir + a).mtimeMs - statSync(dir + b).mtimeMs).at(-1);
const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
// A ramp's verdicts, one a step (moves.mjs RAMP), beside the interval reports.
const verdicts = lines.filter((r) => r.step !== undefined);
const all = lines.filter((r) => r.at);
if (!all.length) { console.log("No reports yet."); process.exit(0); }
const windowMin = opt("--window", 10);
const lastMin = opt("--last", Infinity);
const rows = all.filter((r) => r.elapsedS >= all.at(-1).elapsedS - lastMin * 60);

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const n = (v, d = 0) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const hms = (s) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
function sum(rs) {
    const secs = rs.reduce((a, r) => a + r.seconds, 0);
    const done = rs.reduce((a, r) => a + r.done, 0);
    const errors = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.errors ?? {})) errors[k] = (errors[k] ?? 0) + v;
    return {
        from: rs[0].elapsedS - rs[0].seconds, to: rs.at(-1).elapsedS, movesPerS: done / secs, txPerS: avg(rs.map((r) => r.txPerS)),
        p50: avg(rs.map((r) => r.move.p50).filter((v) => v !== null)), p95: avg(rs.map((r) => r.move.p95).filter((v) => v !== null)), p99max: max(rs.map((r) => r.move.p99).filter((v) => v !== null)),
        behind: rs.reduce((a, r) => a + r.behind, 0), failed: rs.reduce((a, r) => a + r.failed, 0), inFlightMax: max(rs.map((r) => r.inFlight)),
        cpu: avg(rs.map((r) => r.server?.cpu).filter((v) => v !== undefined)), rss: rs.at(-1).server?.rssMb, dbMb: rs.at(-1).db.mb, free: rs.at(-1).diskFreeGb, errors,
    };
}
const first = all[0], last = all.at(-1);
const runSecs = last.elapsedS - (first.elapsedS - first.seconds);
const growMbS = (last.db.mb - first.db.mb) / Math.max(1, last.elapsedS - first.elapsedS);
const stopAtGb = 5;
const etaS = growMbS > 0 ? ((last.diskFreeGb - stopAtGb) * 1024) / growMbS : Infinity;
const whole = sum(rows);
const latest = sum(all.slice(-Math.max(1, Math.round(60 / (last.seconds || 10)))));
const alive = Date.now() - Date.parse(last.at) < 60_000;

// The server's heap after a full collection, when ops/load/heap.mjs samples it: the newest samples file.
const heapFile = readdirSync(dir).filter((f) => /^heap-\d+\.jsonl$/.test(f)).sort((a, b) => statSync(dir + a).mtimeMs - statSync(dir + b).mtimeMs).at(-1);
const heap = heapFile ? readFileSync(dir + heapFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const heapWords = heap.length ? ` | heap after GC ${heap.at(-1).heapUsedMb} MB (first ${heap[0].heapUsedMb} MB, ${heap.length} samples)` : "";
if (args.includes("--line")) {
    console.log(`${new Date().toISOString().slice(11, 16)} ${alive ? "running" : "NOT REPORTING"} ${hms(runSecs)}: last min ${n(latest.movesPerS, 1)} moves/s${last.target !== undefined ? ` (target ${last.target})` : ""}, move p50/p95 ${n(latest.p50)}/${n(latest.p95)} ms, cpu ${n(latest.cpu)}%, behind ${latest.behind}, failed ${latest.failed}`
        + ` | run ${n(whole.movesPerS, 1)} moves/s, ${last.total.done} moves, ${last.total.failed} failed, ${last.total.errors} refused | db ${(last.db.mb / 1024).toFixed(2)} GB (+${n(growMbS * 3600 / 1024, 1)} GB/h), free ${last.diskFreeGb} GB, guard in ~${Number.isFinite(etaS) ? hms(etaS) : "—"}${heapWords}`);
    process.exit(0);
}

console.log(`${file}\nRun: ${hms(runSecs)} (${all.length} reports, last ${last.at}, ${alive ? "still reporting" : "NOT reporting for over a minute"})`);
console.log(`Totals: ${last.total.started} moves started, ${last.total.done} done, ${last.total.behind} behind, ${last.total.failed} failed; ${last.total.calls} calls, ${last.total.errors} refused, ${last.total.lost} lots lost`);
console.log(`Database ${(last.db.mb / 1024).toFixed(2)} GB, growing ${n(growMbS * 3600 / 1024, 2)} GB/h; audit rows ${last.db.auditRows}; disk free ${last.diskFreeGb} GB; the ${stopAtGb} GB guard in ~${Number.isFinite(etaS) ? hms(etaS) : "—"}\n`);
console.log("window          moves/s  tx/s   move p50  p95  p99max  behind failed  inflight  cpu%  rssMB  dbMB");
for (let start = rows[0].elapsedS - rows[0].seconds; start < rows.at(-1).elapsedS; start += windowMin * 60) {
    const rs = rows.filter((r) => r.elapsedS > start && r.elapsedS <= start + windowMin * 60);
    if (!rs.length) continue;
    const s = sum(rs);
    console.log(`${hms(s.from).padEnd(6)}–${hms(s.to).padEnd(7)} ${n(s.movesPerS, 1).padStart(7)} ${n(s.txPerS).padStart(5)} ${n(s.p50).padStart(9)} ${n(s.p95).padStart(4)} ${n(s.p99max).padStart(7)} ${String(s.behind).padStart(7)} ${String(s.failed).padStart(6)} ${String(s.inFlightMax).padStart(9)} ${n(s.cpu).padStart(5)} ${String(s.rss ?? "—").padStart(6)} ${String(s.dbMb).padStart(5)}`);
}
if (verdicts.length) { console.log("\nRamp steps:"); for (const v of verdicts) console.log(`  ${String(v.step).padStart(5)}/s  ${v.kept ? "kept up     " : "did NOT keep up"}  ${v.done.toFixed(1)} done/s, ${v.behind} behind, p95 up to ${Math.round(v.p95)} ms`); }
const errs = Object.entries(whole.errors).sort((a, b) => b[1] - a[1]);
if (errs.length) { console.log("\nRefusals:"); for (const [k, v] of errs.slice(0, 10)) console.log(`  ${v}× ${k}`); }
