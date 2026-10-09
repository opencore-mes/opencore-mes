// Sensitive fields (§6.10), end to end against a running server:
//   1. Dana designs a copy of Lot with a patient's name and id marked sensitive: one as the title is
//      refused in words; the fitness test lists them as access changes; the change is reviewed,
//      approved and executed like any other.
//   2. Sam makes a record. Every read masks both fields, for everyone, even who may write them:
//      records.get, the list (plain and paged), search (which never matches on them), a screen's table
//      block, the Excel export (a workbook never holds them); a list asked to match one by value refuses.
//   3. Showing a value: refused without a reason, in words; with one, the value, and an audit entry
//      (read:sensitive, the field, the reason, who); refused to a viewer whose policy hides the field
//      (and that refusal audited), for a field that is not sensitive, and to anything but a person's
//      own call. The history shows who saw it and why, to who may read the field only.
//   4. Writing: the marker sent back as it came is ignored (a form, an import's unchanged cell); a new
//      value is written, and the audit trail holds neither the old value nor the new one.
//   5. The query views have no column for them: a query cannot name them, SELECT * does not hold them,
//      nor does an AI report's table.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/sensitive.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";
import { createApp } from "../app.mjs";
import { createStore, sessionKey } from "../server/store.js";
import { createServices } from "../server/services.js";
import { readXlsx, writeXlsx } from "../server/xlsx.js";
import { isHidden, HIDDEN_TEXT } from "../client/definition.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const NAME = `patient_lot_${tag}`;
const ADA = "Ada Lovelace";
const GRACE = "Grace Hopper";
const PID = `P-${tag}-42`;
const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const people = ["olga", "sam", "vera", "dana", "eli", "quinn", "ivan", "ines", "iris"];
const sessions = {};
for (const user of people) {
    sessions[user] = `ph-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const attempt = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, status: error.status, message: error.message, body: error.body }));
const key = () => `ph-${randomBytes(8).toString("hex")}`;
const holds = (value, ...texts) => texts.some((t) => JSON.stringify(value ?? null).includes(t));

let made = null;
let executed = false;
try {
    // ---- 1. designed, reviewed, approved, executed ----
    const [live] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const body = JSON.parse(JSON.stringify(live.body));
    Object.assign(body, { object: NAME, label: `Patient lot ${tag}`, description: "A lot for one patient's device." });
    delete body.flow;
    body.fields.patient_name = { label: "Patient name", type: "string", sensitive: true };
    body.fields.patient_id = { label: "Patient id", type: "string", sensitive: true };
    const edit = body.policies.find((p) => p.id === "lot-production-edit");
    edit.fields = { ...edit.fields, patient_name: "write", patient_id: "write" };
    body.policies.push({ id: "patient-not-for-viewers", roles: ["viewer"], deny: { read: ["patient_name", "patient_id"] } });
    body.form.sections.push({ label: "Patient", fields: ["patient_name", "patient_id"] });
    body.list = { ...(body.list ?? {}), columns: [...(body.list?.columns ?? ["lot_no"]), "patient_name"] };
    body.transfer = { import: { create: true, update: true, key: "lot_no" } };

    const { id: change } = await call("dana", "design.start", { object: NAME, label: body.label });
    const wrong = await call("dana", "design.save", { id: change, reason: "Patient-specific lots (sensitive fields).", definitions: { [NAME]: { ...body, titleField: "patient_name" } } });
    const saved = await call("dana", "design.save", { id: change, reason: "Patient-specific lots (sensitive fields).", definitions: { [NAME]: body } });
    step("a sensitive field as the title is refused in words; the design without it is valid",
        (wrong.problems ?? []).some((p) => /"patient_name" is sensitive, so it cannot be the title/.test(p.message)) && !(saved.problems ?? []).length, { wrong: wrong.problems, saved: saved.problems });
    const fitness = await call("dana", "design.fitness", { id: change });
    const access = fitness.checks?.find((c) => c.id === "access")?.items ?? [];
    step("the fitness test lists each sensitive field as an access change", access.some((i) => i.includes("patient_name: now sensitive")) && access.some((i) => i.includes("patient_id: now sensitive")), access);
    const submitted = await attempt(call("dana", "design.submit", { id: change }));
    const reviewed = await attempt(call("vera", "design.review", { id: change, decision: "pass" }));
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) for (const user of people) {
        const seen = await call(user, "design.change", { id: change, as: user }).catch(() => null);
        for (const department of seen?.can?.approveFor ?? []) state = (await call(user, "design.approve", { id: change, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    executed = state === "executed";
    step("the change is reviewed, approved and executed like any other", submitted.ok && reviewed.ok && executed, { submitted, reviewed, state });
    // Its roles, as People & departments would give them (a governed change of its own, not the subject here).
    await db.query(`INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES
        ('group', 'production', $1, 'operator'), ('group', 'quality', $1, 'quality'), ('user', 'sam', $1, 'supervisor'), ('user', 'vera', $1, 'viewer'), ('user', 'dana', $1, 'operator') ON CONFLICT DO NOTHING`, [NAME]);
    const def = await call("sam", "defs.get", { object: NAME, as: "sam" });
    step("the browser is told which fields are sensitive (the form draws them hidden; its guide says so)", def.fields.patient_name.sensitive === true && def.fields.lot_no.sensitive === undefined, def.fields.patient_name);

    // ---- 2. masked wherever records are shown or leave ----
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1001'");
    let rec = await call("sam", "records.create", { object: NAME, data: { lot_no: `PT${tag}`, item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg", patient_name: ADA, patient_id: PID }, key: key() });
    made = rec.id;
    const [stored] = await db.query("SELECT data FROM mes.records WHERE object = $1 AND id = $2", [NAME, made]);
    step("created: the record holds the values; what came back holds the marker, and says Sam may write them",
        stored.data.patient_name === ADA && stored.data.patient_id === PID && isHidden(rec.patient_name) && isHidden(rec.patient_id) && rec.$perm.fields.patient_name === "w" && !holds(rec, ADA, PID), rec);
    const asOlga = await call("olga", "records.get", { object: NAME, id: made, as: "olga" });
    const asVera = await call("vera", "records.get", { object: NAME, id: made, as: "vera" });
    step("records.get: masked for who may read it; absent for a viewer whose policy hides it (policies still decide)",
        isHidden(asOlga.patient_name) && asOlga.$perm.fields.patient_name && asVera.patient_name === undefined && !asVera.$perm.fields.patient_name && !holds([asOlga, asVera], ADA, PID), { asOlga, asVera });
    const plain = await call("sam", "records.list", { object: NAME, as: "sam" });
    const paged = await call("sam", "records.list", { object: NAME, as: "sam", page: 1 });
    const filtered = await call("sam", "records.list", { object: NAME, as: "sam", page: 1, q: "lovelace" });
    step("the list, plain and paged, holds the marker; its filter never matches on a sensitive value",
        plain.rows.some((r) => r.id === made && isHidden(r.patient_name)) && paged.rows.some((r) => r.id === made) && !holds([plain, paged], ADA, PID) && !filtered.rows.some((r) => r.id === made), { filtered: filtered.rows.map((r) => r.id) });
    const probe = await attempt(call("sam", "records.list", { object: NAME, as: "sam", where: { patient_id: PID } }));
    step("a list asked to match a sensitive field by value refuses, in words", !probe.ok && /never searched by its value/.test(probe.message), probe);
    const byName = await call("sam", "records.search", { q: "Lovelace" });
    const byId = await call("sam", "records.search", { q: PID });
    const byLot = await call("sam", "records.search", { q: `PT${tag}` });
    step("search never finds a record by a sensitive value, and a hit found otherwise shows none",
        !byName.some((h) => h.id === made) && !byId.some((h) => h.id === made) && byLot.some((h) => h.id === made) && !holds(byLot, ADA, PID), { byName, byId, byLot });
    const screen = (blocks) => ({ name: `pt_${tag}`, label: "Patients", blocks, callers: { users: ["dana"], groups: [] }, stewards: ["production"] });
    const preview = await call("dana", "screens.preview", { screen: screen([{ block: "table", object: NAME, columns: ["lot_no", "patient_name"] }]) });
    const tableRows = preview.data?.blocks?.[0]?.rows ?? [];
    const bad = await call("dana", "design.check", { screens: { [`pt_${tag}`]: screen([{ block: "breakdown", object: NAME, by: "patient_name" }]) } });
    step("a screen's table block shows it masked; a breakdown by it is refused in words",
        tableRows.some((r) => r.id === made && isHidden(r.patient_name)) && !holds(tableRows, ADA) && (bad.problems ?? []).some((p) => /patient_name is sensitive, so records are not grouped by it/.test(p.message)), { preview, bad: bad.problems });
    const xlsx = await fetch(`${mes}/transfer/export.xlsx?objects=${NAME}&related=0`, { headers: { cookie: `mes_session=${sessions.sam}` } });
    const book = readXlsx(Buffer.from(await xlsx.arrayBuffer()));
    const tab = book.find((s) => s.name !== "_about");
    const header = tab?.rows[0] ?? [];
    const line = tab?.rows.find((r) => r[0] === made) ?? [];
    step("the Excel export writes the marker's words, never the value",
        xlsx.status === 200 && line[header.indexOf("patient_name")] === HIDDEN_TEXT && line[header.indexOf("patient_id")] === HIDDEN_TEXT && !holds(book, ADA, PID), { header, line });

    // ---- 3. shown, with a reason, audited ----
    const noReason = await attempt(call("olga", "records.reveal", { object: NAME, id: made, field: "patient_name" }));
    const blank = await attempt(call("olga", "records.reveal", { object: NAME, id: made, field: "patient_name", reason: "  " }));
    step("showing it without a reason is refused, in words, on the reason", !noReason.ok && noReason.status === 400 && /Say why you need to see Patient name/.test(noReason.message) && noReason.body?.fields?.reason && !blank.ok, { noReason, blank });
    const why = `Calling the patient about lot PT${tag}`;
    const shown = await call("olga", "records.reveal", { object: NAME, id: made, field: "patient_name", reason: why });
    const [entry] = await db.query("SELECT actor, action, after FROM mes.audit_log WHERE object = $1 AND record_id = $2 AND action = 'read:sensitive' ORDER BY seq DESC LIMIT 1", [NAME, made]);
    step("with a reason, the value; the showing is audited: who, which field, why",
        shown.value === ADA && entry?.actor === "olga" && entry.after.field === "patient_name" && entry.after.reason === why, { shown, entry });
    const viewer = await attempt(call("vera", "records.reveal", { object: NAME, id: made, field: "patient_name", reason: "I would like to see it" }));
    const [denied] = await db.query("SELECT action FROM mes.audit_log WHERE object = $1 AND record_id = $2 AND actor = 'vera' AND action = 'denied:read:patient_name'", [NAME, made]);
    const notSensitive = await attempt(call("olga", "records.reveal", { object: NAME, id: made, field: "lot_no", reason: "To check the number" }));
    const internal = await attempt(createServices({ store: createStore(db) }).services["records.reveal"].call({ [CALL_KIND]: "internal", reason: "a script", user: await createStore(db).user("sam") }, { object: NAME, id: made, field: "patient_name", reason: "A script asks" }));
    step("refused to a viewer whose policy hides it (and that refusal audited), for a field that is not sensitive, and to anything but a person's own call (a script, a transaction, the AI)",
        !viewer.ok && viewer.status === 403 && /may not read Patient name/.test(viewer.message) && denied && !notSensitive.ok && /not a sensitive field/.test(notSensitive.message) && !internal.ok && internal.status === 403, { viewer, denied, notSensitive, internal });
    const historyOlga = await call("olga", "records.history", { object: NAME, id: made });
    const historyVera = await call("vera", "records.history", { object: NAME, id: made });
    const sawIt = historyOlga.find((h) => h.action === "read:sensitive");
    step("the history says who saw it and why, to who may read the field only; its values are the marker",
        sawIt?.actor === "olga" && sawIt.after.reason === why && sawIt.after.label === "Patient name" && !historyVera.some((h) => h.action === "read:sensitive") && isHidden(historyOlga.find((h) => h.action === "create")?.after?.patient_name) && !holds(historyOlga, ADA, PID), { historyOlga, historyVera });

    // ---- 4. writing ----
    rec = await call("sam", "records.get", { object: NAME, id: made, as: "sam" });
    const back = await call("sam", "records.update", { object: NAME, id: made, rowVersion: rec.row_version, data: { patient_name: rec.patient_name, patient_id: rec.patient_id, qty: 12 }, key: key() });
    const [after1] = await db.query("SELECT data FROM mes.records WHERE object = $1 AND id = $2", [NAME, made]);
    step("the marker sent back as it came is ignored: the values stay, the rest is saved", after1.data.patient_name === ADA && after1.data.patient_id === PID && after1.data.qty === 12 && back.row_version === rec.row_version + 1, after1.data);
    const changed = await call("sam", "records.update", { object: NAME, id: made, rowVersion: back.row_version, data: { patient_name: GRACE, patient_id: back.patient_id }, key: key() });
    const [after2] = await db.query("SELECT data FROM mes.records WHERE object = $1 AND id = $2", [NAME, made]);
    const [written] = await db.query("SELECT before, after FROM mes.audit_log WHERE object = $1 AND record_id = $2 AND action = 'update' ORDER BY seq DESC LIMIT 1", [NAME, made]);
    const [{ n: copies }] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE record_id = $1 AND (before::text ~* $2 OR after::text ~* $2)", [made, `${ADA}|${GRACE}|${PID}`]);
    step("a new value is written by who may write it; the audit trail says it changed, and holds neither the old value nor the new one",
        after2.data.patient_name === GRACE && after2.data.patient_id === PID && isHidden(changed.patient_name) && isHidden(written?.before?.patient_name) && isHidden(written?.after?.patient_name) && copies === 0, { written, copies });
    // An import of the exported row, the marker's words left as they were and the quantity changed.
    const sheet = { name: tab.name, rows: [header, header.map((h, i) => (h === "qty" ? 14 : h === "row_version" ? null : line[i]))] };
    const imported = await fetch(`${mes}/transfer/import?apply=1`, { method: "POST", headers: { cookie: `mes_session=${sessions.sam}`, origin: mes, "content-type": "application/octet-stream" }, body: writeXlsx([sheet]) });
    const result = await imported.json();
    const [after3] = await db.query("SELECT data FROM mes.records WHERE object = $1 AND id = $2", [NAME, made]);
    step("an import of the exported row leaves the marker's cells alone and applies the rest", imported.status === 200 && after3.data.qty === 14 && after3.data.patient_name === GRACE && after3.data.patient_id === PID, { status: imported.status, result: result.models?.[0]?.rows ?? result, data: after3.data });

    // ---- 5. never in the query views, so never in analytics or the AI ----
    const schema = await call("sam", "query.schema", {});
    const view = schema.views.find((v) => v.name === NAME);
    const named = await attempt(call("sam", "query.sql", { sql: `SELECT patient_name FROM ${NAME}` }));
    const all = await call("sam", "query.sql", { sql: `SELECT * FROM ${NAME}` });
    const report = await call("sam", "reports.run", { report: { title: "Patients", blocks: [{ block: "table", query: { sql: `SELECT * FROM ${NAME}` } }] } });
    step("the query view has no column for a sensitive field: a query cannot name it, SELECT * and an AI report's table hold none",
        view && !view.columns.some((c) => /^patient_/.test(c.name)) && !named.ok && /patient_name/.test(named.message) && all.rows.length >= 1 && !all.columns.some((c) => /^patient_/.test(c)) && !holds([all, report], ADA, GRACE, PID),
        { columns: view?.columns.map((c) => c.name), named, all: all.columns });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message, body: error.body });
} finally {
    await app.close?.().catch(() => {});
    // What this run made, except its audit trail (append-only by design) and its change request.
    if (made) {
        await db.query("DELETE FROM mes.state_intervals WHERE record_id = $1", [made]);
        await db.query("DELETE FROM mes.records WHERE object = $1 AND id = $2", [NAME, made]);
    }
    if (executed) {
        await db.query("DELETE FROM mes.assignments WHERE object = $1", [NAME]);
        await db.query("DELETE FROM mes.definitions WHERE object = $1", [NAME]);
        await db.query(`DROP TABLE IF EXISTS mes."records_${NAME}"`);
    }
    await db.query("DELETE FROM mes.idempotency WHERE key LIKE 'ph-%'");
    await db.query("DELETE FROM mes.sessions WHERE id = ANY($1)", [Object.values(sessions).map(sessionKey)]);
    await pool.end();
}
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
