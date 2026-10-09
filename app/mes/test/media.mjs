// Files on records and screens (DESIGN.md §35.4), end to end over HTTP on the seed:
//   1. Uploaded by their bytes: a PDF and an MP4 kept, under the names they had; a QuickTime movie and a
//      page of HTML refused, in words.
//   2. Steps whose instruction is a file field taking a PDF or a video; lots whose instruction is derived
//      from their step (§6.11). A picture given to the step is refused, naming what it takes.
//   3. A lot's instruction read through the lot, as its reader: a PDF saved, or shown with ?view=1 (inline,
//      framed only by this site); a video played, a range of it answered (206), one past its end refused (416).
//   4. Someone who may not read the lot gets nothing at its address.
//   5. A screen's media blocks, each with its steps (the lot's from its step's text, the screen's own written in it): the lot's instruction for the lot it is opened with, read as the viewer (Quinn,
//      who may not read the lot, is not shown the screen for it), and a guide of the screen's own. A media
//      block's mistakes named.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/media.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;
const people = ["dana", "eli", "vera", "sam", "quinn"];
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of people) {
        sessions[user] = `md-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const cookie = (user) => `mes_session=${sessions[user]}`;
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie(user) }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? (body && typeof body === "object" && !Array.isArray(body) ? { ok: true, ...body } : { ok: true, value: body }) : { ok: false, status: res.status, ...body };
    };
    const upload = async (user, bytes, name) => {
        const res = await fetch(`${mes}/blob?name=${encodeURIComponent(name)}`, { method: "POST", headers: { cookie: cookie(user), origin: mes, "content-type": "application/octet-stream" }, body: bytes });
        return { status: res.status, ...(await res.json()) };
    };
    const get = (user, path, headers = {}) => fetch(`${mes}${path}`, { headers: { cookie: cookie(user), ...headers } });
    const key = () => `md-${randomBytes(6).toString("hex")}`;
    const approveAll = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        if (!submitted.ok) return { state: null, submitted };
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 3 && state !== "executed"; round++) for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
        return { state };
    };
    const change = async (content, first, label, reason) => {
        const started = await call("dana", "design.start", { object: first, label });
        const seen = await call("dana", "design.change", { id: started.id, as: "dana" });
        const saved = await call("dana", "design.save", { id: started.id, seen: seen.draft_rev, reason, ...content });
        return { id: started.id, saved };
    };

    // ---- 1. uploaded by their bytes ----
    const pdfBytes = await fixture("guide.pdf");
    const mp4Bytes = await fixture("clip.mp4");
    const pdf = await upload("dana", pdfBytes, "Cover torque.pdf");
    const mp4 = await upload("dana", mp4Bytes, "Cover torque.mp4");
    const mov = await upload("dana", Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(64)]), "clip.mov");
    const html = await upload("dana", Buffer.from("<html><script>alert(1)</script></html>"), "page.html");
    step("a PDF and an MP4 are kept under the names they had; a QuickTime movie and a page of HTML are refused, in words",
        pdf.status === 200 && pdf.type === "application/pdf" && pdf.name === "Cover torque.pdf" && mp4.status === 200 && mp4.type === "video/mp4" && mp4.size === mp4Bytes.length &&
        mov.status === 415 && /a video \(MP4, WebM\)/.test(mov.error) && html.status === 415, { pdf, mp4, mov, html });

    // ---- 2. steps with a file, lots deriving it ----
    const [STEP, LOT] = ["step", "lot"].map((x) => `md_${x}_t${tag}`);
    const object = (name, label, fields, titleField) => ({ object: name, label, area: "Production", titleField, fields, states: { initial: "open", list: ["open"], transitions: [] }, roles: ["user"], stewards: { object: ["production"] }, policies: [{ id: `${name}-all`, roles: ["user"], record: { read: true, create: true }, fields: { "*": "write" } }], rules: [] });
    const SCREEN = `md_station_t${tag}`;
    const screen = {
        name: SCREEN, label: `Media station ${tag}`, description: "", params: { lot: { label: "Lot", type: "ref", to: LOT, required: true } },
        blocks: [
            { block: "text", text: "**Before you start**\n- Read the instruction\n- See [the plant's guide](https://plant.example/guide)", width: 12 },
            { block: "media", title: "Work instruction", object: LOT, of: { param: "lot" }, field: "instruction", stepsField: "instruction_steps", height: 400, width: 8 },
            { block: "media", title: "Station guide", file: pdf.blob, name: "Station guide", steps: "1 Remove the cover\n2 Clean the seal\n3 Torque the cover", width: 4 },
        ],
        callers: { users: [], groups: ["production", "quality"] }, stewards: ["production"],
    };
    const made = await change({
        definitions: {
            [STEP]: object(STEP, `Media step ${tag}`, { name: { label: "Step", type: "string" }, instruction: { label: "Instruction", type: "file", accept: ["pdf", "video"] }, instruction_steps: { label: "Its steps", type: "text" } }, "name"),
            [LOT]: object(LOT, `Media lot ${tag}`, { lot_id: { label: "Lot", type: "string" }, step: { label: "Step", type: "ref", to: STEP }, instruction: { label: "Instruction", type: "file", from: "step.instruction" }, instruction_steps: { label: "Its steps", type: "text", from: "step.instruction_steps" } }, "lot_id"),
        },
        screens: { [SCREEN]: screen },
    }, STEP, `Media step ${tag}`, "Steps with their instruction; lots showing their step's.");
    const madeDone = await approveAll(made.id);
    await db.query("INSERT INTO mes.assignments (object, role, subject_kind, subject_id) SELECT o, 'user', 'user', u FROM unnest($1::text[]) o, unnest($2::text[]) u ON CONFLICT DO NOTHING", [[STEP, LOT], ["sam", "eli"]]);
    const make = (o, data) => call("sam", "records.create", { object: o, data, key: key() });
    const torque = await make(STEP, { name: `Torque ${tag}`, instruction: pdf.blob, instruction_steps: "1 Remove the cover\n2 Clean the seal\n3 Torque crosswise to 12 Nm" });
    const film = await make(STEP, { name: `Film ${tag}`, instruction: mp4.blob, instruction_steps: "0:00 Set the part\n0:01 Torque it" });
    const png = await upload("dana", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), "dot.png");
    const picture = await make(STEP, { name: `Picture ${tag}`, instruction: png.blob });
    const lot1 = await make(LOT, { lot_id: `L1-${tag}`, step: torque.id });
    const lot2 = await make(LOT, { lot_id: `L2-${tag}`, step: film.id });
    step("steps take a PDF or a video; a picture is refused, naming what it takes; a lot's instruction is its step's (derived)",
        !made.saved.problems?.length && madeDone.state === "executed" && torque.ok && film.ok && picture.status === 400 && /takes a PDF or a video/.test(picture.fields?.instruction ?? "") &&
        lot1.instruction === pdf.blob && lot2.instruction === mp4.blob && lot1.$perm?.fields?.instruction === "r", { problems: made.saved.problems, madeDone, picture, lot1 });

    // ---- 3. read through the lot ----
    const saved = await get("sam", `/file/${LOT}/${lot1.id}/instruction`);
    const viewed = await get("sam", `/file/${LOT}/${lot1.id}/instruction?view=1`);
    const body = Buffer.from(await viewed.arrayBuffer());
    step("a lot's PDF, read through the lot: saved under its name, or shown in this site's frame (?view=1: inline, not sandboxed, SAMEORIGIN)",
        saved.status === 200 && saved.headers.get("content-type") === "application/pdf" && /attachment; filename="Cover torque.pdf"/.test(saved.headers.get("content-disposition") ?? "") &&
        viewed.status === 200 && /^inline/.test(viewed.headers.get("content-disposition") ?? "") && viewed.headers.get("x-frame-options") === "SAMEORIGIN" &&
        !/sandbox/.test(viewed.headers.get("content-security-policy") ?? "") && /frame-ancestors 'self'/.test(viewed.headers.get("content-security-policy") ?? "") && body.equals(pdfBytes),
        { saved: [saved.status, ...saved.headers], viewed: [viewed.status, ...viewed.headers] });
    const part = await get("sam", `/file/${LOT}/${lot2.id}/instruction`, { range: "bytes=0-99" });
    const partBytes = Buffer.from(await part.arrayBuffer());
    const tail = await get("sam", `/file/${LOT}/${lot2.id}/instruction`, { range: `bytes=${mp4Bytes.length - 10}-` });
    const past = await get("sam", `/file/${LOT}/${lot2.id}/instruction`, { range: `bytes=${mp4Bytes.length}-` });
    const head = await fetch(`${mes}/file/${LOT}/${lot2.id}/instruction`, { method: "HEAD", headers: { cookie: cookie("sam") } });
    step("a video plays: shown inline, seeking answered by ranges (206, the bytes asked for), one past its end refused (416); asked about without its bytes (HEAD)",
        part.status === 206 && part.headers.get("content-range") === `bytes 0-99/${mp4Bytes.length}` && partBytes.equals(mp4Bytes.subarray(0, 100)) && /^inline/.test(part.headers.get("content-disposition") ?? "") &&
        tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(mp4Bytes.subarray(mp4Bytes.length - 10)) &&
        past.status === 416 && past.headers.get("content-range") === `bytes */${mp4Bytes.length}` &&
        head.status === 200 && head.headers.get("accept-ranges") === "bytes" && Number(head.headers.get("content-length")) === mp4Bytes.length,
        { part: [part.status, part.headers.get("content-range")], tail: tail.status, past: [past.status, past.headers.get("content-range")], head: [head.status, ...head.headers] });

    // ---- 4. not theirs ----
    const quinn = await get("quinn", `/file/${LOT}/${lot1.id}/instruction`);
    const nobody = await fetch(`${mes}/file/${LOT}/${lot1.id}/instruction`);
    const notFile = await get("sam", `/file/${LOT}/${lot1.id}/lot_id`);
    step("Quinn, who may not read the lot, gets nothing at its address; nobody signed in gets nothing; a field that is no file is no file",
        quinn.status === 404 && nobody.status === 401 && notFile.status === 404, { quinn: quinn.status, nobody: nobody.status, notFile: notFile.status });

    // ---- 5. the screen ----
    const samScreen = await call("sam", "screens.data", { name: SCREEN, arg: lot1.id, as: "sam" });
    const quinnScreen = await call("quinn", "screens.data", { name: SCREEN, arg: lot1.id, as: "quinn" });
    const [, record, own] = samScreen.blocks ?? [];
    step("a screen's media blocks: the lot's instruction for the lot it is opened with, read as the viewer, and the screen's own guide; Quinn, who may not read that lot, is not shown the screen for it at all",
        samScreen.ok && record?.src === `/file/${LOT}/${lot1.id}/instruction` && record.type === "application/pdf" && record.name === "Cover torque.pdf" &&
        own?.src === `/blob/${pdf.blob}` && own.name === "Station guide" &&
        // Its steps: the lot's (from its step, derived), and the screen's own.
        record.steps?.map((x) => x.at).join() === "1,2,3" && record.steps[2].label === "Torque crosswise to 12 Nm" && own.steps?.length === 3 && quinnScreen.need === "lot" && !quinnScreen.blocks && /that you can see/.test(quinnScreen.error ?? ""),
        { sam: samScreen.blocks, quinn: quinnScreen, error: samScreen.error });
    const wrong = await change({ screens: { [SCREEN]: { ...screen, blocks: [{ block: "media", object: LOT, of: { param: "lot" }, field: "lot_id", stepsField: "step" }, { block: "media", file: "x".repeat(64), steps: "Remove the cover" }] } } }, STEP, `Media step ${tag}`, "Wrong on purpose.");
    const words = (wrong.saved.problems ?? []).map((p) => p.message).join("\n");
    await call("dana", "design.withdraw", { id: wrong.id });
    step("a media block's mistakes are named: a field that holds no file, a file name that is none, steps from a field that is no text, a step with no page or time",
        /names a file or picture field of md_lot_t\d+ \(instruction\)/.test(words) && /a 64-character name/.test(words) && /its steps come from a text field/.test(words) && /start it with a page \(3\) or a time \(0:45\)/.test(words), wrong.saved.problems);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.().catch(() => {});
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
