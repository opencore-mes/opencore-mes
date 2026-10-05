// The backend rule runner (DESIGN.md §12.4): every rule pipe, service script, suite script and dry run
// runs in the script runner, a process of its own (script-runner.mjs) started here, with Node's
// permission model and an empty environment: no credentials, no files but the app's to read, no
// process to start. A script reaches a record or another system only through the functions it is
// handed (a lookup, ctx.records, ctx.http), which run here, as the person or service the job is for,
// called over IPC with JSON in and out; nothing of this process enters a script's context
// (script-worker.mjs). A runaway script is stopped at its deadline. With the runner down, scripts
// fail closed: a write that has a pipe is refused, never saved unchecked.
//
// The operating system walls it in too where the deployment says how (SCRIPT_RUNNER_WRAP: on Linux,
// ops/script-runner-sandbox.sh, bubblewrap: no network, nothing to read but the app's code, no
// capabilities). The runner says at start how walled in it is (`scriptRunnerIsolation`), so an
// installation is checked by what it is, not by what its settings say (/healthz, the start log).
import vm from "node:vm";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scriptBody } from "../client/pipe.js";
import { ServiceError } from "../../../src/errors.js";

const SCRIPT_TIMEOUT_MS = 50;       // synchronous CPU per rule script
const PIPE_DEADLINE_MS = 2000;      // wall clock per pipe, lookups included
const SERVICE_CPU_MS = 200;         // synchronous CPU per service run
const ANSWER_GRACE_MS = 5000;       // past a job's deadline, a runner that has not answered is restarted

const RUNNER = fileURLToPath(new URL("./script-runner.mjs", import.meta.url));
const APP_DIR = path.dirname(path.dirname(RUNNER)); // app/mes: the only files it may read

// ---- the runner process ------------------------------------------------------------------------
let child = null;
const jobs = new Map();             // job id → { fns, resolve, timer, child }
let nextJob = 0;
// What the runner said of itself when it last started: { network: "none" | "host" | "unknown",
// sandbox, wrapped, at }; null until it has started.
let isolationSaid = null;
const isolationWaiters = [];

function runner() {
    if (child) return child;
    // --experimental-vm-modules: so that a script's import() reaches the worker's refusal (script-worker.mjs).
    const execArgv = ["--permission", "--allow-worker", `--allow-fs-read=${APP_DIR}`, "--experimental-vm-modules", "--disable-warning=SecurityWarning", "--disable-warning=ExperimentalWarning"];
    const options = { env: {}, serialization: "json", stdio: ["ignore", "inherit", "inherit", "ipc"] };
    // SCRIPT_RUNNER_WRAP: a command the runner is started under, which the deployment uses to give it a
    // network namespace of its own with nothing in it (Linux: ops/script-runner-sandbox.sh, bubblewrap;
    // "unshare -r -n" where the kernel lets any program make user namespaces). The runner takes its
    // own network functions away regardless (no-network.mjs); this is the operating system holding it
    // to that. A wrapper that cannot start leaves no runner, and every script fails closed, saying so.
    const wrap = (process.env.SCRIPT_RUNNER_WRAP ?? "").trim().split(/\s+/).filter(Boolean);
    const c = wrap.length
        ? spawn(wrap[0], [...wrap.slice(1), process.execPath, ...execArgv, RUNNER, process.env.SCRIPT_WORKERS ?? "2"], options)
        : fork(RUNNER, [process.env.SCRIPT_WORKERS ?? "2"], { ...options, execArgv });
    c.on("message", (m) => onMessage(c, m));
    c.on("error", (error) => { if (wrap.length) console.error(`script runner: could not start under "${wrap.join(" ")}" (${error.code ?? error.message}): no script runs until SCRIPT_RUNNER_WRAP is one this machine has`); });
    c.on("exit", () => {
        if (child === c) child = null;
        for (const [id, j] of jobs) if (j.child === c) settle(id, { ok: false, error: { fault: true, message: "the script runner stopped" } });
    });
    child = c;
    return c;
}
// The runner keeps no test or tool alive once it has nothing to do.
function holdWhileBusy() {
    if (!child) return;
    const busy = [...jobs.values()].some((j) => j.child === child);
    for (const handle of [child, child.channel]) busy ? handle?.ref?.() : handle?.unref?.();
}

