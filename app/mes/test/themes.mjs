// Themes (§10.8), end to end, against a server of its own:
//   1. By default a page follows the device (no data-theme). Olga picks dark: her pages are drawn dark
//      from the first byte; a scheme that is not light, dark or system is refused.
//   2. The plant's theme is a change to People & departments: a colour that cannot be read is a
//      problem, and the change cannot be submitted until it is fixed. Routed to governance.
//   3. Approved with the scheme "light": every page is light, Olga's dark choice included, its colours
//      follow the stylesheet, and the top bar says the plant's name. Put back afterwards, through a change.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/themes.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["olga", "dana", "vera", "eli"]) {
        sessions[user] = `th-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const page = async (user) => (await fetch(`${mes}/o/lot`, { headers: { cookie: `mes_session=${sessions[user]}` } })).text();
    const htmlTag = (html) => /<html[^>]*>/.exec(html)?.[0] ?? "";

    // ---- 1. the person's choice ----
    const plain = await page("olga");
    step("by default a page follows the device: no data-theme, no theme colours", !/data-theme/.test(htmlTag(plain)) && !/--accent:/.test(plain), htmlTag(plain));
    await call("olga", "prefs.set", { scheme: "dark" });
    const dark = await page("olga");
    step("Olga picks dark: her page is drawn dark from the first byte", /data-theme="dark"/.test(htmlTag(dark)), htmlTag(dark));
    const odd = await call("olga", "prefs.set", { scheme: "sepia" });
    step("a scheme that is not light, dark or system is refused", odd.status === 400 && /light, dark/.test(odd.error), odd);
    const others = await page("vera");
    step("…and it is hers: Vera's page still follows her device", !/data-theme/.test(htmlTag(others)), htmlTag(others));

    // ---- 2. the plant's theme, as a change ----
    const { id } = await call("dana", "design.start", { organization: true });
    const org = (await call("dana", "design.change", { id, as: "dana" })).content.organization;
    const unreadable = await call("dana", "design.save", { id, reason: "Plant 1's look.", organization: { ...org, theme: { scheme: "light", name: "Plant 1", scope: "Lyon", colors: { light: { accent: "#ffff00" } } } } });
    const refused = await call("dana", "design.submit", { id });
    step("an accent nobody can read is a problem, and the change is not submitted", (unreadable.problems ?? []).some((p) => /accent text on a panel reads at 1\.\d:1/.test(p.message)) && refused.status >= 400, { problems: unreadable.problems, refused });
    const fresh = await call("dana", "design.change", { id, as: "dana" });
    await call("dana", "design.save", { id, seen: fresh.draft_rev, organization: { ...org, theme: { scheme: "light", name: "Plant 1", scope: "Lyon", colors: { light: { accent: "#1d4ed8" } } } } });
    const submitted = await call("dana", "design.submit", { id });
    const routed = await call("dana", "design.change", { id, as: "dana" });
    step("with a readable accent it is submitted, routed to governance (Engineering)", submitted.ok && routed.route.map((r) => r.department).join() === "engineering" && routed.footprint.some((e) => e.element === "theme"), { submitted, problems: routed.problems, route: routed.route, footprint: routed.footprint?.map((e) => e.element) });
    await call("vera", "design.review", { id, decision: "pass" });
    const live = await call("eli", "design.approve", { id, department: "engineering", decision: "approve", meaning: "Approved" });

    // ---- 3. the plant decides ----
    const locked = await page("olga");
    step("approved with the scheme light: Olga's page is light, her dark choice set aside", live.state === "executed" && /data-theme="light"/.test(htmlTag(locked)), { state: live.state, html: htmlTag(locked) });
    step("its colours follow the stylesheet, and the top bar's state names the plant", /<style>:root\{--accent:#1d4ed8;--accent-soft:#[0-9a-f]{6};\}<\/style>/.test(locked) && /"theme":\{"scheme":"light","name":"Plant 1","scope":"Lyon"\}/.test(locked), locked.match(/<style>[^<]*<\/style>/)?.[0]);
    const vera = await page("vera");
    step("…for everyone", /data-theme="light"/.test(htmlTag(vera)), htmlTag(vera));

    // Put back as it was, through a change, so later suites find the plant as seeded.
    const back = await call("dana", "design.start", { organization: true });
    const now = (await call("dana", "design.change", { id: back.id, as: "dana" })).content.organization;
    const { theme, ...rest } = now;
    await call("dana", "design.save", { id: back.id, reason: "As it was.", organization: rest });
    await call("dana", "design.submit", { id: back.id });
    await call("vera", "design.review", { id: back.id, decision: "pass" });
    const undone = await call("eli", "design.approve", { id: back.id, department: "engineering", decision: "approve", meaning: "Approved" });
    const after = await page("olga");
    step("put back: Olga's own dark choice holds again", undone.state === "executed" && /data-theme="dark"/.test(htmlTag(after)), { state: undone.state, html: htmlTag(after) });
    await call("olga", "prefs.set", { scheme: "system" });
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
