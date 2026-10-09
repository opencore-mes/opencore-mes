// Setup codes (§8.2): five capital letters with no I or O, read loosely, bound to the person; and the file
// of codes for slips or a mail merge. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newSetupCode, setupCodeOf, setupCodeHash, CODE_LETTERS, CODE_LENGTH } from "../server/sign-in.js";
import { setupCodesCsv } from "../client/people-file.js";

test("a code is five capital letters, never I or O, each letter as likely as another", () => {
    assert.equal(CODE_LENGTH, 5);
    assert.equal(CODE_LETTERS.length, 24);
    const seen = new Map();
    for (let i = 0; i < 4000; i++) {
        const code = newSetupCode();
        assert.match(code, /^[A-HJ-NP-Z]{5}$/);
        for (const c of code) seen.set(c, (seen.get(c) ?? 0) + 1);
    }
    assert.equal(seen.size, 24);
    // 20,000 letters, ~833 each: none far from it.
    for (const [c, n] of seen) assert.ok(n > 650 && n < 1020, `${c}: ${n}`);
});

test("a code is read as printed, whatever the case, spaces or dashes", () => {
    assert.equal(setupCodeOf(" ab cd-e "), "ABCDE");
    assert.equal(setupCodeHash("p1", "abc de"), setupCodeHash("p1", "ABCDE"));
    // Bound to the person: the same letters are another hash for someone else.
    assert.notEqual(setupCodeHash("p1", "ABCDE"), setupCodeHash("p2", "ABCDE"));
});

test("the codes as a file: a header, a row a person, a name a spreadsheet would run kept as text", () => {
    const csv = setupCodesCsv([{ id: "1001", name: "Ann, Example", departments: "Assembly; Paint", code: "ABCDE" }, { id: "1002", name: "=cmd", departments: "", code: "FGHJK" }], { expires: "10/12/2026 14:00", address: "https://mes.example/password?setup=1" });
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    assert.ok(csv.startsWith("﻿"));
    assert.equal(lines[0], "id,name,departments,code,expires,address");
    assert.equal(lines[1], '1001,"Ann, Example","Assembly; Paint",ABCDE,10/12/2026 14:00,https://mes.example/password?setup=1');
    assert.equal(lines[2], "1002,'=cmd,,FGHJK,10/12/2026 14:00,https://mes.example/password?setup=1");
});
