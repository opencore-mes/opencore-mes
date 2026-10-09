// What a transaction's run locks (§25.1): the records a step writes, to be written; a record it only reads
// (a shift, a work order: what every move of a plant may name), only kept from changing until it commits, so
// runs that read the same record do not wait on each other, and one that would change it waits for them.
//   1. Dana designs a transaction that writes a lot and only reads its work order (a check on the order's state).
//   2. Approved and executed.
//   3. While another transaction holds the work order the way a reading run does (FOR SHARE), the run goes
//      through at once: it reads the order, its check holds, the lot is written.
//   4. While another transaction is changing the work order (FOR UPDATE), the run waits for it.
//   5. Its check still reads the order as it is: an order closed meanwhile refuses the run.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/transaction-locks.mjs   (after a reset)
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
    sessions[user] = `tl-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status, code: body.code };
};
const approveAll = async (id) => {
    let state = null;
    for (let round = 0; round < 5 && state !== "executed"; round++) for (const u of Object.keys(sessions)) {
        const seen = await call(u, "design.change", { id, as: u });
        for (const department of seen?.can?.approveFor ?? []) state = (await call(u, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    return state;
};
// Another connection holding a record the way a run of its own would, until let go.
const holding = async (id, how) => {
    const c = await pool.connect();
    await c.query("BEGIN");
    await c.query(`SELECT 1 FROM mes.records WHERE id = $1 ${how}`, [id]);
    return { release: async () => { await c.query("COMMIT"); c.release(); } };
};
const within = (p, ms) => Promise.race([p.then((v) => ({ done: true, v })), new Promise((r) => setTimeout(() => r({ done: false }), ms))]);

try {
    // ---- 1–2. a transaction that writes the lot and reads its work order ----
    const NAME = `note_lot_t${tag}`;
    const tx = {
        name: NAME, label: "Note a lot", description: "Puts the lot in process, once its work order is released.",
        inputs: { lot: { label: "Lot", type: "ref", to: "lot", required: true }, order: { label: "Work order", type: "ref", to: "work_order", required: true, from: "lot.work_order" } },
        appearsOn: { object: "lot", states: ["created"], fills: "lot" },
        require: [{ that: { eq: [{ lookup: "order.state" }, "released"] }, message: "The work order is not released.", field: "order" }],
        steps: [{ on: "lot", action: "start" }],
        confirm: false, callers: { users: ["olga"], groups: [] }, stewards: ["production"],
        scenarios: [{ name: "a new lot of a released order is put in process", records: { wo: { object: "work_order", where: { wo_no: ["WO-1001"] } }, lot: { object: "lot", data: { lot_no: `TLS-${tag}`, item: "PA66-NAT-25", work_order: "@wo", qty: 10, uom: "kg" } } }, steps: [{ as: "olga", do: { transaction: NAME, input: { lot: "@lot" } }, expect: { ok: true } }] }],
    };
    const { id } = await call("dana", "design.start", { transaction: NAME, label: "Note a lot" });
    const saved = await call("dana", "design.save", { id, reason: "Runs that read the same work order do not wait on each other.", transactions: { [NAME]: tx } });
    const submitted = await call("dana", "design.submit", { id });
    await call("vera", "design.review", { id, decision: "pass" });
    step("a transaction that writes a lot and only reads its work order is designed, approved and executed", !saved.problems?.length && !submitted.error && (await approveAll(id)) === "executed", { problems: saved.problems, submitted: submitted.error });

    const [order] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND state = 'released' AND archived_at IS NULL LIMIT 1");
    const lotOf = async (n) => (await call("olga", "records.create", { object: "lot", data: { lot_no: `TL-${tag}-${n}`, item: "PA66-NAT-25", work_order: order.id, qty: 10, uom: "kg" } })).id;

    // ---- 3. the order held for share elsewhere: the run does not wait ----
    const a = await lotOf(1);
    const share = await holding(order.id, "FOR SHARE");
    const r1 = await within(call("olga", "transactions.run", { name: NAME, input: { lot: a } }), 3000);
    await share.release();
    const [lotA] = await db.query("SELECT state FROM mes.records WHERE id = $1", [a]);
    step("while another transaction holds the work order for reading, the run goes through at once: the lot is written", r1.done && !r1.v.error && lotA.state === "in_process", { r1, lotA });

    // ---- 4. the order being changed elsewhere: the run waits for it ----
    const b = await lotOf(2);
    const update = await holding(order.id, "FOR UPDATE");
    const pending = call("olga", "transactions.run", { name: NAME, input: { lot: b } });
    const early = await within(pending, 1500);
    await update.release();
    const late = await within(pending, 5000);
    step("while another transaction is changing the work order, the run waits for it, then goes through", !early.done && late.done && !late.v.error, { early, late });

    // ---- 5. its check reads the order as it is ----
    const c = await lotOf(3);
    await db.query("UPDATE mes.records SET state = 'closed', row_version = row_version + 1 WHERE id = $1", [order.id]);
    const r3 = await call("olga", "transactions.run", { name: NAME, input: { lot: c } });
    await db.query("UPDATE mes.records SET state = 'released', row_version = row_version + 1 WHERE id = $1", [order.id]);
    step("its check still reads the work order as it is: one closed refuses the run, in words", /not released/.test(r3.error ?? ""), r3);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
