// Excel workbooks (.xlsx) with nothing but Node (DESIGN.md §24). An .xlsx file is a zip of XML parts;
// this writes the few a workbook needs, and reads what Excel, LibreOffice and Google Sheets write:
// shared and inline strings, numbers, booleans. Dates and references are read as the model's field
// types say (transfer.js), so styles are not needed to read them.
//
//   writeXlsx([{ name, rows: [[cell, …], …], widths? }]) → Buffer   (the first row is the header)
//   readXlsx(buffer) → [{ name, rows: [[string | number | boolean | null, …], …] }]
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";

// ---- zip ------------------------------------------------------------------------------------------
function zip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nameBuf = Buffer.from(name, "utf8");
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        const packed = deflateRawSync(raw);
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
        local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
        central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, packed);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + packed.length;
    }
    const dir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
}

// { name: Buffer } of a zip's files.
// What a workbook may hold once read: a small file can name far more than it carries (a part that
// inflates to gigabytes, a row numbered eight million, a cell in column ZZZZZ), and reading is done
// before anyone's rights or the import's own row limit are looked at.
const MAX_PART = 64 * 1024 * 1024;      // one part, inflated
const MAX_TOTAL = 128 * 1024 * 1024;    // every part read, inflated
export const MAX_SHEET_ROWS = 100_000;
const MAX_COLUMNS = 16_384;             // Excel's own limit (XFD)
const MAX_CELLS = 2_000_000;            // across the workbook, empty ones between filled ones counted

// The zip's parts by name, each inflated only when it is read (a workbook's own parts are; anything
// else in the file is never touched), and never past the limits above.
function unzip(buf) {
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error("This is not an .xlsx file (no zip directory found).");
    const count = buf.readUInt16LE(end + 10);
    let p = buf.readUInt32LE(end + 16);
    const parts = new Map();
    try {
        for (let n = 0; n < count; n++) {
            if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("The .xlsx file is damaged.");
            const method = buf.readUInt16LE(p + 10);
            const size = buf.readUInt32LE(p + 20);
            const nameLen = buf.readUInt16LE(p + 28);
            const extraLen = buf.readUInt16LE(p + 30);
            const commentLen = buf.readUInt16LE(p + 32);
            const localAt = buf.readUInt32LE(p + 42);
            const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
            const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
            parts.set(name, { method, data: buf.subarray(dataAt, dataAt + size) });
            p += 46 + nameLen + extraLen + commentLen;
        }
    } catch (e) {
        // A directory that points outside the file.
        if (e instanceof RangeError) throw new Error("The .xlsx file is damaged.");
        throw e;
    }
    let total = 0;
    const read = new Map();
    return (name) => {
        if (read.has(name)) return read.get(name);
        const part = parts.get(name);
        if (!part) return null;
        let data;
        if (part.method === 0) data = part.data;
        else if (part.method === 8) {
            try { data = inflateRawSync(part.data, { maxOutputLength: MAX_PART }); } catch (e) {
                throw new Error(e?.code === "ERR_BUFFER_TOO_LARGE" ? `The workbook is too large: ${name} is over ${MAX_PART / 1024 / 1024} MB once opened.` : "The .xlsx file is damaged.");
            }
        } else throw new Error(`The .xlsx file uses a compression this reader does not know (${part.method}).`);
        total += data.length;
        if (total > MAX_TOTAL) throw new Error(`The workbook is too large: over ${MAX_TOTAL / 1024 / 1024} MB once opened.`);
        read.set(name, data);
        return data;
    };
}

