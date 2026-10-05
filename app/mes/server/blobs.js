// Pictures (DESIGN.md §35) and documents (§34.10): what an image field holds, what a floor layout is
// drawn on, what a person attaches for a copilot to read and a report to show.
//
//   POST /blob          the file's bytes as the body (a picture: PNG, JPEG or WebP, at most MAX_BYTES; a
//                       document: PDF, CSV or an Excel workbook, at most DOC_BYTES), from this site's own
//                       pages, by someone signed in → { blob, type, size }
//   GET  /blob/<sha256>  the file, to anyone signed in: a picture shown, a document saved
//                       (?name= gives the file its name)
//
// A picture is kept by what it is: its name is the SHA-256 of its bytes. So it never changes (a design
// or a record that names one names exactly those bytes, and may be cached for ever), the same picture
// uploaded twice is kept once, and nothing is ever replaced under a name. What kind it is is read from
// its first bytes, never from what the browser says: only those three kinds are kept, so nothing that
// could run (SVG, HTML) is ever served from here, and each is served as what it is, never sniffed.
// A picture's name cannot be guessed without the picture; whoever is signed in and has its name may
// read it (a record whose image field a policy hides does not give the name out).
import { createHash } from "node:crypto";
import { readBody } from "../../../src/server/http.js";
import { sessionIdOf } from "./auth.js";

export const MAX_BYTES = 5_000_000;
export const DOC_BYTES = 10_000_000;
export const PDF = "application/pdf", CSV = "text/csv", XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const KINDS = { "image/png": "picture", "image/jpeg": "picture", "image/webp": "picture", [PDF]: "PDF", [CSV]: "CSV file", [XLSX]: "Excel workbook" };
const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", [PDF]: "pdf", [CSV]: "csv", [XLSX]: "xlsx" };
// What a document is, by its bytes: a PDF by its header; a workbook as the zip that holds xl/workbook.xml;
// a CSV file as text (UTF-8, no NUL) of lines with separators. Nothing else is kept.
export function fileType(bytes) {
    const image = imageType(bytes);
    if (image) return image;
    if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
    if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return PDF;
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04 && bytes.includes(Buffer.from("xl/workbook.xml"))) return XLSX;
    const head = bytes.subarray(0, 65536);
    if (head.includes(0)) return null;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.length > 65536 ? head.subarray(0, head.lastIndexOf(0x0a) > 0 ? head.lastIndexOf(0x0a) : head.length) : head); } catch { return null; }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.length >= 1 && lines.slice(0, 20).every((l) => /[,;\t]/.test(l) || lines.length === 1) && /[,;\t]/.test(text) ? CSV : null;
}
export const BLOB = /^[0-9a-f]{64}$/;
// What a picture is, by its first bytes.
export function imageType(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    return null;
}
// Uploads a person may make in an hour: files are kept for ever.
const UPLOADS = { perPerson: 60, everyMs: 60 * 60_000 };

export function createBlobs({ store, log = console, uploads = UPLOADS }) {
    const { db } = store;
    const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; };
    const sameSite = (req) => {
        const from = req.headers.origin ?? req.headers.referer;
        try { return Boolean(from) && new URL(from).host === req.headers.host; } catch { return false; }
    };
    const made = [];
    const within = (user) => {
        const since = Date.now() - uploads.everyMs;
        while (made.length && made[0].at < since) made.shift();
        if (made.filter((m) => m.user === user).length >= uploads.perPerson) return false;
        made.push({ user, at: Date.now() });
        return true;
    };
    async function put(user, bytes) {
        const type = fileType(bytes);
        if (!type) return { status: 415, error: "Keep a picture (PNG, JPEG, WebP), a PDF, a CSV file or an Excel workbook (.xlsx)." };
        if (type.startsWith("image/") && bytes.length > MAX_BYTES) return { status: 413, error: `A picture is at most ${MAX_BYTES / 1_000_000} MB: save it smaller, or as a JPEG or WebP.` };
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        await db.query("INSERT INTO mes.blobs (sha256, type, size, bytes, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sha256) DO NOTHING", [sha256, type, bytes.length, bytes, user.id]);
        return { blob: sha256, type, size: bytes.length };
    }
    const exists = async (sha256) => typeof sha256 === "string" && BLOB.test(sha256) && (await db.query("SELECT 1 FROM mes.blobs WHERE sha256 = $1", [sha256])).length > 0;
    // What is kept under each name: { type, size }, without the bytes.
    const about = async (names) => new Map((await db.query("SELECT sha256, type, size FROM mes.blobs WHERE sha256 = ANY($1)", [names.filter((n) => typeof n === "string" && BLOB.test(n))])).map((r) => [r.sha256, { type: r.type, size: r.size }]));
    const bytesOf = async (sha256) => (await db.query("SELECT type, bytes FROM mes.blobs WHERE sha256 = $1", [sha256]))[0] ?? null;

    const handler = async (req, res, url) => {
        if (url.pathname !== "/blob" && !url.pathname.startsWith("/blob/")) return false;
        const user = await store.userForSession(sessionIdOf(req));
        if (!user) return json(res, 401, { error: "Sign in first." });
        if (req.method === "POST" && url.pathname === "/blob") {
            if (!sameSite(req)) return json(res, 403, { error: "Upload from this site's own page." });
            if (!within(user.id)) return json(res, 429, { error: "A great many files in the past hour: try again later." });
            const bytes = await readBody(req, { limit: DOC_BYTES });
            if (bytes === null) return json(res, 413, { error: `A file is at most ${DOC_BYTES / 1_000_000} MB (a picture ${MAX_BYTES / 1_000_000} MB).` });
            const out = await put(user, bytes).catch((error) => { log.error?.("blob: keeping a file", error); return { status: 500, error: "The file could not be kept." }; });
            return out.error ? json(res, out.status, { error: out.error }) : json(res, 200, out);
        }
        const m = /^\/blob\/([0-9a-f]{64})$/.exec(url.pathname);
        if ((req.method === "GET" || req.method === "HEAD") && m) {
            const [row] = await db.query("SELECT type, bytes FROM mes.blobs WHERE sha256 = $1", [m[1]]);
            if (!row) return json(res, 404, { error: "No such file." });
            // Its bytes never change under this name: kept by the browser, and by it alone. A picture is
            // shown; a document is saved, under the name asked for (letters, digits, - _ . and spaces).
            const picture = row.type.startsWith("image/");
            const asked = String(url.searchParams.get("name") ?? "").replace(/[^A-Za-z0-9 ._-]/g, "_").replace(/^[. ]+/, "").slice(0, 120);
            const name = asked ? (asked.toLowerCase().endsWith(`.${EXTENSION[row.type]}`) ? asked : `${asked}.${EXTENSION[row.type]}`) : `${m[1].slice(0, 12)}.${EXTENSION[row.type]}`;
            res.writeHead(200, { "content-type": row.type, "content-length": row.bytes.length, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": picture ? "inline" : `attachment; filename="${name}"` });
            res.end(req.method === "HEAD" ? undefined : row.bytes);
            return true;
        }
        return json(res, 404, { error: "Not found." });
    };
    return { handler, put, exists, about, bytesOf };
}
