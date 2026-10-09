// The expression builder's pure parts (client/expr-builder.js, DESIGN.md §9.2a). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wordsOf, problemsOf, rowOf, nodeOfRow, patternsFor, objectEntries, scope, userScope, opsFor, newRow } from "../client/expr-builder.js";
import { evaluate } from "../client/expr.js";

const lot = { label: "Lot", states: ["created", "on_hold", "released"], fields: { qty: { label: "Quantity", type: "decimal" }, scrap: { label: "Scrap", type: "decimal" }, disposition: { label: "Disposition", type: "enum", values: ["pending", "accept", "reject"] }, uom: { type: "enum", values: ["kg", "ea"] }, tags: { type: "enum", values: ["a", "b"], multiple: true } } };
const spec = { scopes: { record: scope("the lot", objectEntries(lot)), user: userScope(["supervisor", "operator"]) } };

test("in words, with the place's labels", () => {
    assert.equal(wordsOf({ all: [{ eq: [{ record: "state" }, "on_hold"] }, { gt: [{ record: "qty" }, 0] }] }, spec), 'state is "on_hold" and Quantity is more than 0');
    assert.equal(wordsOf({ any: [{ in: [{ record: "disposition" }, ["accept", "reject"]] }, { not: { is_null: { record: "qty" } } }] }, spec), 'Disposition is one of "accept", "reject" or Quantity is not empty');
    assert.equal(wordsOf({ not: { any: [{ is_null: { record: "qty" } }] } }, spec), "none of (Quantity is empty)");
    assert.equal(wordsOf({ contains: [{ user: "roles" }, "supervisor"] }, spec), 'their roles include "supervisor"');
    assert.equal(wordsOf({ gt: [{ count: { object: "lot", where: { machine: { input: "machine" }, state: ["processing"] } } }, 2] }, spec), 'the number of lot records where machine is input machine and state is one of "processing" is more than 2');
});

test("a row and back: the same node; what is more than a row is not a row", () => {
    for (const n of [{ eq: [{ record: "state" }, "on_hold"] }, { ne: [{ record: "qty" }, { record: "qty" }] }, { in: [{ record: "uom" }, ["kg"]] }, { contains: [{ user: "roles" }, "operator"] }, { is_null: { record: "qty" } }, { not: { is_null: { record: "qty" } } }]) {
        assert.deepEqual(nodeOfRow(rowOf(n)), n, JSON.stringify(n));
    }
    assert.equal(rowOf({ gt: [{ add: [{ record: "qty" }, 1] }, 3] }), null);
    assert.equal(rowOf({ all: [] }), null);
    assert.deepEqual(opsFor("list"), ["contains", "is_null", "not_null"]);
    assert.deepEqual(newRow(spec), { eq: [{ record: "state" }, "created"] });
});

test("what is wrong with it, here: a scope the place cannot read, a field it does not have, a node that does not read", () => {
    assert.deepEqual(problemsOf({ eq: [{ record: "state" }, "x"] }, spec), []);
    assert.match(problemsOf({ eq: [{ input: "qty" }, 1] }, spec)[0], /reads input \(qty\), which this place cannot read: it reads record, user/);
    assert.match(problemsOf({ eq: [{ record: "nope" }, 1] }, spec)[0], /the lot has no "nope"/);
    assert.match(problemsOf({ eq: [1, 2], ne: [1, 2] }, spec)[0], /does not read as an expression/);
    assert.deepEqual(problemsOf(undefined, spec), []);
});

test("patterns: filled in with what the place reads, each one an expression that evaluates", () => {
    const ps = patternsFor(spec);
    assert.deepEqual(ps.map((p) => p.id), ["state", "one_of", "empty", "not_empty", "between", "same", "role"]);
    for (const p of ps) assert.doesNotThrow(() => evaluate(p.node, { record: { state: "created", qty: 3, disposition: "accept" }, user: { roles: ["operator"] } }), p.id);
    assert.deepEqual(ps.find((p) => p.id === "role").node, { contains: [{ user: "roles" }, "supervisor"] });
    assert.ok(patternsFor({ ...spec, count: ["lot"] }).some((p) => p.id === "count"));
});
