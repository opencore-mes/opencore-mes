// Comparing a change with what is published (client/compare.js). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { objectChanges, serviceChanges, countByTab, lineDiff, statusMaps } from "../client/compare.js";
import { definitions } from "../db/seed.mjs";

const lot = definitions.find((d) => d.object === "lot");

test("each difference is placed on the tab where it is edited", () => {
    const after = structuredClone(lot);
    after.fields.batch_ref = { label: "Batch reference", type: "string" };
    after.fields.qty.label = "Quantity (net)";
    delete after.fields.expiry;
    after.policies = after.policies.filter((p) => p.id !== "lot-archive");
    after.policies[0].fields = { "*": "read", batch_ref: "read" };
    after.form = { tabs: [{ label: "Lot", sections: after.form.sections }] };
    after.analytics = { dimensions: ["item"] };
    const changes = objectChanges(lot, after, { lot_round_qty: { before: "a\nb", after: "a\nc" } });
    const where = Object.fromEntries(changes.map((c) => [c.element, `${c.tab}:${c.change}`]));
    assert.equal(where["field:batch_ref"], "fields:added");
    assert.equal(where["field:qty"], "fields:changed");
    assert.equal(where["field:expiry"], "fields:removed");
    assert.equal(where["policy:lot-archive"], "access:removed");
    assert.equal(where["policy:lot-read"], "access:changed");
    assert.equal(where.form, "layout:changed");
    assert.equal(where.analytics, "general:changed");
    assert.equal(where["script:lot_round_qty"], "rules:changed");
    assert.deepEqual(countByTab(changes), { fields: 3, access: 2, layout: 1, general: 1, rules: 1 });
    assert.deepEqual(objectChanges(lot, structuredClone(lot)), [], "nothing changed, nothing listed");
});

test("a service's differences, by its tabs", () => {
    const before = { name: "s", label: "S", on: [], uses: { objects: {} }, callers: { users: [] } };
    const after = { ...before, on: [{ schedule: { every: { minutes: 5 } } }], runOn: "erp", callers: { users: ["erp"] } };
    const tabs = serviceChanges(before, after, { before: "x", after: "x" }).map((c) => c.tab);
    assert.deepEqual(tabs.sort(), ["callers", "triggers", "triggers"]);
});

test("line by line: what stayed, what was added, what was taken out", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nc\nd\ne");
    assert.deepEqual(d.map((l) => `${l.op}${l.text}`), [" a", "-b", " c", " d", "+e"]);
    assert.deepEqual(lineDiff("", "x").map((l) => l.op), ["+"]);  // nothing before: only the added line
});

test("inside the tabs: which fields, policies and layout places are new or changed", () => {
    const after = structuredClone(lot);
    after.fields.batch_ref = { label: "Batch reference", type: "string" };
    after.fields.qty.required = false;
    after.form.sections[0].fields.push("batch_ref");
    after.form.sections[1].fields[0] = { field: "qty", width: 6 };
    const m = statusMaps(lot, after);
    assert.deepEqual(m.fields, { batch_ref: "added", qty: "changed" });
    assert.equal(m.layout.batch_ref, "added");
    assert.equal(m.layout.qty, "changed");
    assert.equal(m.layout.item, undefined, "a field that did not move is not marked");
});
