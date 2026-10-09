// A desktop's page at sign-in (§6.8), end to end against a running server behind one proxy:
//   1. Desktop is a built-in object: IT keeps its records (a form, the list); others do not.
//   2. Olga signs in at the press terminal (its address): she lands on its screen, not on Home; the
//      session keeps it, the sign-in's audit says which desktop, and Home links back to it.
//   3. From any other address, and with an address a client only claims (written into the header
//      before the proxy's own), she lands on Home.
//   4. On her way somewhere (a deep link), she goes there; the desktop's page is still its own.
//   5. Someone who may not open that page lands on Home, as on any computer.
//   6. The loader: a workbook of desktops, each row found by its address, changes the press terminal
//      to a transaction and adds a bench. An address is kept in one spelling, by the object's rule.
//   7. Archived, a desktop opens nothing; its design keeps what sign-in reads (the lock).
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/desktops.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { writeXlsx } from "../server/xlsx.js";
import { hashPassword } from "../server/sign-in.js";
// Sessions are kept by the SHA-256 of their id (§8.2).
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const PRESS = `10.77.${Number(tag) % 250}.41`;
const BENCH = `10.77.${Number(tag) % 250}.42`;
let app = null;

try {
    // One proxy in front: the address is the one the proxy wrote, never one the client claims.
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, secure: false, signIn: { picker: true, passwords: true }, trustProxy: { hops: 1 } });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["ivan", "olga", "dana", "sam"]) {
        sessions[user] = `dk-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `dk-${randomBytes(8).toString("hex")}`;
    // A sign-in (the picker: this is a test instance) as it arrives through the proxy: `from` is the
    // address the proxy saw; `claimed`, what the client wrote into the header itself.
    const signIn = async (user, from, { to = null, claimed = null } = {}) => {
        const res = await fetch(`${mes}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: mes, "x-forwarded-for": [claimed, from].filter(Boolean).join(", ") }, body: new URLSearchParams({ user, ...(to ? { to } : {}) }).toString() });
        const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("mes_session=") && c !== "mes_session=") ?? null;
        return { status: res.status, at: res.headers.get("location"), cookie };
    };
    const page = async (cookie, path) => { const res = await fetch(`${mes}${path}`, { headers: { cookie } }); return { status: res.status, html: await res.text() }; };

    // ---- 1. the object ----
    const def = await call("ivan", "defs.get", { object: "desktop", as: "ivan" });
    const press = await call("ivan", "records.create", { object: "desktop", data: { name: `Press terminal ${tag}`, address: PRESS, opens: "screen", page: "shop_floor" }, key: key() });
    const notHers = await call("olga", "records.create", { object: "desktop", data: { name: "Mine", address: "10.9.9.9", opens: "screen", page: "shop_floor" }, key: key() });
    const [live] = await db.query("SELECT body FROM mes.definitions WHERE object = 'desktop' AND status = 'published'");
    step("Desktop is the platform's object; IT makes a desktop, and someone with no role on it does not", live?.body.builtIn === true && def?.label === "Desktop" && press.id && press.state === "active" && notHers.status >= 400, { def: def?.label, builtIn: live?.body.builtIn, press, notHers });
    // Its address is an IP address, kept in one spelling (its rule): so sign-in and an import find it.
    const spelled = await call("ivan", "records.create", { object: "desktop", data: { name: `Lab bench ${tag}`, address: ` ::FFFF:10.77.${Number(tag) % 250}.43 `, opens: "screen", page: "shop_floor" }, key: key() });
    const notOne = await call("ivan", "records.create", { object: "desktop", data: { name: `Nowhere ${tag}`, address: "press3", opens: "screen", page: "shop_floor" }, key: key() });
    const badPage = await call("ivan", "records.create", { object: "desktop", data: { name: `Nowhere ${tag}`, address: "10.9.9.8", opens: "screen", page: "../admin" }, key: key() });
    step("an address is kept as the IP address it is, however it was typed; what is not one, or a page not named as a design is, is refused at its field",
        spelled.address === `10.77.${Number(tag) % 250}.43` && notOne.status >= 400 && notOne.fields?.address && badPage.status >= 400 && badPage.fields?.page, { spelled: spelled.address, notOne, badPage });

    // ---- 2. at the desktop ----
    const there = await signIn("olga", PRESS);
    const [kept] = await db.query("SELECT home, home_label FROM mes.sessions WHERE id = $1", [sessionKey(there.cookie?.split("=")[1] ?? "")]);
    const [audit] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$auth' AND actor = 'olga' AND action = 'sign-in' ORDER BY seq DESC LIMIT 1");
    step("signed in at the press terminal, she lands on its screen; the session keeps it and the trail says which desktop", there.status === 303 && there.at === "/s/shop_floor" && kept?.home === "/s/shop_floor" && kept.home_label === "Shop floor" && audit?.after?.desktop === `Press terminal ${tag}` && audit.after.opens === "/s/shop_floor", { there, kept, audit: audit?.after });
    const home = await page(there.cookie, "/");
    const board = await page(there.cookie, "/s/shop_floor");
    step("Home says what this desktop opens, with a way back; its page is drawn with the control that fills and restores it", home.status === 200 && home.html.includes("This desktop opens") && home.html.includes('href="/s/shop_floor"') && board.status === 200 && board.html.includes("maximize-btn"), { home: home.status, board: board.status });

    // ---- 3. elsewhere ----
    const elsewhere = await signIn("olga", "10.99.0.7");
    const claimed = await signIn("olga", "203.0.113.9", { claimed: PRESS });
    const plain = await page(elsewhere.cookie, "/");
    step("from another address she lands on Home; an address the client only claims is not the proxy's word", elsewhere.at === "/" && claimed.at === "/" && !plain.html.includes("This desktop opens"), { elsewhere, claimed });

    // ---- 4. on her way somewhere ----
    const deep = await signIn("olga", PRESS, { to: "/o/lot" });
    const [deepKept] = await db.query("SELECT home FROM mes.sessions WHERE id = $1", [sessionKey(deep.cookie?.split("=")[1] ?? "")]);
    step("on her way to a page, she goes there; the desktop's page is still kept as its own", deep.at === "/o/lot" && deepKept?.home === "/s/shop_floor", { deep, deepKept });

    // The sign-in page's own form carries where she was going, across a wrong password too.
    const SECRET = `pw-${randomBytes(12).toString("hex")}`;
    await db.query("INSERT INTO mes.credentials (user_id, hash) VALUES ('olga', $1) ON CONFLICT (user_id) DO UPDATE SET hash = $1", [await hashPassword(SECRET)]);
    const withPassword = async (password, to) => {
        const res = await fetch(`${mes}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: mes, "x-forwarded-for": PRESS }, body: new URLSearchParams({ user: "olga", password, ...(to ? { to } : {}) }).toString() });
        return res.headers.get("location");
    };
    const wrong = await withPassword("not-her-password", "/o/lot");
    const right = await withPassword(SECRET, "/o/lot");
    const leaving = await withPassword(SECRET, "//elsewhere.example/x");
    const atDesk = await withPassword(SECRET, null);
    await db.query("DELETE FROM mes.credentials WHERE user_id = 'olga'");
    await db.query("DELETE FROM mes.sign_in_failures WHERE user_id = 'olga'");
    step("with her password too: a wrong one keeps where she was going, the right one leads there (never off this site), and with nowhere to go, to the desktop's page",
        new URLSearchParams(wrong?.split("?")[1]).get("to") === "/o/lot" && right === "/o/lot" && leaving === "/s/shop_floor" && atDesk === "/s/shop_floor", { wrong, right, leaving, atDesk });

    // ---- 5. who may not open it ----
    const dana = await signIn("dana", PRESS);
    const [danaAudit] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$auth' AND actor = 'dana' AND action = 'sign-in' ORDER BY seq DESC LIMIT 1");
    const [danaKept] = await db.query("SELECT home FROM mes.sessions WHERE id = $1", [sessionKey(dana.cookie?.split("=")[1] ?? "")]);
    step("someone who may not open that screen lands on Home, as on any computer; the trail still says which desktop it was", dana.at === "/" && dana.cookie && danaKept?.home === null && danaAudit?.after.desktop === `Press terminal ${tag}` && !danaAudit.after.opens, { dana, danaAudit, danaKept });

    // An address that is also the start of many others (…1 in …10 to …19, …100 to …124), each saved later.
    const ONE = `10.78.${Number(tag) % 250}.1`;
    const one = await call("ivan", "records.create", { object: "desktop", data: { name: `First ${tag}`, address: ONE, opens: "screen", page: "shop_floor" }, key: key() });
    for (const n of [...Array(10).keys()].map((i) => 10 + i).concat([...Array(25).keys()].map((i) => 100 + i))) {
        await call("ivan", "records.create", { object: "desktop", data: { name: `Later ${n} ${tag}`, address: `${ONE}${String(n).slice(1)}`, opens: "transaction", page: "move_in" }, key: key() });
    }
    const first = await signIn("olga", ONE);
    step("a desktop is found by its whole address, however many later ones contain it", one.id && first.at === "/s/shop_floor", { one: one.id ?? one, first });

    // ---- 6. the loader ----
    const book = writeXlsx([{ name: "desktop", rows: [["name", "address", "opens", "page", "opened_with", "note"], [`Press terminal ${tag}`, PRESS, "transaction", "move_in", null, "Now moves lots in."], [`Packing bench ${tag}`, BENCH, "screen", "shop_floor", null, null]] }]);
    const upload = async (apply) => (await fetch(`${mes}/transfer/import${apply ? "?apply=1" : ""}`, { method: "POST", headers: { "content-type": "application/octet-stream", origin: mes, cookie: `mes_session=${sessions.ivan}` }, body: book })).json();
    const countRows = async () => (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'desktop' AND archived_at IS NULL AND data->>'name' LIKE $1", [`%${tag}`]))[0].n;
    const rowsBefore = await countRows();
    const preview = await upload(false);
    const applied = await upload(true);
    const counts = (r) => r.models?.find((m) => m.object === "desktop")?.counts;
    const pressNow = await signIn("olga", PRESS);
    const bench = await signIn("olga", BENCH);
    const rows = await countRows();
    step("a workbook of desktops: previewed, then applied; the press terminal (found by its address) now opens a transaction, and the bench is new",
        counts(preview)?.update === 1 && counts(preview)?.create === 1 && counts(applied)?.update === 1 && counts(applied)?.create === 1 && rows === rowsBefore + 1 && pressNow.at === "/t/move_in" && bench.at === "/s/shop_floor",
        { preview: counts(preview) ?? preview, applied: counts(applied) ?? applied, rows, pressNow: pressNow.at, bench: bench.at });
    const moveIn = await page(pressNow.cookie, "/t/move_in");
    step("the transaction's page is drawn with the fill control too", moveIn.status === 200 && moveIn.html.includes("maximize-btn"), moveIn.status);

    // ---- 7. out of use; and what the platform reads stays ----
    const row = await call("ivan", "records.get", { object: "desktop", id: press.id, as: "ivan" });
    const archived = await call("ivan", "records.archive", { object: "desktop", id: press.id, rowVersion: row.row_version, key: key() });
    const after = await signIn("olga", PRESS);
    step("archived, the desktop opens nothing: she lands on Home there", !archived.error && after.at === "/", { archived, after });
    const change = await call("dana", "design.start", { object: "desktop" });
    const body = (await call("dana", "design.change", { id: change.id, as: "dana" })).content.definitions.desktop;
    const { address, ...fields } = body.fields;
    const broken = await call("dana", "design.save", { id: change.id, reason: "x", definitions: { desktop: { ...body, fields, form: { sections: [{ label: "Desktop", fields: ["name", "opens", "page"] }] }, list: { columns: ["name"] }, transfer: { import: { create: true, update: true, key: "name" } } } } });
    const extended = await call("dana", "design.save", { id: change.id, reason: "x", definitions: { desktop: { ...body, fields: { ...body.fields, line: { label: "Line", type: "string" } } } } });
    await call("dana", "design.withdraw", { id: change.id });
    step("its design is the plant's to add to (a line), but what sign-in reads cannot be removed", broken.problems?.some((p) => /address/.test(p.message)) && extended.problems?.length === 0, { broken: broken.problems, extended: extended.problems });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await db.query("UPDATE mes.records SET archived_at = now(), archived_by = 'test' WHERE object = 'desktop' AND archived_at IS NULL AND data->>'name' LIKE $1", [`%${tag}`]).catch(() => {});
    await app?.close?.();
    await pool.end();
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
