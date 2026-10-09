// The data integrity review's seals and settings (§7.7), without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealOfRecord, sealOfBody, integrityKey, keyId } from "../server/integrity.js";
import { integrityProblems, validateOrganization, kindOfElement, PSEUDO_ROLES } from "../client/definition.js";

const KEY = Buffer.from("11".repeat(32), "hex");
const row = { row_version: 3, type: null, state: "on_hold", data: { qty: 10, lot_no: "4711", uom: "kg" }, archived_by: null };

test("a record's seal: the same for the same contents, whatever the order of its fields or the type of its version", () => {
    const a = sealOfRecord("lot", row, KEY);
    assert.equal(sealOfRecord("lot", { ...row, data: { uom: "kg", lot_no: "4711", qty: 10 } }, KEY), a);
    assert.equal(sealOfRecord("lot", { ...row, row_version: "3" }, KEY), a, "the database answers a bigint as text");
    assert.equal(sealOfRecord("lot", { ...row, updated_at: new Date(), seal: "x" }, KEY), a, "what is not sealed does not count");
    assert.match(a, /^[0-9a-f]{64}$/);
});

test("a record's seal changes with anything that decides it: its data, state, type, version, archive, object, key", () => {
    const a = sealOfRecord("lot", row, KEY);
    for (const other of [
        { ...row, data: { ...row.data, qty: 11 } }, { ...row, state: "released" }, { ...row, type: "resin" }, { ...row, row_version: 4 }, { ...row, archived_by: "sam" },
    ]) assert.notEqual(sealOfRecord("lot", other, KEY), a, JSON.stringify(other));
    assert.notEqual(sealOfRecord("machine", row, KEY), a, "the same row under another object");
    assert.notEqual(sealOfRecord("lot", row, Buffer.from("22".repeat(32), "hex")), a, "another key");
    assert.notEqual(sealOfRecord("lot", row, null), a, "no key: a plain digest");
    assert.equal(sealOfRecord("lot", { ...row, data: { ...row.data, note: undefined } }, KEY), a, "an undefined field is no field, as stored");
});

test("a design's seal: its kind, name and body", () => {
    const body = { label: "Lot", fields: { qty: { type: "decimal" } } };
    assert.equal(sealOfBody("definitions", "lot", body, KEY), sealOfBody("definitions", "lot", JSON.parse(JSON.stringify(body)), KEY));
    assert.notEqual(sealOfBody("definitions", "lot", { ...body, label: "Lot (by hand)" }, KEY), sealOfBody("definitions", "lot", body, KEY));
    assert.notEqual(sealOfBody("screens", "lot", body, KEY), sealOfBody("definitions", "lot", body, KEY));
});

test("the key: 64 hex characters or none; its id tells keys apart without saying them", () => {
    assert.equal(integrityKey({}), null);
    assert.deepEqual(integrityKey({ INTEGRITY_KEY: "11".repeat(32) }), KEY);
    assert.throws(() => integrityKey({ INTEGRITY_KEY: "short" }), /64 hex characters/);
    assert.equal(keyId(null), "none");
    assert.match(keyId(KEY), /^[0-9a-f]{16}$/);
    assert.notEqual(keyId(KEY), keyId(Buffer.from("22".repeat(32), "hex")));
    assert.ok(!KEY.toString("hex").includes(keyId(KEY)));
});

test("the organization's report object: an object, its fields mapped to parts of the report, fixed values", () => {
    assert.deepEqual(integrityProblems(undefined), []);
    assert.deepEqual(integrityProblems({ reportObject: "deviation", fields: { title: "finding", description: "what", root_cause: "why" }, values: { severity: "major" } }), []);
    assert.match(integrityProblems("deviation").join(), /\{ reportObject, fields \}/);
    assert.match(integrityProblems({ reportObject: "Deviation!", fields: { a: "what" } }).join(), /an object's name/);
    assert.match(integrityProblems({ reportObject: "deviation" }).join(), /say which of the report object's fields/);
    assert.match(integrityProblems({ reportObject: "deviation", fields: { title: "nothing" } }).join(), /title takes one of what, why, decision, action, finding/);
    assert.match(integrityProblems({ reportObject: "deviation", fields: { title: "what" }, values: { title: "x" } }).join(), /a part of the report or a value, not both/);
    assert.match(integrityProblems({ reportObject: "deviation", fields: { title: "what" }, values: { severity: { a: 1 } } }).join(), /a text, a number or true\/false/);
    assert.match(integrityProblems({ reportObject: "deviation", fields: { title: "what" }, other: 1 }).join(), /not "other"/);
    assert.equal(kindOfElement("integrity"), "organization", "approved by governance");
    assert.deepEqual(PSEUDO_ROLES.integrity, ["reviewer"]);
    const org = { governance: "engineering", departments: { engineering: { name: "Engineering", members: [], approval: [] } }, users: {}, groups: {}, roles: {}, standing: {}, integrity: { reportObject: "deviation" } };
    assert.ok(validateOrganization(org, { objects: {} }).some((p) => p.path === "integrity"));
});
