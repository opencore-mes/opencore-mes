// The designer's checks, footprint and routing (DESIGN.md §5.6, §6.2). `npm test`. (Presence is shared
// through the database now; test/cluster.mjs checks it across instances.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDefinition, footprint, scriptFootprint, routeOf, renameField, fieldNameProblem, needsApproval, recordRoute } from "../client/definition.js";
import { definitions } from "../db/seed.mjs";

const lot = definitions.find((d) => d.object === "lot");
const known = { objects: ["lot", "work_order", "deviation", "machine"], scripts: ["lot_round_qty", "lot_qty_positive", "lot_default_expiry", "lot_check_qty", "lot_release_checks", "lot_archive_checks"], departments: ["production", "quality", "engineering"] };
const edit = (fn) => { const copy = JSON.parse(JSON.stringify(lot)); fn(copy); return copy; };

test("the seed definitions are valid", () => {
    for (const def of definitions) {
        const all = { ...known, scripts: [...known.scripts, "wo_qty_positive", "dev_close_needs_cause"] };
        assert.deepEqual(validateDefinition(def, all), [], def.object);
    }
});

test("names that would break paths or the live diff are refused (§6.2)", () => {
    for (const bad of ["constructor", "__proto__", "toString", "id", "state", "Qty", "a.b", ""]) {
        // As a browser sends it: JSON, where "__proto__" is an ordinary own key.
        const problems = validateDefinition(edit((d) => { d.fields = JSON.parse(JSON.stringify(d.fields).replace(/^\{/, `{${JSON.stringify(bad)}:{"type":"string"},`)); }), known);
        assert.ok(problems.length, `"${bad}" is refused`);
    }
});

test("references must exist: states, fields, actions, scripts, departments", () => {
    const messages = (d) => validateDefinition(d, known).map((p) => p.message).join("\n");
    assert.match(messages(edit((d) => { d.states.transitions[0].to = "nowhere"; })), /"to" must be a state/);
    assert.match(messages(edit((d) => { d.policies[0].fields.nope = "read"; })), /"nope" is not a field/);
    assert.match(messages(edit((d) => { d.policies[1].actions.fly = "allow"; })), /"fly" is not an action/);
    assert.match(messages(edit((d) => { d.rules.push({ script: "missing" }); })), /no script "missing"/);
    assert.match(messages(edit((d) => { d.stewards.object = ["sales"]; })), /"sales" is not a department/);
    assert.match(messages(edit((d) => { d.policies[1].when = { eq: [{ record: "colour" }, "red"] }; })), /reads record.colour/);
});

test("a change to one field is approved by that field's stewards only", () => {
    const draft = edit((d) => { d.fields.disposition.label = "Quality decision"; });
    const elements = footprint(lot, draft);
    assert.deepEqual(elements.map((e) => e.element), ["field:disposition"]);
    assert.deepEqual(routeOf(elements), [{ department: "quality", because: ["field:disposition"] }]);
});

test("a policy change also answers to the stewards of the states its condition names", () => {
    const draft = edit((d) => { d.policies.find((p) => p.id === "lot-quality-disposition").when = { in: [{ record: "state" }, ["released"]] }; });
    const route = routeOf(footprint(lot, draft)).map((r) => r.department);
    assert.ok(route.includes("quality"));
});

test("a new field with no stewards of its own falls back to the object's", () => {
    const draft = edit((d) => { d.fields.moisture = { label: "Moisture", type: "decimal" }; });
    assert.deepEqual(routeOf(footprint(lot, draft)).map((r) => r.department), ["production", "quality"]);
});

test("changing stewardship needs the old and the new stewards", () => {
    const draft = edit((d) => { d.stewards.fields.disposition = ["engineering"]; });
    const stewards = footprint(lot, draft).find((e) => e.element === "stewards").stewards;
    assert.deepEqual(stewards, ["engineering", "production", "quality"]);
});

test("a script is stewarded by the objects whose pipes use it", () => {
    const [element] = scriptFootprint("lot_round_qty", "old", "new", definitions);
    assert.deepEqual(element.usedBy, ["lot"]);
    assert.deepEqual(element.stewards, ["production", "quality"]);
});

test("an added element answers to its new stewards only", () => {
    const draft = edit((d) => { d.fields.moisture = { label: "Moisture", type: "decimal" }; d.stewards.fields.moisture = ["quality"]; });
    const field = footprint(lot, draft).find((e) => e.element === "field:moisture");
    assert.deepEqual(field.stewards, ["quality"]);
});

test("renaming a field renames it everywhere the definition names it", () => {
    for (const [from, to] of [["qty", "quantity"], ["scrap_qty", "scrap"], ["lot_no", "number"]]) {
        const renamed = edit((d) => renameField(d, from, to));
        assert.deepEqual(validateDefinition(renamed, known), [], `${from} → ${to}`);
        const json = JSON.stringify(renamed);
        assert.doesNotMatch(json, new RegExp(`"${from}"|:${from}"|"${from}\\.`), `no ${from} left`);
        assert.deepEqual(Object.keys(renamed.fields), Object.keys(lot.fields).map((k) => (k === from ? to : k)), "in its place");
        assert.deepEqual(renamed.fields[to], lot.fields[from]);
    }
    const titled = edit((d) => renameField(d, "lot_no", "number"));
    assert.equal(titled.titleField, "number");
    const hinted = edit((d) => renameField(d, "qty", "quantity"));
    assert.ok(hinted.hints["write:quantity"] && !hinted.hints["write:qty"]);
    assert.ok(hinted.rules.find((r) => r.script === "lot_round_qty").writes.includes("quantity"));
    // Conditions: a reference, and a count of this object's records by the field.
    const cond = renameField({ object: "part", fields: { a: { type: "integer" }, b: { type: "string", requiredWhen: { gt: [{ data: "a" }, 0] } } }, policies: [{ id: "p", roles: ["r"], when: { all: [{ eq: [{ record: "a" }, 1] }, { eq: [{ count: { object: "part", where: { a: 1 } } }, 0] }, { eq: [{ count: { object: "lot", where: { a: 1 } } }, 0] }] } }] }, "a", "amount");
    assert.deepEqual(cond.fields.b.requiredWhen, { gt: [{ data: "amount" }, 0] });
    assert.deepEqual(cond.policies[0].when.all.map((x) => x.eq[0]), [{ record: "amount" }, { count: { object: "part", where: { amount: 1 } } }, { count: { object: "lot", where: { a: 1 } } }]);
});

test("a field's name: its form, reserved words, one already there", () => {
    assert.equal(fieldNameProblem(lot, "quantity"), null);
    assert.match(fieldNameProblem(lot, "Qty"), /lower case/);
    assert.match(fieldNameProblem(lot, "state"), /reserved/);
    assert.match(fieldNameProblem(lot, "uom"), /exists already/);
});

test("approval of record changes (§28): what waits, and for whom", () => {
    const approved = edit((d) => { d.approval = { edit: { fields: ["qty", "disposition"], states: ["in_process", "released"] }, create: true, actions: ["hold"] }; });
    assert.deepEqual(validateDefinition(approved, known), []);
    const m = validateDefinition(edit((d) => { d.approval = { edit: { fields: ["weight"], states: ["lost"] }, create: "yes", actions: ["fly"], also: 1 }; }), known).map((p) => p.message).join("\n");
    for (const expected of [/"weight" is not a field/, /"lost" is not a state/, /true or false/, /"fly" is not an action/, /"also" is not edit, create or actions/]) assert.match(m, expected);
    // What waits.
    assert.equal(needsApproval(approved, { op: "edit", state: "in_process", changed: ["qty"] }), true);
    assert.equal(needsApproval(approved, { op: "edit", state: "in_process", changed: ["uom"] }), false, "another field");
    assert.equal(needsApproval(approved, { op: "edit", state: "created", changed: ["qty"] }), false, "another state");
    assert.equal(needsApproval(approved, { op: "create" }), true);
    assert.equal(needsApproval(approved, { op: "action", action: "hold" }), true);
    assert.equal(needsApproval(approved, { op: "action", action: "start" }), false);
    assert.equal(needsApproval(lot, { op: "edit", state: "in_process", changed: ["qty"] }), false, "no approval designed");
    assert.equal(needsApproval({ approval: { edit: true, actions: true } }, { op: "action", action: "x" }), true);
    // For whom: a field's stewards, else its state's, else the object's.
    assert.deepEqual(recordRoute(lot, { op: "edit", state: "in_process", changed: ["qty"] }), [{ department: "production", because: ["field:qty"] }, { department: "quality", because: ["field:qty"] }]);
    assert.deepEqual(recordRoute(lot, { op: "edit", state: "in_process", changed: ["disposition"] }), [{ department: "quality", because: ["field:disposition"] }]);
    assert.deepEqual(recordRoute(lot, { op: "edit", state: "released", changed: ["qty"] }).map((r) => r.department), ["quality"], "a released lot: its state's stewards");
    assert.deepEqual(recordRoute(lot, { op: "action", state: "in_process", action: "release" }).map((r) => r.department), ["quality"], "an action: its target state's");
    assert.deepEqual(recordRoute(lot, { op: "action", state: "created", action: "hold" }).map((r) => r.department), ["production", "quality"]);
});
