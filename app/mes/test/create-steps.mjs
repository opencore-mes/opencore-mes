// Transactions that create records, and inputs that repeat (§25.1), end to end:
//   1. Dana designs "Check readings": a lot, at least 3 readings (a rows input), one deviation created
//      per reading (a create step, forEach), and the lot held when some reading is over 1.5 (some/row).
//      A rows field that is a reference, a forEach over an input that is not rows, a row read outside
//      a forEach step: named. Approved by Production (the lot) and Quality (the deviations it creates).
//   2. Two readings: refused, "at least 3 rows". A reading that is not a number: refused, on its row.
//   3. Three readings within the limit: the preview lists three new deviations (their lot by its
//      number), and no hold.
//   4. One over the limit: run; three deviations created as Olga, through their own policies, audited
//      in the run; the lot on hold.
//   5. A value filled in from the lot (its quantity, `from: "lot.qty"`): copied as Olga reads it, never
//      what is typed for it; one of another type than the field's is named.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/create-steps.mjs   (after a reset)
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
    for (const user of ["olga", "sam", "quinn", "dana", "vera"]) {
        sessions[user] = `cs-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `cs-${randomBytes(8).toString("hex")}`;

    // ---- 1. the design ----
    const NAME = `check_readings_t${tag}`;
    const { id } = await call("dana", "design.start", { transaction: NAME, label: "Check readings" });
    const base = (await call("dana", "design.change", { id, as: "dana" })).content.transactions[NAME];
    const over = { some: [{ input: "readings" }, { gt: [{ row: "value" }, 1.5] }] };
    const body = {
        ...base, label: "Check readings", description: "Three readings or more; a deviation for each, and the lot held when one is over 1.5.",
        inputs: {
            lot: { label: "Lot", type: "ref", to: "lot", required: true },
            readings: { label: "Readings", type: "rows", min: 3, max: 10, fields: { value: { label: "Value", type: "decimal", required: true }, note: { label: "Note", type: "string", required: true } } },
            // Shown beside the readings, read only: the lot's quantity, copied from it.
            lot_qty: { label: "Lot quantity", type: "decimal", from: "lot.qty" },
        },
        require: [{ that: { eq: [{ input: "lot_qty" }, { lookup: "lot.qty" }] }, message: "The lot quantity shown is not the lot's.", field: "lot_qty" }],
        steps: [
            { create: "deviation", forEach: "readings", set: { title: { row: "note" }, lot: { input: "lot" }, severity: "minor", description: "A reading of the sample." } },
            { on: "lot", action: "hold", when: over },
        ],
        confirm: true, callers: { users: [], groups: ["production"] }, stewards: ["production"],
        scenarios: [{
            name: "one reading over 1.5: three deviations, the lot held",
            records: {
                wo: { object: "work_order", where: { wo_no: ["WO-1002"] } },
                lot: { object: "lot", data: { lot_no: `SC${tag}`, item: "PP-BLK-10", work_order: "@wo", qty: 50, uom: "kg" } },
            },
            steps: [{ as: "olga", do: { transaction: NAME, input: { lot: "@lot", readings: [{ value: 1.1, note: "a" }, { value: 1.8, note: "b" }, { value: 1.2, note: "c" }] } }, expect: { ok: true, states: { lot: "on_hold" }, created: { deviation: 3 } } }],
        }],
    };
    const wrong = await call("dana", "design.save", { id, reason: "Readings on a lot.", transactions: { [NAME]: { ...body,
        inputs: { ...body.inputs, wafers: { type: "rows", fields: { lot: { type: "ref", to: "lot" } } }, lot_no: { label: "Lot number", type: "integer", from: "lot.lot_no" } },
        steps: [...body.steps, { create: "deviation", forEach: "lot", set: { title: "x", severity: "minor" } }, { create: "deviation", set: { title: { row: "note" }, severity: "minor" } }],
    } } });
    const words = (wrong.problems ?? []).map((p) => p.message).join("\n");
    step("a reference in rows, a forEach over an input that is not rows, a row read outside a forEach, a value filled in from a field of another type: named", /"wafers.lot": a row's field is a string, integer, decimal, boolean, date or enum/.test(words) && /forEach names a rows input/.test(words) && /it reads a row, but the step does not run once per row/.test(words) && /"lot_no": lot\.lot_no is a string; this input must be one too/.test(words), wrong.problems);
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    const saved = await call("dana", "design.save", { id, seen: fresh.draft_rev, transactions: { [NAME]: body } });
    const submitted = await call("dana", "design.submit", { id });
    const routed = await call("dana", "design.change", { id, as: "dana" });
    await call("vera", "design.review", { id, decision: "pass" });
    await call("sam", "design.approve", { id, department: "production", decision: "approve", meaning: "Approved" });
    const live = await call("quinn", "design.approve", { id, department: "quality", decision: "approve", meaning: "Approved" });
    step("approved by Production (the lot) and by Quality (the deviations it creates)", !saved.problems?.length && submitted.ok && routed.route.map((r) => r.department).sort().join() === "production,quality" && live.state === "executed", { problems: saved.problems, route: routed.route, live: live.state ?? live });

    // ---- 2. too few, and a bad value ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const lot = (await call("sam", "records.create", { object: "lot", data: { lot_no: `LOT${tag}CS-A`, item: "PP-BLK-10", work_order: wo.id, qty: 50, uom: "kg" }, key: key() })).id;
    const two = await call("olga", "transactions.preview", { name: NAME, input: { lot, readings: [{ value: 1.1, note: "a" }, { value: 1.2, note: "b" }] } });
    step("two readings: refused, at least 3", two.status === 400 && /at least 3 rows, not 2/.test(two.fields?.readings ?? ""), two);
    const bad = await call("olga", "transactions.preview", { name: NAME, input: { lot, readings: [{ value: 1.1, note: "a" }, { value: "x", note: "b" }, { value: 1.2, note: "c" }] } });
    step("a reading that is not a number: refused, on its row", bad.status === 400 && /Row 2: Value: A number/.test(bad.fields?.readings ?? ""), bad);

    // ---- 3. within the limit ----
    const ok = await call("olga", "transactions.preview", { name: NAME, input: { lot, readings: [{ value: 1.1, note: `R1-${tag}` }, { value: 1.2, note: `R2-${tag}` }, { value: 1.4, note: `R3-${tag}` }, {}] } });
    const created = (ok.changes ?? []).filter((c) => c.created);
    step("within the limit: three new deviations in the preview (an empty last row is not a reading), no hold", created.length === 3 && created.every((c) => c.object === "deviation" && c.id === null && c.fields.lot) && !(ok.changes ?? []).some((c) => c.object === "lot") && ok.skipped?.includes(1), ok);
    step("…each new deviation shows its lot by the lot's number, not its id", created.length === 3 && created.every((c) => c.fields.lot?.to === `LOT${tag}CS-A`), created.map((c) => c.fields.lot));

    // ---- 4. one over ----
    const run = await call("olga", "transactions.run", { name: NAME, input: { lot, readings: [{ value: 1.1, note: `S1-${tag}` }, { value: 1.8, note: `S2-${tag}` }, { value: 1.3, note: `S3-${tag}` }] }, key: key() });
    const made = await db.query("SELECT id, created_by, data FROM mes.records WHERE object = 'deviation' AND data->>'title' LIKE $1 ORDER BY data->>'title'", [`S%-${tag}`]);
    const [held] = await db.query("SELECT state FROM mes.records WHERE id = $1", [lot]);
    step("one over the limit: three deviations created as Olga, each with its id in the answer, the lot held", run.ok && made.length === 3 && made.every((d) => d.created_by === "olga" && d.data.lot === lot) && held.state === "on_hold" && run.changes.filter((c) => c.created).every((c) => made.some((d) => d.id === c.id)), { run, made: made.length, held });
    const audits = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE object = 'deviation' AND action = 'create' AND actor = 'olga' AND on_behalf_of LIKE $1", [`transaction:${NAME}:%`]);
    step("each created through the deviation's own write, audited as part of the run", audits[0].n === 3, audits);

    // ---- 5. a value filled in from the lot ----
    const typed = await call("olga", "transactions.preview", { name: NAME, input: { lot, lot_qty: 999, readings: [{ value: 1.1, note: "a" }, { value: 1.2, note: "b" }, { value: 1.3, note: "c" }] } });
    step("a value filled in from the lot (its quantity): copied from it, what is typed for it ignored", typed.ok !== false && !typed.error && !typed.fields?.lot_qty, typed);
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
