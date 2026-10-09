// A person's id is their sign-in id, as the plant's directory knows them (§27.1a). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSON_ID, validateOrganization } from "../client/definition.js";

test("employee numbers and hyphens are ids; dots, colons, capitals and spaces are not", () => {
    for (const ok of ["104523", "0042", "mark", "j-doe", "jane_doe", "a1"]) assert.ok(PERSON_ID.test(ok), ok);
    for (const no of ["jane.doe", "user:mark", "Mark", "jane doe", "-x", "_x", "", "a".repeat(65)]) assert.ok(!PERSON_ID.test(no), no);
});

test("People & departments takes an employee number as a person's id", () => {
    const org = {
        governance: "engineering",
        users: { "104523": { name: "Ann Example", active: true }, "j-doe": { name: "Jo Doe", active: true } },
        departments: { engineering: { name: "Engineering", members: ["104523", "j-doe"], approval: [{ label: "Lead", approvers: ["104523"] }] } },
        groups: {}, standing: {}, roles: { design: { designer: ["user:104523"], reviewer: ["user:j-doe"] } },
    };
    assert.deepEqual(validateOrganization(org).filter((p) => p.path.startsWith("users") || p.path.startsWith("roles") || p.path.startsWith("departments")), []);
    const dotted = { ...org, users: { ...org.users, "jane.doe": { name: "Jane", active: true } } };
    assert.match(validateOrganization(dotted).map((p) => p.message).join(), /"jane\.doe": a person's id is their sign-in id/);
});
