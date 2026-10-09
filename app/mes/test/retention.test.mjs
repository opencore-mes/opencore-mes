// How long the plant keeps each kind of data, and what erasing leaves (§27.8), without a server. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETENTION_KINDS, KIND, FOREVER, AUDIT_FLOOR_DAYS, retentionProblems, periodsOf, parsePeriod, periodWords, cutoffOf, erasableFields, tombstoneOf, isErased, ERASED } from "../client/retention.js";
import { validateOrganization, organizationFootprint, validateDefinition, kindOfElement, PSEUDO_ROLES } from "../client/definition.js";
import { organizationChanges } from "../client/compare.js";

test("the kinds: records and the audit trail are counted, never purged; the audit trail's floor is six years", () => {
    assert.deepEqual(RETENTION_KINDS.filter((k) => !k.purged).map((k) => k.key), ["records", "audit"]);
    assert.equal(KIND.audit.floor, 6 * 365);
    assert.equal(KIND.audit.days, null, "the audit trail is kept forever by default");
    assert.equal(KIND.records.days, null, "records are kept forever by default");
    for (const k of RETENTION_KINDS) assert.ok(k.label && k.what && k.floor >= 1, k.key);
});

test("periods: typed in days, years or forever; the defaults where nothing is set", () => {
    assert.equal(parsePeriod(""), undefined);
    assert.equal(parsePeriod(" 90 "), 90);
    assert.equal(parsePeriod("6y"), 6 * 365);
    assert.equal(parsePeriod("2 years"), 730);
    assert.equal(parsePeriod("Forever"), FOREVER);
    assert.equal(parsePeriod("a while"), "a while", "kept as typed, for the check to name");
    assert.equal(periodWords(null), "forever");
    assert.equal(periodWords(365), "1 year");
    assert.equal(periodWords(2190), "6 years");
    assert.equal(periodWords(1), "1 day");
    assert.equal(periodWords(400), "400 days");
    const p = periodsOf({ conversations: 30, events: FOREVER, answers: 3 });
    assert.equal(p.conversations, 30);
    assert.equal(p.events, null);
    assert.equal(p.answers, 90, "below its floor: the default stands");
    assert.equal(p.sign_in, 30);
    assert.equal(p.audit, null);
    assert.deepEqual(periodsOf(undefined), Object.fromEntries(RETENTION_KINDS.map((k) => [k.key, k.days])));
    assert.equal(cutoffOf(null), null);
    assert.equal(cutoffOf(1, Date.parse("2026-10-06T00:00:00Z")), "2026-10-05T00:00:00.000Z");
});

test("the setting's mistakes, in words", () => {
    assert.deepEqual(retentionProblems(undefined), []);
    assert.deepEqual(retentionProblems({}), []);
    assert.deepEqual(retentionProblems({ conversations: 365, sign_in: 7, events: FOREVER }), []);
    assert.match(retentionProblems([]).join(), /Retention is/);
    assert.match(retentionProblems({ chats: 30 }).join(), /"chats" is not a kind of data kept/);
    assert.match(retentionProblems({ conversations: "a while" }).join(), /"a while" is not a period/);
    assert.match(retentionProblems({ conversations: 2.5 }).join(), /not a period/);
    assert.match(retentionProblems({ events: 30 }).join(), /The event log's copy: at least 1 year, not 30 days/);
    assert.match(retentionProblems({ audit: 365 }).join(), /The audit trail: at least 6 years \(HIPAA/);
    assert.match(retentionProblems({ answers: 365 * 200 }).join(), /at most 100 years/);
    // Part 11 §11.10(e): the audit trail outlives the records it describes.
    assert.match(retentionProblems({ audit: AUDIT_FLOOR_DAYS }).join(), /at least as long as the records it describes.*records forever, the audit trail 6 years/);
    assert.match(retentionProblems({ records: 3650, audit: AUDIT_FLOOR_DAYS }).join(), /records 10 years, the audit trail 6 years/);
    assert.deepEqual(retentionProblems({ records: AUDIT_FLOOR_DAYS, audit: 3650 }), []);
});

test("a change to it: checked with the organization, approved by governance, on its own tab", () => {
    const org = {
        governance: "engineering",
        users: { dana: { name: "Dana" }, eli: { name: "Eli" } },
        departments: { engineering: { name: "Engineering", members: ["dana", "eli"], approval: [{ label: "Approver", approvers: ["dana"] }] } },
        roles: { design: { designer: ["user:dana"], reviewer: ["user:eli"] }, privacy: { officer: ["user:eli"] } },
    };
    assert.deepEqual(validateOrganization(org).map((p) => p.message), []);
    const wrong = validateOrganization({ ...org, retention: { audit: 30 } });
    assert.ok(wrong.some((p) => p.path === "retention" && /at least 6 years/.test(p.message)), JSON.stringify(wrong));
    const after = { ...org, retention: { conversations: 365 } };
    const fp = organizationFootprint(org, after);
    assert.deepEqual(fp.map((e) => [e.element, e.change, e.stewards.join()]), [["retention", "changed", "engineering"]]);
    assert.equal(kindOfElement("retention"), "organization", "standing approvers of the organization join it");
    assert.deepEqual(organizationChanges(org, after).map((c) => [c.tab, c.element]), [["retention", "retention"]]);
    assert.deepEqual(PSEUDO_ROLES.privacy, ["officer"]);
});

test("erasable fields: marked on the design; a picture and what People & departments keeps are not", () => {
    const body = {
        object: "visitor", label: "Visitor", area: "Site",
        fields: { name: { type: "string", erasable: true }, email: { type: "string", erasable: true }, visits: { type: "integer", erasable: true }, badge: { type: "string" }, photo: { type: "image", erasable: true }, note: { type: "text", erasable: "yes" } },
        states: { initial: "in", list: ["in"], transitions: [] }, roles: ["host"], policies: [],
    };
    const problems = validateDefinition(body, { objects: [] }).filter((p) => p.path.endsWith(".erasable"));
    assert.deepEqual(problems.map((p) => p.path).sort(), ["fields.note.erasable", "fields.photo.erasable"]);
    assert.match(problems.find((p) => p.path === "fields.photo.erasable").message, /picture cannot be erased yet/);
    assert.deepEqual(erasableFields(body), ["name", "email", "visits", "photo"]);
    assert.equal(tombstoneOf(body.fields.name), ERASED);
    assert.equal(tombstoneOf(body.fields.visits), null);
    assert.ok(isErased(body.fields.name, ERASED) && isErased(body.fields.visits, null) && isErased(body.fields.name, ""));
    assert.ok(!isErased(body.fields.name, "Ada") && !isErased(body.fields.visits, 0));
});
