// Setup's rules in the organization (§5.15), without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOrganization, organizationFootprint, kindOfElement } from "../client/definition.js";

// One engineer, who designs and approves for the one department: what a plant being set up may start with.
const alone = (setup) => ({
    governance: "engineering",
    users: { dana: { name: "Dana", active: true } },
    departments: { engineering: { name: "Engineering", members: ["dana"], approval: [{ label: "Lead", approvers: ["dana"] }] } },
    groups: {}, standing: {}, roles: { design: { designer: ["user:dana"] } },
    ...(setup === undefined ? {} : { setup }),
});
const about = (problems, path) => problems.filter((p) => p.path === path).map((p) => p.message);

test("while setup is open, one engineer is enough: nobody else needs to review", () => {
    assert.deepEqual(about(validateOrganization(alone({ open: true })), "roles.design"), []);
});

test("outside setup, someone besides the designers must be able to review", () => {
    assert.match(about(validateOrganization(alone()), "roles.design").join(), /Someone besides Dana must be able to review/);
    assert.match(about(validateOrganization(alone({ open: false })), "roles.design").join(), /^Someone besides/);
});

test("ending setup waits for that reviewer, and says so", () => {
    assert.match(about(validateOrganization(alone({ open: false }), { liveSetup: true }), "roles.design").join(), /^Setup cannot end yet: Someone besides Dana/);
    const withVera = alone({ open: false });
    withVera.users.vera = { name: "Vera", active: true };
    withVera.roles.design.reviewer = ["user:vera"];
    assert.deepEqual(about(validateOrganization(withVera, { liveSetup: true }), "roles.design"), []);
});

test("the setting's shape", () => {
    assert.deepEqual(about(validateOrganization(alone({ open: true })), "setup"), []);
    assert.match(about(validateOrganization(alone("yes")), "setup").join(), /\{ open: true \} or \{ open: false \}/);
    assert.match(about(validateOrganization(alone({ open: "yes" })), "setup").join(), /open is true or false/);
    assert.match(about(validateOrganization(alone({ open: true, until: "2027" })), "setup").join(), /not "until"/);
});

test("ending it or opening it again is governance's to approve", () => {
    assert.equal(kindOfElement("setup"), "organization");
    const before = alone({ open: true });
    const out = organizationFootprint(before, alone({ open: false }), {});
    assert.ok(out.some((e) => e.element === "setup"), JSON.stringify(out.map((e) => e.element)));
});
