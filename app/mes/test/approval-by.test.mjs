// Who approves a change to a record, by a value of the record (§28.3a): a product of the power group
// approved by power engineering, one of the MCU group by MCU engineering; a value not listed, the
// stewards; a record moved from one value to another, both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordRoute, validateDefinition, renameField, validateOrganization, transactionFootprint, flowFootprint, integrationFootprint, valueApprovers } from "../client/definition.js";

const product = (by) => ({
    object: "product", label: "Product", area: "Engineering", titleField: "code",
    fields: { code: { label: "Code", type: "string", required: true }, group: { label: "Engineering group", type: "enum", values: ["power", "mcu", "rf"] }, note: { label: "Note", type: "string" } },
    states: { initial: "active", list: ["active", "obsolete"], transitions: [{ action: "retire", from: ["active"], to: "obsolete" }] },
    roles: ["engineer"], stewards: { object: ["engineering"], fields: { note: ["quality"] } },
    policies: [{ id: "all", roles: ["engineer"], record: { read: true, create: true }, fields: { "*": "write" }, actions: { retire: "allow" } }],
    approval: { edit: true, create: true, actions: true, ...(by ? { by } : {}) },
});
const map = { field: "group", values: { power: ["power_eng"], mcu: ["mcu_eng", "quality"] } };
const depts = (route) => route.map((r) => r.department).join(",");

test("by the record's value, in place of the stewards: a power product's edit by power engineering alone", () => {
    const r = recordRoute(product(map), { op: "edit", state: "active", changed: ["note"], now: { group: "power" }, asked: {} });
    assert.equal(depts(r), "power_eng");
    assert.deepEqual(r[0].because, ["value:group=power"]);
    assert.equal(depts(recordRoute(product(map), { op: "action", state: "active", action: "retire", now: { group: "mcu" } })), "mcu_eng,quality");
    assert.equal(depts(recordRoute(product(map), { op: "create", changed: ["code", "group"], asked: { group: "mcu" } })), "mcu_eng,quality");
});

test("moved to another value: the group it leaves and the group it joins both sign", () => {
    assert.equal(depts(recordRoute(product(map), { op: "edit", state: "active", changed: ["group"], now: { group: "power" }, asked: { group: "mcu" } })), "mcu_eng,power_eng,quality");
});

test("a value not listed, or none, is the stewards' as ever; as well as the stewards when the design says so", () => {
    assert.equal(depts(recordRoute(product(map), { op: "edit", state: "active", changed: ["note"], now: { group: "rf" } })), "quality");
    assert.equal(depts(recordRoute(product(map), { op: "edit", state: "active", changed: ["code"], now: { group: null } })), "engineering");
    assert.equal(depts(recordRoute(product({ ...map, stewards: "also" }), { op: "edit", state: "active", changed: ["note"], now: { group: "power" } })), "power_eng,quality");
    assert.equal(depts(recordRoute(product(null), { op: "edit", state: "active", changed: ["note"], now: { group: "power" } })), "quality");
});

