// What an object's access requires (DESIGN.md §9.9): the guard before every policy, in the policy engine and
// in SQL alike, and what a design check says of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, mask, accessMissing, readAllRule } from "../server/policy.js";
import { rightsSql, accessSql } from "../server/record-sql.js";
import { viewSql } from "../server/query.js";
import { validateDefinition, validateService, organizationFootprint, READ_ALL_ROLE } from "../client/definition.js";

const LOT = {
    object: "lot", label: "Lot", titleField: "lot_id",
    fields: { lot_id: { type: "string" }, control: { type: "string" }, secret: { type: "string" } },
    states: { initial: "open", list: ["open"], transitions: [{ action: "close", from: ["open"], to: "open" }] },
    roles: ["viewer"],
    policies: [{ id: "read", roles: ["viewer"], record: { read: true, create: true }, fields: { "*": "write" }, actions: { close: "allow" } }],
    access: { requires: [{ certification: "itar", when: { eq: [{ record: "control" }, "military"] } }] },
};
const MIL = { lot_id: "A1", control: "military", state: "open" };
const CIV = { lot_id: "A2", control: "none", state: "open" };

test("a record whose condition holds is nobody's without the certification: not readable, writable or acted on, whatever their roles", () => {
    const sam = { id: "sam", roles: ["viewer"], certifications: [] };
    const eli = { id: "eli", roles: ["viewer"], certifications: ["itar"] };
    assert.deepEqual(accessMissing(LOT, sam, MIL), ["itar"]);
    assert.deepEqual(accessMissing(LOT, sam, CIV), []);
    const d = decide(LOT, sam, MIL);
    assert.equal(d.read, false);
    assert.equal(d.create, false);
    assert.deepEqual(d.actions, []);
    assert.equal(d.fields.lot_id, null);
    assert.equal(d.why.lot_id, "restricted");
    assert.deepEqual(d.restricted, ["itar"]);
    assert.equal(decide(LOT, eli, MIL).read, true);
    assert.equal(decide(LOT, sam, CIV).read, true);
    assert.equal(mask(LOT, sam, { id: "x", data: MIL, state: "open" }), null);
});

test("reading every record does not get past it; the plant's own automation is not held to it", () => {
    const iris = { id: "iris", roles: [READ_ALL_ROLE], certifications: [] };
    assert.equal(decide(LOT, iris, MIL).read, false);
    assert.equal(decide(LOT, iris, CIV).read, true);
    const plan = { id: "flow:x", roles: ["viewer"], unrestricted: true };
    assert.equal(decide(LOT, plan, MIL).read, true);
    // Without a condition, every record requires it.
    const always = { ...LOT, access: { requires: [{ certification: "itar" }] } };
    assert.equal(decide(always, { id: "sam", roles: ["viewer"], certifications: [] }, CIV).read, false);
});

test("in SQL: the guard joins the read rule, for whoever reads, and says nothing for who holds it", () => {
    const sam = { id: "sam", roles: ["viewer"], certifications: [] };
    const eli = { id: "eli", roles: ["viewer"], certifications: ["itar"] };
    assert.match(rightsSql(LOT, sam).read, /^\(true AND \(NOT coalesce\(.*r\.data->'control'.*'"military"'::jsonb/);
    assert.equal(accessSql(LOT, eli), "true");
    assert.equal(accessSql(LOT, { unrestricted: true }), "true");
    assert.equal(accessSql({ ...LOT, access: { requires: [{ certification: "itar" }] } }, sam), "false");
    assert.equal(rightsSql({ ...LOT, access: { requires: [{ certification: "itar" }] } }, sam).read, "false");
    assert.equal(rightsSql(LOT, eli).read, "true");
    // The reader's view of the object: the viewer's certifications, from their row.
    const [view] = viewSql(LOT);
    assert.match(view, /ctx\.certifications \? 'itar'/);
    assert.ok(readAllRule(LOT));
});

test("a design check: a certification the organization lists, a condition on the record's own fields, a service's own", () => {
    const known = { objects: ["lot"], certifications: { itar: { name: "ITAR" } } };
    const words = (body) => validateDefinition(body, known).filter((p) => p.path.startsWith("access")).map((p) => p.message).join("\n");
    assert.equal(words(LOT), "");
    assert.match(words({ ...LOT, access: { requires: [{ certification: "nuclear" }] } }), /"nuclear" is not a certification People & departments lists \(itar\)/);
    assert.match(words({ ...LOT, access: { requires: [{ certification: "itar", when: { eq: [{ user: "id" }, "x"] } }] } }), /reads user/);
    assert.match(words({ ...LOT, access: { requires: [{ certification: "itar", when: { eq: [{ record: "lot_id.x" }, "x"] } }] } }), /derive that field first/);
    assert.match(words({ ...LOT, access: { requires: "itar" } }), /requires is a list/);
    assert.match(words({ ...LOT, access: { reserve: true, requires: [] } }), /access has no "reserve"/);
    const service = (extra) => validateService({ name: "s", label: "S", input: {}, http: { enabled: true }, callers: { users: [], groups: [] }, on: [], roles: {}, uses: { connections: [], objects: {} }, stewards: ["it"], ...extra }, { ...known, departments: ["it"], connections: [], objects: {} }).filter((p) => p.path === "certifications").map((p) => p.message).join("\n");
    assert.equal(service({ certifications: ["itar"] }), "");
    assert.match(service({ certifications: ["nuclear"] }), /"nuclear" is not a certification/);
    assert.match(service({ runAs: "caller", certifications: ["itar"] }), /Only a service that runs as its own service role/);
});

test("the organization's certifications: approved by governance, each with a name", () => {
    const fp = organizationFootprint({ governance: "engineering", departments: {}, certifications: {} }, { governance: "engineering", departments: {}, certifications: { itar: { name: "ITAR" } } });
    assert.ok(fp.some((e) => e.element === "certifications"), JSON.stringify(fp));
});
