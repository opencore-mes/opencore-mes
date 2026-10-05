// A worker thread of the script runner (DESIGN.md §12.4): it runs one job at a time, each script in a
// fresh `vm` context, and is terminated by the runner when a job runs past its deadline (which also
// stops a script that loops after an `await`, where `vm`'s own timeout no longer reaches).
//
// Nothing of this realm enters a script's context. A script's context is built inside the context,
// from JSON; what it may call on the host (a lookup, `ctx.records.get`, `ctx.http`) is a function
// made inside the context, which calls one bridge function captured in a closure and answers with
// JSON. So `ctx.constructor.constructor` is the context's own Function, and with code generation
// off it compiles nothing. Its values come back to this realm as JSON text.
import "./no-network.mjs";
import { parentPort } from "node:worker_threads";
import vm from "node:vm";
import { scriptBody, runPipe } from "../client/pipe.js";

// The clock fixed at the run's `now`, no randomness: a script is deterministic, and a decision can be
// replayed (§12.5).
const FIXED_CLOCK = `
  delete Math.random;
  const RealDate = Date;
  const fixed = RealDate.parse(__now);
  globalThis.Date = class Date extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  delete globalThis.__now;`;

// What holds memory outside the heap the worker's limit counts, and what compiles code: a script has
// neither (a typed array of a gigabyte passes a 64 MB limit; its data is JSON).
const NO_BUFFERS = `for (const name of ["ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]) delete globalThis[name];`;

// A script imports nothing. Without this, import() is refused by the host with an error of the
// host's realm, whose constructor compiles code there (the way out of the context: it reached
// process). What is thrown here is a string, so nothing of this realm is handed over; Node calls
// it only when started with --experimental-vm-modules (rules.js), and the test holds both to it.
const NO_IMPORT = { importModuleDynamically() { throw "import is not available in a script"; } };

// Runs inside the context. `build` makes the script's ctx from JSON, the host calls placed at their
// paths; `run` calls the script and answers JSON text: { ok, value } or { ok: false, thrown }.
const BOOT = `(() => {
  "use strict";
  const bridge = globalThis.__bridge;
  delete globalThis.__bridge;
  const parse = JSON.parse, stringify = JSON.stringify;
  const KEYS = ["name", "field", "fields", "fault", "retry", "expose", "status", "code"];
  const rebuilt = (e) => {
    const err = new Error(String((e && e.message) || "The call failed."));
    for (const k of KEYS) if (e && e[k] !== undefined) err[k] = e[k];
    return err;
  };
  const call = (id) => async (...args) => {
    let answer;
    try { answer = await bridge(id, stringify(args)); }
    catch { answer = '{"ok":false,"error":{"message":"The call could not be made.","fault":true}}'; }
    const r = parse(answer);
    if (!r.ok) throw rebuilt(r.error);
    return r.value;
  };
  const shape = (e) => {
    if (e === null || typeof e !== "object") return { primitive: true, message: String(e) };
    const out = { message: String(e.message), stack: String(e.stack || "") };
    for (const k of KEYS) if (e[k] !== undefined) out[k] = e[k];
    try { stringify(out); } catch { return { message: out.message, stack: out.stack, fault: true }; }
    return out;
  };
  return {
    build(json, calls) {
      const ctx = parse(json);
      for (const [path, id] of parse(calls)) {
        let at = ctx;
        for (const key of path.slice(0, -1)) { if (at[key] === null || typeof at[key] !== "object") at[key] = {}; at = at[key]; }
        at[path[path.length - 1]] = call(id);
      }
      return ctx;
    },
    async run(fn, ctx) {
      try {
        const out = await fn(ctx);
        return stringify({ ok: true, value: out === undefined ? null : out });
      } catch (e) {
        let thrown;
        try { thrown = shape(e); } catch { thrown = { message: "The script threw something that cannot be read.", fault: true }; }
        return stringify({ ok: false, thrown });
      }
    },
  };
})()`;

// Host calls in flight: call id → resolve(answer text).
const calls = new Map();
let nextCall = 0;
let job = null;
const bridge = (id, args) => new Promise((resolve) => {
    const call = ++nextCall;
    calls.set(call, resolve);
    parentPort.postMessage({ type: "call", job, call, id, args: String(args) });
});

// Compiled published scripts, by their source (a draft and a published version never share one).
const compiled = new Map();
const compile = (name, source) => {
    if (!compiled.has(source)) {
        if (compiled.size > 500) compiled.clear();
        compiled.set(source, new vm.Script(`(${scriptBody(name, source)})`, { filename: `${name}.js`, ...NO_IMPORT }));
    }
    return compiled.get(source);
};

