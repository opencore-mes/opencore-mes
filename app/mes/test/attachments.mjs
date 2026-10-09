// Attachments (§34.10), end to end against a running server, with a scripted model in place of the AI:
//   1. The file store keeps a picture, a PDF, a CSV file and an Excel workbook, each by what its bytes are
//      (an HTML page refused); a document is saved under the name asked for, a picture shown. An image
//      field refuses a PDF: it holds a picture.
//   2. The analytics copilot is asked with three files: the model is given the picture as an image, the
//      PDF as a document and the workbook as its rows; the conversation keeps only their names. The
//      report it draws shows the picture as a media block, which a run gives as kept. A file not kept
//      here, and too many, are refused in words.
//   3. The design copilot is given what is attached the same way.
//   4. A kept prompt keeps its attachments, and is given them each time it is asked.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/attachments.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { writeXlsx } from "../server/xlsx.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDFDOC = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF ${tag}\n`);
const CSVDOC = Buffer.from(`parameter,min,max\nthickness ${tag},48,52\nwidth,9.8,10.2\n`);
const XLSXDOC = writeXlsx([{ name: "Limits", rows: [["parameter", "min", "max"], [`bond force ${tag}`, 40, 60]] }]);

// The model, scripted: what it is given is kept for the checks; with an attachment it shows the picture.
const given = [];
const scripted = {
    name: "scripted", model: "scripted-model", available: true,
    async complete({ system, messages }) {
        given.push({ system: system.slice(0, 40), messages });
        const last = messages[messages.length - 1];
        if (/design copilot/.test(system)) return { stop: "end", content: [{ type: "text", text: "Read the drawing: two fields." }] };
        if (last.content?.some?.((b) => b.type === "tool_result")) return { stop: "end", content: [{ type: "text", text: "Drawn, with the picture." }] };
        const text = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const pic = /Attached picture "[^"]*" \(attachment ([0-9a-f]{64})/.exec(text)?.[1];
        return { stop: "tools", content: [{ type: "tool_use", id: `r${given.length}`, name: "render_report", input: { title: `With files ${tag}`, blocks: [{ block: "text", text: "The photo shows the defect; the spec allows 48 to 52." }, ...(pic ? [{ block: "media", title: "The defect", blob: pic, caption: "As photographed at the line" }] : [])] } }] };
    },
};

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, ai: scripted });
const { url: mes } = await app.listen({ port: 0 });
const people = ["sam", "dana", "olga"];
const sessions = {};
for (const user of people) {
    sessions[user] = `at-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const attempt = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, status: error.status, message: error.message, fields: error.body?.fields }));
const upload = async (user, bytes) => { const res = await fetch(`${mes}/blob`, { method: "POST", headers: { cookie: `mes_session=${sessions[user]}`, origin: mes }, body: bytes }); return { status: res.status, ...(await res.json()) }; };
const wait = async (fn) => { for (let i = 0; i < 200; i++) { const v = await fn(); if (!v.running) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error("never finished"); };
const blocksOf = (m) => (Array.isArray(m.content) ? m.content : []);

try {
    // ---- 1. the store ----
    const [png, pdf, csv, xlsx] = [await upload("sam", PNG), await upload("sam", PDFDOC), await upload("sam", CSVDOC), await upload("sam", XLSXDOC)];
    const html = await upload("sam", Buffer.from("<html><script>alert(1)</script></html>"));
    const saved = await fetch(`${mes}/blob/${pdf.blob}?name=${encodeURIComponent("Spec <rev B>")}`, { headers: { cookie: `mes_session=${sessions.sam}` } });
    const shown = await fetch(`${mes}/blob/${png.blob}`, { headers: { cookie: `mes_session=${sessions.sam}` } });
    // An image field holds a picture: Picture on Machine, as the floor suite designs it.
    const [machine] = await db.query("SELECT body FROM mes.definitions WHERE object = 'machine' AND status = 'published'");
    const photoField = Object.entries(machine.body.fields).find(([, f]) => f.type === "image")?.[0];
    let imageRefused = { skipped: true };
    if (photoField) {
        // As one who may give a machine its picture (Sam, as the floor suite runs it): a PDF is refused, a picture kept.
        imageRefused = await attempt(call("sam", "records.create", { object: "machine", data: { machine_id: `AT-${tag}`, name: "Press AT", kind: "press", capacity: 1, [photoField]: pdf.blob }, key: `at-${tag}-img` }));
    }
    step("the store keeps a picture, a PDF, a CSV file and an Excel workbook by what their bytes are (an HTML page refused); a document is saved under the name asked for (made safe), a picture shown; an image field refuses a PDF",
        png.type === "image/png" && pdf.type === "application/pdf" && csv.type === "text/csv" && xlsx.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" && html.status === 415 &&
        /^attachment; filename="Spec _rev B_\.pdf"$/.test(saved.headers.get("content-disposition") ?? "") && /^inline(;|$)/.test(shown.headers.get("content-disposition") ?? "") && /sandbox/.test(saved.headers.get("content-security-policy") ?? "") &&
        (imageRefused.skipped || (!imageRefused.ok && /Upload a picture/.test(JSON.stringify(imageRefused.fields ?? imageRefused.message)))),
        { png, pdf, csv, xlsx, html, disposition: saved.headers.get("content-disposition"), imageRefused });

    // ---- 2. the analytics copilot ----
    const files = [{ blob: png.blob, name: "defect.png" }, { blob: pdf.blob, name: "Spec rev B.pdf" }, { blob: xlsx.blob, name: "limits.xlsx" }];
    const before = given.length;
    await call("sam", "analyst.send", { text: "What does the photo show, and is it within the spec?", attachments: files });
    const view = await wait(() => call("sam", "analyst.get"));
    const firstAsk = given[before]?.messages.find((m) => m.role === "user");
    const kinds = blocksOf(firstAsk ?? {}).map((b) => b.type);
    const image = blocksOf(firstAsk ?? {}).find((b) => b.type === "image");
    const document = blocksOf(firstAsk ?? {}).find((b) => b.type === "document");
    const sheet = blocksOf(firstAsk ?? {}).find((b) => b.type === "text" && /Sheet "Limits"/.test(b.text));
    const [kept] = await db.query("SELECT messages FROM mes.analyst_conversations WHERE owner = 'sam'").catch(() => [null]);
    const keptText = JSON.stringify(kept?.messages ?? []);
    const report = view.report;
    const media = report?.blocks?.find((b) => b.block === "media");
    const ran = report ? await call("sam", "reports.run", { report }) : null;
    const ranMedia = ran?.blocks?.find((b) => b.block === "media");
    const userMsg = view.transcript?.find((m) => m.role === "user");
    const unknown = await attempt(call("sam", "analyst.send", { text: "And this?", attachments: [{ blob: "f".repeat(64), name: "gone.pdf" }] }));
    const many = await attempt(call("sam", "analyst.send", { text: "And these?", attachments: Array.from({ length: 6 }, (_, i) => ({ blob: `${i}`.repeat(64).slice(0, 64), name: `x${i}` })) }));
    step("the analytics copilot is asked with three files: the model is given the picture as an image, the PDF as a document, the workbook as its rows; the conversation keeps only their names; the report shows the picture, a run gives it as kept; a file not kept here, and six files, are refused in words",
        kinds.includes("image") && image?.source?.media_type === "image/png" && image.source.data === PNG.toString("base64") && document?.source?.media_type === "application/pdf" && Buffer.from(document.source.data, "base64").equals(PDFDOC) &&
        sheet && sheet.text.includes(`bond force ${tag}`) && (!kept || (!keptText.includes(PNG.toString("base64")) && keptText.includes(png.blob))) &&
        media?.blob === png.blob && ranMedia?.media?.type === "image/png" && userMsg?.files?.length === 3 &&
        !unknown.ok && /not a file kept here/.test(unknown.message) && !many.ok && /at most 5 files/.test(many.message),
        { kinds, sheet: sheet?.text?.slice(0, 200), media, ranMedia, files: userMsg?.files, unknown, many, kept: Boolean(kept) });

    // ---- 3. the design copilot ----
    const { id: change } = await call("dana", "design.start", { object: `att_${tag}`, label: "From a drawing" });
    const dBefore = given.length;
    await call("dana", "copilot.send", { change, text: "Design the object this form shows.", attachments: [{ blob: png.blob, name: "form.png" }, { blob: csv.blob, name: "values.csv" }] });
    await wait(() => call("dana", "copilot.get", { change }));
    const dAsk = given.slice(dBefore).find((g) => /design copilot/.test(g.system))?.messages.find((m) => m.role === "user");
    step("the design copilot is given what is attached the same way: the form as an image, the CSV file as its text",
        blocksOf(dAsk ?? {}).some((b) => b.type === "image") && blocksOf(dAsk ?? {}).some((b) => b.type === "text" && b.text.includes(`thickness ${tag}`)), { kinds: blocksOf(dAsk ?? {}).map((b) => b.type) });
    await attempt(call("dana", "design.withdraw", { id: change }));

    // ---- 4. a kept prompt keeps its attachments ----
    const keptPrompt = await call("sam", "prompts.save", { title: `Spec check ${tag}`, prompt: "Is the line within this spec?", schedule: null, attachments: [{ blob: pdf.blob, name: "Spec rev B.pdf" }] });
    const listed = (await call("sam", "prompts.list", {})).find((p) => p.id === keptPrompt.id);
    const pBefore = given.length;
    await call("sam", "prompts.run", { id: keptPrompt.id });
    for (let i = 0; i < 200 && given.length === pBefore; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const pAsk = given[pBefore]?.messages.find((m) => m.role === "user");
    step("a kept prompt keeps its attachments, and is given them each time it is asked",
        listed?.attachments?.length === 1 && listed.attachments[0].blob === pdf.blob && blocksOf(pAsk ?? {}).some((b) => b.type === "document"), { listed: listed?.attachments, kinds: blocksOf(pAsk ?? {}).map((b) => b.type) });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app.close?.().catch(() => {});
    await pool.end();
}
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
