// What removing a field or a state leaves behind in the designer (withoutField, withStates): nothing in
// what merely lists it; what decides by it is left for the checks to name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutField, withStates, validateDefinition } from "../client/definition.js";

const lot = () => ({
    object: "lot", label: "Lot", area: "Production", titleField: "lot_no",
    fields: { lot_no: { label: "Lot", type: "string", required: true }, name: { label: "Name", type: "string" }, qty: { label: "Qty", type: "integer" } },
    form: { tabs: [{ label: "Lot", sections: [{ label: "Details", fields: ["lot_no", { field: "name", width: 6 }, "qty"] }] }] },
    list: { columns: ["lot_no", "name", "qty"] },
    analytics: { dimensions: ["name"] },
    states: { initial: "open", list: ["open", "held", "closed"], transitions: [], tones: { open: "info", held: "warning", closed: "done" } },
    roles: ["user"], stewards: { object: ["production"] },
    policies: [{ id: "all", roles: ["user"], record: { read: true, create: true }, fields: { name: "write", qty: "write", lot_no: "write" }, deny: { read: ["name"] } }],
    approval: { edit: { fields: ["name", "qty"] } },
});

test("a field removed: out of the form, the list, analytics, the policies and approval; the rest kept", () => {
    const out = withoutField(lot(), "name");
    assert.equal(out.fields.name, undefined);
    assert.deepEqual(out.form.tabs[0].sections[0].fields, ["lot_no", "qty"]);
    assert.deepEqual(out.list.columns, ["lot_no", "qty"]);
    assert.deepEqual(out.analytics.dimensions, []);
    assert.deepEqual(out.policies[0].fields, { qty: "write", lot_no: "write" });
    assert.deepEqual(out.policies[0].deny.read, []);
    assert.deepEqual(out.approval.edit.fields, ["qty"]);
    assert.deepEqual(validateDefinition(out).map((p) => p.message).filter((m) => /name/.test(m)), []);
});

test("a state removed takes its tone with it", () => {
    const st = withStates(lot().states, ["open", "closed"]);
    assert.deepEqual(st.list, ["open", "closed"]);
    assert.deepEqual(st.tones, { open: "info", closed: "done" });
    assert.equal(withStates({ list: ["a"], tones: { a: "info" } }, ["b"]).tones, undefined);
});
