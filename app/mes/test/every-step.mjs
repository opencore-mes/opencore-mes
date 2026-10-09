// Records a step finds (§25.1) and what a route does at every step (§32.15), end to end on the seed's lots:
//   1. Dana designs, with nothing named in the platform: an object of the plant's own (a hold set for later:
//      which lot, at which step, why; active until used or cancelled), a transaction that finds those set for
//      the lot at the step it is leaving, uses each, and holds the lot with the reason of the first, and a route
//      that runs it as the traveler leaves every step. Their mistakes are named.
//   2. Approved and executed.
//   3. A lot with a hold set for its first step: leaving that step, the route runs the transaction as itself;
//      the lot is held with the reason given, the hold used, one set for a later step left as it was; the run
//      audited as the route. A lot with none set goes on, not held.
//   4. Someone not named among its callers, and a route not named there, may not run it.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/every-step.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "vera", "eli", "sam", "olga", "quinn", "ivan", "ines"]) {
    sessions[user] = `es-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
};
const key = () => `es-${randomBytes(8).toString("hex")}`;
const approveAll = async (id) => {
    let state = null;
    for (let round = 0; round < 5 && state !== "executed"; round++) for (const u of Object.keys(sessions)) {
        const seen = await call(u, "design.change", { id, as: u });
        for (const department of seen?.can?.approveFor ?? []) state = (await call(u, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    return state;
};

try {
    // ---- 1. the design: an object, a transaction and a route, all the plant's own ----
    const ITEM = `ES-${tag}`;
    const HOLDS = `later_hold_t${tag}`;      // the plant's own object: a hold set for later
    const APPLY = `apply_holds_t${tag}`;     // the transaction the route runs at every step
    const INSPECT = `es_inspect_t${tag}`;
    const ROUTE = `es_route_t${tag}`;
    // The step the holds are set for has a long name, as a plant's do (final_inspection): the route's request for
    // its every-step transaction must still be one the record services take (a key of at most 100 characters).
    const LONG = "inspect_the_lot_before_it_goes_on_to_the_press";
    const [lotDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const lot = {
        ...lotDef.body,
        fields: { ...lotDef.body.fields, hold_note: { label: "Held because", type: "string" } },
        roles: [...new Set([...lotDef.body.roles, "router"])],
        policies: [...lotDef.body.policies.filter((x) => x.id !== "es-router"), { id: "es-router", roles: ["router"], record: { read: true }, fields: { station: "write", hold_note: "write", "*": "read" }, actions: { hold: "allow" } }],
        flow: { as: ["traveler"], step: "station" },
    };
    const holds = {
        object: HOLDS, label: "Hold later", area: "Quality", titleField: "reason",
        fields: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, at: { label: "At step", type: "string", required: true }, reason: { label: "Why", type: "string", required: true } },
        states: { initial: "active", list: ["active", "used", "cancelled"], transitions: [{ action: "use", label: "Use", from: ["active"], to: "used" }, { action: "cancel", label: "Cancel", from: ["active"], to: "cancelled" }] },
        roles: ["setter", "router"], stewards: { object: ["quality"] },
        policies: [
            { id: "set", roles: ["setter"], record: { read: true, create: true }, fields: { "*": "write" }, actions: { cancel: "allow" } },
            { id: "route", roles: ["router"], record: { read: true }, fields: { "*": "read" }, actions: { use: "allow" } },
        ],
        list: { columns: ["lot", "at", "reason"] },
    };
    const apply = {
        name: APPLY, label: "Apply holds set for this step", description: "The holds set for the lot at the step it leaves: used, and the lot held.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true } },
        appearsOn: { object: "lot", fills: "lot" },
        require: [],
        steps: [
            { find: { object: HOLDS, where: { lot: { input: "lot" }, at: { lookup: "lot.station" }, state: ["active"] } }, as: "set_for_here", action: "use" },
            { on: "lot", when: { gt: [{ found: "set_for_here.count" }, 0] }, set: { hold_note: { found: "set_for_here.first.reason" } }, action: "hold" },
        ],
        confirm: false, callers: { flows: [ROUTE] }, stewards: ["quality"],
    };
    const inspect = {
        name: INSPECT, label: "Inspect", description: "The lot is looked at, and started.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true } },
        appearsOn: { object: "lot", states: ["created"], fills: "lot" },
        require: [], steps: [{ on: "lot", action: "start" }],
        confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [{ name: "a new lot started", records: { wo: { object: "work_order", where: { wo_no: ["WO-1002"] } }, lot: { object: "lot", data: { lot_no: `ESI-${tag}`, item: "PP-BLK-10", work_order: "@wo", qty: 10, uom: "kg" } } }, steps: [{ as: "olga", do: { transaction: INSPECT, input: { lot: "@lot" } }, expect: { ok: true } }] }],
    };
    const route = {
        name: ROUTE, label: "Two steps", description: "Inspect, then press; holds set for a step are applied as the lot leaves it.", kind: "route",
        participants: { lot: { object: "lot", as: "traveler" } },
        nodes: {
            start: { kind: "start", label: "Start", when: { eq: [{ context: "lot.item" }, ITEM] } },
            [LONG]: { kind: "sequence", label: "Inspect", offers: [INSPECT], leaves: [INSPECT] },
            press: { kind: "sequence", label: "Press", offers: ["move_in"], leaves: ["move_in"] },
            done: { kind: "end", label: "Done", outcome: "done" },
        },
        edges: [{ from: "start", to: LONG }, { from: LONG, to: "press" }, { from: "press", to: "done" }],
        layout: { start: { x: 40, y: 60 }, [LONG]: { x: 220, y: 60 }, press: { x: 400, y: 60 }, done: { x: 580, y: 60 } },
        everySequence: { onExit: { run: APPLY } },
        roles: { lot: ["router"], [HOLDS]: ["router"], work_order: ["viewer"] }, stewards: ["production"],
        scenarios: [{ name: "Inspect takes a lot on to Press", records: { wo: { object: "work_order", where: { wo_no: ["WO-1002"] } }, lot: { object: "lot", data: { lot_no: `ESC-${tag}`, item: ITEM, work_order: "@wo", qty: 10, uom: "kg", station: LONG } } }, steps: [{ as: "olga", do: { transaction: INSPECT, input: { lot: "@lot" } }, expect: { ok: true, node: { lot: "press" } } }] }],
    };
    const wrong = await call("dana", "design.check", {
        definitions: { lot, [HOLDS]: holds },
        transactions: {
            [APPLY]: { ...apply, callers: { users: ["olga"] }, steps: [{ on: "lot", when: { gt: [{ found: "set_for_here.count" }, 0] }, action: "hold" }, { find: { object: HOLDS, where: { colour: "red" } }, as: "x" }] },
            [INSPECT]: inspect,
        },
        flows: { [ROUTE]: route },
    });
    const words = (wrong.problems ?? []).map((p) => p.message).join("\n");
    step("its mistakes are named: what a step found read before any step finds it, a field it cannot find by, a route's every-step transaction that does not name the route among its callers",
        /no step before it finds records as "set_for_here"/.test(words) && /has no field "colour" to find by/.test(words) && /does not name this route among its callers/.test(words), words);

    // ---- 2. approved, executed ----
    const { id } = await call("dana", "design.start", { flow: ROUTE, label: "Two steps" });
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const saved = await call("dana", "design.save", { id, seen: fresh.draft_rev, reason: "Holds engineers set for a step are applied as a lot leaves it.", definitions: { lot, [HOLDS]: holds }, transactions: { [APPLY]: apply, [INSPECT]: inspect }, flows: { [ROUTE]: route } });
    const submitted = await call("dana", "design.submit", { id });
    await call("vera", "design.review", { id, decision: "pass" });
    const state = await approveAll(id);
    const fit = submitted.error ? (await call("dana", "design.change", { id, as: "dana" })).fitness : null;
    step("the object, the transaction (a step that finds records) and the route (a transaction at every step) are approved and executed", !saved.problems?.length && state === "executed", { problems: saved.problems, state, submitted: submitted.error, fit: JSON.stringify(fit)?.slice(0, 1500) });
    // Who sets holds: Olga, given the setter role (People & departments).
    const orgChange = await call("dana", "design.start", { organization: true });
    const org = (await call("dana", "design.change", { id: orgChange.id, as: "dana" })).content.organization;
    org.roles = { ...(org.roles ?? {}), [HOLDS]: { setter: ["user:olga", "user:eli"] } };
    await call("dana", "design.save", { id: orgChange.id, reason: "Who sets holds for later.", organization: org });
    await call("dana", "design.submit", { id: orgChange.id });
    await call("vera", "design.review", { id: orgChange.id, decision: "pass" });
    await approveAll(orgChange.id);

    // ---- 3. a lot leaving the step a hold is set for is held, as the route ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const lotA = await call("sam", "records.create", { object: "lot", data: { lot_no: `ESA-${tag}`, item: ITEM, work_order: wo.id, qty: 10, uom: "kg" }, key: key() });
    const lotB = await call("sam", "records.create", { object: "lot", data: { lot_no: `ESB-${tag}`, item: ITEM, work_order: wo.id, qty: 10, uom: "kg" }, key: key() });
    const here = await call("olga", "records.create", { object: HOLDS, data: { lot: lotA.id, at: LONG, reason: "Particle check before press" }, key: key() });
    const later = await call("olga", "records.create", { object: HOLDS, data: { lot: lotA.id, at: "press", reason: "Look at it after press" }, key: key() });
    if (!lotA.id || !lotB.id || !here.id || !later.id) throw new Error(`made: ${JSON.stringify({ lotA, lotB, here, later })}`);
    const [atFirst] = await db.query("SELECT data->>'station' AS station FROM mes.records WHERE id = $1", [lotA.id]);
    const ran = await call("olga", "transactions.run", { name: INSPECT, input: { lot: lotA.id }, key: key() });
    const rec = async (rid) => (await db.query("SELECT state, data FROM mes.records WHERE id = $1", [rid]))[0];
    const [a, h1, h2] = [await rec(lotA.id), await rec(here.id), await rec(later.id)];
    const [audit] = await db.query("SELECT actor, after FROM mes.audit_log WHERE action = $1 ORDER BY seq DESC LIMIT 1", [`run:${APPLY}`]);
    step("leaving Inspect, the route runs the transaction as itself: the hold set for Inspect is used, the lot held with its reason, the one set for Press left active",
        atFirst?.station === LONG && ran.ok && a.state === "on_hold" && a.data.hold_note === "Particle check before press" && h1.state === "used" && h2.state === "active",
        { atFirst, ran: ran.error ?? ran.ok, lot: { state: a.state, note: a.data.hold_note, station: a.data.station }, h1: h1.state, h2: h2.state });
    step("…its run audited as the route, with the records it changed", audit?.actor === `flow:${ROUTE}` && (audit.after.records ?? []).some((r) => r.id === lotA.id) && (audit.after.records ?? []).some((r) => r.id === here.id), audit);
    await call("olga", "transactions.run", { name: INSPECT, input: { lot: lotB.id }, key: key() });
    const b = await rec(lotB.id);
    step("a lot with no hold set for the step goes on, not held", b.state === "in_process" && b.data.station === "press", { state: b.state, station: b.data.station });

    // ---- 4. only those its callers name run it ----
    const notHers = await call("olga", "transactions.run", { name: APPLY, input: { lot: lotB.id }, key: key() });
    step("someone its callers do not name may not run it (a route named there may)", notHers.status === 403, notHers);
} catch (error) {
    step("the test ran to the end", false, { error: error.message, stack: error.stack?.split("\n").slice(0, 3) });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
