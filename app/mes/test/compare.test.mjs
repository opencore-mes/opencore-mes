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

// A change's differences are drawn by ChangesView for every kind an editor opens it for, each grouped by its
// kind's tabs: a kind with none failed to draw (a flow's change, opened by its reviewer).
test("every kind an editor shows the differences of has its tabs, and a flow's fall on them", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../client/", import.meta.url);
    const designer = readFileSync(new URL("designer.js", dir), "utf8");
    const map = /const tabs = \{([^}]*)\}\[kind\]/.exec(designer)?.[1] ?? "";
    const known = new Set([...map.matchAll(/(\w+):/g)].map((m) => m[1]));
    const asked = new Set(["service", "connection"]); // integration-editor.js passes its own kind, one of these
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
        for (const m of readFileSync(new URL(file, dir), "utf8").matchAll(/ChangesView: \{[^}]*kind: "(\w+)"/g)) asked.add(m[1]);
    }
    for (const kind of asked) assert.ok(known.has(kind), `ChangesView has no tabs for ${kind}`);
    const { flowChanges, FLOW_TABS } = await import("../client/compare.js");
    const changes = flowChanges(null, { label: "OCAP", kind: "plan", nodes: { start: { kind: "start" } }, edges: [], participants: { record_1: { object: "deviation", as: "subject" } }, stewards: ["engineering"] });
    assert.ok(changes.length > 0 && changes.every((c) => Object.hasOwn(FLOW_TABS, c.tab)), JSON.stringify(changes.map((c) => c.tab)));
});
