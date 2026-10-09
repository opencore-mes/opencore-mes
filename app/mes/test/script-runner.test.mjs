// The script runner (DESIGN.md §12.4), without a database: scripts run in a process of their own, and
// nothing of the host reaches them. `npm test`.
//   - The ways out of a `vm` context that worked when scripts ran in the web process are closed: the
//     context's constructors compile nothing, and no function, promise or error of the host is in it.
//   - A runaway script is stopped: a loop (before or after an await) and memory.
//   - What a script may call (a lookup, ctx.records, ctx.http) still works, and a refusal keeps its words.
//   - With the runner gone, a pipe fails closed, and the next one starts another runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDryScript, runServiceScript, runRules, stopScriptRunner, scriptRunnerIsolation, probeScriptRunner } from "../server/rules.js";
import { ServiceError } from "@opencore-mes/juris-kit/errors.js";

const now = "2026-10-02T08:00:00.000Z";
const dry = (body, extra = {}) => runDryScript({ name: "p", source: `export default async function p(ctx) { ${body} }`, ctx: { now, lookup: async () => { throw new Error("refused"); } }, deadlineMs: 1500, ...extra });

test("the ways out of the context are closed", async () => {
    for (const body of [
        `return { got: typeof ctx.constructor.constructor("return process")() };`,
        `return { got: typeof ctx.lookup.constructor("return process")() };`,
        `try { await ctx.lookup("x"); } catch (e) { return { got: typeof e.constructor.constructor("return process")() }; }`,
        `const pr = ctx.lookup("y"); pr.catch(() => {}); return { got: typeof pr.constructor.constructor("return process")() };`,
    ]) {
        const r = await dry(body);
        assert.equal(r.error?.name, "EvalError", body);
        assert.match(r.error.message, /Code generation from strings disallowed/);
    }
    const seen = await dry(`return { got: [typeof process, typeof require, typeof setTimeout, typeof fetch, typeof globalThis.__bridge, typeof Math.random, Date.now()] };`);
    assert.deepEqual(seen.result.got, ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", Date.parse(now)]);
    // import(): refused with a string, never an error of the host's realm (whose constructor compiled
    // code there: it reached process), in a dry run and in a published script alike.
    const imported = await dry(`try { await import("node:fs"); return { got: "imported" }; } catch (e) { return { thrown: typeof e, got: typeof e.constructor.constructor }; }`);
    assert.deepEqual(imported.result, { thrown: "string", got: "function" });
    const through = await dry(`try { await import("node:fs"); } catch (e) { return { got: typeof e.constructor.constructor("return process")() }; }`);
    assert.equal(through.error?.name, "EvalError");
    const published = await runServiceScript({ name: "p", source: `export default async function p(ctx) { try { await import("node:fs"); return { got: "imported" }; } catch (e) { return { thrown: typeof e }; } }`, ctx: { now }, calls: {}, deadlineMs: 1500 });
    assert.deepEqual(published, { thrown: "string" });
    // No memory outside the heap the worker's limit counts, and no WebAssembly.
    const buffers = await dry(`return { got: [typeof ArrayBuffer, typeof SharedArrayBuffer, typeof Uint8Array, typeof Float64Array, typeof DataView, typeof WebAssembly, typeof Atomics] };`);
    assert.ok(buffers.result.got.every((t) => t === "undefined"), JSON.stringify(buffers));
    const frames = await dry(`Error.prepareStackTrace = (e, s) => s.map((f) => typeof f.getThis()); return { got: new Error("x").stack };`);
    assert.ok(frames.result.got.every((t) => t === "undefined"), "no frame hands over its `this`");
});

test("a runaway script is stopped: a loop, a loop after an await, memory", async () => {
    const sync = await dry(`while (true) {}`);
    assert.match(sync.error.message, /timed out/);
    const t = Date.now();
    const late = await dry(`await 0; while (true) {}`, { deadlineMs: 800 });
    assert.match(late.error.message, /ran past the dry run's 800 ms/);
    assert.ok(Date.now() - t < 3000);
    const memory = await dry(`const a = []; while (true) a.push(new Array(1e6).fill(1));`);
    assert.match(memory.error.message, /out of memory/);
    // …and the runner goes on.
    assert.deepEqual((await dry(`return { ok: 1 };`)).result, { ok: 1 });
});

test("what a script may call works; a refusal keeps its words and its field", async () => {
    const ran = await runServiceScript({
        name: "s", version: 1, source: `export default async function s(ctx) { ctx.output = { got: await ctx.records.get("lot", "L1"), sent: await ctx.http("erp", { path: "/x" }) }; return ctx; }`,
        ctx: { now, input: {}, records: { get: async (object, id) => ({ object, id }) }, http: async (connection, req) => ({ status: 200, connection, path: req.path }) },
    });
    assert.deepEqual(ran.output, { got: { object: "lot", id: "L1" }, sent: { status: 200, connection: "erp", path: "/x" } });
    await assert.rejects(
        runServiceScript({ name: "s", version: 1, source: `export default async function s(ctx) { await ctx.records.create("lot", {}); return ctx; }`, ctx: { now, records: { create: async () => { throw new ServiceError("Quantity is required.", { field: "qty" }); } } } }),
        (e) => e instanceof ServiceError && e.expose && e.fields.qty === "Quantity is required.",
    );
    const pipe = await runRules({
        definition: { rules: [{ script: "r", writes: ["qty"] }] },
        scripts: new Map([["r", { version: 1, source: `export default async function r(ctx) { if (ctx.data.qty < 0) throw Object.assign(new Error("Must be positive."), { field: "qty" }); ctx.data.qty = (await ctx.lookup("work_order", "w")).qty; return ctx; }` }]]),
        ctx: { event: { kind: "save" }, data: { qty: 1 }, now }, lookup: async () => ({ qty: 7 }),
    });
    assert.deepEqual([pipe.ctx.data, pipe.error], [{ qty: 7 }, null]);
    const refused = await runRules({
        definition: { rules: [{ script: "r", writes: ["qty"] }] },
        scripts: new Map([["r", { version: 1, source: `export default function r(ctx) { throw Object.assign(new Error("Must be positive."), { field: "qty" }); }` }]]),
        ctx: { event: { kind: "save" }, data: { qty: -1 }, now },
    });
    assert.deepEqual([refused.error.message, refused.error.field, refused.error.fault], ["Must be positive.", "qty", false]);
});

test("with the runner gone, a pipe fails closed, and the next one starts another", async () => {
    const pending = dry(`await 0; while (true) {}`, { deadlineMs: 5000 });
    await new Promise((r) => setTimeout(r, 200));
    stopScriptRunner();
    const r = await pending;
    assert.equal(r.error.fault, true);
    assert.match(r.error.message, /runner stopped/);
    assert.deepEqual((await dry(`return { again: true };`)).result, { again: true });
});

test("the runner has no network of its own, and starts under the deployment's wrapper when one is given", async () => {
    // Its own network functions are gone in the process and in each worker (no-network.mjs).
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
        await import(${JSON.stringify(new URL("../server/no-network.mjs", import.meta.url).href)});
        const net = (await import("node:net")).default, http = (await import("node:http")).default, dns = (await import("node:dns")).default;
        const tried = [() => net.connect(9, "127.0.0.1"), () => new net.Socket().connect(9, "127.0.0.1"), () => http.get("http://127.0.0.1:9/"), () => dns.lookup("example.com", () => {}), () => net.createServer().listen(0)];
        console.log(JSON.stringify([typeof fetch, ...tried.map((f) => { try { f(); return "reached"; } catch (e) { return e.code; } })]));
    `], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), ["undefined", "ERR_NO_NETWORK", "ERR_NO_NETWORK", "ERR_NO_NETWORK", "ERR_NO_NETWORK", "ERR_NO_NETWORK"]);
    for (const file of ["script-runner.mjs", "script-worker.mjs"]) assert.match((await import("node:fs")).readFileSync(new URL(`../server/${file}`, import.meta.url), "utf8"), /^import "\.\/no-network\.mjs";$/m, file);
    // It says how walled in it is when it starts: here, with no wrapper, the host's network (a
    // development machine), no sandbox, not wrapped.
    const gone = async () => { stopScriptRunner(); await new Promise((r) => setTimeout(r, 300)); };
    await gone();
    const bare = await probeScriptRunner();
    assert.equal(bare.sandbox, null);
    assert.equal(bare.wrapped, false);
    assert.ok(["host", "none"].includes(bare.network), JSON.stringify(bare));
    assert.deepEqual(scriptRunnerIsolation(), bare, "the status /healthz shows");
    // Under a wrapper (in a plant: ops/script-runner-sandbox.sh; here one every machine has, naming a
    // sandbox the way the real one does), scripts run as before, and the runner reports the sandbox.
    await gone();
    process.env.SCRIPT_RUNNER_WRAP = "/usr/bin/env MES_SCRIPT_SANDBOX=test-wrapper";
    try {
        assert.deepEqual((await dry(`return { ok: 1 };`)).result, { ok: 1 });
        assert.equal(scriptRunnerIsolation()?.sandbox, "test-wrapper");
        assert.equal(scriptRunnerIsolation()?.wrapped, true);
    } finally {
        delete process.env.SCRIPT_RUNNER_WRAP;
        await gone();
    }
    // On Linux, where the machine lets a process make a network namespace of its own: the runner in
    // one, with nothing in it, runs scripts as before (what COMPLIANCE.md G14 asks a plant to set).
    const { spawnSync } = await import("node:child_process");
    const unshare = process.platform === "linux" && spawnSync("unshare", ["-r", "-n", "true"]).status === 0;
    if (unshare) {
        process.env.SCRIPT_RUNNER_WRAP = "unshare -r -n";
        try {
            assert.deepEqual((await dry(`return { ok: 2 };`)).result, { ok: 2 });
            assert.equal((await dry(`return { got: await ctx.lookup("x") };`, { ctx: { now, lookup: async () => 7 } })).result?.got, 7, "its calls to the web process still pass");
            assert.equal(scriptRunnerIsolation()?.network, "none", "it sees no network of its own");
        } finally {
            delete process.env.SCRIPT_RUNNER_WRAP;
            await gone();
        }
    }
    // On Linux with bubblewrap (what app/mes/README.md asks a plant to install): the shipped wrapper,
    // scripts running as before, no network, the sandbox named.
    const bwrap = process.platform === "linux" && spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "true"]).status === 0;
    if (bwrap) {
        process.env.SCRIPT_RUNNER_WRAP = new URL("../../../ops/script-runner-sandbox.sh", import.meta.url).pathname;
        try {
            assert.equal((await dry(`return { got: await ctx.lookup("x") };`, { ctx: { now, lookup: async () => 8 } })).result?.got, 8);
            assert.deepEqual([scriptRunnerIsolation()?.network, scriptRunnerIsolation()?.sandbox], ["none", "bwrap"]);
        } finally {
            delete process.env.SCRIPT_RUNNER_WRAP;
            await gone();
        }
    }
    // The wrapper is a valid shell script, ready to run.
    assert.equal(spawnSync("sh", ["-n", new URL("../../../ops/script-runner-sandbox.sh", import.meta.url).pathname]).status, 0);
    assert.ok((await import("node:fs")).statSync(new URL("../../../ops/script-runner-sandbox.sh", import.meta.url)).mode & 0o111, "executable");
});
