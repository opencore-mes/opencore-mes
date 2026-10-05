// Fields with several values and requiredWhen (DESIGN.md §10.4), end to end against the database:
//   1. A lot with several defects is saved as a list; a value not in the field's list is refused.
//   2. requiredWhen: a dent needs a rework note, at the server, whatever the form showed.
//   3. In the query views the field is a text array: 'dent' = ANY(defects).
//   4. A field that becomes several values (or one again) has its stored values converted.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/forms.mjs
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createStore } from "../server/store.js";
import { createServices } from "../server/services.js";
import { createQuery } from "../server/query.js";
import { multipleConversion } from "../server/design.js";
import { CALL_KIND } from "../../../src/live-protocol.js";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const store = createStore(db);
const records = createServices({ store });
const query = createQuery({ store, log: { info() {} } });
const refused = (p) => p.then(() => null, (e) => ({ message: e.message, fields: e.fields }));
let original = null;
const made = [];
const session = `fm-${randomBytes(8).toString("hex")}`;
try {
    const [lot] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    original = lot;
    const next = structuredClone(lot.body);
    next.fields.defects = { label: "Defects", type: "enum", values: ["scratch", "dent", "stain"], multiple: true };
    next.fields.rework_note = { label: "Rework note", type: "text", requiredWhen: { contains: [{ data: "defects" }, "dent"] } };
    const edit = next.policies.find((p) => p.id === "lot-production-edit");
    edit.fields = { ...edit.fields, defects: "write", rework_note: "write" };
    next.form.sections.push({ label: "Defects", fields: [{ field: "defects", widget: "chips" }, { field: "rework_note", show: { contains: [{ data: "defects" }, "dent"] } }] });
    await db.query("UPDATE mes.definitions SET status = 'superseded' WHERE object = 'lot' AND version = $1", [lot.version]);
    await db.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ('lot', $1, 'published', $2)", [lot.version + 1, JSON.stringify(next)]);
    store.forget?.();

    const sam = await store.user("sam");
    const self = { [CALL_KIND]: "internal", reason: "forms test", user: sam };
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    const base = { item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" };

    const badValue = await refused(records.services["records.create"].call(self, { object: "lot", data: { ...base, lot_no: `F${tag}-0`, defects: ["rust"] } }));
    step("a value not in the field's list is refused", /Some of: scratch, dent, stain/.test(badValue?.fields?.defects ?? ""), badValue);
    const noNote = await refused(records.services["records.create"].call(self, { object: "lot", data: { ...base, lot_no: `F${tag}-1`, defects: ["dent", "scratch"] } }));
    step("requiredWhen at the server: a dent without a rework note is refused on that field", /Rework note is required here/.test(noNote?.fields?.rework_note ?? ""), noNote);
    const ok = await records.services["records.create"].call(self, { object: "lot", data: { ...base, lot_no: `F${tag}-2`, defects: ["dent", "scratch"], rework_note: "Reground the edge." } });
    made.push(ok.id);
    step("with the note, saved: several values kept as a list", JSON.stringify(ok.defects) === '["dent","scratch"]');
    const plain = await records.services["records.create"].call(self, { object: "lot", data: { ...base, lot_no: `F${tag}-3`, defects: ["stain"] } });
    made.push(plain.id);
    step("no dent, no note needed", plain.defects[0] === "stain");

    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'sam', now() + interval '10 minutes')", [session]);
    const q = await query.services["query.sql"].call({ sessionId: session }, { sql: `SELECT lot_no, defects, cardinality(defects) AS n FROM lot WHERE 'dent' = ANY(defects) AND lot_no LIKE 'F${tag}-%'` });
    const schema = await query.services["query.schema"].call({ sessionId: session }, {});
    step("in the query views, a text array: 'dent' = ANY(defects)", q.rows.length === 1 && Array.isArray(q.rows[0][1]) && q.rows[0][2] === 2 && schema.views.find((v) => v.name === "lot").columns.find((c) => c.name === "defects")?.type === "text[]", q.rows);

    // A field that becomes one value, then several again.
    const one = await db.query(multipleConversion(false), ["lot", "defects"]);
    const [afterOne] = await db.query("SELECT data->'defects' AS d FROM mes.records WHERE id = $1", [ok.id]);
    const several = await db.query(multipleConversion(true), ["lot", "defects"]);
    const [afterSeveral] = await db.query("SELECT data->'defects' AS d FROM mes.records WHERE id = $1", [ok.id]);
    step("to one value: the first kept; to several again: a list of one", one.length >= 2 && afterOne.d === "dent" && several.length >= 2 && JSON.stringify(afterSeveral.d) === '["dent"]', { one: afterOne.d, several: afterSeveral.d });
} catch (error) {
    step("unexpected", false, { message: error.message, stack: error.stack?.split("\n").slice(0, 4) });
} finally {
    if (made.length) {
        await db.query("DELETE FROM mes.state_intervals WHERE record_id = ANY($1::uuid[])", [made]);
        await db.query("DELETE FROM mes.records WHERE id = ANY($1::uuid[])", [made]);
    }
    if (original) {
        await db.query("DELETE FROM mes.definitions WHERE object = 'lot' AND version = $1", [original.version + 1]);
        await db.query("UPDATE mes.definitions SET status = 'published' WHERE object = 'lot' AND version = $1", [original.version]);
    }
    await db.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(session)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
