// An object's roles and policies at a glance (§9.8): what each role may do, over every policy.
import test from "node:test";
import assert from "node:assert/strict";
import { policyMatrix, cellWords, cellWhy } from "../client/policy-matrix.js";

const body = {
    roles: ["engineer", "operator", "viewer", "nobody"],
    fields: { name: { label: "Name" }, picture: { label: "Picture" }, cost: {}, note: {} },
    states: { transitions: [{ action: "start" }, { action: "break_down" }, { action: "start" }] },
    policies: [
        { id: "read", roles: ["engineer", "operator", "viewer"], record: { read: true }, fields: { "*": "read" } },
        { id: "edit", roles: ["engineer"], record: { read: true, create: true }, fields: { "*": "write" }, actions: { start: "allow", break_down: "allow" }, deny: { fields: ["cost"] } },
        { id: "run", roles: ["operator"], when: { eq: [{ record: "state" }, "idle"] }, fields: { note: "write" }, actions: { start: "allow" } },
        { id: "moved", roles: ["operator"], via: ["move_in"], fields: { picture: "write" } },
        { id: "secret", roles: ["viewer"], deny: { read: ["cost"], actions: ["start"] } },
    ],
};
const m = policyMatrix(body);
const at = (key, role) => m.rows.find((r) => r.key === key).cells[role];
const said = (key, role) => cellWords(at(key, role), m.rows.find((r) => r.key === key).kind).text;

test("the rows are the records, each field and each action; the columns the object's roles", () => {
    assert.deepEqual(m.roles, body.roles);
    assert.deepEqual(m.rows.map((r) => `${r.kind}:${r.key}`), ["record:read", "record:create", "record:archive", "field:name", "field:picture", "field:cost", "field:note", "action:start", "action:break_down"]);
    assert.equal(m.rows.find((r) => r.key === "picture").label, "Picture");
});

test("a role's rights are the most its policies grant; a grant under a condition is sometimes", () => {
    assert.equal(said("read", "engineer"), "yes");
    assert.equal(said("create", "engineer"), "yes");
    assert.equal(said("create", "operator"), "—");
    assert.equal(said("name", "engineer"), "write");
    assert.equal(said("name", "operator"), "read");
    assert.equal(said("note", "operator"), "write*", "write, only while idle");
    assert.equal(said("picture", "operator"), "write*", "write, only through a transaction");
    assert.equal(said("start", "operator"), "allow*");
    assert.equal(said("start", "engineer"), "allow");
    assert.equal(said("break_down", "viewer"), "—");
});

test("a deny wins: a locked field is read at most, a hidden one is not read, a refused action is refused", () => {
    assert.equal(said("cost", "engineer"), "read (locked)");
    assert.equal(cellWords(at("cost", "engineer"), "field").tone, "deny");
    assert.equal(said("cost", "viewer"), "hidden");
    assert.equal(said("start", "viewer"), "refused");
});

test("a role no policy names may do nothing; a field is read only by who may read records", () => {
    assert.ok(m.rows.every((r) => cellWords(r.cells.nobody, r.kind).text === "—"));
    const blind = policyMatrix({ roles: ["x"], fields: { a: {} }, states: { transitions: [] }, policies: [{ id: "p", roles: ["x"], fields: { a: "write" } }] });
    assert.equal(cellWords(blind.rows.find((r) => r.key === "a").cells.x, "field").text, "—");
});

test("a cell says which policies make it so", () => {
    assert.equal(cellWhy(at("note", "operator")), "by read; by run (under its condition)");
    assert.equal(cellWhy(at("cost", "viewer")), "by read; denied by secret");
    assert.equal(cellWhy(at("create", "viewer")), "no policy grants it");
});

test("a draft half written does not break it", () => {
    assert.deepEqual(policyMatrix({}).rows.map((r) => r.key), ["read", "create", "archive"]);
    assert.doesNotThrow(() => policyMatrix({ roles: ["a"], policies: [null, { roles: "a" }, { id: "p", roles: ["a"], fields: "x", deny: { fields: "cost" } }], fields: { f: null }, states: {} }));
});

// ---- changing a grant from the grid ----
import { policiesFor, quickTarget, nextGrant, setGrant, grantIn } from "../client/policy-matrix.js";

test("a change from the grid is a change to one policy: its own grant, cycled", () => {
    assert.deepEqual(["", "read", "write"].map((v) => nextGrant("field", v)), ["read", "write", ""]);
    assert.deepEqual(["", "yes"].map((v) => nextGrant("action", v)), ["yes", ""]);
    const p = { id: "p", roles: ["a"] };
    assert.deepEqual(setGrant(p, "field", "name", "read").fields, { name: "read" });
    assert.deepEqual(setGrant(p, "record", "create", "yes").record, { create: true });
    assert.deepEqual(setGrant(p, "action", "start", "yes").actions, { start: "allow" });
    assert.equal(grantIn(p, "action", "start"), "yes");
    setGrant(p, "field", "name", ""); setGrant(p, "record", "create", ""); setGrant(p, "action", "start", "");
    assert.deepEqual([p.fields, p.record, p.actions], [{}, {}, {}]);
});

test("the policies a cell's change may go to are those naming the role; a shared one says whom else it is for", () => {
    const of = policiesFor(body, "operator", "field", "note");
    assert.deepEqual(of.map((x) => [x.id, x.own, x.when, x.value, x.star, x.others.join()]), [["read", false, false, "", "read", "engineer,viewer"], ["run", true, true, "write", "", ""], ["moved", true, true, "", "", ""]]);
    assert.deepEqual(policiesFor(body, "nobody", "field", "note"), []);
});

test("a double click changes at once only where there is no doubt: one policy, the role's alone, always applying", () => {
    assert.equal(quickTarget(body, "engineer", "field", "name").id, "edit");
    assert.equal(quickTarget(body, "operator", "field", "note"), null, "its own policies are conditional");
    assert.equal(quickTarget(body, "viewer", "action", "start").id, "secret");
    assert.equal(quickTarget(body, "nobody", "field", "name"), null);
    const two = { ...body, policies: [...body.policies, { id: "edit2", roles: ["engineer"] }] };
    assert.equal(quickTarget(two, "engineer", "field", "name"), null, "two of its own: the person chooses");
});
