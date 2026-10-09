// Pictures (DESIGN.md §35), documents (§34.10) and videos (§35.4): what an image or a file field holds,
// what a floor layout is drawn on, what a screen's media block shows, what a person attaches for a copilot
// to read and a report to show.
//
//   POST /blob          the file's bytes as the body (a picture: PNG, JPEG or WebP, at most MAX_BYTES; a
//                       document: PDF, CSV or an Excel workbook, at most DOC_BYTES; a video: MP4 or WebM,
//                       at most VIDEO_BYTES), from this site's own pages, by someone signed in (?name= the
//                       name it had) → { blob, type, size, name }
//   GET  /blob/<sha256>  the file, to anyone signed in: a picture or a video shown, a PDF shown with ?view=1,
//                       any other document saved (?name= gives the file its name)
//   GET  /file/<object>/<id>/<field>   the file a record's file or image field holds, only to someone who
//                       may read that record and that field (its policies, what its access requires, §9.9),
//                       served as /blob/ serves it
// Both answer a range of bytes (Range: bytes=…, 206), so a video seeks without being read whole.
//
// A picture is kept by what it is: its name is the SHA-256 of its bytes. So it never changes (a design
// or a record that names one names exactly those bytes, and may be cached for ever), the same picture
// uploaded twice is kept once, and nothing is ever replaced under a name. What kind it is is read from
// its first bytes, never from what the browser says: only those three kinds are kept, so nothing that
// could run (SVG, HTML) is ever served from here, and each is served as what it is, never sniffed.
// A picture's name cannot be guessed without the picture; whoever is signed in and has its name may
// read it (a record whose image field a policy hides does not give the name out).
import { createHash } from "node:crypto";
import { readBody } from "@opencore-mes/juris-kit/server/http.js";
import { sessionIdOf } from "./auth.js";

