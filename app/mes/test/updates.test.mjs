// Staying on the server's version (client/updates.js): when a reload would lose nothing. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { editing } from "../client/updates.js";

const apiWith = (state) => ({ peek: (path) => state[path] });

test("nothing edited: a new version may load at once", () => {
    assert.equal(editing(apiWith({})), false);
    assert.equal(editing(apiWith({ f: { lot: { "id-1": { dirty: false, data: {} } } }, dz: { c1: { dirty: false } } })), false);
});

test("a form edited, being saved, or with an unknown outcome, or a change in the designer: it waits", () => {
    assert.equal(editing(apiWith({ f: { lot: { "id-1": { dirty: true } } } })), true);
    assert.equal(editing(apiWith({ f: { lot: { new: { saving: true } } } })), true);
    assert.equal(editing(apiWith({ f: { work_order: { "id-2": { unknown: true } } } })), true);
    assert.equal(editing(apiWith({ dz: { c1: { dirty: true } } })), true);
    assert.equal(editing(apiWith({ dz: { c1: { busy: true } } })), true);
});
