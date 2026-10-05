#!/usr/bin/env node
// The equipment-adapter 1.0 conformance kit (README.md beside this file). It drives an adapter against
// a scripted tool through the contract only, and says, step by step, what holds and what does not.
//
//   node docs/contracts/equipment-adapter/kit.mjs path/to/fixture.mjs [--json]
//   import { runKit } from "…/kit.mjs"; await runKit(fixture) → { contract, adapter, ok, steps }
//
// It imports nothing of the core: an adapter's author runs it with only this file and their fixture.
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

export const CONTRACT = { name: "equipment-adapter", version: "1.0" };

// The tool type every fixture maps its tool onto. The tool reports Temperature in kelvin (the mapping
// converts) and State as the codes 1 (IDLE) and 2 (RUNNING) (the mapping names them).
export const KIT_TOOL_TYPE = Object.freeze({
    label: "Kit tool",
    variables: { Temperature: { units: "degC" }, State: { values: ["IDLE", "RUNNING"] }, Lot: {} },
    events: { Started: { values: ["Lot"] }, Ended: { values: ["Lot"] } },
    commands: { START: ["Lot"], STOP: [] },
});
export const KIT_ALARM = "Overheat";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// `onStep(step)` hears each step as it is decided (the command prints them as they come).
export async function runKit(fixture, { timeoutMs = 10_000, reconnectMs = 45_000, onStep = () => {} } = {}) {
    const steps = [];
    const record = (s) => { steps.push(s); try { onStep(s); } catch { /* a listener's problem is not the adapter's */ } };
    const step = (name, ok, detail = "", extra = {}) => { record({ name, ok: Boolean(ok), ...extra, detail: String(detail) }); return Boolean(ok); };
    const skip = (name, detail) => record({ name, ok: true, skipped: true, detail });
    const a = fixture?.adapter;
    const finish = () => ({ contract: `${CONTRACT.name}@${CONTRACT.version}`, adapter: a?.name ?? null, ok: steps.every((s) => s.ok), steps });

    // ---- the module ----
    const members = [];
    if (!isPlain(a)) members.push("the fixture gives no adapter (its default export's `adapter`)");
    else {
        if (typeof a.name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(a.name)) members.push("name: letters, digits and -, starting with a letter");
        if (typeof a.label !== "string" || !a.label) members.push("label: what a person reads");
        if (typeof a.contract !== "string" || a.contract.split(".")[0] !== CONTRACT.version.split(".")[0]) members.push(`contract: "${CONTRACT.version}" (this kit checks ${CONTRACT.version}; the adapter says ${JSON.stringify(a.contract)})`);
        if (!Array.isArray(a.serves) || !a.serves.every((x) => ["command", "recipes", "gem300"].includes(x))) members.push('serves: a list of "command", "recipes", "gem300"');
        for (const f of ["check", "connect"]) if (typeof a[f] !== "function") members.push(`${f}: a function`);
    }
    if (!step("the module: name, label, contract, serves, check, connect", !members.length, members.join("; ") || `${a.name} ${a.contract}: ${a.label}`)) return finish();

    let tool = null;
    let session = null;
    const dir = await mkdtemp(path.join(os.tmpdir(), "adapter-kit-"));
    const items = [];
    const since = (mark, pred) => items.slice(mark).filter(pred);
    const waitFor = async (mark, pred, ms = timeoutMs, count = 1) => {
        const until = Date.now() + ms;
        while (Date.now() < until) { const found = since(mark, pred); if (found.length >= count) return found; await sleep(25); }
        return since(mark, pred);
    };
    const words = (e) => String(e?.message ?? e);
    try {
        tool = await fixture.tool();
        if (!step("the scripted tool starts, with an address and a mapping", isPlain(tool?.address) && isPlain(tool?.mapping), isPlain(tool?.address) ? `${tool.address.host}:${tool.address.port}` : "no address or mapping")) return finish();

        // ---- check ----
        let problems;
        try { problems = a.check(tool.mapping, { toolType: KIT_TOOL_TYPE }); } catch (e) { problems = [`check threw: ${words(e)}`]; }
        step("check accepts the fixture's mapping", Array.isArray(problems) && !problems.length, Array.isArray(problems) ? problems.join("; ") || "no problems" : "check did not return a list");
        const bad = Array.isArray(fixture.badMappings) ? fixture.badMappings : [];
        if (!bad.length) step("check refuses what the adapter cannot serve", false, "the fixture gives no badMappings to try");
        for (const { why, mapping } of bad) {
            let got;
            try { got = a.check(mapping, { toolType: KIT_TOOL_TYPE }); } catch (e) { got = null; }
            step(`check refuses a mapping: ${why}`, Array.isArray(got) && got.length > 0 && got.every((p) => typeof p === "string" && p.trim()), Array.isArray(got) ? got.join("; ") || "accepted" : "check threw instead of answering");
        }

        // ---- connect ----
        const machine = { id: "kit-machine", title: "KIT-01", address: tool.address, mapping: tool.mapping, toolType: KIT_TOOL_TYPE, modules: [], secret: (name) => tool.secrets?.[name], dir };
        const hooks = { emit: (item) => items.push(item), log: { info() {}, warn() {}, error() {} } };
        const started = Date.now();
        try { session = await Promise.race([a.connect(machine, hooks), sleep(timeoutMs).then(() => { throw new Error(`connect did not return within ${timeoutMs} ms (it must not wait for the tool)`); })]); } catch (e) { step("connect returns a session", false, words(e)); return finish(); }
        step("connect returns a session with status and stop", typeof session?.status === "function" && typeof session?.stop === "function", typeof session?.status === "function" ? `in ${Date.now() - started} ms` : "no status or stop");
        const up = await waitFor(0, (i) => i?.kind === "state" && i.communicating === true);
        if (!step("the link comes up and says so (state, communicating)", up.length, up[0]?.detail ?? `no state with communicating: true within ${timeoutMs} ms (${items.filter((i) => i?.kind === "state").map((i) => i.detail).join("; ") || "nothing emitted"})`)) return finish();
        step("every state says what, in words", items.filter((i) => i?.kind === "state").every((i) => typeof i.detail === "string" && i.detail.trim()), "");

        // ---- status: converted and named ----
        await tool.set("Temperature", 300);
        await tool.set("State", 2);
        await tool.set("Lot", "KIT-LOT-1");
        let status = null;
        let statusError = null;
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            try { status = await session.status(["Temperature", "State", "Lot"], {}); statusError = null; } catch (e) { statusError = e; }
            const v = status?.values;
            if (v && Math.abs(Number(v.Temperature) - 26.85) < 0.01 && v.State === "RUNNING" && v.Lot === "KIT-LOT-1") break;
            await sleep(50);
        }
        const v = status?.values ?? {};
        step("status: Temperature in degC (the tool reports 300 K)", Math.abs(Number(v.Temperature) - 26.85) < 0.01, statusError ? words(statusError) : `Temperature ${JSON.stringify(v.Temperature)}`);
        step("status: State by its name (the tool reports 2)", v.State === "RUNNING", `State ${JSON.stringify(v.State)}`);
        step("status: Lot as the tool has it", v.Lot === "KIT-LOT-1", `Lot ${JSON.stringify(v.Lot)}`);
        step("status: an ISO time (at)", typeof status?.at === "string" && !Number.isNaN(Date.parse(status.at)), `at ${JSON.stringify(status?.at)}`);
        step("status: no protocol term above the adapter (only the names asked)", Object.keys(v).every((k) => ["Temperature", "State", "Lot"].includes(k)), Object.keys(v).join(", "));

        // ---- events: in order, by the tool type's names, with distinct ids ----
        let mark = items.length;
        await tool.raise("Started", { Lot: "KIT-LOT-2" });
        await tool.raise("Ended", { Lot: "KIT-LOT-2" });
        const events = await waitFor(mark, (i) => i?.kind === "event" && !i.unknown, timeoutMs, 2);
        step("events: Started then Ended, in the order the tool sent them", events.length >= 2 && events[0].name === "Started" && events[1].name === "Ended", events.map((e) => e.name).join(", ") || "none emitted");
        step("events: each carries what its report does (Lot)", events.length >= 2 && events.slice(0, 2).every((e) => isPlain(e.values) && e.values.Lot === "KIT-LOT-2"), events.map((e) => JSON.stringify(e.values)).join(" "));
        step("events: each says the tool's code for it", events.slice(0, 2).every((e) => typeof e.code === "string" || typeof e.code === "number"), events.map((e) => JSON.stringify(e.code)).join(", "));
        const ids = events.slice(0, 2).map((e) => e.id).filter((x) => x !== undefined && x !== null);
        if (ids.length === 2) step("events: two occurrences, two ids", ids[0] !== ids[1], ids.join(", "));
        else skip("events: two occurrences, two ids", "the adapter gives no ids (allowed: the protocol may have none)");

        // ---- alarms ----
        mark = items.length;
        await tool.alarm(KIT_ALARM, true);
        const set = await waitFor(mark, (i) => i?.kind === "alarm" && i.set === true);
        step("an alarm set: emitted, by its name, set", set.length && set[0].name === KIT_ALARM, set.length ? `${set[0].name} (code ${set[0].code})` : "none emitted");
        mark = items.length;
        await tool.alarm(KIT_ALARM, false);
        const cleared = await waitFor(mark, (i) => i?.kind === "alarm" && i.set === false);
        step("the alarm cleared: emitted, not set", cleared.length && cleared[0].name === KIT_ALARM, cleared.length ? cleared[0].name : "none emitted");

        // ---- commands ----
        if (!a.serves.includes("command")) skip("commands", `${a.name} does not serve commands`);
        else if (typeof session.command !== "function") step("commands: the session has command", false, "serves command, and the session has no command()");
        else {
            const before = (await tool.commands()).length;
            let answer = null;
            try { answer = await session.command("START", { Lot: "KIT-LOT-3" }, {}); } catch (e) { answer = { error: words(e) }; }
            step("a command accepted (START)", answer?.accepted === true, answer?.error ?? JSON.stringify(answer));
            let got = await tool.commands();
            const last = got[got.length - 1];
            step("the tool received START with its parameter, by the kit's names", got.length === before + 1 && last?.name === "START" && last?.params?.Lot === "KIT-LOT-3", JSON.stringify(last ?? null));
            try { answer = await session.command("STOP", {}, {}); } catch (e) { answer = { error: words(e) }; }
            step("a command with no parameters accepted (STOP)", answer?.accepted === true, answer?.error ?? JSON.stringify(answer));
            await tool.refuse("START", "the chamber is busy");
            let refusal = null;
            try { await session.command("START", { Lot: "KIT-LOT-4" }, {}); } catch (e) { refusal = e; }
            step("a command the tool refuses throws, refused, with words", refusal?.refused === true && words(refusal).trim().length > 0, refusal ? `${refusal.refused === true ? "refused" : "not marked refused"}: ${words(refusal)}` : "it did not throw");
            const count = (await tool.commands()).length;
            let unknown = null;
            try { await session.command("FLY", {}, {}); } catch (e) { unknown = e; }
            got = await tool.commands();
            step("a command the mapping does not have throws, and nothing is sent", unknown !== null && got.length === count, unknown ? words(unknown) : "it did not throw");
        }

        // ---- the link dropped, and back by itself ----
        mark = items.length;
        await tool.drop();
        const down = await waitFor(mark, (i) => i?.kind === "state" && i.communicating === false, reconnectMs);
        step("the link lost: state, not communicating, in words", down.length, down[0]?.detail ?? "no state with communicating: false");
        let refusedDown = null;
        try { await session.status(["Temperature"], {}); } catch (e) { refusedDown = e; }
        step("a call while not communicating throws, saying why", refusedDown !== null && words(refusedDown).trim().length > 0, refusedDown ? words(refusedDown) : "status answered while the link was down");
        mark = items.length;
        await tool.restore();
        const back = await waitFor(mark, (i) => i?.kind === "state" && i.communicating === true, reconnectMs);
        step("the link back by itself: state, communicating", back.length, back[0]?.detail ?? `not within ${reconnectMs} ms`);
        let again = null;
        try { again = await session.status(["Lot"], {}); } catch (e) { again = { error: words(e) }; }
        step("status answers again", again?.values?.Lot !== undefined, again?.error ?? JSON.stringify(again?.values));

        // ---- a redelivery keeps its id ----
        if (typeof tool.replay !== "function") skip("the same occurrence delivered again keeps its id", "the fixture's tool cannot deliver an event again");
        else {
            mark = items.length;
            await tool.raise("Ended", { Lot: "KIT-LOT-5" });
            const first = await waitFor(mark, (i) => i?.kind === "event" && i.name === "Ended");
            await tool.replay();
            const both = await waitFor(mark, (i) => i?.kind === "event" && i.name === "Ended", timeoutMs, 2);
            step("the same occurrence delivered again keeps its id", both.length >= 2 && both[0].id !== undefined && both[0].id === both[1].id, both.map((e) => JSON.stringify(e.id)).join(", ") || (first.length ? "delivered once only" : "none emitted"));
        }

        // ---- nothing after stop ----
        await session.stop();
        session = null;
        mark = items.length;
        await tool.raise("Started", { Lot: "KIT-LOT-6" }).catch(() => {});
        await sleep(700);
        step("nothing emitted after stop()", items.length === mark, items.slice(mark).map((i) => i.kind).join(", ") || "nothing");
    } catch (e) {
        step("the kit ran to the end", false, e?.stack ?? words(e));
    } finally {
        await session?.stop?.().catch(() => {});
        await tool?.stop?.().catch(() => {});
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return finish();
}

// As a command: the fixture's path, and --json for a program to read.
// (Real paths: an npm package's command is a link to this file.)
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
    const file = process.argv.slice(2).find((x) => !x.startsWith("--"));
    if (!file) { console.error("node kit.mjs path/to/fixture.mjs [--json]"); process.exit(2); }
    const fixture = (await import(pathToFileURL(path.resolve(file)).href)).default;
    const json = process.argv.includes("--json");
    if (!json) console.log(`${CONTRACT.name}@${CONTRACT.version}: ${fixture?.adapter?.name ?? "(no adapter)"}`);
    const result = await runKit(fixture, { onStep: (s) => { if (!json) console.log(`  ${s.skipped ? "-" : s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `: ${s.detail}` : ""}`); } });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.ok ? "conforms" : `does not conform: ${result.steps.filter((s) => !s.ok).length} step(s) failed`);
    process.exit(result.ok ? 0 : 1);
}
