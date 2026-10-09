// People & departments (§5.6, §8) without a database: the checks, who approves a change to it, and
// standing approvers. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOrganization, organizationFootprint, applyStanding, kindOfElement, routeOf, roleChanges } from "../client/definition.js";

const org = {
    governance: "engineering", standing: {},
    users: { dana: { name: "Dana", active: true }, eli: { name: "Eli", active: true }, ivan: { name: "Ivan", active: true }, ines: { name: "Ines", active: true }, olga: { name: "Olga", active: true }, gone: { name: "Gone", active: false } },
    departments: {
        engineering: { name: "Engineering", members: ["dana", "eli"], approval: [{ label: "Approver", approvers: ["dana", "eli"] }] },
        it: { name: "IT", members: ["ivan", "ines"], approval: [{ label: "Specialist", approvers: ["ivan"] }, { label: "Manager", approvers: ["ines"] }] },
        production: { name: "Production", members: ["olga"], approval: [{ label: "Approver", approvers: ["olga"] }] },
    },
    groups: {},
    roles: { lot: { operator: ["group:production"] }, design: { designer: ["user:dana"], reviewer: ["user:eli"] } },
};
const known = { objects: { lot: { roles: ["operator", "viewer"] } }, liveDepartments: ["engineering", "it", "production"] };
const clone = (v) => JSON.parse(JSON.stringify(v));

test("a valid organization; its mistakes named", () => {
    assert.deepEqual(validateOrganization(org, known), []);
    const bad = clone(org);
    delete bad.departments.production;
    bad.departments.it.approval[1].approvers.push("ivan");
    bad.departments.it.approval.push({ label: "", approvers: [] });
    bad.departments.engineering.members.push("gone");
    bad.roles.lot.pilot = ["user:olga"];
    bad.roles.tool = { user: ["user:olga"] };
    bad.roles.lot.operator.push("user:nobody");
    bad.standing = { connection: ["legal"], widget: ["it"] };
    bad.governance = "legal";
    const m = validateOrganization(bad, known).map((p) => p.message).join("\n");
    for (const expected of [/Department production cannot be removed/, /ivan approves in two steps/, /step 3: give the step a label/, /step 3: name at least one approver/, /member "gone" is not an active person/, /lot has no role "pilot"/, /Roles on "tool": it is not an object/, /"user:nobody" is not an active user/, /"legal" is not a department/, /not "widget"/, /Name the governance department/]) assert.match(m, expected);
});

test("who approves a change to it", () => {
    const next = clone(org);
    next.departments.it.approval[0].approvers.push("olga");                 // IT's steps: IT itself and governance
    next.users.mark = { name: "Mark", active: true };
    next.departments.production.members.push("mark");                       // a new person in Production
    next.roles.lot.viewer = ["user:mark"];                                   // a role on lots: the lot's stewards
    next.standing = { service: ["it"] };                                     // standing: governance and IT
    const elements = organizationFootprint(org, next, { objects: { lot: { stewards: { object: ["production", "quality"] } } } });
    const by = Object.fromEntries(elements.map((e) => [e.element, e.stewards.join(",")]));
    assert.equal(by["department:it"], "engineering,it");
    assert.equal(by["department:production"], "engineering,production");
    assert.equal(by["person:mark"], "engineering,production");
    assert.equal(by["roles:lot"], "engineering,production,quality");
    assert.equal(by.standing, "engineering,it");
    assert.deepEqual(organizationFootprint(org, clone(org)), []);
});

test("standing approvers join the stewards of every element of their kind", () => {
    assert.deepEqual(["service:erp_in.uses", "connection:erp", "field:qty", "script:lot_check", "department:it", "screen:board"].map(kindOfElement), ["service", "connection", "object", "script", "organization", "screen"]);
    const elements = [{ element: "service:erp_in.uses", stewards: ["production"] }, { element: "field:qty", stewards: ["production"] }];
    const route = routeOf(applyStanding(elements, { service: ["it"], connection: ["it"] }));
    assert.deepEqual(route, [{ department: "it", because: ["service:erp_in.uses"] }, { department: "production", because: ["service:erp_in.uses", "field:qty"] }]);
});

test("moving someone between departments moves the roles that come with them", async () => {
    const { roleChanges, effectiveRoles } = await import("../client/definition.js");
    const before = clone(org);
    before.roles.deviation = { reporter: ["group:production", "user:olga"] };
    const after = clone(before);
    after.departments.production.members = [];
    after.departments.engineering.members.push("olga");
    after.roles.design.reviewer = ["group:engineering"];
    assert.deepEqual(effectiveRoles(before).olga, { "lot:operator": ["through production"], "deviation:reporter": ["through production", "directly"] });
    const [olga] = roleChanges(before, after).filter((c) => c.user === "olga");
    assert.deepEqual(olga.lost, [{ role: "lot:operator", via: "through production" }]);          // deviation reporter: still hers directly
    assert.deepEqual(olga.gained, [{ role: "design:reviewer", via: "through engineering" }]);
});

