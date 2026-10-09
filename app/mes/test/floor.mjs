// Floor layouts, pictures and image fields (§35), end to end against a running server:
//   1. The picture store: a PNG is kept by what it is (its SHA-256), once however often it is uploaded,
//      and read back as it was; what is not a picture, is too large, comes from another site or from
//      nobody is refused.
//   2. An image field: the machine object gains one through a change; a record takes a picture's name,
//      and nothing else.
//   3. A floor layout is a screen's block: its mistakes are named; designed, reviewed and approved, it
//      draws the placed machines where they stand, each with its state and its picture.
//   4. It follows the records: a machine that goes down is down on the floor at the next reading, and
//      every record write touches the screen's data (live).
//   5. With the viewer's rights: someone with no role on machines is shown where they stand and nothing
//      about them; only the placed records are read.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/floor.mjs   (after a reset)
import pg from "pg";
import { randomBytes, createHash } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
// The same picture with a text chunk after it: other bytes, so another picture.
const PNG2 = Buffer.concat([PNG, Buffer.from(`floor-${tag}`)]);

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["sam", "dana", "eli", "ivan", "olga"]) {
        sessions[user] = `fl-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args ?? {}]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `fl-${randomBytes(8).toString("hex")}`;
    const put = async (user, bytes, { type = "image/png", origin = mes } = {}) => {
        const res = await fetch(`${mes}/blob`, { method: "POST", headers: { "content-type": type, ...(origin ? { origin } : {}), ...(user ? { cookie: `mes_session=${sessions[user]}` } : {}) }, body: bytes });
        return { status: res.status, ...(await res.json().catch(() => ({}))) };
    };
    const get = async (user, name) => {
        const res = await fetch(`${mes}/blob/${name}`, { headers: user ? { cookie: `mes_session=${sessions[user]}` } : {} });
        return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), sniff: res.headers.get("x-content-type-options"), csp: res.headers.get("content-security-policy"), bytes: Buffer.from(await res.arrayBuffer()) };
    };

    // ---- 1. the picture store ----
    const sha = createHash("sha256").update(PNG).digest("hex");
    const [first, again] = [await put("dana", PNG), await put("sam", PNG)];
    const [kept] = await db.query("SELECT count(*)::int AS n, min(created_by) AS by FROM mes.blobs WHERE sha256 = $1", [sha]);
    const read = await get("olga", sha);
    step("a picture is kept by what it is: its name is the SHA-256 of its bytes, kept once however often it is uploaded, and read back as it was, to be kept by the browser and never sniffed",
        first.status === 200 && first.blob === sha && first.type === "image/png" && first.size === PNG.length && again.blob === sha && kept.n === 1 && kept.by === "dana" && read.status === 200 && read.bytes.equals(PNG) && read.type === "image/png" && /immutable/.test(read.cache) && /private/.test(read.cache) && read.sniff === "nosniff" && /sandbox/.test(read.csp),
        { first, again, kept, read: { ...read, bytes: read.bytes.length } });
    const refused = {
        svg: await put("dana", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), { type: "image/svg+xml" }),
        lie: await put("dana", Buffer.from("<!doctype html><script>alert(1)</script>"), { type: "image/png" }),
        large: await put("dana", Buffer.concat([PNG, Buffer.alloc(5_000_001)])),
        elsewhere: await put("dana", PNG, { origin: "https://evil.example" }),
        nobody: await put(null, PNG),
        unread: await get(null, sha),
        missing: await get("dana", "0".repeat(64)),
    };
    step("refused: what is not a picture whatever it calls itself (SVG, HTML named PNG), one too large, one from another site, one from nobody; nobody unsigned reads one; one that is not there is not found",
        refused.svg.status === 415 && refused.lie.status === 415 && refused.large.status === 413 && refused.elsewhere.status === 403 && refused.nobody.status === 401 && refused.unread.status === 401 && refused.missing.status === 404,
        Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.status])));

    // ---- 2. an image field ----
    const change = await call("dana", "design.start", { object: "machine" });
    const machine = (await call("dana", "design.change", { id: change.id, as: "dana" })).content.definitions.machine;
    const saved = await call("dana", "design.save", { id: change.id, reason: "A picture of each machine, for the floor layout.", definitions: { machine: { ...machine, fields: { ...machine.fields, photo: { label: "Picture", type: "image" } } } } });
    await call("dana", "design.submit", { id: change.id });
    await call("eli", "design.review", { id: change.id, decision: "pass" });
    let fieldLive = null;
    for (const [user, department] of [["sam", "production"], ["quinn", "quality"], ["eli", "engineering"]]) {
        if (!sessions[user]) { sessions[user] = `fl-${randomBytes(8).toString("hex")}`; await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]); }
        const r = await call(user, "design.approve", { id: change.id, department, decision: "approve", meaning: "Approved" });
        if (r.state) fieldLive = r.state;
        if (fieldLive === "executed") break;
    }
    const A = `FL-A-${tag}`;
    const B = `FL-B-${tag}`;
    const a = await call("sam", "records.create", { object: "machine", data: { machine_id: A, name: "Press A", kind: "press", capacity: 1, photo: sha }, key: key() });
    const b = await call("sam", "records.create", { object: "machine", data: { machine_id: B, name: "Press B", kind: "press", capacity: 1 }, key: key() });
    const notOne = await call("sam", "records.create", { object: "machine", data: { machine_id: `FL-X-${tag}`, name: "Press X", kind: "press", capacity: 1, photo: "https://evil.example/x.png" }, key: key() });
    step("an image field arrives through a change like any field; a record takes a picture's name, and nothing else (not an address)",
        !saved.error && fieldLive === "executed" && a.id && a.photo === sha && b.id && notOne.status === 400 && /Upload a picture/.test(notOne.fields?.photo ?? ""), { saved: saved.error ?? "saved", fieldLive, a: a.error ?? a.photo, notOne });

    // ---- 3. a floor layout ----
    const floorImage = await put("dana", PNG2);
    const SCREEN = `line_status_${tag}`;
    const floor = { block: "floor", title: "Line 1", width: 12, object: "machine", status: "state", colours: { running: "ok", idle: "c1", down: "danger" }, image: { blob: floorImage.blob, w: 1600, h: 900 }, picture: "photo",
        places: [{ of: A, x: 0.1, y: 0.2, w: 0.08, ix: 0.8, iy: 0.1 }, { of: B, x: 0.3, y: 0.2, w: 0.08, ix: 0.5, iy: 0.5 }, { of: `GONE-${tag}`, x: 0.5, y: 0.2, w: 0.08, ix: 0.5, iy: 0.5 }] };
    const sc = await call("dana", "design.start", { screen: SCREEN, label: "Line status" });
    const draft = (await call("dana", "design.change", { id: sc.id, as: "dana" })).content.screens[SCREEN];
    const screen = { ...draft, blocks: [floor], callers: { users: ["sam", "ivan"], groups: [] }, stewards: ["production"] };
    const wrong = await call("dana", "design.check", { screens: { [SCREEN]: { ...screen, blocks: [{ ...floor, status: "colour", colours: { running: "#0f0" }, image: undefined, picture: "name", places: [floor.places[0], { ...floor.places[0], x: 3 }] }] } } });
    const wrongWords = (wrong.problems ?? []).map((p) => p.message).join("\n");
    step("a floor's mistakes are named as it is designed: a status that is not a field, a colour that is not the theme's, no picture of the floor, a picture field that is not an image, a record placed twice, a place off the floor",
        /machine has no field "colour"/.test(wrongWords) && /the legend's colour for "running"/.test(wrongWords) && /upload the picture of the floor/.test(wrongWords) && /"name" is not an image field of machine/.test(wrongWords) && /placed twice/.test(wrongWords) && /fractions between 0 and 1/.test(wrongWords), wrong.problems ?? wrong);
    const okSave = await call("dana", "design.save", { id: sc.id, reason: "The line, seen from above.", screens: { [SCREEN]: screen } });
    await call("dana", "design.submit", { id: sc.id });
    await call("eli", "design.review", { id: sc.id, decision: "pass" });
    const live = await call("sam", "design.approve", { id: sc.id, department: "production", decision: "approve", meaning: "Approved" });
    const seen = await call("sam", "screens.data", { name: SCREEN, arg: null, as: "sam" });
    const f = seen.blocks?.[0] ?? {};
    const item = (data, of) => (data.items ?? []).find((it) => it.of === of);
    step("designed, reviewed and approved, it draws the placed machines where they stand, each with its state as it is and its picture; one that is not a record is drawn where it stands, saying nothing; the legend lists the states with the colours given",
        !okSave.error && live.state === "executed" && f.image?.blob === floorImage.blob && f.items?.length === 3 && item(f, A)?.id === a.id && item(f, A).status === "idle" && item(f, A).picture === sha && item(f, A).x === 0.1 && item(f, A).ix === 0.8
        && item(f, B)?.status === "idle" && item(f, B).picture === null && item(f, `GONE-${tag}`)?.id === null && item(f, `GONE-${tag}`).status === null && f.values?.includes("down") && f.colours?.running === "ok" && f.status === "state",
        { save: okSave.error ?? "saved", state: live.state ?? live, floor: f });

    // ---- 4. it follows the records ----
    const down = await call("sam", "records.update", { object: "machine", id: a.id, rowVersion: a.row_version, data: { down_reason: "Hydraulic leak" }, key: key() });
    const broke = await call("sam", "records.action", { object: "machine", id: a.id, action: "break_down", rowVersion: down.row_version, key: key() });
    const after = (await call("sam", "screens.data", { name: SCREEN, arg: null, as: "sam" })).blocks?.[0] ?? {};
    const touched = app.touchesOf?.("records.action", [{ object: "machine", id: a.id }], broke) ?? null;
    step("it follows the records: the machine goes down, and is down on the floor at the next reading; the other is as it was",
        broke.state === "down" && item(after, A)?.status === "down" && item(after, B)?.status === "idle", { broke: broke.state ?? broke, after: after.items, touched });
    const page = await fetch(`${mes}/s/${SCREEN}`, { headers: { cookie: `mes_session=${sessions.sam}` } });
    const html = await page.text();
    step("the screen's page is served with the floor on it: the floor's picture, each machine where it stands, its square in its status's colour",
        page.status === 200 && html.includes(`/blob/${floorImage.blob}`) && html.includes(`/blob/${sha}`) && /floor-dot fc-danger/.test(html) && /floor-dot fc-c1/.test(html) && html.includes(A), { status: page.status, has: [html.includes(`/blob/${floorImage.blob}`), /fc-danger/.test(html), /fc-c1/.test(html)] });

    // ---- 5. with the viewer's rights ----
    const ivans = (await call("ivan", "screens.data", { name: SCREEN, arg: null, as: "ivan" })).blocks?.[0] ?? {};
    const olgas = await call("olga", "screens.data", { name: SCREEN, arg: null, as: "olga" });
    step("with the viewer's rights: Ivan, who may open the screen but holds no role on machines, is shown where they stand and nothing about them; Olga, who may not open it, is shown no floor",
        ivans.items?.length === 3 && ivans.items.every((it) => it.id === null && it.status === null && it.picture === null) && (olgas === null || olgas?.status >= 400 || !olgas?.blocks), { ivans: ivans.items ?? ivans, olga: olgas?.status ?? olgas });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.();
    await pool.end();
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