function settle(id, outcome) {
    const j = jobs.get(id);
    if (!j) return;
    clearTimeout(j.timer);
    jobs.delete(id);
    holdWhileBusy();
    j.resolve(outcome);
}

// How an error of this process travels back into a script: as data, rebuilt there.
const ERROR_KEYS = ["name", "field", "fields", "fault", "retry", "expose", "status", "code"];
const errorData = (e) => {
    const out = { message: String(e?.message ?? e) };
    for (const k of ERROR_KEYS) if (e?.[k] !== undefined) out[k] = e[k];
    try { JSON.stringify(out); return out; } catch { return { message: out.message, fault: true }; }
};

async function onMessage(c, m) {
    if (m?.type === "done") { settle(m.job, m.outcome); return; }
    if (m?.type === "isolation") {
        isolationSaid = { network: ["none", "host"].includes(m.network) ? m.network : "unknown", sandbox: typeof m.sandbox === "string" ? m.sandbox.slice(0, 40) : null, wrapped: Boolean((process.env.SCRIPT_RUNNER_WRAP ?? "").trim()), at: new Date().toISOString() };
        for (const w of isolationWaiters.splice(0)) w(isolationSaid);
        holdWhileBusy();
        return;
    }
    if (m?.type !== "call") return;
    const fn = jobs.get(m.job)?.fns.get(m.id);
    let answer;
    try {
        if (!fn) throw Object.assign(new Error("not something this script may call"), { fault: true });
        const value = await fn(...JSON.parse(m.args));
        answer = JSON.stringify({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
        answer = JSON.stringify({ ok: false, error: errorData(e) });
    }
    if (jobs.has(m.job) && c.connected) c.send({ type: "answer", job: m.job, call: m.call, answer });
}

// One job in the runner: { ok, value } or { ok: false, error: { message, fault, deadline? } }.
function job(kind, payload, fns, deadlineMs) {
    return new Promise((resolve) => {
        let c;
        try { c = runner(); } catch (e) { resolve({ ok: false, error: { fault: true, message: `the script runner could not start: ${e.message}` } }); return; }
        const id = ++nextJob;
        const timer = setTimeout(() => {
            settle(id, { ok: false, error: { fault: true, deadline: true, message: "the script runner did not answer" } });
            c.kill();
        }, deadlineMs + ANSWER_GRACE_MS);
        jobs.set(id, { fns, resolve, timer, child: c });
        holdWhileBusy();
        try { c.send({ type: "job", job: id, kind, payload, deadlineMs }); } catch (e) { settle(id, { ok: false, error: { fault: true, message: `the script runner could not be reached: ${e.message}` } }); }
    });
}

// A context, split for the runner: its data as JSON, and the functions in it (ctx.records.get,
// ctx.http, a lookup) kept here, named by their path.
function split(ctx) {
    const fns = new Map();
    const calls = [];
    const walk = (value, at) => {
        if (typeof value === "function") {
            const id = `f${fns.size}`;
            fns.set(id, value);
            calls.push([at, id]);
            return undefined;
        }
        if (value === null || typeof value !== "object" || Array.isArray(value) || at.length > 4) return value;
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const w = walk(v, [...at, k]);
            if (w !== undefined) out[k] = w;
        }
        return out;
    };
    const data = walk(ctx, []);
    return { data: JSON.parse(JSON.stringify(data ?? {})), fns, calls };
}

// What a script threw, rebuilt for its caller here: a refusal with words stays one.
function thrownError(t) {
    if (t.primitive) return Object.assign(new Error(t.message), { fault: true });
    if (t.expose) return new ServiceError(t.message, { status: t.status, fields: t.fields, field: t.field, code: t.code });
    const e = new Error(t.message);
    for (const k of ERROR_KEYS) if (t[k] !== undefined) e[k] = t[k];
    if (t.stack) e.stack = t.stack;
    return e;
}

// ---- what the rest of the server calls ----------------------------------------------------------

// Stops the runner (a shutdown, or a test of a runner gone): its jobs fail closed, the next job
// starts another.
// How walled in the script runner is, as it said when it last started (null before it has).
export const scriptRunnerIsolation = () => isolationSaid;
// The runner started (if it is not), and what it says of itself: at a server's start, for its log and
// event log. → the isolation, or { network: "unknown", failed: words } when it does not start in time.
export function probeScriptRunner(ms = 5000) {
    if (isolationSaid && child) return Promise.resolve(isolationSaid);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ network: "unknown", sandbox: null, wrapped: Boolean((process.env.SCRIPT_RUNNER_WRAP ?? "").trim()), failed: "the script runner did not start" }), ms);
        isolationWaiters.push((said) => { clearTimeout(timer); resolve(said); });
        try { runner(); } catch (e) { clearTimeout(timer); resolve({ network: "unknown", sandbox: null, failed: e.message }); }
    });
}

