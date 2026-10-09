// What a person typed, trimmed (client/definition.js trimValues, server/transfer.js cellValue; DESIGN.md §11.1a). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimValues, trimText } from "../client/definition.js";
import { cellValue } from "../server/transfer.js";

test("single-line text trimmed, multi-line text kept as written, only spaces empty; numbers, yes/no, markers and files as given; several choices without empty ones; table rows cell by cell", () => {
    const fields = { lot_no: { type: "string" }, note: { type: "text" }, empty_note: { type: "text" }, qty: { type: "decimal" }, ok: { type: "boolean" }, tags: { type: "enum", multiple: true }, rows: { type: "rows" }, pic: { type: "image" } };
    const marker = { $sensitive: true };
    const given = { lot_no: "  4711 ", note: "\n  two lines\n of text  \n", empty_note: " \n ", qty: 3, ok: false, tags: [" a ", "", " b"], rows: [{ value: " 1.5 ", by: " olga" }], pic: marker, blank: "   " };
    assert.deepEqual(trimValues(fields, given), { lot_no: "4711", note: "\n  two lines\n of text  \n", qty: 3, ok: false, tags: ["a", "b"], rows: [{ value: "1.5", by: "olga" }], pic: marker, blank: "", empty_note: "" });
    const clean = { lot_no: "4711", qty: 3 };
    assert.equal(trimValues(fields, clean), clean, "nothing to trim: the same object back");
    assert.equal(trimText("  x "), "x");
    assert.equal(trimText(5), 5);
});

test("an imported cell trimmed: only spaces is empty, a choice matched without its spaces", () => {
    assert.deepEqual(cellValue({ type: "string" }, "  L-1 "), { value: "L-1" });
    assert.deepEqual(cellValue({ type: "string" }, "   "), { value: null });
    assert.deepEqual(cellValue({ type: "enum", values: ["kg", "ea"] }, " kg "), { value: "kg" });
    assert.deepEqual(cellValue({ type: "enum", values: ["a", "b"], multiple: true }, " a ; b "), { value: ["a", "b"] });
});