test("its design is checked: a field to read, its values, departments that exist, how it stands with the stewards", () => {
    const known = { departments: ["engineering", "quality", "power_eng", "mcu_eng"] };
    const ok = validateDefinition(product(map), known).filter((p) => p.path === "approval");
    assert.deepEqual(ok, []);
    const words = (by) => validateDefinition(product(by), known).filter((p) => p.path === "approval").map((p) => p.message).join("\n");
    assert.match(words({ field: "nope", values: { a: ["quality"] } }), /"nope" is not a field/);
    assert.match(words({ field: "group", values: { analog: ["quality"] } }), /"analog" is not one of Engineering group's values/);
    assert.match(words({ field: "group", values: { power: ["ghost"] } }), /"ghost" \(for power\) is not a department/);
    assert.match(words({ field: "group", values: { power: [] } }), /"power" names at least one department/);
    assert.match(words({ ...map, stewards: "both" }), /in place of the stewards \(replace\) or as well \(also\)/);
});

test("the field renamed, its approval follows", () => {
    const out = renameField(product(map), "group", "eng_group");
    assert.equal(out.approval.by.field, "eng_group");
});

test("a group approves as a department does: named per value, checked to exist, kept while an object names it", () => {
    const known = { departments: ["engineering", "quality"], groups: ["power_team"] };
    const words = (by) => validateDefinition(product(by), known).filter((p) => p.path === "approval").map((p) => p.message).join("\n");
    assert.equal(words({ field: "group", values: { power: ["power_team"], mcu: ["quality"] } }), "");
    assert.match(words({ field: "group", values: { power: ["ghost"] } }), /"ghost" \(for power\) is not a department or a group/);
    assert.equal(depts(recordRoute(product({ field: "group", values: { power: ["power_team"] } }), { op: "edit", state: "active", changed: ["note"], now: { group: "power" } })), "power_team");
    // The organization: a group's mailbox is an address; a group an object's approval names is not removed.
    const org = (groups) => ({
        governance: "engineering", standing: {},
        users: { ann: { name: "Ann", active: true }, bo: { name: "Bo", active: true } },
        departments: { engineering: { name: "Engineering", members: ["ann"], approval: [{ label: "Approver", approvers: ["ann"] }] }, quality: { name: "Quality", members: ["bo"], approval: [{ label: "Approver", approvers: ["bo"] }] } },
        groups, roles: {},
    });
    const orgWords = (groups, k = {}) => validateOrganization(org(groups), k).map((p) => p.message).join("\n");
    assert.doesNotMatch(orgWords({ power_team: { name: "Power team", email: "power@plant.example", members: ["ann", "bo"] } }), /Power team/);
    assert.match(orgWords({ power_team: { name: "Power team", email: "not mail", members: ["ann"] } }), /Group Power team: "not mail" is not an email address/);
    assert.match(orgWords({}, { objects: { product: { label: "Product", approvers: ["power_team"] } }, liveGroups: ["power_team"] }), /Group power_team is named by Product's approval by value/);
});

test("a design that writes what an approval by value controls is approved by its departments and groups, once (§28.3b)", () => {
    const def = product({ field: "group", values: { power: ["power_team"], mcu: ["mcu_eng", "quality"] } });
    def.approval.edit = { fields: ["note"] };
    const objects = { product: def };
    const route = (body) => [...new Set(transactionFootprint("t", undefined, body, { objects }).flatMap((e) => e.stewards))].sort().join(",");
    const tx = (steps) => ({ name: "t", inputs: { p: { type: "ref", to: "product" } }, steps, stewards: ["production"] });
    assert.equal(route(tx([{ on: "p", set: { note: { input: "x" } } }])), "engineering,mcu_eng,power_team,production,quality");
    assert.equal(route(tx([{ on: "p", set: { code: { input: "x" } } }])), "engineering,production", "a field the approval does not control: the stewards as ever");
    assert.equal(route(tx([{ on: "p", action: "retire" }])), "engineering,mcu_eng,power_team,production,quality");
    assert.equal(route(tx([{ create: "product", set: { code: { input: "x" } } }])), "engineering,mcu_eng,power_team,production,quality");
    // A service that may update or act on it; a route whose sequence puts its traveler in a state.
    const svc = integrationFootprint("service", "s", undefined, { uses: { objects: { product: ["read", "update"] } }, stewards: ["it"] }, { objects })[0].stewards;
    assert.ok(["power_team", "mcu_eng", "quality"].every((d) => svc.includes(d)), svc);
    const flow = { kind: "route", participants: { p: { object: "product", as: "traveler" } }, nodes: { s: { kind: "start" }, a: { kind: "sequence", state: "obsolete" }, e: { kind: "end" } }, edges: [], stewards: ["production"] };
    assert.ok(flowFootprint("f", undefined, flow, { objects }).flatMap((e) => e.stewards).includes("power_team"));
    assert.deepEqual(valueApprovers(product(null), { fields: ["note"] }), [], "no approval by value: nobody more");
});