export function stopScriptRunner() {
    child?.kill();
}

// runRules({ definition, scripts, ctx, lookup }) → runPipe's { ctx, error, trace }.
// `scripts` maps name → { version, source } (the published versions, or a draft's).
export async function runRules({ definition, scripts, ctx, lookup }) {
    const entries = definition.rules ?? [];
    const clone = JSON.parse(JSON.stringify(ctx));
    if (!entries.length) return { ctx: clone, error: null, trace: [] };
    const sources = {};
    for (const e of entries) { const s = scripts.get(e.script); if (s) sources[e.script] = { version: s.version, source: s.source }; }
    const fns = new Map(lookup ? [["lookup", lookup]] : []);
    const outcome = await job("pipe", { entries, scripts: sources, ctx: clone, cpuMs: SCRIPT_TIMEOUT_MS }, fns, PIPE_DEADLINE_MS);
    if (outcome.ok) return outcome.value;
    return { ctx: clone, error: { script: "(pipe)", fault: true, message: "The rules could not run; the change was not saved.", detail: outcome.error.message }, trace: [] };
}

// The design-time check of one script (§12.1): the name rule, and that it compiles alone. Compiling
// runs nothing, so it stays here.
export function checkScript(name, source) {
    const body = scriptBody(name, source);
    new vm.Script(`(${body})`, { filename: `${name}.js` });
    return true;
}

// A service's script (§15.2), or a suite's (§29.4): the rule-script contract, with what it may reach
// on its context (records, connections), and more time: it waits on other systems. Answers the
// context it returned, or throws what it threw (a refusal with words stays a ServiceError).
export async function runServiceScript({ name, version, source, ctx, deadlineMs = 15000 }) {
    const { data, fns, calls } = split(ctx);
    const outcome = await job("service", { name, version, source, ctx: data, calls, cpuMs: SERVICE_CPU_MS }, fns, deadlineMs);
    if (!outcome.ok) throw Object.assign(new Error(outcome.error.deadline ? `service ${name} ran past its ${deadlineMs} ms deadline` : `service ${name} could not run: ${outcome.error.message}`), { fault: true });
    if (!outcome.value.ok) throw thrownError(outcome.value.thrown);
    return outcome.value.value;
}

// A dry run of a draft script (§15.2): the same sandbox and clock, its line numbers the editor's.
// Answers { result } or { error: { message, name, line, column, fault, … } }.
export async function runDryScript({ name, source, ctx, deadlineMs = 5000, cpuMs = 200 }) {
    const { data, fns, calls } = split(ctx);
    const outcome = await job("dry", { name, source, ctx: data, calls, cpuMs }, fns, deadlineMs);
    if (outcome.ok) return outcome.value;
    return { error: { message: outcome.error.deadline ? `${name} ran past the dry run's ${deadlineMs} ms` : `${name} could not run: ${outcome.error.message}`, name: "Error", line: null, column: null, fault: true } };
}
