// Excel import and export (server/xlsx.js, server/transfer.js), without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { writeXlsx, readXlsx, sheetName, excelDate } from "../server/xlsx.js";
import { cellValue, dependencyOrder, keyOf, aboutOf, aboutField, modelChanges } from "../server/transfer.js";

test("a workbook written reads back: tabs, strings with markup, numbers, booleans, blanks", () => {
    const book = writeXlsx([{ name: "lot", rows: [["lot_no", "qty", "ok", "note"], ["4711", 1250.5, true, "a & <b> \"c\""], ["4712", 0, false, null]] }, { name: "work_order", rows: [["wo_no"], ["WO-1"]] }]);
    const sheets = readXlsx(book);
    assert.deepEqual(sheets.map((s) => s.name), ["lot", "work_order"]);
    assert.deepEqual(sheets[0].rows[1], ["4711", 1250.5, true, 'a & <b> "c"']);
    assert.deepEqual(sheets[0].rows[2], ["4712", 0, false]);
});

test("cells as Excel writes them: shared strings, numbers, dates as serials", () => {
    // A minimal workbook in Excel's shape, zipped by hand.
    const files = {
        "xl/workbook.xml": '<workbook><sheets><sheet name="lot" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/sharedStrings.xml": '<sst><si><t>lot_no</t></si><si><r><t>ex</t></r><r><t>piry</t></r></si><si><t>4799 &amp; co</t></si></sst>',
        "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>46477</v></c></row></sheetData></worksheet>',
    };
    const [sheet] = readXlsx(zip(files));
    assert.deepEqual(sheet.rows[0], ["lot_no", "expiry"]);
    assert.deepEqual(sheet.rows[1], ["4799 & co", null, 46477]);
    assert.equal(excelDate(46477), "2027-03-31");
});

test("a cell as its field's type wants it, or why not", () => {
    assert.deepEqual(cellValue({ type: "decimal" }, "1,250.5"), { value: 1250.5 });
    assert.deepEqual(cellValue({ type: "integer" }, 3), { value: 3 });
    assert.ok(cellValue({ type: "integer" }, "3.5").error);
    assert.deepEqual(cellValue({ type: "date" }, 46477), { value: "2027-03-31" });
    assert.deepEqual(cellValue({ type: "date" }, "2027-03-31T00:00"), { value: "2027-03-31" });
    assert.deepEqual(cellValue({ type: "boolean" }, "Yes"), { value: true });
    assert.deepEqual(cellValue({ type: "enum", values: ["kg", "l"] }, "kg"), { value: "kg" });
    assert.match(cellValue({ type: "enum", values: ["kg", "l"] }, "lb").error, /one of kg, l/);
    assert.deepEqual(cellValue({ type: "string" }, 4711), { value: "4711" });
    assert.deepEqual(cellValue({ type: "string" }, ""), { value: null });
});

test("models load in dependency order; the key names a record", () => {
    const lot = { object: "lot", fields: { work_order: { type: "ref", to: "work_order" } }, titleField: "lot_no" };
    const wo = { object: "work_order", fields: { wo_no: { type: "string" } }, titleField: "wo_no", transfer: { import: { key: "wo_no" } } };
    const dev = { object: "deviation", fields: { lot: { type: "ref", to: "lot" } } };
    assert.deepEqual(dependencyOrder([dev, lot, wo]).map((d) => d.object), ["work_order", "lot", "deviation"]);
    assert.equal(keyOf(wo), "wo_no");
    assert.equal(keyOf(lot), "lot_no");
    assert.equal(sheetName("a:b/c[d]" + "x".repeat(40)).length, 31);
});

function zip(files) {
    const entries = Object.entries(files).map(([name, text]) => ({ name: Buffer.from(name), data: deflateRawSync(Buffer.from(text)) }));
    const parts = [];
    const dir = [];
    let offset = 0;
    for (const e of entries) {
        const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(e.data.length, 18); local.writeUInt16LE(e.name.length, 26);
        const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(e.data.length, 20); central.writeUInt16LE(e.name.length, 28); central.writeUInt32LE(offset, 42);
        parts.push(local, e.name, e.data); dir.push(central, e.name); offset += 30 + e.name.length + e.data.length;
    }
    const d = Buffer.concat(dir);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(d.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, d, end]);
}

