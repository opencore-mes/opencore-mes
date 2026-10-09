// Approval levels in the organization (§5.16), without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOrganization, organizationFootprint, kindOfElement } from "../client/definition.js";

const plant = (approval, govApprovers = ["ann"]) => ({
    governance: "engineering",
    users: { ann: { name: "Ann", active: true }, bob: { name: "Bob", active: true } },
    departments: { engineering: { name: "Engineering", members: ["ann", "bob"], approval: [{ label: "Lead", approvers: govApprovers }] } },
    groups: {}, standing: {}, roles: { design: { designer: ["user:ann"] } },
    ...(approval ? { approval } : {}),
});
const about = (org, path) => validateOrganization(org).filter((p) => p.path === path).map((p) => p.message);

test("the level: full, one or none", () => {
    for (const level of ["full", "one", "none"]) assert.deepEqual(about(plant({ level }, ["ann", "bob"]), "approval"), [], level);
    assert.match(about(plant({ level: "two" }), "approval").join(), /level: \\?"full\\?" \}/);
    assert.match(about(plant("one"), "approval").join(), /Approval is set as/);
});

test("at One or None nobody reviews: one designer is enough; at Full someone else must be able to review", () => {
    assert.deepEqual(about(plant({ level: "none" }), "roles.design"), []);
    assert.deepEqual(about(plant({ level: "one" }, ["ann", "bob"]), "roles.design"), []);
    assert.match(about(plant(null), "roles.design").join(), /Someone besides Ann must be able to review/);
});

test("at One, governance needs an approver besides each designer, or People & departments could never change again", () => {
    assert.match(about(plant({ level: "one" }, ["ann"]), "approval").join(), /someone besides Ann must approve for Engineering/);
    assert.deepEqual(about(plant({ level: "one" }, ["bob"]), "approval"), [], "an approver who does not design");
    assert.deepEqual(about(plant({ level: "one" }, ["ann", "bob"]), "approval"), []);
});

test("changing the level is governance's to approve", () => {
    assert.equal(kindOfElement("approval"), "organization");
    assert.ok(organizationFootprint(plant(null), plant({ level: "one" }), {}).some((e) => e.element === "approval"));
});
