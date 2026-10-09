// Forms as laid out (client/form-layout.js), fields with several values and requiredWhen
// (server/services.js validate), without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForm, storeForm, layoutProblems, widgetsFor, minWidth } from "../client/form-layout.js";
import { validateDefinition } from "../client/definition.js";
import { validate } from "../server/services.js";
import { definitions } from "../db/seed.mjs";

const lot = structuredClone(definitions.find((d) => d.object === "lot"));
lot.fields.defects = { label: "Defects", type: "enum", values: ["scratch", "dent", "stain"], multiple: true };
lot.fields.rework_note = { label: "Rework note", type: "text", requiredWhen: { contains: [{ data: "defects" }, "dent"] } };

test("an old layout reads as one tab, with default widths and widgets", () => {
    const n = normalizeForm(lot);
    assert.equal(n.tabs.length, 1);
    const qty = n.tabs[0].sections[1].fields[0];
    assert.deepEqual([qty.field, qty.width, qty.widget], ["qty", 4, "number"]);
    assert.deepEqual(widgetsFor(lot.fields.defects), ["checkboxes", "multiselect", "chips"]);
    assert.deepEqual(widgetsFor(lot.fields.disposition), ["select", "radio", "buttons"]);
});

test("a layout stores back in its shortest form: defaults left out, one tab as sections", () => {
    const n = normalizeForm(lot);
    assert.deepEqual(storeForm(n, lot), lot.form, "nothing changed, nothing added");
    n.tabs[0].sections[1].fields[0] = { ...n.tabs[0].sections[1].fields[0], width: 6, widget: "stepper", show: { eq: [{ record: "state" }, "created"] } };
    n.tabs.push({ label: "Quality", sections: [{ label: "Defects", collapsible: true, collapsed: true, fields: [{ field: "defects", width: 4, widget: "chips" }] }] });
    const stored = storeForm(n, lot);
    assert.equal(stored.tabs.length, 2);
    assert.deepEqual(stored.tabs[0].sections[1].fields[0], { field: "qty", width: 6, widget: "stepper", show: { eq: [{ record: "state" }, "created"] } });
    assert.deepEqual(stored.tabs[1].sections[0], { label: "Defects", collapsible: true, collapsed: true, fields: [{ field: "defects", widget: "chips" }] });
});

test("the checks: fields that exist, once, widths the widget fits, widgets of their type, conditions over the form", () => {
    const bad = { ...lot, form: { tabs: [{ label: "A", sections: [{ label: "S", fields: ["qty", "qty", "nope", { field: "item", width: 13 }, { field: "uom", widget: "chips" }, { field: "expiry", show: { eq: [{ event: "kind" }, "x"] } }, { field: "lot_no", enable: { eq: [{ data: "ghost" }, 1] } }] }] }] } };
    const messages = layoutProblems(bad).map((p) => p.message).join("\n");
    assert.match(messages, /"qty" is placed twice/);
    assert.match(messages, /"nope" is not a field/);
    assert.match(messages, /"item": width is 2 to 12 \(of a 12-column row\) drawn as text\./);
    assert.match(messages, /"uom": a enum is drawn as select, radio, buttons, not "chips"/);
    assert.match(messages, /"expiry" show when: it reads event/);
    assert.match(messages, /"lot_no" enable when: it reads data\.ghost, which is not a field/);
    assert.equal(layoutProblems({ ...bad, form: { tabs: [], sections: [] } })[0].message, "A form has sections or tabs, not both.");
});

test("widths: no narrower than the widget fits, in the checks and in the form as drawn", () => {
    assert.deepEqual([minWidth("checkbox"), minWidth("select"), minWidth("chips"), minWidth("textarea")], [2, 3, 4, 4]);
    const narrow = { ...lot, form: { sections: [{ label: "S", fields: [{ field: "uom", width: 1 }, { field: "defects", width: 3, widget: "chips" }, { field: "qty", width: 2 }] }] } };
    const messages = layoutProblems(narrow).map((p) => p.message);
    assert.deepEqual(messages, ['"uom": width is 3 to 12 (of a 12-column row) drawn as dropdown.', '"defects": width is 4 to 12 (of a 12-column row) drawn as chips.']);
    // A stored layout that is too narrow is still drawn at the widget's minimum.
    assert.deepEqual(normalizeForm(narrow).tabs[0].sections[0].fields.map((e) => e.width), [3, 4, 2]);
});

