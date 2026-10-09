// Pop-ups and dialogs (§26.6, §26.7), end to end, against a server of its own:
//   1. The seed's machine_down pop-up: over Move in and Track in, for Production, while the machine the
//      page names is down. A machine of its own, a lot moved onto it: nothing pops up while it runs.
//   2. Olga marks it down: the pop-up holds for Move in (its machine input) and for Track in (the
//      machine its lot is on, derived), opened with that machine; not for Vera (not Production). A
//      page that is not a transaction:<name>, screen:<name> or * is refused.
//   3. Repaired by Sam (maintenance): it no longer holds.
//   4. A button that opens a screen as a dialog: Dana designs a board with one, through the lifecycle
//      (a button to a screen that does not exist, and a pop-up over one, are named); it is offered to
//      those who may open that screen, and not to Vera, who may not.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/popups.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["olga", "sam", "vera", "dana", "eli"]) {
        sessions[user] = `pu-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `pu-${randomBytes(8).toString("hex")}`;
    const popups = (user, target, values) => call(user, "popups.for", { target, values, as: user });
    const act = async (user, id, action) => {
        const m = await call(user, "records.get", { object: "machine", id, as: user });
        return call(user, "records.action", { object: "machine", id, action, rowVersion: m.row_version, key: key() });
    };

    // ---- 1. a machine of its own, a lot on it ----
    const press = (await call("sam", "records.create", { object: "machine", data: { machine_id: `PU-M-${tag}`, name: "Pop-up press", kind: "press", capacity: 1 }, key: key() })).id;
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const lot = (await call("sam", "records.create", { object: "lot", data: { lot_no: `PU-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 80, uom: "kg" }, key: key() })).id;
    const moved = await call("olga", "transactions.run", { name: "move_in", input: { lot, machine: press }, key: key() });
    const quiet = [await popups("olga", "transaction:move_in", { machine: press }), await popups("olga", "transaction:track_in", { lot })];
    step("while the machine runs, nothing pops up over Move in or Track in", moved.ok !== false && !moved.error && quiet.every((l) => Array.isArray(l) && l.length === 0), { moved, quiet });

    // ---- 2. down ----
    const m = await call("olga", "records.get", { object: "machine", id: press, as: "olga" });
    await call("olga", "records.update", { object: "machine", id: press, rowVersion: m.row_version, data: { down_reason: "Hydraulic leak" }, key: key() });
    const down = await act("olga", press, "break_down");
    const overMoveIn = await popups("olga", "transaction:move_in", { machine: press });
    step("Olga marks it down: Machine down pops up over Move in, opened with that machine", down.state === "down" && overMoveIn.length === 1 && overMoveIn[0].name === "machine_down" && overMoveIn[0].arg === press, { down: down.state ?? down, overMoveIn });
    const overTrackIn = await popups("olga", "transaction:track_in", { lot });
    step("…and over Track in, from the machine its lot is on (an input filled from the lot)", overTrackIn.length === 1 && overTrackIn[0].arg === press, overTrackIn);
    const shown = await call("olga", "screens.data", { name: "machine_down", arg: press, as: "olga" });
    step("…what it shows: the machine, down, and why", shown.blocks?.[0]?.record?.state === "down" && shown.blocks[0].record.down_reason === "Hydraulic leak", shown.blocks?.[0]);
    const notHers = await popups("vera", "transaction:move_in", { machine: press });
    step("not for Vera: it opens for Production only", Array.isArray(notHers) && notHers.length === 0, notHers);
    const odd = await popups("olga", "lot list", {});
    step("a page that is not transaction:<name>, screen:<name> or * is refused", odd.status === 400 && /transaction:<name>/.test(odd.error), odd);
    const refusedRun = await call("olga", "transactions.run", { name: "move_in", input: { lot, machine: press }, key: key() });
    step("it decides nothing: Move in's own check refuses a machine that is down", refusedRun.status >= 400 && /down/i.test(refusedRun.error ?? ""), refusedRun);

    // ---- 3. repaired ----
    const repaired = await act("sam", press, "repair");
    const after = await popups("olga", "transaction:move_in", { machine: press });
    step("repaired by Sam: it no longer holds", repaired.state === "idle" && after.length === 0, { repaired: repaired.state ?? repaired, after });

    // ---- 4. a button that opens a screen as a dialog ----
    const NAME = `press_board_t${tag}`;
    const { id } = await call("dana", "design.start", { screen: NAME, label: "Press board" });
    const base = (await call("dana", "design.change", { id, as: "dana" })).content.screens[NAME];
    const board = {
        ...base, params: { machine: { label: "Machine", type: "ref", to: "machine", required: true, widget: "scan" } },
        blocks: [{ block: "text", text: "The press.", width: 8 }, { block: "button", opens: "machine_down", label: "Why is it down?", with: { param: "machine" }, width: 4 }],
        callers: { users: ["vera"], groups: ["production"] }, stewards: ["production"],
    };
    const wrong = await call("dana", "design.save", { id, reason: "A board for the press.", screens: { [NAME]: { ...board, blocks: [...board.blocks, { block: "button", opens: "nowhere" }], popup: { on: ["transaction:nope"], for: { groups: ["production"] }, while: { eq: [1, 1] } } } } });
    const words = (wrong.problems ?? []).map((p) => p.message).join("\n");
    step("a button to a screen that does not exist, and a pop-up over a transaction that does not, are named", /"nowhere" is not a screen/.test(words) && /"nope" is not a transaction/.test(words), wrong.problems);
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const saved = await call("dana", "design.save", { id, seen: fresh.draft_rev, screens: { [NAME]: board } });
    const submitted = await call("dana", "design.submit", { id });
    await call("eli", "design.review", { id, decision: "pass" });
    const live = await call("sam", "design.approve", { id, department: "production", decision: "approve", meaning: "Approved" });
    step("designed, reviewed and approved", !saved.problems?.length && submitted.ok && live.state === "executed", { problems: saved.problems, submitted, live: live.state ?? live });
    const forOlga = await call("olga", "screens.data", { name: NAME, arg: press, as: "olga" });
    const forVera = await call("vera", "screens.data", { name: NAME, arg: press, as: "vera" });
    step("the button is offered to Olga, who may open Machine down, not to Vera, who may not", forOlga.blocks?.[1]?.canOpen === true && forOlga.blocks[1].label === "Machine down" && forVera.blocks?.[1]?.canOpen === false, { olga: forOlga.blocks?.[1], vera: forVera.blocks?.[1] });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
