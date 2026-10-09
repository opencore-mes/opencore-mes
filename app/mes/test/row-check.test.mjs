// One way to check a file's rows against their columns' constraints, for every import (§24). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCell, checkRow, rowMessage } from "../client/row-check.js";

test("each type: the value, or what it must be", () => {
    assert.deepEqual(checkCell({ type: "integer" }, " 3 "), { value: 3 });
    assert.equal(checkCell({ type: "integer" }, "3.5").error, "a whole number");
    assert.deepEqual(checkCell({ type: "decimal" }, "1,250.5"), { value: 1250.5 });
    assert.deepEqual(checkCell({ type: "boolean" }, "Yes"), { value: true });
    assert.equal(checkCell({ type: "boolean" }, "maybe").error, "yes or no");
    assert.deepEqual(checkCell({ type: "date" }, "2026-10-07T10:00"), { value: "2026-10-07" });
    assert.equal(checkCell({ type: "enum", values: ["kg", "ea"] }, "lb").error, "one of kg, ea");
    assert.deepEqual(checkCell({ type: "enum", values: ["a", "b"], multiple: true }, " a ; b "), { value: ["a", "b"] });
    assert.deepEqual(checkCell({ type: "string" }, "   "), { value: null });
});

test("required, required only for something new, a pattern, lower case", () => {
    assert.equal(checkCell({ type: "string", required: true }, "").error, "required");
    assert.deepEqual(checkCell({ type: "string", required: "new" }, "", { isNew: false }), { value: null });
    assert.equal(checkCell({ type: "string", required: "new" }, "", { isNew: true }).error, "required for a new one");
    assert.equal(checkCell({ type: "string", lower: true, pattern: /^[a-z]+$/, patternWords: "letters only" }, "Ab1").error, '"ab1" is not letters only');
    assert.deepEqual(checkCell({ type: "string", lower: true, pattern: /^[a-z]+$/ }, "ABC"), { value: "abc" });
});

test("a reference must exist: what there is, where to make one; an ambiguous one is said", () => {
    const ref = { label: "department", yet: true, find: (v) => ({ qa: "qa", dup: "ambiguous" })[v] ?? null, known: () => ["engineering", "qa"], hint: "Add it on the Departments tab, then import again" };
    assert.deepEqual(checkCell({ type: "ref", ref }, "qa"), { value: "qa" });
    assert.equal(checkCell({ type: "ref", ref }, "it").error, 'there is no department "it" yet (there are: engineering, qa). Add it on the Departments tab, then import again');
    assert.equal(checkCell({ type: "ref", ref }, "dup").error, 'more than one department "dup"');
    assert.equal(checkCell({ type: "ref", ref: { label: "Work order", scope: "that you can see", find: () => null } }, "WO-9").error, 'there is no Work order "WO-9" that you can see');
    assert.deepEqual(checkCell({ type: "ref", multiple: true, separator: /[\s,]+/, ref }, "qa, qa"), { value: ["qa"] });
    assert.match(checkCell({ type: "ref", multiple: true, separator: /[\s,]+/, ref }, "qa it").error, /no department "it"/);
});

test("a row: every column checked, a unique one once in the file, the problems in one line by label", () => {
    const columns = [
        { key: "id", label: "Id", type: "string", required: true, unique: true },
        { key: "qty", label: "Quantity", type: "decimal" },
        { key: "ok", label: "Active", type: "boolean" },
    ];
    const seen = new Set();
    const cells = (o) => (k) => o[k];
    assert.deepEqual(checkRow(columns, cells({ id: "a", qty: "2", ok: "no" }), { seen }), { values: { id: "a", qty: 2, ok: false }, problems: {} });
    const bad = checkRow(columns, cells({ id: "a", qty: "two", ok: "x?" }), { seen });
    assert.equal(rowMessage(bad.problems, columns), 'Id: "a" is in the file twice: only its first row is taken; Quantity: a number, not "two"; Active: yes or no, not "x?"');
    assert.deepEqual(checkRow(columns, cells({ id: "b" })).values, { id: "b" }, "a column not in the file is left out");
});
