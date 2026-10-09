// Derived fields (DESIGN.md §6.11): their paths, their values through references, what reads through
// what, and the checks a design passes. The writes themselves are in test/derived.mjs (e2e).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hopsOf, withDerived, dependencies, dependentObjects, derivedCycles, changedDerived, derivedProblems, pathsOf } from "../server/derived.js";
import { validateDefinition } from "../client/definition.js";
import { decide } from "../server/policy.js";

const PRODUCT = { object: "product", label: "Product", fields: { code: { type: "string" }, control: { type: "enum", values: ["none", "military"] }, secret: { type: "string", sensitive: true } }, states: { initial: "draft", list: ["draft", "released"], transitions: [] } };
const LOT = { object: "lot", label: "Lot", fields: { lot_id: { type: "string" }, product: { type: "ref", to: "product" }, control: { type: "string", from: "product.control" }, released: { type: "boolean", from: { eq: [{ record: "product.state" }, "released"] } } }, states: { initial: "open", list: ["open"], transitions: [] } };
const WAFER = { object: "wafer", label: "Wafer", fields: { lot: { type: "ref", to: "lot" }, control: { type: "string", from: "lot.control" }, product_code: { type: "string", from: "lot.product.code" } }, states: { initial: "in", list: ["in"], transitions: [] } };
const defs = new Map([["product", PRODUCT], ["lot", LOT], ["wafer", WAFER]]);
const defOf = (o) => defs.get(o) ?? null;
const P = "11111111-1111-4111-8111-111111111111";
const L = "22222222-2222-4222-8222-222222222222";
const rows = { [`product:${P}`]: { data: { code: "MIL-1", control: "military" }, state: "released" }, [`lot:${L}`]: { data: { lot_id: "A1", product: P, control: "military" }, state: "open" } };
const load = async (object, id) => rows[`${object}:${id}`] ?? null;

test("a path's hops go by single references to a field or a state", () => {
    assert.deepEqual(hopsOf(LOT, "product.control", defOf), [{ object: "lot", field: "product" }, { object: "product", field: "control" }]);
    assert.deepEqual(hopsOf(WAFER, "lot.product.code", defOf).map((h) => h.object), ["wafer", "lot", "product"]);
    assert.deepEqual(hopsOf(LOT, "product.state", defOf).at(-1), { object: "product", field: "state" });
    assert.equal(hopsOf(LOT, "product.nothing", defOf), null);
    assert.equal(hopsOf(LOT, "lot_id.x", defOf), null);
    assert.deepEqual(pathsOf(LOT, LOT.fields.released), ["product.state"]);
});

test("values are read through the references, a path or an expression; an empty reference gives an empty value", async () => {
    assert.deepEqual(await withDerived(LOT, { lot_id: "A1", product: P }, defOf, load), { lot_id: "A1", product: P, control: "military", released: true });
    assert.deepEqual(await withDerived(WAFER, { lot: L }, defOf, load), { lot: L, control: "military", product_code: "MIL-1" });
    assert.deepEqual(await withDerived(LOT, { lot_id: "A2", product: null, control: "stale" }, defOf, load), { lot_id: "A2", product: null, control: null, released: false });
    assert.deepEqual(await withDerived(LOT, { product: "33333333-3333-4333-8333-333333333333" }, defOf, load), { product: "33333333-3333-4333-8333-333333333333", control: null, released: false });
});

test("what reads through what: a product's change reaches its lots and, through them, their wafers", () => {
    const deps = dependencies(defs);
    assert.ok(deps.some((d) => d.object === "wafer" && d.field === "product_code" && d.hops.length === 3));
    assert.deepEqual(dependentObjects(defs, "product").sort(), ["lot", "wafer"]);
    assert.deepEqual(dependentObjects(defs, "lot"), ["wafer"]);
    assert.deepEqual(dependentObjects(defs, "wafer"), []);
    // The same map read twice gives the same answer, worked out once.
    assert.equal(dependencies(defs), dependencies(defs));
});

test("a change adding derived fields works out the objects in the order they read each other", () => {
    const before = new Map([["product", PRODUCT], ["lot", { ...LOT, fields: { lot_id: LOT.fields.lot_id, product: LOT.fields.product } }], ["wafer", { ...WAFER, fields: { lot: WAFER.fields.lot } }]]);
    const order = changedDerived(before, defs);
    assert.deepEqual(order, ["lot", "wafer"]);
    assert.deepEqual(changedDerived(defs, defs), []);
});

test("a loop of derived fields is found; the checks say a path that does not go, a sensitive end, a wrong type", () => {
    const A = { object: "a", fields: { b: { type: "ref", to: "b" }, x: { type: "string", from: "b.y" } } };
    const B = { object: "b", fields: { a: { type: "ref", to: "a" }, y: { type: "string", from: "a.x" } } };
    const loops = derivedCycles(new Map([["a", A], ["b", B]]));
    assert.equal(loops.length, 1);
    assert.deepEqual(loops[0].cycle.slice(0, 1).concat(loops[0].cycle.at(-1)), [loops[0].cycle[0], loops[0].cycle[0]]);
    assert.deepEqual(derivedCycles(defs), []);

    const bad = { ...LOT, fields: { ...LOT.fields, a: { type: "string", from: "product.nothing" }, b: { type: "string", from: "product.secret" }, c: { type: "integer", from: "product.code" } } };
    const words = derivedProblems(bad, defOf).map((p) => p.message).join("\n");
    assert.match(words, /"a": product\.nothing does not go/);
    assert.match(words, /"b": product\.secret is sensitive/);
    assert.match(words, /"c" is integer, and product\.code is string/);
    assert.deepEqual(derivedProblems(LOT, defOf), []);
});

test("its shape: a path through a reference or an expression on the record; never required, sensitive or a picture", () => {
    const known = { objects: ["product", "lot"] };
    const check = (field) => validateDefinition({ ...LOT, fields: { product: LOT.fields.product, x: field } }, known).filter((p) => p.path.startsWith("fields.x")).map((p) => p.message).join("\n");
    assert.equal(check({ type: "string", from: "product.control" }), "");
    assert.match(check({ type: "string", from: "control" }), /a path through a reference/);
    assert.match(check({ type: "string", from: "lot_id.code" }), /not a reference of this object/);
    assert.match(check({ type: "string", from: "product.control", required: true }), /cannot be required/);
    assert.match(check({ type: "string", from: "product.control", sensitive: true }), /cannot be sensitive/);
    assert.match(check({ type: "boolean", from: { eq: [{ user: "id" }, "x"] } }), /reads user/);
    assert.match(check({ type: "boolean", from: { eq: [{ record: "x" }, "x"] } }), /reads itself/);
    assert.match(check({ type: "boolean", from: { all: [{ record: "product" }, { eq: [{ record: "product.control" }, "military"] }] } }), /both as a reference and through it/);
});

test("nobody writes a derived field, whatever their policies give", () => {
    const def = { ...LOT, policies: [{ id: "all", roles: ["editor"], record: { read: true, create: true }, fields: { "*": "write" } }] };
    const d = decide(def, { id: "dana", roles: ["editor"] }, { lot_id: "A1", state: "open" });
    assert.equal(d.fields.lot_id, "w");
    assert.equal(d.fields.control, "r");
    assert.equal(d.why.control, "derived");
});
