// Design packs (§29.6) without a database: a pack's shape, what in it is new or changed, the roles it
// suggests, the state its sample records reach. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packProblems, packStatus, missingRoles, stateAfter, resolveRefs, packFiles, missingCertifications, missingGroups, forInstalled } from "../server/packs.js";
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

test("a pack's files (§35.4): a list of { path, name? }; each read by its bytes, named by its SHA-256; one missing or of another kind named", async () => {
    const base = { label: "P", version: "1" };
    assert.deepEqual(packProblems({ ...base, files: [{ path: new URL("./fixtures/guide.pdf", import.meta.url), name: "Guide.pdf" }] }), []);
    assert.match(packProblems({ ...base, files: [{ path: "guide.pdf" }] }).join(), /designs.files: a list of \{ path: a file: URL, name\? \}/);
    const [f] = await packFiles({ files: [{ path: new URL("./fixtures/guide.pdf", import.meta.url) }] });
    assert.equal(f.type, "application/pdf");
    assert.equal(f.name, "guide.pdf");
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    await assert.rejects(packFiles({ files: [{ path: new URL("./fixtures/none.pdf", import.meta.url) }] }, "suite x: designs"), /suite x: designs.files\[0\]: .*none\.pdf cannot be read/);
    const odd = join(tmpdir(), `pack-file-${process.pid}.bin`);
    await writeFile(odd, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
    await assert.rejects(packFiles({ files: [{ path: pathToFileURL(odd) }] }), /is not a picture, a PDF, a video/);
    await rm(odd, { force: true });
});

test("certifications a pack suggests (§27.9): those the organization does not list; their shape", () => {
    const pack = { label: "P", version: "1", certifications: { kiln_firing: { name: "Kiln firing" }, itar: { name: "ITAR" } } };
    assert.deepEqual(packProblems(pack), []);
    assert.deepEqual(missingCertifications(pack, { certifications: { itar: { name: "ITAR export control" } } }).map(([id]) => id), ["kiln_firing"]);
    assert.match(packProblems({ label: "P", version: "1", certifications: { "Bad id": { name: "x" } } }).join(), /designs.certifications/);
    assert.match(packProblems({ label: "P", version: "1", certifications: { ok: {} } }).join(), /designs.certifications/);
});

test("groups a pack brings (§29.6): those the plant has neither as a group nor a department, empty; roles given to them suggested", () => {
    const pack = { label: "P", version: "1", groups: { crib_keepers: { name: "Tool crib keepers" }, production: { name: "Production" } }, roles: { tool: { keeper: ["group:crib_keepers"], operator: ["group:nobody"] } } };
    const org = { departments: { production: { name: "Production", members: [] } }, groups: {}, users: {}, roles: {} };
    assert.deepEqual(packProblems(pack), []);
    assert.deepEqual(missingGroups(pack, org), [["crib_keepers", { name: "Tool crib keepers" }]]);
    assert.deepEqual(missingGroups(pack, { ...org, groups: { crib_keepers: { name: "Crib", members: ["olga"] } } }), []);
    assert.deepEqual(missingRoles(pack, org), [["tool", "keeper", "group:crib_keepers"]]);
    assert.match(packProblems({ label: "P", version: "1", groups: { "Crib people": { name: "x" } } }).join(), /designs.groups/);
    assert.match(packProblems({ label: "P", version: "1", groups: { crib: {} } }).join(), /designs.groups/);
});

test("what a pack brings only with another suite (onlyWith) is offered only where that suite is installed", () => {
    const pack = { label: "P", version: "1", definitions: [{ object: "x_week" }], services: [{ name: "x_from_cal" }, { name: "x_other" }], scripts: { x_from_cal: "…", x_other: "…" }, tests: { x_from_cal: [] },
        onlyWith: { calendar: { services: ["x_from_cal"], scripts: ["x_from_cal"], tests: ["x_from_cal"] } } };
    assert.deepEqual(packProblems(pack), []);
    const alone = forInstalled(pack, ["x"]);
    assert.deepEqual([alone.services.map((b) => b.name), Object.keys(alone.scripts), Object.keys(alone.tests), alone.definitions.length], [["x_other"], ["x_other"], [], 1]);
    assert.equal(forInstalled(pack, ["x", "calendar"]), pack);
    assert.match(packProblems({ label: "P", version: "1", onlyWith: { calendar: { widgets: ["a"] } } }).join(), /designs.onlyWith/);
});

test("a sample found by its fields may carry a key, so later samples name it (a certification for a Person)", () => {
    const base = { label: "P", version: "1" };
    assert.deepEqual(packProblems({ ...base, records: [{ key: "olga", object: "person", find: { user: "olga" }, set: {} }, { key: "c", object: "certification", data: { person: "@olga", kind: "x" } }] }), []);
    assert.match(packProblems({ ...base, records: [{ key: "a", object: "person", find: { user: "olga" }, set: {} }, { key: "a", object: "lot", data: {} }] }).join(), /the key "a" twice/);
});

// A pack's named queries (§23.1): what a reference's choices are drawn from (a tester fit for a board).
test("a pack's named queries are elements like the rest", async () => {
    const { packElements } = await import("../server/packs.js");
    const query = { name: "p_fit", label: "Fit", sql: "SELECT id FROM lot WHERE item = :item", params: { item: { type: "string" } }, stewards: ["production"] };
    const pack = { label: "P", version: "1", queries: [query] };
    assert.deepEqual(packProblems(pack), []);
    assert.ok(packProblems({ ...pack, queries: [{ label: "no name" }] }).some((w) => /designs\.queries: a list of bodies, each with its name/.test(w)));
    assert.deepEqual(Object.keys(packElements(pack).queries), ["p_fit"]);
    const live = { definitions: {}, scripts: {}, connections: {}, services: {}, transactions: {}, screens: {}, flows: {}, layouts: {}, elements: {}, queries: { p_fit: { version: 1, body: { ...query, sql: "SELECT id FROM lot" } } } };
    assert.deepEqual(packStatus(pack, live).map((e) => `${e.kind}:${e.name}:${e.status}`), ["queries:p_fit:changed"]);
});