test("several values: only a choice field; not an analytics dimension or an import key", () => {
    const known = { objects: ["lot", "work_order", "deviation", "machine"], scripts: ["lot_round_qty", "lot_qty_positive", "lot_default_expiry", "lot_check_qty", "lot_release_checks", "lot_archive_checks"], departments: ["production", "quality", "engineering"] };
    assert.deepEqual(validateDefinition(lot, known), []);
    const wrong = { ...lot, fields: { ...lot.fields, qty: { ...lot.fields.qty, multiple: true } }, analytics: { dimensions: ["defects"] }, transfer: { import: { create: true, key: "defects" } } };
    const messages = validateDefinition(wrong, known).map((p) => p.message).join("\n");
    assert.match(messages, /only a choice field \(enum\) may hold several values/);
    assert.match(messages, /"defects" holds several values/);
    assert.match(messages, /Import key "defects" must be a short field/);
});

test("the server checks several values, and requiredWhen on the data it is given", () => {
    const base = { lot_no: "1", item: "x", work_order: "5993d238-054b-4dfe-b8a3-aa265b6ad7bb", qty: 1, uom: "kg" };
    assert.equal(validate(lot, { ...base, defects: ["scratch", "stain"] }), null);
    assert.match(validate(lot, { ...base, defects: ["scratch", "rust"] }).defects, /Some of: scratch, dent, stain/);
    assert.match(validate(lot, { ...base, defects: ["dent", "dent"] }).defects, /Each value once/);
    assert.match(validate(lot, { ...base, defects: "dent" }).defects, /Some of/);
    assert.match(validate(lot, { ...base, defects: ["dent"] }).rework_note, /Rework note is required here/);
    assert.equal(validate(lot, { ...base, defects: ["dent"], rework_note: "Reground" }), null);
    assert.equal(validate(lot, { ...base, defects: [] }), null, "an empty list is empty, and not required");
});

test("a text's longest length: designed per field, checked on every write; unsaid, 500", () => {
    const def = structuredClone(lot);
    def.fields.lot_no.maxLength = 8;
    def.fields.rework_note.maxLength = 20000;
    assert.deepEqual(validateDefinition(def, { departments: ["production", "quality", "engineering"] }).filter((p) => /maxLength/.test(p.path)), []);
    assert.equal(validate(def, { ...validData(def), lot_no: "LOT-0001" }), null);
    assert.match(validate(def, { ...validData(def), lot_no: "LOT-00012" })?.lot_no ?? "", /Text, at most 8 characters \(this is 9\)/);
    assert.match(validate(lot, { ...validData(lot), rework_note: "x".repeat(501) })?.rework_note ?? "", /Text, at most 500 characters/);
    const bad = (field) => validateDefinition({ ...def, fields: { ...def.fields, ...field } }, {}).filter((p) => /maxLength/.test(p.path)).map((p) => p.message).join("\n");
    assert.match(bad({ qty: { ...def.fields.qty, maxLength: 5 } }), /only a text or a long text field has a longest length/);
    assert.match(bad({ lot_no: { ...def.fields.lot_no, maxLength: 2001 } }), /1 to 2000 characters/);
    assert.match(bad({ rework_note: { ...def.fields.rework_note, maxLength: 0 } }), /1 to 20000 characters/);
});

test("a long text's height: at least its rows, growing to maxRows; only a long text has one", () => {
    const def = structuredClone(lot);
    def.form = { sections: [{ label: "Details", fields: Object.keys(def.fields).map((f) => (f === "rework_note" ? { field: f, rows: 3, maxRows: 12 } : f)) }] };
    assert.deepEqual(layoutProblems(def), []);
    const stored = storeForm(normalizeForm(def), def).sections[0].fields.find((e) => e.field === "rework_note");
    assert.deepEqual([stored.rows, stored.maxRows], [3, 12]);
    const said = (entry) => layoutProblems({ ...def, form: { sections: [{ label: "Details", fields: Object.keys(def.fields).map((f) => (f === entry.field ? entry : f)) }] } }).map((p) => p.message).join("\n");
    assert.match(said({ field: "rework_note", rows: 6, maxRows: 4 }), /largest height is 6 to 40 lines/);
    assert.match(said({ field: "rework_note", maxRows: 41 }), /largest height is 3 to 40 lines/);
    assert.match(said({ field: "lot_no", rows: 4 }), /only a long text has a height in lines/);
});

// A lot's data that passes, but for what a test changes.
function validData(def) {
    const out = {};
    for (const [k, f] of Object.entries(def.fields)) {
        if (!f.required) continue;
        out[k] = f.type === "integer" || f.type === "decimal" ? 1 : f.type === "enum" ? f.values[0] : f.type === "ref" ? "00000000-0000-4000-8000-000000000000" : f.type === "date" ? "2026-01-01" : f.type === "boolean" ? true : "x";
    }
    return out;
}
