// A policy in words (client/policy-words.js, §9): what it grants beside its name, what to look at, the
// starting points. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grantsWords, togetherWords, policyAdvice, PRESETS, POLICY_ID } from "../client/policy-words.js";

const edit = { id: "desktop-edit", roles: ["editor"], record: { create: true, archive: true }, fields: { "*": "write" } };
const read = { id: "desktop-read", roles: ["viewer", "editor"], record: { read: true }, fields: { "*": "read" } };

test("what a policy grants, in words", () => {
    assert.equal(grantsWords(edit), "editor may create records, archive and restore them and write every field.");
    assert.equal(grantsWords(read), "viewer and editor may read records and read every field.");
    assert.equal(grantsWords({ roles: ["operator"], record: { read: true }, fields: { qty: "write", "*": "read" }, actions: { move_in: "allow" }, when: { eq: [1, 1] }, via: ["move_in"] }, { fieldLabel: (f) => ({ qty: "Quantity" })[f] ?? f }),
        "operator may read records, write Quantity, read every other field and take the action move_in, only while its condition holds, only through the transaction move_in.");
    assert.match(grantsWords({ roles: ["a"], record: { read: true }, when: { eq: [{ record: "state" }, "active"] } }, { conditionWords: () => 'state is "active"' }), /only while state is "active"\.$/);
    assert.match(grantsWords({ roles: ["x"] }), /^Grants x nothing yet/);
    assert.equal(grantsWords({ roles: ["operator", "viewer"], deny: { fields: ["expiry"] } }, { fieldLabel: () => "Expiry" }), "operator and viewer may never write Expiry, whatever else grants it.");
    assert.match(grantsWords({ roles: ["x"], record: { read: true }, deny: { fields: ["cost"] } }), /Never writes cost, whatever else grants it\.$/);
});

test("what a role may do once its other policies are counted too", () => {
    assert.deepEqual(togetherWords(edit, [read, edit]), ["With desktop-read as well, editor may read records, create records, archive and restore them and write every field."]);
    assert.deepEqual(togetherWords(read, [read, edit]), ["With desktop-edit as well, editor may read records, create records, archive and restore them and write every field."], "viewer has no other policy");
    const mixed = togetherWords({ id: "a", roles: ["op"], record: { read: true }, fields: { "*": "read", qty: "write" } }, [{ id: "b", roles: ["op"], fields: { note: "write" }, deny: { fields: ["cost"] }, when: { eq: [1, 1] } }]);
    assert.deepEqual(mixed, ["With b as well, op may read records, write qty and note and read every other field (some of it only under a condition or through a transaction). Never writes cost while a lock's condition holds."]);
    assert.deepEqual(togetherWords(edit, [edit]), []);
    const many = togetherWords({ id: "a", roles: ["op"], record: { read: true } }, ["b", "c", "d"].map((id) => ({ id, roles: ["op"], record: { read: true } })));
    assert.match(many[0], /^With b and 2 other policies as well, op may read records\.$/);
});

test("advice: who may change but reads nowhere, a name saying the opposite", () => {
    assert.deepEqual(policyAdvice(edit, [edit, read]), [], "reading through desktop-read: the summary says so, nothing to warn");
    const blind = policyAdvice(edit, [edit]);
    assert.equal(blind[0].tone, "warn");
    assert.match(blind[0].words, /editor may change records, but no policy lets it read records/);
    assert.match(policyAdvice({ ...read, fields: { "*": "write" } }, [])[0].words, /name says reading, but it lets viewer and editor change records/);
    assert.match(policyAdvice({ id: "lot_edit", roles: ["operator"], record: { read: true }, fields: { "*": "read" } }, [])[0].words, /name says editing, but it lets operator change nothing/);
    assert.deepEqual(policyAdvice({ id: "lot_quality", roles: ["quality"], record: { read: true }, fields: { "*": "read" } }, []), []);
});

test("starting points, and a policy's name", () => {
    const r = { id: "p", roles: ["a"], record: { read: true, archive: true }, fields: { qty: "write" }, actions: { hold: "allow" }, via: ["t"] };
    const by = Object.fromEntries(PRESETS.map((p) => [p.key, p]));
    const ro = structuredCloneish(r); by.read.apply(ro);
    assert.deepEqual([ro.record, ro.fields, ro.actions, ro.via], [{ read: true }, { "*": "read" }, { hold: "allow" }, ["t"]]);
    const ed = structuredCloneish(r); by.edit.apply(ed);
    assert.deepEqual([ed.record, ed.fields], [{ read: true, archive: true, create: true }, { "*": "write" }]);
    const no = structuredCloneish(r); by.none.apply(no);
    assert.deepEqual([no.record, no.fields, no.actions], [{}, {}, undefined]);
    assert.ok(POLICY_ID.test("desktop-read") && POLICY_ID.test("lot_quality_edit") && !POLICY_ID.test("Lot read") && !POLICY_ID.test("1lot"));
});
function structuredCloneish(v) { return JSON.parse(JSON.stringify(v)); }
