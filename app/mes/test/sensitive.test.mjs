// Sensitive fields (§6.10) without a database: the design checks (definition.js, shared with the
// server), the mask every read goes through, the audit trail's values, the query views, the SQL that
// lists, screens and search read with, and the form's guide. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDefinition, validateScreen, validateTransaction, isHidden, hiddenValue, isSensitive, sensitiveFields, SENSITIVE_TYPES, HIDDEN_TEXT } from "../client/definition.js";
import { mask } from "../server/policy.js";
import { auditValues } from "../server/services.js";
import { viewSql } from "../server/query.js";
import { rightsSql, searchSql } from "../server/record-sql.js";
import { dimsOf } from "../server/analytics.js";
import { formGuide } from "../client/guide.js";
import { definitions, transactions, users, groups } from "../db/seed.mjs";

const lot = definitions.find((d) => d.object === "lot");
const known = { objects: ["lot", "work_order", "deviation", "machine", "item", "uom", "station"], scripts: ["lot_round_qty", "lot_qty_positive", "lot_default_expiry", "lot_check_qty", "lot_release_checks", "lot_archive_checks"], departments: ["production", "quality", "engineering"] };
// A copy of Lot with a patient's name and id on it, as a patient-specific device's record would have.
const withPatient = (edit = () => {}) => {
    const d = JSON.parse(JSON.stringify(lot));
    d.fields.patient_name = { label: "Patient name", type: "string", sensitive: true };
    d.fields.patient_id = { label: "Patient id", type: "string", sensitive: true };
    d.policies.find((p) => p.id === "lot-production-edit").fields.patient_name = "write";
    d.list = { ...d.list, columns: [...d.list.columns, "patient_name"] };
    edit(d);
    return d;
};
const messages = (d) => validateDefinition(d, { ...known, objects: [...new Set([...known.objects, ...definitions.map((x) => x.object)])] }).map((p) => p.message).join("\n");

test("a sensitive field is designed like any other, and shown in a list's columns (masked)", () => {
    const d = withPatient();
    assert.equal(messages(d).match(/sensitive/i), null, messages(d));
    assert.deepEqual(sensitiveFields(d), ["patient_name", "patient_id"]);
    assert.ok(isSensitive(d, "patient_id") && !isSensitive(d, "lot_no"));
});