test("roles already in place and unchanged are not the change's to answer for", () => {
    const withPending = clone(org);
    withPending.roles.machine = { operator: ["group:production"] };   // an object not published yet
    assert.match(validateOrganization(withPending, known).map((p) => p.message).join("\n"), /Roles on "machine": it is not an object/);
    assert.deepEqual(validateOrganization(withPending, { ...known, liveRoles: withPending.roles }), []);
    const touched = clone(withPending);
    touched.roles.machine.operator.push("user:olga");
    assert.match(validateOrganization(touched, { ...known, liveRoles: withPending.roles }).map((p) => p.message).join("\n"), /Roles on "machine": it is not an object/);
});

test("a department this change creates does not approve it: governance, as it is now, does", () => {
    const next = clone(org);
    next.departments.dtit = { name: "DTIT", members: ["ines"], approval: [{ label: "Approver", approvers: ["ines"] }] };
    next.standing = { service: ["dtit"] };
    next.governance = "it";                       // a new governance also starts with the next change
    const route = routeOf(organizationFootprint(org, next, {})).map((r) => r.department);
    assert.ok(!route.includes("dtit"), route.join());
    assert.deepEqual(route, ["engineering"]);
});

test("an approver belongs to the department they approve for", () => {
    const next = clone(org);
    next.departments.it.approval[1].approvers.push("olga");   // Olga is in Production, not IT
    assert.match(validateOrganization(next, known).map((p) => p.message).join("\n"), /IT, step 2 \(Manager\): Olga approves for IT but is not a member of it/);
});

test("someone always remains to change the system: a designer, and someone else to review", () => {
    const words = (o) => validateOrganization(o, known).map((p) => p.message).join("\n");
    const none = clone(org);
    none.roles.design.designer = [];
    assert.match(words(none), /Someone active must remain a designer/);
    const gone = clone(org);
    gone.users.dana.active = false;                                           // the only designer leaves
    gone.departments.engineering.members = ["eli"];
    gone.departments.engineering.approval[0].approvers = ["eli"];
    assert.match(words(gone), /Someone active must remain a designer/);
    const alone = clone(org);
    alone.roles.design.reviewer = [];                                          // nobody to review Dana's changes
    assert.match(words(alone), /Someone besides Dana must be able to review/);
    const viaGroup = clone(org);
    viaGroup.roles.design = { designer: ["group:engineering"] };               // Dana and Eli, each the other's reviewer
    assert.doesNotMatch(words(viaGroup), /designer|review/);
});

test("who reads every record: people and groups that exist, approved by governance, shown in what changes for people", () => {
    const withReaders = { ...clone(org), readers: ["user:ivan", "group:production"] };
    assert.deepEqual(validateOrganization(withReaders, known), []);
    const bad = { ...clone(org), readers: ["user:gone", "group:nowhere", "everyone"] };
    assert.equal(validateOrganization(bad, known).filter((p) => p.path === "readers").length, 3);
    assert.deepEqual(organizationFootprint(org, withReaders).find((e) => e.element === "readers")?.stewards, ["engineering"]);
    const gained = roleChanges(org, withReaders);
    assert.deepEqual(gained.find((c) => c.user === "ivan").gained, [{ role: "all records:read", via: "directly" }]);
    assert.deepEqual(gained.find((c) => c.user === "olga").gained, [{ role: "all records:read", via: "through production" }]);
});

test("emergency changes: allowed and their review's days, checked, and approved by governance (§5.7)", () => {
    assert.deepEqual(validateOrganization({ ...clone(org), emergency: { allowed: false, reviewDays: 5 } }, known), []);
    const m = (e) => validateOrganization({ ...clone(org), emergency: e }, known).map((p) => p.message).join("\n");
    assert.match(m({ reviewDays: 0 }), /1 to 30 days/);
    assert.match(m({ allowed: "no" }), /true or false/);
    assert.match(m({ often: 1 }), /not "often"/);
    assert.match(m([]), /allowed, reviewDays/);
    const fp = organizationFootprint(clone(org), { ...clone(org), emergency: { allowed: false } }, known);
    assert.ok(JSON.stringify(fp).includes("emergency"), JSON.stringify(fp));
});
