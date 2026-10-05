// People to and from a file (people-file.js): what Export writes, Import reads back the same, and what
// a spreadsheet's rows do to the draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { peopleCsv, parseTable, importPeople, importWords } from "../client/people-file.js";

const org = () => ({
    governance: "it",
    users: { dana: { name: "Dana Reyes", active: true }, olga: { name: "Olga Ortiz", active: true }, noah: { name: "Noah, Jr.", active: false } },
    departments: {
        production: { name: "Production", members: ["olga", "dana"], approval: [{ label: "Lead", approvers: ["olga"] }] },
        it: { name: "IT", members: ["dana"], approval: [{ label: "IT", approvers: ["dana"] }] },
    },
});

test("Export writes every person, sorted, quoted where needed; read back, it changes nothing", () => {
    const text = peopleCsv(org());
    assert.ok(text.startsWith("﻿id,name,active,departments\r\n"));
    assert.match(text, /dana,Dana Reyes,yes,production it\r\n/);
    assert.match(text, /noah,"Noah, Jr.",no,\r\n/);
    const back = importPeople(org(), text);
    assert.deepEqual(back.problems, []);
    assert.deepEqual(back.changes, { added: [], renamed: [], activated: [], deactivated: [], moved: [] });
    assert.deepEqual(back.next, org());
});

test("a spreadsheet's separators and quotes are read", () => {
    assert.deepEqual(parseTable('id;name\nmark;"Mark ""M"" Lee"\n'), [["id", "name"], ["mark", 'Mark "M" Lee']]);
    assert.deepEqual(parseTable("id\tname\r\nmark\tMark\r\n\r\n"), [["id", "name"], ["mark", "Mark"]]);
    assert.deepEqual(parseTable('id,name\nmark,"two\nlines"'), [["id", "name"], ["mark", "two\nlines"]]);
});

test("each row says what that person is; people not in the file stay as they are", () => {
    const text = "Sign-in id,Name,Active,Departments\nmark,Mark Lee,,production\nOLGA,Olga Ortiz-Lee,no,it\nnoah,,yes,\n";
    const { next, changes, problems } = importPeople(org(), text);
    assert.deepEqual(problems, []);
    assert.deepEqual(next.users.mark, { name: "Mark Lee", active: true });
    assert.deepEqual(changes, { added: ["mark"], renamed: ["olga"], activated: ["noah"], deactivated: ["olga"], moved: ["olga"] });
    assert.equal(next.users.olga.active, false);
    assert.deepEqual(next.departments.production.members, ["dana", "mark"]);
    // Olga left Production: she leaves its approval step too.
    assert.deepEqual(next.departments.production.approval[0].approvers, []);
    assert.deepEqual(next.departments.it.members, ["dana", "olga"]);
    assert.equal(next.users.dana.name, "Dana Reyes");
    assert.match(importWords({ changes, problems }, next), /1 new: Mark Lee\n1 renamed: Olga Ortiz-Lee/);
});

test("rows it cannot take are said, by row, and the rest are taken", () => {
    const text = "id,name,active,departments\nMark Lee,x,,\nzoe,,,\nann,Ann,maybe,\nbob,Bob,,quality\nkim,Kim,,\nkim,Kim Again,,\n";
    const { next, changes, problems } = importPeople(org(), text);
    assert.deepEqual(problems.map((p) => p.row), [2, 3, 4, 5, 7]);
    assert.match(problems[0].message, /is not an id/);
    assert.match(problems[1].message, /zoe is new: give their name/);
    assert.match(problems[2].message, /write yes or no/);
    assert.match(problems[3].message, /no department quality/);
    assert.match(problems[4].message, /twice/);
    assert.deepEqual(changes.added, ["kim"]);
    assert.equal(next.users.kim.name, "Kim");
    assert.match(importPeople(org(), "name\nMark\n").problems[0].message, /No "id" column/);
    assert.match(importPeople(org(), "").problems[0].message, /empty/);
});

test("people are found by search: what this change touches first, then by name; nobody by default unless lists are simple", async () => {
    const { findPeople } = await import("../client/people-file.js");
    const o = org();
    assert.deepEqual(findPeople(o, "").ids, []);
    assert.deepEqual(findPeople(o, "", { touched: ["noah"] }).ids, ["noah"]);
    assert.deepEqual(findPeople(o, "", { all: true, touched: ["olga"] }).ids, ["olga", "dana", "noah"]);
    assert.deepEqual(findPeople(o, "production").ids, ["dana", "olga"]);
    assert.deepEqual(findPeople(o, "prod").ids, ["dana", "olga"]);
    assert.deepEqual(findPeople(o, "REY dana").ids, ["dana"]);
    assert.deepEqual(findPeople(o, "it reyes").ids, ["dana"]);
    // A word's start, not anywhere in it: "duct" is in Production, but starts no word.
    assert.deepEqual(findPeople(o, "duct").ids, []);
    // The sign-in id anywhere.
    assert.deepEqual(findPeople(o, "lg").ids, ["olga"]);
    // One letter is too little: nobody, and said so.
    assert.deepEqual(findPeople(o, "d"), { ...findPeople(o, "d"), ids: [], total: 0, short: true });
    assert.equal(findPeople(o, "nobody here").total, 0);
    assert.deepEqual(findPeople(o, "olga").departmentsOf.get("olga"), ["Production"]);
});
