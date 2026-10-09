// Transactions (§25), end to end, against a running server. Everything here is a definition: the
// machine object, the lot's machine states, and the four transactions come from the seed (standing
// in for approved changes), and step 8 designs a fifth through the change lifecycle.
//   1. Who may run what: Olga (production) sees the four; Vera sees none and is refused.
//   2. The lot's machine transitions are not on its form: records.action is refused, in words that
//      name the transaction, and "why?" offers it.
//   3. Move in, previewed (nothing written), then run: the lot and the machine change as one, audited
//      as one run; the same key answers the same result.
//   4. Refusals, each writing nothing: the machine full (capacity 1), the machine down, a lot not on
//      a machine, good + scrap not the lot's quantity, a scrap without its reason, and a step the
//      lot's own rule pipe refuses (the quantity 0) after an earlier step was planned.
//   5. Two operators move two lots into the same one-lot press at once: exactly one gets it.
//   6. Track in, track out, move out: the press runs, stops and is idle again.
//   7. The oven (capacity 4): two lots; it starts once, stops only when the last is tracked out,
//      and is idle only when the last is moved out.
//   8. Dana designs "Start" (move in and track in at once) for a plant that works that way: a
//      change holding the transaction and the two objects' via policies, routed to their stewards,
//      reviewed, approved, executed; Olga runs it.
//   9. An AI, over the REST API as Dana: reads the contract's transactions, drafts one, is told
//      what is wrong with it, and fixes it.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/transactions.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { createTokens } from "../server/ai-api.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["olga", "sam", "vera", "dana", "eli", "quinn"]) {
    sessions[user] = `tx-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const attempt = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, status: error.status, message: error.message, fields: error.body?.fields }));
const key = () => `tx-${randomBytes(8).toString("hex")}`;
const rec = async (object, id) => (await db.query("SELECT state, data, row_version FROM mes.records WHERE object = $1 AND id = $2", [object, id]))[0];
const byTitle = async (object, field, value) => (await db.query(`SELECT id FROM mes.records WHERE object = $1 AND data->>$2 = $3`, [object, field, value]))[0]?.id;

const created = [];
const tokens_revoke = (id) => db.query("UPDATE mes.api_tokens SET revoked_at = now() WHERE id = $1", [id]);
try {
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const newLot = async (no, qty = 100) => {
        const lot = await call("sam", "records.create", { object: "lot", data: { lot_no: `${no}-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty, uom: "kg" }, key: key() });
        created.push(lot.id);
        return lot.id;
    };
    const press1 = await byTitle("machine", "machine_id", "M-101");
    const press2 = await byTitle("machine", "machine_id", "M-102");
    const oven = await byTitle("machine", "machine_id", "OV-1");
    const lotA = await newLot("TA", 400);

    // ---- 1. callers ----
    const olgaList = await call("olga", "transactions.list", { as: "olga" });
    step("an operator sees the four transactions", ["move_in", "move_out", "track_in", "track_out"].every((n) => olgaList.some((t) => t.name === n)), olgaList);
    step("each says where it appears (move in: on a lot while created or in process)", olgaList.find((t) => t.name === "move_in")?.appearsOn?.states?.includes("created"));
    const veraList = await call("vera", "transactions.list", { as: "vera" });
    step("a viewer sees none", veraList.length === 0, veraList);
    const veraRun = await attempt(call("vera", "transactions.run", { name: "move_in", input: { lot: lotA, machine: press1 }, key: key() }));
    step("…and is refused, deny by default", !veraRun.ok && veraRun.status === 403 && /may not run Move in/.test(veraRun.message), veraRun);

    // ---- 2. not on the lot's form ----
    const lotRow = await call("olga", "records.get", { object: "lot", id: lotA, as: "olga" });
    step("the lot's form does not offer Move in", !lotRow.$perm.actions.includes("move_in") && lotRow.$perm.why["action:move_in"] === "transaction", lotRow.$perm.why);
    const direct = await attempt(call("olga", "records.action", { object: "lot", id: lotA, action: "move_in", rowVersion: lotRow.row_version, key: key() }));
    step("taking the transition directly is refused, naming the transaction", !direct.ok && direct.status === 403 && /Move in is done through the Move in transaction: start it from there\./.test(direct.message), direct);
    const why = await call("olga", "access.explain", { object: "lot", id: lotA, action: "move_in" });
    step("\"why?\" offers the transaction", why.decision === "deny" && why.remedies.some((r) => r.kind === "transaction" && r.transactions.includes("move_in")), why);

    // ---- 3. move in ----
    const before = await rec("lot", lotA);
    const preview = await call("olga", "transactions.preview", { name: "move_in", input: { lot: lotA, machine: press1 } });
    const pl = preview.changes.find((c) => c.id === lotA);
    const pm = preview.changes.find((c) => c.id === press1);
    step("the preview shows both records: the lot to at_machine with its machine, the press loaded", pl?.state?.to === "at_machine" && pl.fields.machine?.to === "M-101" && pm?.state?.from === "idle" && pm.state.to === "loaded", preview);
    step("…and writes nothing", (await rec("lot", lotA)).row_version === before.row_version && (await rec("machine", press1)).state === "idle");
    const k1 = key();
    const run1 = await call("olga", "transactions.run", { name: "move_in", input: { lot: lotA, machine: press1 }, key: k1 });
    const afterLot = await rec("lot", lotA);
    step("run: the lot is at the machine, assigned to it", afterLot.state === "at_machine" && afterLot.data.machine === press1, afterLot);
    step("run: the press is loaded", (await rec("machine", press1)).state === "loaded");
    const audit = await db.query("SELECT object, action, on_behalf_of FROM mes.audit_log WHERE on_behalf_of = $1 OR (object = '$transaction' AND record_id = $2) ORDER BY seq", [`transaction:move_in:${run1.run}`, run1.run]);
    step("audited as one run: the lot's update and transition, the press's, and the run", audit.map((a) => `${a.object} ${a.action}`).join(", ") === "lot update, lot transition:move_in, machine transition:load, $transaction run:move_in", audit);
    const again = await call("olga", "transactions.run", { name: "move_in", input: { lot: lotA, machine: press1 }, key: k1 });
    step("the same key answers the same result, and nothing runs twice", again.run === run1.run && (await rec("lot", lotA)).row_version === afterLot.row_version);

    // ---- 4. refusals ----
    const lotB = await newLot("TB", 200);
    const snapshot = async () => JSON.stringify([await rec("lot", lotB), await rec("machine", press1), await rec("machine", press2)]);
    const s0 = await snapshot();
    const full = await attempt(call("olga", "transactions.run", { name: "move_in", input: { lot: lotB, machine: press1 }, key: key() }));
    step("the press is full: refused on the machine input", !full.ok && full.status === 422 && full.message === "The machine is full." && full.fields?.machine, full);
    const [rejected] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$transaction' AND action = 'rejected:move_in' ORDER BY seq DESC LIMIT 1");
    step("…and the refusal is audited", rejected?.after?.refusal?.message === "The machine is full.", rejected);
    await db.query("UPDATE mes.records SET state = 'down', data = data || '{\"down_reason\":\"test\"}' WHERE id = $1", [press2]);
    const down = await attempt(call("olga", "transactions.run", { name: "move_in", input: { lot: lotB, machine: press2 }, key: key() }));
    step("the machine is down: refused", !down.ok && down.message === "The machine is down.", down);
    await db.query("UPDATE mes.records SET state = 'idle', data = data - 'down_reason' WHERE id = $1", [press2]);
    const notOn = await attempt(call("olga", "transactions.run", { name: "track_in", input: { lot: lotB }, key: key() }));
    step("track in of a lot on no machine: the derived machine input says so", !notOn.ok && /has no machine/.test(notOn.fields?.machine ?? ""), notOn);
    step("none of that wrote anything", (await snapshot()) === s0);

    // ---- 5. two operators, one slot ----
    const lotC = await newLot("TC", 50);
    const [r1, r2] = await Promise.all([
        attempt(call("olga", "transactions.run", { name: "move_in", input: { lot: lotB, machine: press2 }, key: key() })),
        attempt(call("sam", "transactions.run", { name: "move_in", input: { lot: lotC, machine: press2 }, key: key() })),
    ]);
    const onPress2 = (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'lot' AND data->>'machine' = $1", [press2]))[0].n;
    step("two at once into a one-lot press: exactly one gets it", [r1, r2].filter((r) => r.ok).length === 1 && onPress2 === 1, { r1, r2, onPress2 });
    const loser = [r1, r2].find((r) => !r.ok);
    step("…the other is told why", loser && (/full/.test(loser.message) || loser.status === 409), loser);

    // ---- 6. track in, out, move out (press 1) ----
    await call("olga", "transactions.run", { name: "track_in", input: { lot: lotA }, key: key() });
    step("track in: the lot processing, the press running", (await rec("lot", lotA)).state === "processing" && (await rec("machine", press1)).state === "running");
    const s1 = JSON.stringify([await rec("lot", lotA), await rec("machine", press1)]);
    const sum = await attempt(call("olga", "transactions.run", { name: "track_out", input: { lot: lotA, good_qty: 380, scrap_qty: 10, scrap_reason: "setup" }, key: key() }));
    step("good + scrap must be the lot's quantity", !sum.ok && sum.fields?.good_qty === "Good and scrap together must be the lot's quantity.", sum);
    const reason = await attempt(call("olga", "transactions.run", { name: "track_out", input: { lot: lotA, good_qty: 390, scrap_qty: 10 }, key: key() }));
    step("a scrap needs its reason (required when)", !reason.ok && reason.fields?.scrap_reason, reason);
    const zero = await attempt(call("olga", "transactions.run", { name: "track_out", input: { lot: lotA, good_qty: 0, scrap_qty: 400, scrap_reason: "surface" }, key: key() }));
    step("a step the lot's rule pipe refuses (quantity 0): refused on the input it came from, naming the lot", !zero.ok && /^Lot TA-\d+: The quantity must be more than zero\./.test(zero.message) && zero.fields?.good_qty, zero);
    step("none of those wrote anything", JSON.stringify([await rec("lot", lotA), await rec("machine", press1)]) === s1);
    const out = await call("olga", "transactions.run", { name: "track_out", input: { lot: lotA, good_qty: 390, scrap_qty: 10, scrap_reason: "setup" }, key: key() });
    const outLot = await rec("lot", lotA);
    step("track out: good and scrap recorded, the lot processed, the press stopped", outLot.state === "processed" && outLot.data.qty === 390 && outLot.data.scrap_qty === 10 && outLot.data.scrap_reason === "setup" && (await rec("machine", press1)).state === "loaded", { outLot, out });
    await call("olga", "transactions.run", { name: "move_out", input: { lot: lotA }, key: key() });
    const offLot = await rec("lot", lotA);
    step("move out: the lot off the machine and waiting, the press idle", offLot.state === "in_process" && !offLot.data.machine && (await rec("machine", press1)).state === "idle", offLot);
    const stays = await db.query("SELECT state, left_at IS NOT NULL AS closed FROM mes.state_intervals WHERE object = 'lot' AND record_id = $1 ORDER BY entered_at", [lotA]);
    step("analytics: each step is a stay (queue, process, waiting to unload)", ["created", "at_machine", "processing", "processed", "in_process"].every((s, i) => stays[i]?.state === s), stays);

    // ---- 7. the oven ----
    const o1 = await newLot("TO1", 100);
    const o2 = await newLot("TO2", 100);
    for (const l of [o1, o2]) await call("olga", "transactions.run", { name: "move_in", input: { lot: l, machine: oven }, key: key() });
    step("oven: two lots in, loaded once", (await rec("machine", oven)).state === "loaded");
    for (const l of [o1, o2]) await call("olga", "transactions.run", { name: "track_in", input: { lot: l }, key: key() });
    step("oven: both tracked in, it runs", (await rec("machine", oven)).state === "running");
    await call("olga", "transactions.run", { name: "track_out", input: { lot: o1, good_qty: 100 }, key: key() });
    step("oven: one tracked out, still running (the other is in it)", (await rec("machine", oven)).state === "running");
    await call("olga", "transactions.run", { name: "track_out", input: { lot: o2, good_qty: 100 }, key: key() });
    step("oven: the last tracked out, it stops", (await rec("machine", oven)).state === "loaded");
    await call("olga", "transactions.run", { name: "move_out", input: { lot: o1 }, key: key() });
    step("oven: one moved out, still loaded", (await rec("machine", oven)).state === "loaded");
    await call("olga", "transactions.run", { name: "move_out", input: { lot: o2 }, key: key() });
    step("oven: the last moved out, idle", (await rec("machine", oven)).state === "idle");

    // ---- 8. a plant that moves in and tracks in at once ----
    const START = `start_t${tag}`;
    const { id } = await call("dana", "design.start", { transaction: START, label: "Start" });
    const change = await call("dana", "design.change", { id, as: "dana" });
    const lotDef = (await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'"))[0].body;
    const machineDef = (await db.query("SELECT body FROM mes.definitions WHERE object = 'machine' AND status = 'published'"))[0].body;
    const via = (def, policy) => ({ ...def, policies: def.policies.map((p) => (p.id === policy ? { ...p, via: [...p.via, START] } : p)) });
    const start = {
        ...change.content.transactions[START],
        description: "Put a lot on a machine and start it, in one go.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, machine: { label: "Machine", type: "ref", to: "machine", required: true } },
        form: { sections: [{ label: "Start", fields: [{ field: "lot", widget: "scan", width: 6 }, { field: "machine", widget: "scan", width: 6 }] }] },
        appearsOn: { object: "lot", states: ["created", "in_process"], fills: "lot" },
        require: [{ that: { eq: [{ lookup: "machine.state" }, "idle"] }, message: "Start needs an idle machine.", field: "machine" }],
        steps: [
            { on: "lot", set: { machine: { input: "machine" } }, action: "move_in" },
            { on: "lot", action: "track_in" },
            { on: "machine", action: "load" },
            { on: "machine", action: "start" },
        ],
        callers: { users: [], groups: ["production"] },
        stewards: ["production"],
        // Its evidence (§5.11): a lot it is given, on a press it is given, under the real WO-1002.
        scenarios: [{
            name: "a lot moved in and started on an idle press, in one run",
            records: {
                wo: { object: "work_order", where: { wo_no: ["WO-1002"] } },
                lot: { object: "lot", data: { lot_no: `SC-${tag}`, item: "PP-BLK-10", work_order: "@wo", qty: 50, uom: "kg" } },
                press: { object: "machine", data: { machine_id: `SC-M-${tag}`, name: "Scenario press", kind: "press", capacity: 1 } },
            },
            steps: [{ as: "olga", do: { transaction: START, input: { lot: "@lot", machine: "@press" } }, expect: { ok: true, states: { lot: "processing", press: "running" } } }],
        }],
    };
    const bad = await call("dana", "design.save", { id, reason: "Line 3 moves in and tracks in at once.", transactions: { [START]: { ...start, steps: [{ on: "lot", action: "fly" }] } } });
    step("the designer's mistakes are named: an action the lot does not have", bad.problems.some((p) => /lot has no action "fly"/.test(p.message)), bad.problems);
    const saved = await call("dana", "design.save", { id, reason: "Line 3 moves in and tracks in at once.", transactions: { [START]: start }, definitions: { lot: via(lotDef, "lot-machine-moves"), machine: via(machineDef, "machine-lot-moves") } });
    step("the transaction and the two objects' via policies, drafted together: no problems", saved.problems.length === 0, saved.problems);
    await call("dana", "design.submit", { id });
    const submitted = await call("dana", "design.change", { id, as: "dana" });
    const route = submitted.route.map((r) => r.department).sort().join(",");
    step("routed to the stewards of what it writes: production (and quality, the lot's)", route === "production,quality", submitted.route);
    await call("eli", "design.review", { id, decision: "pass" });
    await call("sam", "design.approve", { id, department: "production", decision: "approve", meaning: "Approved" });
    const done = await call("quinn", "design.approve", { id, department: "quality", decision: "approve", meaning: "Approved" });
    step("approved and executed by the platform", done.state === "executed", done);
    const listed = await call("olga", "transactions.list", { as: "olga" });
    step("live at once: Olga has Start", listed.some((t) => t.name === START));
    const lotS = await newLot("TS", 60);
    await call("olga", "transactions.run", { name: START, input: { lot: lotS, machine: press1 }, key: key() });
    step("Start: the lot processing on the press, the press running, in one run", (await rec("lot", lotS)).state === "processing" && (await rec("machine", press1)).state === "running");
    const busy = await attempt(call("olga", "transactions.run", { name: START, input: { lot: lotC, machine: press1 }, key: key() }));
    step("…and its own check refuses a busy machine", !busy.ok && busy.message === "Start needs an idle machine.", busy);

    // ---- 9. an AI drafts one ----
    const issued = await createTokens(db).issue("dana", { name: "transactions test", agent: "test agent" });
    const ai = async (method, path, body) => {
        const res = await fetch(`${mes}/ai/v1${path}`, { method, headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", "x-ai-agent": "test agent" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    const contract = await ai("GET", "/contract");
    step("the AI reads how a transaction is drawn", /steps/.test(contract.body.transactions?.shape ?? "") && /via/.test(contract.body.policies.rule), contract.body.transactions);
    const HOLD = `hold_at_machine_t${tag}`;
    const aiChange = await ai("POST", "/changes", { transaction: HOLD, label: "Hold at the machine" });
    const draft = { name: HOLD, label: "Hold at the machine", inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true } }, steps: [{ on: "lot", action: "hold", set: { colour: "red" } }], callers: { groups: ["production"] }, stewards: ["production"] };
    const first = await ai("PUT", `/changes/${aiChange.body.id}`, { reason: "Hold a lot where it stands.", transactions: { [HOLD]: draft } });
    step("…is told what is wrong (lot has no field colour)", first.body.problems?.some((p) => /lot has no field "colour"/.test(p.message)), first.body);
    const fixed = await ai("PUT", `/changes/${aiChange.body.id}`, { transactions: { [HOLD]: { ...draft, steps: [{ on: "lot", action: "hold" }] } } });
    const aiRow = await call("dana", "design.change", { id: aiChange.body.id, as: "dana" });
    step("…fixes it; the change records that an AI drafted it", fixed.body.problems?.length === 0 && aiRow.aiEdits.some((e) => e.elements.includes(`transaction: ${HOLD}`)), { fixed: fixed.body, aiEdits: aiRow.aiEdits });
    await call("dana", "design.withdraw", { id: aiChange.body.id });
    await tokens_revoke(issued.id);
} catch (error) {
    step("the test ran to the end", false, { error: error.message, body: error.body });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