test("where a sensitive field may not be named, said in words", () => {
    assert.match(messages(withPatient((d) => { d.titleField = "patient_name"; })), /"patient_name" is sensitive, so it cannot be the title/);
    assert.match(messages(withPatient((d) => { d.analytics = { dimensions: ["item", "patient_id"] }; })), /cannot be an analytics dimension/);
    assert.match(messages(withPatient((d) => { d.list = { ...d.list, sort: { field: "patient_name" } }; })), /the list cannot be sorted by it/);
    assert.match(messages(withPatient((d) => { d.transfer = { import: { create: true, update: true, key: "patient_id" } }; })), /an import cannot match rows by it/);
    assert.match(messages(withPatient((d) => { d.fields.patient_name.sensitive = "yes"; })), /sensitive is true or false/);
    assert.match(messages(withPatient((d) => { d.fields.work_order.sensitive = true; })), /a reference \(its record's title is shown\) cannot be sensitive/);
    for (const type of SENSITIVE_TYPES) assert.equal(messages(withPatient((d) => { d.fields.patient_id.type = type; if (type === "enum") d.fields.patient_id.values = ["a"]; })).match(/cannot be sensitive/), null, type);
});

test("a read masks a sensitive value for everyone, even who may write it; $perm still says what they may do", () => {
    const d = withPatient();
    const row = { id: "00000000-0000-4000-8000-000000000001", state: "created", type: null, row_version: 1, data: { lot_no: "L1", qty: 5, patient_name: "Ada Lovelace", patient_id: "" } };
    const operator = mask(d, { id: "op", roles: ["operator"] }, row);
    assert.deepEqual(operator.patient_name, hiddenValue());
    assert.ok(isHidden(operator.patient_name));
    assert.equal(operator.$perm.fields.patient_name, "w");
    assert.equal(operator.lot_no, "L1");
    assert.equal(operator.patient_id, "", "an empty value is not hidden: emptiness is not what is protected");
    assert.ok(!JSON.stringify(operator).includes("Ada"), "the value is nowhere in what goes out");
    // Who may not read it at all does not get the marker either.
    const hidden = withPatient((x) => { x.policies.find((p) => p.id === "lot-read").deny = { read: ["patient_name"] }; });
    const viewer = mask(hidden, { id: "v", roles: ["viewer"] }, row);
    assert.equal(viewer.patient_name, undefined);
});

test("the audit trail keeps that a sensitive field changed, never what it holds", () => {
    const d = withPatient();
    assert.deepEqual(auditValues(d, { patient_name: "Ada Lovelace", qty: 3 }), { patient_name: hiddenValue(), qty: 3 });
    assert.deepEqual(auditValues(d, { patient_name: null, qty: 3 }), { patient_name: null, qty: 3 });
    const same = { qty: 3 };
    assert.equal(auditValues(d, same), same, "nothing to hide: the same object");
});

test("the query views have no column for a sensitive field, nor do their stays' dimensions", () => {
    const d = withPatient((x) => { x.analytics = { dimensions: ["item", "patient_id"] }; }); // made sensitive since: still left out
    const [view, stays] = viewSql(d);
    assert.ok(!view.includes("patient_name") && !view.includes("patient_id"), view);
    assert.ok(view.includes('"lot_no"'));
    assert.ok(!stays.includes("patient_id"));
    assert.deepEqual(dimsOf(d, { item: "i1", patient_id: "P-17" }), { item: "i1" });
});

test("lists, screens and search never match, sort or group by a sensitive value", () => {
    const d = withPatient();
    const rights = rightsSql(d, { id: "op", roles: ["operator"] });
    assert.equal(rights.field("patient_name"), "false");
    assert.notEqual(rights.field("lot_no"), "false");
    const params = [];
    const sql = searchSql(d, rights, "lovelace", (v) => `$${params.push(v)}`);
    assert.ok(!sql.includes("patient_name"), sql);
});

test("a screen may show a sensitive field, masked, but not pick, sort, sum or group by it", () => {
    const d = withPatient((x) => { x.fields.dose = { label: "Dose", type: "decimal", sensitive: true }; });
    const objects = Object.fromEntries(definitions.map((x) => [x.object, { fields: x.fields, states: x.states.list }]));
    objects.lot = { fields: d.fields, states: d.states.list };
    const k = { objects, transactions: Object.fromEntries(transactions.map((t) => [t.name, { inputs: t.inputs, appearsOn: t.appearsOn }])), users: users.map((u) => u.id), groups: groups.map((g) => g.id), departments: ["production", "quality", "engineering"] };
    const screen = (blocks) => ({ name: "patients", label: "Patients", blocks });
    assert.deepEqual(validateScreen(screen([{ block: "table", object: "lot", columns: ["lot_no", "patient_name"] }, { block: "record", object: "lot", of: { param: "lot" }, show: ["patient_name"] }]), { ...k }).filter((p) => /sensitive/.test(p.message)), []);
    const m = validateScreen(screen([
        { block: "table", object: "lot", columns: ["lot_no"], where: { patient_id: "P-1" }, sort: { field: "patient_name" } },
        { block: "breakdown", object: "lot", by: "patient_name" },
        { block: "kpi", object: "lot", label: "Doses", measure: { sum: "dose" } },
    ]), k).map((p) => p.message).join("\n");
    assert.match(m, /lot\.patient_id is sensitive, so records are not picked by it/);
    assert.match(m, /lot\.patient_name is sensitive, so records are not sorted by it/);
    assert.match(m, /lot\.patient_name is sensitive, so records are not grouped by it/);
    assert.match(m, /lot\.dose is sensitive, so records are not summed up by it/);
});

test("a transaction neither copies a sensitive field into an input, nor sets one from an input that is not sensitive", () => {
    const d = withPatient();
    const objects = Object.fromEntries(definitions.map((x) => [x.object, { fields: x.fields, actions: x.states.transitions.map((t) => t.action), states: x.states.list, transitions: x.states.transitions, stewards: x.stewards }]));
    objects.lot = { ...objects.lot, fields: d.fields };
    const k = { objects, users: users.map((u) => u.id), groups: groups.map((g) => g.id), departments: ["production", "quality", "engineering"] };
    const tx = (inputs, steps) => ({ name: "admit", label: "Admit", inputs, steps, stewards: ["production"] });
    const copied = validateTransaction(tx({ lot: { label: "Lot", type: "ref", to: "lot", required: true }, who: { label: "Who", type: "string", from: "lot.patient_name" } }, [{ on: "lot", action: "start" }]), k).map((p) => p.message).join("\n");
    assert.match(copied, /lot\.patient_name is sensitive, so it is not filled in from there/);
    const plain = validateTransaction(tx({ lot: { label: "Lot", type: "ref", to: "lot", required: true }, name: { label: "Name", type: "string" } }, [{ on: "lot", set: { patient_name: { input: "name" } } }]), k).map((p) => p.message).join("\n");
    assert.match(plain, /the input it is set from, "name", must be sensitive too/);
    const ok = validateTransaction(tx({ lot: { label: "Lot", type: "ref", to: "lot", required: true }, name: { label: "Name", type: "string", sensitive: true } }, [{ on: "lot", set: { patient_name: { input: "name" } } }]), k).map((p) => p.message).join("\n");
    assert.equal(ok.match(/sensitive/), null, ok);
});

test("the form's guide says a sensitive field is hidden until shown", () => {
    const d = withPatient((x) => { delete x.form; }); // every field on the form, as an object without a layout has it
    const guide = formGuide({ ...d, fields: Object.fromEntries(Object.entries(d.fields).map(([n, f]) => [n, { ...f, label: f.label ?? n }])) });
    const item = guide.sections.flatMap((s) => s.items).find((i) => i.label === "Patient name");
    assert.match(item.words, /Sensitive: hidden until you press Show and say why/);
    assert.equal(HIDDEN_TEXT, "(hidden: sensitive)");
});
