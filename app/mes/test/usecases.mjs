// The use cases book (USECASES.md) against the designer's own checks, so what it shows designers is what
// the platform takes:
//   1. Every JSON example in it is JSON (a part of an element, `"fields": {…}`, read as inside braces).
//   2. Every whole element in it (an object, a transaction, a screen, a flow, a connection, a service, a
//      query, a report layout), with the scripts it shows, saved into one change on the seed's model, with
//      the fields and policies its parts add to Lot and Machine: the change names no problem.
// Nothing is submitted: the draft is checked as a designer's would be, then withdrawn.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/usecases.mjs   (after a reset)
import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const session = `uc-${randomBytes(8).toString("hex")}`;
await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'dana', now() + interval '1 hour')", [session]);
const call = async (name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${session}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status };
};

try {
    // ---- 1. every example is JSON ----
    const text = await readFile(new URL("../../../USECASES.md", import.meta.url), "utf8");
    const blocks = [];
    let heading = "";
    const fence = /^### (.+)$|^```(json|js)\n([\s\S]*?)^```$/gm;
    for (let m; (m = fence.exec(text));) {
        if (m[1]) heading = m[1];
        else blocks.push({ heading, lang: m[2], source: m[3] });
    }
    const parse = (s) => { for (const t of [s, `{${s}}`, `[${s}]`]) { try { return JSON.parse(t); } catch { /* the next reading */ } } return undefined; };
    const json = blocks.filter((b) => b.lang === "json").map((b) => ({ ...b, value: parse(b.source) }));
    const broken = json.filter((b) => b.value === undefined).map((b) => b.heading);
    step(`every JSON example is JSON (${json.length})`, json.length > 50 && !broken.length, broken);

    // ---- 2. the whole elements, saved into one change ----
    const kindOf = (v) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return null;
        if (typeof v.object === "string" && v.fields && v.states) return "definitions";
        if (["route", "plan", "input"].includes(v.kind) && v.nodes) return "flows";
        if (typeof v.name !== "string") return null;
        if (v.baseUrl) return "connections";
        if (v.runAs) return "services";
        if (typeof v.sql === "string") return "queries";
        if (v.guidance !== undefined) return "layouts";
        if (Array.isArray(v.steps)) return "transactions";
        if (Array.isArray(v.blocks)) return "screens";
        return null;
    };
    const content = { definitions: {}, transactions: {}, screens: {}, flows: {}, connections: {}, services: {}, queries: {}, layouts: {}, scripts: {} };
    const live = Object.fromEntries((await db.query("SELECT object, body FROM mes.definitions WHERE status = 'published'")).map((r) => [r.object, r.body]));
    let whole = 0;
    for (const b of json) {
        const kind = kindOf(b.value);
        if (!kind) continue;
        whole++;
        // The book's own Lot (use case 1) is a smaller one than the seed's: checked under a name of its own.
        const name = kind === "definitions" ? (live[b.value.object] ? `uc_${b.value.object}` : b.value.object) : b.value.name;
        content[kind][name] = kind === "definitions" ? { ...b.value, object: name } : b.value;
    }
    for (const b of blocks.filter((x) => x.lang === "js")) {
        const name = /export default (?:async )?function (\w+)/.exec(b.source)?.[1];
        if (name) content.scripts[name] = b.source.trim() + "\n";
    }
    // What the book's parts add (use cases 4, 33, 34, 43, 46, 48): Lot's hold fields, written through Hold and
    // Release; Machine's count, written through Track out, and the plan it sets off; the route's every step.
    const lot = live.lot;
    content.definitions.lot = {
        ...lot,
        fields: { ...lot.fields, hold_reason: { label: "Held because", type: "text" }, release_note: { label: "Released because", type: "text" }, hold_every_step: { label: "Hold after every step", type: "boolean" } },
        policies: [...lot.policies, { id: "lot-hold-notes", roles: ["operator", "supervisor", "quality"], via: ["hold_lot", "release_lot"], fields: { hold_reason: "write", release_note: "write" } }],
        // As use case 43 says it, whatever the suites before this one left (every-step's lot is a traveler only).
        roles: [...new Set([...lot.roles, "router"])],
        flow: { as: ["traveler", "reference"], step: "station" },
    };
    const machine = live.machine;
    content.definitions.machine = {
        ...machine,
        fields: { ...machine.fields, shots: { label: "Shots since PM", type: "integer" }, pm_every: { label: "PM every (shots)", type: "integer" } },
        policies: [...machine.policies, { id: "machine-count", roles: ["operator"], via: ["track_out"], fields: { shots: "write" } }],
        flow: { as: ["resource", "subject", "reference"] },
    };
    const route = content.flows.molding_route;
    content.flows.molding_route = { ...route, everySequence: { onExit: { run: "apply_future_holds" } }, roles: { ...route.roles, future_hold: ["router"] } };
    // Hold if asked (use case 46) runs on a route of its own: one transaction per every-step rule.
    content.flows.engineering_route = { ...route, name: "engineering_route", label: "Engineering route", everySequence: { onExit: { run: "hold_if_asked" } } };
    content.transactions.hold_if_asked = { ...content.transactions.hold_if_asked, callers: { users: [], groups: [], flows: ["engineering_route"] } };
    // Use cases 28, 29 and 32 show parts of one transaction (its readings, a deviation when one is out, who
    // may run it): put together, as a designer would, on the step of the route that gives the limits.
    const part = (n) => json.filter((b) => b.heading.startsWith(`${n}.`)).map((b) => b.value);
    const [readings, limits] = part(28), [reacts] = part(29), [certified] = part(32);
    content.transactions.measure = {
        name: "measure", label: "Measure", inputs: readings.inputs, require: [...readings.require, ...certified.require], steps: reacts.steps,
        appearsOn: { object: "lot", states: ["processing"], fills: "lot" }, callers: { users: [], groups: ["production"] }, stewards: ["production"],
    };
    content.flows.molding_route.nodes = { ...content.flows.molding_route.nodes, ...limits };
    content.flows.molding_route.edges = [...content.flows.molding_route.edges.filter((e) => e.to !== "done"), { from: "molding", to: "measure_ox" }, { from: "measure_ox", to: "done" }];
    const counts = Object.fromEntries(Object.entries(content).map(([k, v]) => [k, Object.keys(v).length]));
    step("the book's whole elements are found: objects, transactions, screens, flows, a connection, services, queries, a layout and their scripts",
        whole >= 20 && counts.transactions >= 6 && counts.screens >= 5 && counts.flows >= 5 && counts.connections === 1 && counts.services >= 2 && counts.queries >= 3 && counts.layouts === 1, counts);

    const { id } = await call("design.start", { flow: "molding_route", label: "The use cases" });
    const fresh = await call("design.change", { id, as: "dana" });
    const saved = await call("design.save", { id, seen: fresh.draft_rev, reason: "The use cases book, checked.", ...content });
    step("…and saved into one change, the designer names no problem in any of them", saved.problems && !saved.problems.length, saved.error ?? saved.problems?.map((p) => p.message));
    // Left as found: the draft withdrawn, so the suites after it may change what it held (the lot, the machine).
    await call("design.withdraw", { id, reason: "Checked." });
} catch (error) {
    step("the test ran to the end", false, { error: error.message, stack: error.stack });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail, null, 1)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
