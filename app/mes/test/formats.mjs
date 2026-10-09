// How the plant writes dates, times and numbers (§27.6), end to end:
//   1. By default, as stored: 2027-03-31, 1,250.
//   2. A change to People & departments sets German formats: its mistakes named, approved by
//      governance alone, executed.
//   3. Every page follows: a record's date fields read 31.03.2027, its list 1.250, its history on the
//      plant's clock; what is stored does not change.
//   4. Put back, for the suites after this one.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/formats.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, plantTz: "UTC" });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["olga", "dana", "vera", "eli"]) {
        sessions[user] = `fmt-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status };
    };
    const page = async (path) => (await fetch(`${mes}${path}`, { headers: { cookie: `mes_session=${sessions.olga}` } })).text();
    const [lot] = await db.query("SELECT id, data FROM mes.records WHERE object = 'lot' AND data->>'lot_no' = '4711'");
    const setFormats = async (formats, reason) => {
        const { id } = await call("dana", "design.start", { organization: true });
        const org = (await call("dana", "design.change", { id, as: "dana" })).content.organization;
        const saved = await call("dana", "design.save", { id, reason, organization: { ...org, formats } });
        return { id, saved };
    };
    const execute = async (id) => {
        await call("dana", "design.submit", { id });
        await call("vera", "design.review", { id, decision: "pass" });
        return call("eli", "design.approve", { id, department: "engineering", decision: "approve", meaning: "Approved" });
    };

    // ---- 1. by default ----
    const before = await page(`/o/lot/${lot.id}`);
    step("by default, as stored: the expiry reads 2027-03-31", before.includes('value="2027-03-31"'), before.match(/value="[0-9.\/-]{8,10}"/g));

    // ---- 2. German formats, through a change ----
    const wrong = await setFormats({ locale: "de-DE", date: "D.M.Y", timeZone: "Mars/Olympus" }, "German formats.");
    const words = wrong.saved.problems.map((p) => p.message).join("\n");
    step("its mistakes named: a date format and a time zone that are not", /dates are written/.test(words) && /"Mars\/Olympus" is not a time zone/.test(words), wrong.saved.problems);
    const right = await call("dana", "design.save", { id: wrong.id, organization: { ...(await call("dana", "design.change", { id: wrong.id, as: "dana" })).content.organization, formats: { locale: "de-DE", date: "DD.MM.YYYY", time: "24h", firstDay: 1, timeZone: "Europe/Berlin" } } });
    const routed = await call("dana", "design.change", { id: wrong.id, as: "dana" });
    step("fixed; approved by governance alone", right.problems.length === 0 && routed.route.map((r) => r.department).join() === "engineering" && routed.footprint.some((e) => e.element === "formats"), routed.route);
    const done = await execute(wrong.id);
    step("executed", done.state === "executed", done);

    // ---- 3. every page follows ----
    const after = await page(`/o/lot/${lot.id}`);
    step("the record's date field reads 31.03.2027", after.includes('value="31.03.2027"') && after.includes('placeholder="DD.MM.YYYY"'), after.match(/value="[0-9.\/-]{8,10}"/g));
    step("the page carries the plant's formats, on its clock", /"formats":\{"locale":"de-DE","date":"DD.MM.YYYY","time":"24h","firstDay":1,"timeZone":"Europe\/Berlin"\}/.test(after));
    const list = await page("/o/lot");
    step("the list writes quantities the German way (1.250)", list.includes(">1.250<"), list.match(/>[0-9.,]{3,8}</g)?.slice(0, 8));
    const [stored] = await db.query("SELECT data->>'expiry' AS expiry FROM mes.records WHERE id = $1", [lot.id]);
    step("what is stored does not change", stored.expiry === "2027-03-31");

    // ---- 4. put back ----
    const back = await setFormats({}, "Back to the defaults.");
    step("put back", (await execute(back.id)).state === "executed" && (await page(`/o/lot/${lot.id}`)).includes('value="2027-03-31"'));
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
