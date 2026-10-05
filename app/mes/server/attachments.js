// Attachments (DESIGN.md §34.10): files a person gives a copilot with a message (the analytics copilot,
// the design copilot) or keeps with a prompt: a picture, a PDF, a CSV file, an Excel workbook, from the
// file store (blobs.js: kept by what they are, never changed). A conversation keeps only what names them,
// { type: "attachment", blob, name, mime }; each time the model is asked, they are given as it reads
// them: a picture as an image, a PDF as a document, a spreadsheet as its rows in text (what it reads of
// them is clipped, and says so). A model that reads no PDF or picture is told one was attached.
import { PDF, CSV, XLSX, KINDS, BLOB } from "./blobs.js";
import { readXlsx } from "./xlsx.js";

export const MAX_ATTACHMENTS = 5;
const TEXT_CHARS = 30_000; // of a spreadsheet, what the model is given
const SHEET_ROWS = 400;

// What is wrong with a list of attachments as a page sends it ([{ blob, name }]), or null.
export function attachmentsProblem(list) {
    if (list === undefined || list === null) return null;
    if (!Array.isArray(list) || list.length > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} files.`;
    for (const a of list) {
        if (!a || typeof a !== "object" || typeof a.blob !== "string" || !BLOB.test(a.blob)) return "An attachment is a file kept here (upload it first).";
        if (a.name !== undefined && (typeof a.name !== "string" || a.name.length > 200)) return "An attachment's name is at most 200 characters.";
    }
    if (new Set(list.map((a) => a.blob)).size !== list.length) return "The same file is attached twice.";
    return null;
}

export function createAttachments({ blobs }) {
    // Attachments checked against the store: each kept, of a kind a copilot reads. → [{ blob, name, type, size }]
    async function checked(list) {
        const problem = attachmentsProblem(list);
        if (problem) return { problem };
        const kept = await blobs.about((list ?? []).map((a) => a.blob));
        const out = [];
        for (const a of list ?? []) {
            const k = kept.get(a.blob);
            if (!k || !KINDS[k.type]) return { problem: `"${a.name ?? a.blob.slice(0, 8)}" is not a file kept here: upload it again.` };
            out.push({ blob: a.blob, name: String(a.name ?? `${KINDS[k.type]}`).trim().slice(0, 200) || KINDS[k.type], type: k.type, size: k.size });
        }
        return { list: out };
    }
    // What names them in a conversation: kept with the message, no bytes.
    const blocks = (list) => list.map((a) => ({ type: "attachment", blob: a.blob, name: a.name, mime: a.type }));

    // The messages as the model reads them: every attachment block given as its file is.
    async function expand(messages) {
        const out = [];
        for (const m of messages) {
            if (m.role !== "user" || !Array.isArray(m.content) || !m.content.some((b) => b?.type === "attachment")) { out.push(m); continue; }
            const content = [];
            for (const b of m.content) {
                if (b?.type !== "attachment") { content.push(b); continue; }
                content.push(...(await given(b)));
            }
            out.push({ ...m, content });
        }
        return out;
    }
    async function given(a) {
        const row = await blobs.bytesOf(a.blob);
        const head = `Attached ${KINDS[a.mime] ?? "file"} "${a.name}" (attachment ${a.blob}: name it so to show it in a report; never quote it to the person).`;
        if (!row) return [{ type: "text", text: `${head} It is no longer kept here.` }];
        const bytes = Buffer.from(row.bytes);
        if (row.type.startsWith("image/")) return [{ type: "text", text: head }, { type: "image", source: { type: "base64", media_type: row.type, data: bytes.toString("base64") } }];
        if (row.type === PDF) return [{ type: "text", text: head }, { type: "document", source: { type: "base64", media_type: PDF, data: bytes.toString("base64") }, title: a.name }];
        if (row.type === CSV) return [{ type: "text", text: `${head}\n${clip(bytes.toString("utf8"))}` }];
        if (row.type === XLSX) {
            try {
                const sheets = readXlsx(bytes, { maxRows: SHEET_ROWS });
                const text = sheets.map((s) => `Sheet "${s.name}":\n${(s.rows ?? []).map((r) => r.map(cell).join(",")).join("\n")}`).join("\n\n");
                return [{ type: "text", text: `${head}\n${clip(text)}` }];
            } catch {
                return [{ type: "text", text: `${head} It could not be read as a workbook.` }];
            }
        }
        return [{ type: "text", text: head }];
    }
    return { checked, blocks, expand };
}
const cell = (v) => { const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const clip = (text) => (text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}\n… (clipped: the first ${TEXT_CHARS} characters of ${text.length})` : text);
