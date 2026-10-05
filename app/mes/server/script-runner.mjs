// The script runner (DESIGN.md §12.4): a process of its own beside each web process, which runs every
// rule pipe, service script and dry run. It is started (rules.js) with Node's permission model: it
// reads only the app's own files, writes none, starts no process; and with an empty environment, so it
// holds no credentials (no database address, no secret, no API key). It talks to its web process over
// IPC only, and reaches a record or another system only by asking it (a lookup, ctx.records, ctx.http),
// as the person or service the job runs for.
//
// Jobs run in a pool of worker threads, each with a memory limit; a job past its deadline has its
// worker terminated (the runaway script with it) and fails closed.
import "./no-network.mjs";
import os from "node:os";
import { Worker } from "node:worker_threads";

// How walled in it is, said once at start (rules.js keeps it; /healthz and the start log show it):
// whether the operating system gives it any network (an address on any interface but loopback: none in
// a network namespace of its own), and the sandbox it runs in, as the wrapper names it
// (ops/script-runner-sandbox.sh sets MES_SCRIPT_SANDBOX). Infosec checks an installation by this, not
// by its settings.
function isolation() {
    let outside = [];
    try { outside = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal); } catch { outside = null; }
    return { network: outside === null ? "unknown" : outside.length ? "host" : "none", sandbox: process.env.MES_SCRIPT_SANDBOX || null };
}
process.send?.({ type: "isolation", ...isolation() });

const SIZE = Math.max(1, Math.min(8, Number(process.argv[2]) || 2));
const LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 };
const WORKER = new URL("./script-worker.mjs", import.meta.url);

const idle = [];               // workers waiting for a job
let alive = 0;
const queue = [];              // jobs waiting for a worker
const running = new Map();     // job id → { worker, timer }

function spawn() {
    const worker = new Worker(WORKER, { resourceLimits: LIMITS });
    alive += 1;
    worker.on("message", (m) => fromWorker(worker, m));
    worker.on("error", (e) => lost(worker, e));
    worker.on("exit", () => lost(worker, null));
    return worker;
}

function pump() {
    while (queue.length && (idle.length || alive < SIZE)) start(idle.pop() ?? spawn(), queue.shift());
}

function start(worker, j) {
    worker.job = j.job;
    const timer = setTimeout(() => {
        finish(j.job, { ok: false, error: { fault: true, deadline: true, message: `ran past its ${j.deadlineMs} ms deadline` } });
        worker.terminate();
    }, j.deadlineMs);
    running.set(j.job, { worker, timer });
    worker.postMessage({ type: "job", job: j.job, kind: j.kind, payload: j.payload });
}

function finish(job, outcome) {
    const r = running.get(job);
    if (!r) return;
    clearTimeout(r.timer);
    running.delete(job);
    send({ type: "done", job, outcome });
}

function fromWorker(worker, m) {
    if (m.type === "call") { if (running.has(m.job)) send({ type: "call", job: m.job, call: m.call, id: m.id, args: m.args }); return; }
    if (m.type !== "done") return;
    finish(m.job, m.outcome);
    worker.job = null;
    if (!worker.dead) idle.push(worker);
    pump();
}

// A worker gone (terminated at a deadline, out of memory, crashed): its job fails closed.
function lost(worker, error) {
    if (worker.dead) return;
    worker.dead = true;
    alive -= 1;
    const at = idle.indexOf(worker);
    if (at >= 0) idle.splice(at, 1);
    if (worker.job != null) {
        finish(worker.job, { ok: false, error: { fault: true, message: error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "ran out of memory" : "its worker stopped" } });
    }
    pump();
}

function send(message) {
    if (process.connected) process.send(message);
}

process.on("message", (m) => {
    if (m?.type === "job") { queue.push(m); pump(); return; }
    if (m?.type === "answer") running.get(m.job)?.worker.postMessage({ type: "answer", call: m.call, answer: m.answer });
});
// Its web process gone: so is it.
process.on("disconnect", () => process.exit(0));
