// Design packs (§29.6) without a database: a pack's shape, what in it is new or changed, the roles it
// suggests, the state its sample records reach. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { packProblems, packStatus, missingRoles, stateAfter, resolveRefs } from "../server/packs.js";
import { definitions } from "../db/seed.mjs";

const lot = definitions.find((d) => d.object === "lot");

test("a pack's shape: what is wrong is named", () => {
    assert.deepEqual(packProblems({ label: "P", version: "1", definitions: [lot], records: [{ key: "a", object: "lot", data: {} }, { ref: "a", set: { qty: 1 } }] }), []);
    const words = packProblems({ label: "", definitions: [{}], scripts: { x: 1 }, records: [{ key: "a", object: "lot", data: {} }, { key: "a", object: "lot", data: {} }, { ref: "b", set: {} }, { object: "lot" }] }).join("\n");
    for (const m of [/designs.label/, /designs.version/, /definitions: a list of bodies, each with its object/, /scripts.x: its source/, /the key "a" twice/, /\{ ref, set \} names a record listed before it/, /records\[3\]: \{ key, object, data, actions\? \}/]) assert.match(words, m);
});

test("new, changed and the same, against what is live; roles missing, for subjects that exist", () => {
    const live = { definitions: { lot: { body: JSON.parse(JSON.stringify(lot)) } }, transactions: {}, screens: {}, scripts: { s: { source: "a" } } };
    const status = packStatus({ definitions: [lot, { ...lot, object: "lot2" }], scripts: { s: "b" } }, live);
    assert.deepEqual(status.map((e) => `${e.name}:${e.status}`), ["lot:same", "lot2:new", "s:changed"]);
    const org = { groups: { production: {} }, users: { sam: {} }, roles: { lot: { operator: ["group:production"] } } };
    assert.deepEqual(missingRoles({ roles: { lot: { operator: ["group:production", "user:sam", "group:nowhere", "user:nobody"] } } }, org), [["lot", "operator", "user:sam"]]);
});

test("a sample's state: its actions in turn from the initial state; @key is the id made for it", () => {
    assert.equal(stateAfter(lot, []), "created");
    assert.equal(stateAfter(lot, ["move_in", "track_in"]), "processing");
    assert.equal(stateAfter(lot, ["consume"]), null);
    assert.deepEqual(resolveRefs({ a: "@k", b: "x", c: 1, d: "@none" }, { k: "id-1" }), { a: "id-1", b: "x", c: 1, d: null });
});

// A model file (§24.1) is a pack that carries services and connections too.
test("a pack's services and connections are elements like the rest", async () => {
    const { packElements } = await import("../server/packs.js");
    const pack = { label: "Model", version: "1", connections: [{ name: "erp", label: "ERP", baseUrl: "https://erp.example" }], services: [{ name: "erp_order", label: "Order" }], scripts: { erp_order: "export default async function erp_order(ctx) { return ctx; }" } };
    assert.deepEqual(packProblems(pack), []);
    assert.ok(packProblems({ ...pack, services: [{ label: "no name" }] }).some((w) => /designs\.services/.test(w)));
    const live = { definitions: {}, scripts: { erp_order: { version: 3, source: pack.scripts.erp_order } }, connections: { erp: { version: 2, body: { name: "erp", label: "ERP", baseUrl: "https://old.example" } } }, services: {}, transactions: {}, screens: {}, flows: {}, layouts: {} };
    assert.deepEqual(Object.keys(packElements(pack).connections), ["erp"]);
    const status = Object.fromEntries(packStatus(pack, live).map((e) => [`${e.kind}:${e.name}`, e.status]));
    assert.deepEqual(status, { "connections:erp": "changed", "services:erp_order": "new", "scripts:erp_order": "same" });
});