test("an export's _about tab, read back: each model's version, and its fields as they were", () => {
    const lot = { object: "lot", fields: { lot_no: { type: "text", label: "Lot", required: true }, qty: { type: "decimal", label: "Quantity (kg)" }, grade: { type: "enum", values: ["A", "B"] }, wo: { type: "ref", to: "work_order" } } };
    const wo = { object: "work_order", titleField: "wo_no", fields: { wo_no: { type: "text" } } };
    const defs = new Map([["lot", lot], ["work_order", wo]]);
    const book = writeXlsx([{ name: "_about", rows: [
        ["OpenCore MES export"], ["exported", "2026-10-01T08:00:00.000Z"], ["by", "sam"], [],
        ["model", "label", "definition version", "matched by", "records", "import may create", "import may update"], ["lot", "Lot", 3, "lot_no", 2, true, false], [],
        ["model", "field", "label", "type", "required", "values / refers to"], ...Object.keys(lot.fields).map((f) => ["lot", f, ...aboutField(lot, defs, f)]),
    ] }]);
    const about = aboutOf(readXlsx(book));
    assert.equal(about.models.get("lot"), 3);
    assert.deepEqual([...about.fields.get("lot").keys()], ["lot_no", "qty", "grade", "wo"]);
    assert.deepEqual(modelChanges(lot, defs, about.fields.get("lot")), [], "the same model: nothing changed");
    // Since the export: a unit in a label, a value gone, a field removed, a new required field.
    const now = { ...lot, fields: { lot_no: lot.fields.lot_no, qty: { type: "decimal", label: "Quantity (lb)" }, grade: { type: "enum", values: ["A", "C"] }, site: { type: "text", required: true } } };
    assert.deepEqual(modelChanges(now, defs, about.fields.get("lot")), [
        'qty was labelled "Quantity (kg)", now "Quantity (lb)"',
        "grade was A, B, now A, C",
        "wo is no longer a field",
        "site is required, and not in this file",
    ]);
    assert.equal(aboutOf([{ name: "lot", rows: [["lot_no"]] }]), null, "a workbook without _about: nothing to check");
});

test("a hostile workbook is refused in words, quickly: a part that inflates without end, a row or a cell far away, tags never closed", () => {
    const book = (sheet, extra = {}) => zip({
        "xl/workbook.xml": '<workbook><sheets><sheet name="lot" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": sheet, ...extra,
    });
    // The reading alone is timed (the workbooks are made first: one of them deflates 200 MB), with room
    // for a slow machine; what it guards against took seconds to hours.
    const timed = (fn) => { const t = Date.now(); const out = fn(); assert.ok(Date.now() - t < 4000, `took ${Date.now() - t} ms`); return out; };
    const read = (workbook) => timed(() => readXlsx(workbook));
    const cell = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
    // A part the workbook never names is never opened, however large it would be.
    const bomb = book(cell, { "xl/media/bomb.bin": "\0".repeat(200 * 1024 * 1024) });
    assert.deepEqual(read(bomb)[0].rows, [[1]]);
    // …and one it does name is read only so far.
    const large = book(" ".repeat(70 * 1024 * 1024));
    assert.throws(() => read(large), /too large/);
    assert.throws(() => timed(() => readXlsx(book('<worksheet><sheetData><row r="8000000"><c r="A8000000"><v>1</v></c></row></sheetData></worksheet>'))), /row numbered 8000000/);
    assert.throws(() => timed(() => readXlsx(book('<worksheet><sheetData><row r="1"><c r="ZZZZZ1"><v>1</v></c></row></sheetData></worksheet>'))), /past the last column/);
    const wide = `<worksheet><sheetData>${Array.from({ length: 200 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`).join("")}</sheetData></worksheet>`;
    const wideBook = book(wide);
    assert.throws(() => read(wideBook), /more than 2000000 cells/);
    // Unclosed tags: read to the end once, not once per tag.
    const unclosedRows = book(`<worksheet><sheetData>${"<row>".repeat(200_000)}</sheetData></worksheet>`);
    assert.deepEqual(read(unclosedRows)[0].rows, []);
    const unclosedStrings = book(cell, { "xl/sharedStrings.xml": `<sst>${"<si><t>".repeat(200_000)}</sst>` });
    assert.deepEqual(read(unclosedStrings)[0].rows, [[1]]);
    // A directory that points outside the file.
    const cut = book(cell); cut.writeUInt32LE(0x7fffffff, cut.length - 6);
    assert.throws(() => readXlsx(cut), /damaged|not an .xlsx/);
});