function freshContext(now) {
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    context.__now = String(now ?? new Date().toISOString());
    vm.runInContext(FIXED_CLOCK, context);
    vm.runInContext(NO_BUFFERS, context);
    context.__bridge = bridge;
    context.__api = vm.runInContext(BOOT, context);
    return context;
}

// One script, once: `fn` from the compiled script, ctx built in the context. The synchronous part is
// held to `cpuMs`; the rest to the job's deadline, which the runner keeps.
async function invoke(context, fn, ctx, calls, cpuMs) {
    context.__fn = fn;
    context.__ctx = context.__api.build(JSON.stringify(ctx), JSON.stringify(calls));
    const text = await vm.runInContext("__api.run(__fn, __ctx)", context, { timeout: cpuMs });
    return JSON.parse(text);
}
const asError = (t) => (t.primitive ? t.message : Object.assign(new Error(t.message), t));

// Where in its source a runtime error happened (the editor's lines: §15.2).
const where = (name, stack) => {
    const at = new RegExp(`${name}\\.js:(\\d+)(?::(\\d+))?`).exec(String(stack ?? ""));
    return at ? { line: Number(at[1]), column: at[2] ? Number(at[2]) : null } : { line: null, column: null };
};
const shaped = (name, e) => ({
    message: String(e?.message ?? e), name: e?.name ?? "Error", ...where(name, e?.stack),
    fault: e?.fault === true || e?.primitive === true || ["TypeError", "ReferenceError", "SyntaxError", "RangeError", "EvalError", "URIError"].includes(e?.name) || e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT",
    ...(e?.field ? { field: e.field } : {}), ...(e?.fields ? { fields: e.fields } : {}), ...(e?.retry ? { retry: true } : {}),
});

const kinds = {
    // A rule pipe (§12): each script with `lookup` its one host call.
    async pipe({ entries, scripts, ctx, cpuMs }) {
        return runPipe({
            entries, ctx,
            invoke: async (name, input) => {
                const script = scripts[name];
                if (!script) throw Object.assign(new Error(`rule script ${name} is not published`), { fault: true });
                const context = freshContext(input.now);
                const fn = compile(name, script.source).runInContext(context);
                const r = await invoke(context, fn, input, [[["lookup"], "lookup"]], cpuMs);
                if (!r.ok) throw asError(r.thrown);
                return r.value;
            },
        });
    },
    // A published service's script (§15.2) or a suite's (§29.4): { ok, value } or { ok: false, thrown }.
    async service({ name, source, ctx, calls, cpuMs }) {
        const context = freshContext(ctx.now);
        const fn = compile(name, source).runInContext(context);
        return invoke(context, fn, ctx, calls, cpuMs);
    },
    // A draft's dry run: compiled so that its lines are the editor's; { result } or { error }.
    async dry({ name, source, ctx, calls, cpuMs }) {
        const context = freshContext(ctx.now);
        let fn;
        try {
            scriptBody(name, source);
            const blanked = source.replace(/\bexport\s+default\b/, (m) => m.replace(/[^\n]/g, " "));
            fn = new vm.Script(`"use strict";${blanked}\n;${name}`, { filename: `${name}.js`, ...NO_IMPORT }).runInContext(context, { timeout: cpuMs });
        } catch (e) {
            return { error: { ...shaped(name, e), fault: true, stage: "compile" } };
        }
        try {
            const r = await invoke(context, fn, ctx, calls, cpuMs);
            return r.ok ? { result: r.value } : { error: shaped(name, r.thrown) };
        } catch (e) {
            return { error: shaped(name, e) };
        }
    },
};

parentPort.on("message", async (msg) => {
    if (msg.type === "answer") {
        const resolve = calls.get(msg.call);
        calls.delete(msg.call);
        resolve?.(msg.answer);
        return;
    }
    if (msg.type !== "job") return;
    job = msg.job;
    let outcome;
    try {
        outcome = { ok: true, value: await kinds[msg.kind](msg.payload) };
    } catch (e) {
        outcome = { ok: false, error: { message: String(e?.message ?? e), name: e?.name, code: e?.code, fault: true } };
    }
    calls.clear();
    job = null;
    parentPort.postMessage({ type: "done", job: msg.job, outcome: JSON.parse(JSON.stringify(outcome)) });
});