export const MAX_BYTES = 5_000_000;
export const DOC_BYTES = 10_000_000;
export const VIDEO_BYTES = 100_000_000;
export const PDF = "application/pdf", CSV = "text/csv", XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", MP4 = "video/mp4", WEBM = "video/webm";
export const KINDS = { "image/png": "picture", "image/jpeg": "picture", "image/webp": "picture", [PDF]: "PDF", [CSV]: "CSV file", [XLSX]: "Excel workbook", [MP4]: "video", [WEBM]: "video" };
const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", [PDF]: "pdf", [CSV]: "csv", [XLSX]: "xlsx", [MP4]: "mp4", [WEBM]: "webm" };
// What a file field may take (`accept`), by kind: the field's own list, or pictures, PDFs and videos.
export const ACCEPT = { picture: ["image/png", "image/jpeg", "image/webp"], pdf: [PDF], video: [MP4, WEBM], spreadsheet: [CSV, XLSX] };
export const acceptedTypes = (accept) => (Array.isArray(accept) && accept.length ? accept : ["picture", "pdf", "video"]).flatMap((k) => ACCEPT[k] ?? []);
// The most a file of a type may be.
export const limitOf = (type) => (type.startsWith("image/") ? MAX_BYTES : type.startsWith("video/") ? VIDEO_BYTES : DOC_BYTES);
// A video, by its bytes: MP4 by its `ftyp` box (not QuickTime's own "qt  " brand, which browsers do not all
// play), WebM by its EBML header naming the webm doc type.
export function videoType(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 16) return null;
    if (bytes.subarray(4, 8).toString("latin1") === "ftyp" && bytes.subarray(8, 12).toString("latin1") !== "qt  ") return MP4;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && bytes.subarray(0, 64).includes(Buffer.from("webm"))) return WEBM;
    return null;
}
// What a document is, by its bytes: a PDF by its header; a workbook as the zip that holds xl/workbook.xml;
// a CSV file as text (UTF-8, no NUL) of lines with separators. Nothing else is kept.
export function fileType(bytes) {
    const image = imageType(bytes) ?? videoType(bytes);
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

// A file's name as it may be given in a header and kept: letters, digits, - _ . and spaces.
const cleanName = (n) => String(n ?? "").replace(/[^A-Za-z0-9 ._-]/g, "_").replace(/^[. ]+/, "").slice(0, 120);
// One range of bytes asked for (`Range: bytes=…`): { start, end } (inclusive), "bad" when it cannot be
// served, or null to send the whole (none asked, or several, which are answered whole).
export function rangeOf(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
    if (!m || (m[1] === "" && m[2] === "")) return null;
    let start;
    let end;
    if (m[1] === "") { const n = Number(m[2]); if (n === 0) return "bad"; start = Math.max(0, size - n); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
    return start > end || start >= size ? "bad" : { start, end };
}

// `fileOf(user, object, id, field)` → the blob a record's file or image field holds when this user may read
// it (the record services', app.mjs), or null.
export function createBlobs({ store, log = console, uploads = UPLOADS, fileOf = async () => null }) {
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
    async function put(user, bytes, name = null) {
        const type = fileType(bytes);
        if (!type) return { status: 415, error: "Keep a picture (PNG, JPEG, WebP), a PDF, a video (MP4, WebM), a CSV file or an Excel workbook (.xlsx)." };
        if (type.startsWith("image/") && bytes.length > MAX_BYTES) return { status: 413, error: `A picture is at most ${MAX_BYTES / 1_000_000} MB: save it smaller, or as a JPEG or WebP.` };
        if (!type.startsWith("image/") && !type.startsWith("video/") && bytes.length > DOC_BYTES) return { status: 413, error: `A document is at most ${DOC_BYTES / 1_000_000} MB.` };
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const kept = cleanName(name) || null;
        await db.query("INSERT INTO mes.blobs (sha256, type, size, bytes, created_by, name) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (sha256) DO NOTHING", [sha256, type, bytes.length, bytes, user.id, kept]);
        const [row] = await db.query("SELECT name FROM mes.blobs WHERE sha256 = $1", [sha256]);
        return { blob: sha256, type, size: bytes.length, name: row?.name ?? kept };
    }
    const exists = async (sha256) => typeof sha256 === "string" && BLOB.test(sha256) && (await db.query("SELECT 1 FROM mes.blobs WHERE sha256 = $1", [sha256])).length > 0;
    // What is kept under each name: { type, size }, without the bytes.
    const about = async (names) => new Map((await db.query("SELECT sha256, type, size, name FROM mes.blobs WHERE sha256 = ANY($1)", [names.filter((n) => typeof n === "string" && BLOB.test(n))])).map((r) => [r.sha256, { type: r.type, size: r.size, name: r.name ?? null }]));

    // One file to the browser, whole or a range of it. Its bytes never change under its name: kept by the
    // browser, and by it alone. A picture and a video are shown; a PDF is shown when asked (?view=1, in a
    // frame of this site's pages) and saved otherwise; a CSV file or a workbook is saved, under the name
    // asked for or the one it was uploaded under.
    async function send(req, res, url, sha256) {
        const [meta] = await db.query("SELECT type, size, name FROM mes.blobs WHERE sha256 = $1", [sha256]);
        if (!meta) return json(res, 404, { error: "No such file." });
        const shown = meta.type.startsWith("image/") || meta.type.startsWith("video/");
        const view = meta.type === PDF && url.searchParams.get("view") === "1";
        const asked = cleanName(url.searchParams.get("name")) || meta.name || "";
        const name = asked ? (asked.toLowerCase().endsWith(`.${EXTENSION[meta.type]}`) ? asked : `${asked}.${EXTENSION[meta.type]}`) : `${sha256.slice(0, 12)}.${EXTENSION[meta.type]}`;
        const headers = {
            "content-type": meta.type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "accept-ranges": "bytes",
            // A PDF shown in a frame of this site's pages: the browser's viewer runs it, so it is not sandboxed
            // (a sandboxed PDF is not shown at all); nothing else of this site's is reachable from it.
            "content-security-policy": view ? "default-src 'none'; frame-ancestors 'self'" : "default-src 'none'; sandbox",
            ...(view ? { "x-frame-options": "SAMEORIGIN" } : {}),
            "content-disposition": shown || view ? `inline; filename="${name}"` : `attachment; filename="${name}"`,
        };
        const range = rangeOf(req.headers.range, meta.size);
        if (range === "bad") { res.writeHead(416, { ...headers, "content-range": `bytes */${meta.size}` }); res.end(); return true; }
        if (!range) {
            res.writeHead(200, { ...headers, "content-length": meta.size });
            if (req.method === "HEAD") res.end();
            else res.end((await db.query("SELECT bytes FROM mes.blobs WHERE sha256 = $1", [sha256]))[0].bytes);
            return true;
        }
        const length = range.end - range.start + 1;
        res.writeHead(206, { ...headers, "content-length": length, "content-range": `bytes ${range.start}-${range.end}/${meta.size}` });
        if (req.method === "HEAD") res.end();
        else res.end((await db.query("SELECT substring(bytes from $2 for $3) AS part FROM mes.blobs WHERE sha256 = $1", [sha256, range.start + 1, length]))[0].part);
        return true;
    }
    const bytesOf = async (sha256) => (await db.query("SELECT type, bytes FROM mes.blobs WHERE sha256 = $1", [sha256]))[0] ?? null;

    const handler = async (req, res, url) => {
        const file = /^\/file\/([a-z][a-z0-9_]{0,62})\/([0-9a-f-]{36})\/([a-z][a-z0-9_]{0,62})$/.exec(url.pathname);
        if (url.pathname !== "/blob" && !url.pathname.startsWith("/blob/") && !file) return false;
        const user = await store.userForSession(sessionIdOf(req));
        if (!user) return json(res, 401, { error: "Sign in first." });
        if (req.method === "POST" && url.pathname === "/blob") {
            if (!sameSite(req)) return json(res, 403, { error: "Upload from this site's own page." });
            if (!within(user.id)) return json(res, 429, { error: "A great many files in the past hour: try again later." });
            const bytes = await readBody(req, { limit: VIDEO_BYTES });
            if (bytes === null) return json(res, 413, { error: `A file is at most ${VIDEO_BYTES / 1_000_000} MB (a video; a document ${DOC_BYTES / 1_000_000} MB, a picture ${MAX_BYTES / 1_000_000} MB).` });
            const out = await put(user, bytes, url.searchParams.get("name")).catch((error) => { log.error?.("blob: keeping a file", error); return { status: 500, error: "The file could not be kept." }; });
            return out.error ? json(res, out.status, { error: out.error }) : json(res, 200, out);
        }
        if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Not allowed." });
        // A record's file: only through the record, as its reader.
        if (file) {
            const sha256 = await fileOf(user, file[1], file[2], file[3]).catch((error) => { log.error?.("file: reading a record's file", error); return null; });
            return sha256 && BLOB.test(sha256) ? send(req, res, url, sha256) : json(res, 404, { error: "No such file, or not yours to read." });
        }
        const m = /^\/blob\/([0-9a-f]{64})$/.exec(url.pathname);
        if (m) return send(req, res, url, m[1]);
        return json(res, 404, { error: "Not found." });
    };
    return { handler, put, exists, about, bytesOf };
}