// ---- XML ------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // XML 1.0 cannot hold most control characters: dropped rather than writing a file Excel refuses.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()];
});
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const colName = (i) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "A") n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// ---- writing --------------------------------------------------------------------------------------
function sheetXml({ rows, widths }) {
    const out = [];
    rows.forEach((row, r) => {
        const cells = row.map((v, c) => {
            const ref = `${colName(c)}${r + 1}`;
            const style = r === 0 ? ' s="1"' : "";
            if (v === null || v === undefined || v === "") return "";
            if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
            if (typeof v === "boolean") return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
            return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        }).join("");
        out.push(`<row r="${r + 1}">${cells}</row>`);
    });
    const cols = widths?.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${out.join("")}</sheetData></worksheet>`;
}

// A sheet's name as Excel allows it: at most 31 characters, none of []:*?/\.
export const sheetName = (name) => String(name).replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet";

export function writeXlsx(sheets) {
    const files = [
        { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
        { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
        { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
        ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
    ];
    return zip(files);
}

// ---- reading --------------------------------------------------------------------------------------
// Each <tag …>…</tag> or <tag …/> of `xml`, as [attributes, body or null], found by indexOf: a lazy
// regex over a part full of unclosed tags reads the rest of the part once per tag (80,000 of them held
// the server for seconds). An element that is never closed ends the reading of its part.
function* elements(xml, tag) {
    const open = `<${tag}`, close = `</${tag}>`;
    let at = 0;
    for (;;) {
        const start = xml.indexOf(open, at);
        if (start < 0) return;
        const next = xml[start + open.length];
        if (next !== ">" && next !== "/" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") { at = start + open.length; continue; }
        const gt = xml.indexOf(">", start);
        if (gt < 0) return;
        if (xml[gt - 1] === "/") { yield [xml.slice(start + open.length, gt - 1), null]; at = gt + 1; continue; }
        const stop = xml.indexOf(close, gt);
        if (stop < 0) return;
        yield [xml.slice(start + open.length, gt), xml.slice(gt + 1, stop)];
        at = stop + close.length;
    }
}
const first = (xml, tag) => { for (const [, body] of elements(xml, tag)) return body ?? ""; return undefined; };
const textOf = (xml) => { let out = ""; for (const [, body] of elements(xml, "t")) out += unesc(body ?? ""); return out; };

export function readXlsx(buffer, { maxRows = MAX_SHEET_ROWS } = {}) {
    const part = unzip(buffer);
    const text = (name) => part(name)?.toString("utf8") ?? null;
    const workbook = text("xl/workbook.xml");
    if (!workbook) throw new Error("This is not an Excel workbook (no xl/workbook.xml).");
    const rels = Object.fromEntries([...(text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
    const shared = [];
    for (const [, body] of elements(text("xl/sharedStrings.xml") ?? "", "si")) shared.push(textOf(body ?? ""));
    const sheets = [];
    let cells = 0;
    for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
        const name = unesc(attr(m[0], "name") ?? "");
        const target = rels[attr(m[0], "r:id")] ?? "";
        const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
        const xml = text(path);
        if (!xml) continue;
        const rows = [];
        for (const [rowAttrs, rowBody] of elements(xml, "row")) {
            const r = Number(attr(rowAttrs, "r")) - 1;
            const at = Number.isInteger(r) && r >= 0 ? r : rows.length;
            if (at >= maxRows) throw new Error(`Sheet "${name}" has a row numbered ${at + 1}; at most ${maxRows} rows are read.`);
            const row = [];
            for (const [cellAttrs, cellBody] of elements(rowBody ?? "", "c")) {
                const ref = attr(cellAttrs, "r");
                const col = ref ? colIndex(ref) : row.length;
                if (!(col >= 0 && col < MAX_COLUMNS)) throw new Error(`Sheet "${name}" has a cell at ${ref}, past the last column a workbook has.`);
                const type = attr(cellAttrs, "t");
                const body = cellBody ?? "";
                const v = first(body, "v");
                let value = null;
                if (type === "s") value = v === undefined ? null : shared[Number(v)] ?? null;
                else if (type === "inlineStr") value = textOf(first(body, "is") ?? "");
                else if (type === "b") value = v === "1";
                else if (type === "str" || type === "e") value = v === undefined ? null : unesc(v);
                else if (v !== undefined) value = Number(v);
                row[col] = value;
            }
            cells += row.length;
            if (cells > MAX_CELLS) throw new Error(`The workbook has more than ${MAX_CELLS} cells, counting the empty ones between its filled ones.`);
            rows[at] = Array.from(row, (x) => (x === undefined ? null : x));
        }
        sheets.push({ name, rows: Array.from(rows, (x) => x ?? []) });
    }
    return sheets;
}

// An Excel date serial number (1900 system) as YYYY-MM-DD.
export const excelDate = (serial) => new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
