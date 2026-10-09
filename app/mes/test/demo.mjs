// A public demo (DEMO=1 with PROD=1), end to end: production, yet its sign-in lists the demo people
// and every page says it is a public demo; a plain production server lists nobody. Its guest (§6.9,
// SEED_GUEST): every role there is, every group and department; the demo opens as it (DEMO_AS=guest),
// and a link from the landing page lands on its page as the guest, nothing refused.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/demo.mjs   (after a reset)
import pg from "pg";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { sessionKey } from "../server/store.js";
import { addGuest, keepGuestsWhole } from "../db/guest.mjs";
import { PSEUDO_ROLES } from "../client/definition.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const apps = [];
try {
    const start = async (demo) => { const app = await createApp({ db, dev: false, demo, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 }); apps.push(app); return (await app.listen({ port: 0 })).url; };
    const demo = await start(true);
    const plain = await start(false);
    const users = async (url) => { const res = await fetch(`${url}/api/auth.users`, { method: "POST", headers: { "content-type": "application/json" }, body: "[{}]" }); return res.ok ? (await res.json()).length : -1; };
    step("the demo's sign-in lists the demo people", (await users(demo)) > 0);
    const found = await (await fetch(`${demo}/api/auth.users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ q: "olg ORTIZ" }]) })).json();
    step("…and finds one by a few letters of their name or id", found.length === 1 && found[0].id === "olga" && found[0].roles.length > 0, found);
    // The picker on a plant's test instance (no simple lists): ready to switch to, nothing typed, those who
    // review and approve, and those picked lately first.
    const pickerApp = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, signIn: { picker: true, passwords: true }, simpleLists: false });
    apps.push(pickerApp);
    const picker = (await pickerApp.listen({ port: 0 })).url;
    const ask = async (args) => (await (await fetch(`${picker}/api/auth.users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([args]) })).json());
    const approvers = new Set([
        ...(await db.query("SELECT user_id FROM mes.department_reps")).map((r) => r.user_id),
        ...(await db.query("SELECT subject_id AS id FROM mes.assignments WHERE object = 'design' AND subject_kind = 'user' UNION SELECT m.user_id FROM mes.assignments a JOIN mes.group_members m ON a.subject_kind = 'group' AND m.group_id = a.subject_id WHERE a.object = 'design'")).map((r) => r.id),
    ]);
    const ready = await ask({});
    const withRecent = await ask({ recent: ["olga", "vera"] });
    step("a plant's picker lists, with nothing typed, everyone who reviews or approves (and nobody else); those picked lately first",
        ready.length > 0 && ready.every((u) => approvers.has(u.id) || u.waiting.review.length || u.waiting.sign.length) && [...approvers].every((id) => ready.some((u) => u.id === id)) && !ready.some((u) => u.id === "olga" && !approvers.has("olga"))
        && withRecent[0]?.id === "olga" && withRecent[0].recent === true && withRecent[1]?.id === "vera", { ready: ready.map((u) => u.id), approvers: [...approvers], recent: withRecent.map((u) => u.id) });
    const picked = await fetch(`${plain}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: plain }, body: "user=olga", redirect: "manual" });
    step("a plain production server lists nobody, and refuses a sign-in without a password", (await users(plain)) === 0 && /e=wrong/.test(picked.headers.get("location") ?? "") && !picked.headers.get("set-cookie")?.includes("mes_session=") , { status: picked.status, location: picked.headers.get("location") });
    // No sign-in page: a visitor is the demo person (the first who designs), and a link goes where it points.
    const arrived = await fetch(`${demo}/login`, { redirect: "manual" });
    const visitor = (arrived.headers.get("set-cookie") ?? "").split(";")[0];
    const deep = await fetch(`${demo}/design/people`, { redirect: "manual" });
    const deepThen = await fetch(new URL(deep.headers.get("location") ?? "/", demo), { redirect: "manual" });
    const firstDesigner = (await db.query("SELECT u.id FROM mes.users u WHERE u.active AND u.id IN (SELECT subject_id FROM mes.assignments WHERE object = 'design' AND role = 'designer' AND subject_kind = 'user' UNION SELECT m.user_id FROM mes.assignments a JOIN mes.group_members m ON a.subject_kind = 'group' AND m.group_id = a.subject_id WHERE a.object = 'design' AND a.role = 'designer') ORDER BY u.name LIMIT 1"))[0]?.id;
    const [visitorSession] = await db.query("SELECT user_id FROM mes.sessions WHERE id = $1", [sessionKey(decodeURIComponent(visitor.split("=")[1] ?? ""))]);
    step("no sign-in page on the demo: a visitor is the demo person at once, and a link takes them where it points",
        arrived.status === 303 && arrived.headers.get("location") === "/" && visitorSession?.user_id === firstDesigner
        && deep.status === 302 && deep.headers.get("location") === "/login?to=%2Fdesign%2Fpeople" && deepThen.status === 303 && deepThen.headers.get("location") === "/design/people",
        { arrived: [arrived.status, arrived.headers.get("location")], who: visitorSession, firstDesigner, deep: [deep.status, deep.headers.get("location")], then: [deepThen.status, deepThen.headers.get("location")] });
    const switched = await fetch(`${demo}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: demo, cookie: visitor }, body: "user=vera&to=%2Fdesign%2Fpeople", redirect: "manual" });
    const [gone] = await db.query("SELECT 1 FROM mes.sessions WHERE id = $1", [sessionKey(decodeURIComponent(visitor.split("=")[1] ?? ""))]);
    const page = await (await fetch(`${demo}/`, { headers: { cookie: (switched.headers.get("set-cookie") ?? "").split(";")[0] } })).text();
    step("…and is someone else from the top bar, staying on the page; the last session ends; every page says it is a public demo, erased every night",
        switched.status === 303 && switched.headers.get("location") === "/design/people" && !gone && /"demo":true/.test(page), { status: switched.status, location: switched.headers.get("location"), gone });
    const signedIn = await fetch(`${demo}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: demo }, body: "user=olga", redirect: "manual" });
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0];
    const home = await (await fetch(`${demo}/`, { headers: { cookie } })).text();
    step("signed in as Olga, every page says PUBLIC DEMO", signedIn.status === 303 && /PUBLIC DEMO/.test(home), { status: signedIn.status });

    // ---- the guest ----
    const made = await addGuest(db);
    const again = await addGuest(db);
    const [{ n: departmentCount }] = await db.query("SELECT count(*)::int AS n FROM mes.groups WHERE kind = 'department'");
    const declared = [...Object.entries(PSEUDO_ROLES).filter(([o]) => o !== "privacy" && o !== "integrity").flatMap(([o, roles]) => roles.map((r) => `${o}:${r}`)), ...(await db.query("SELECT object, body->'roles' AS roles FROM mes.definitions WHERE status = 'published'")).flatMap((d) => (d.roles ?? []).map((r) => `${d.object}:${r}`))];
    const held = new Set((await db.query("SELECT object, role FROM mes.assignments WHERE subject_kind = 'group' AND subject_id = 'guests'")).map((a) => `${a.object}:${a.role}`));
    const [{ n: groups }] = await db.query("SELECT count(*)::int AS n FROM mes.groups g WHERE (g.id = 'guests' OR g.kind = 'department') AND NOT EXISTS (SELECT 1 FROM mes.group_members m WHERE m.group_id = g.id AND m.user_id = 'guest')");
    const [{ n: departments }] = await db.query("SELECT count(*)::int AS n FROM mes.groups g WHERE g.kind = 'department' AND NOT EXISTS (SELECT 1 FROM mes.department_reps r WHERE r.group_id = g.id AND r.user_id = 'guest')");
    const [person] = await db.query("SELECT 1 FROM mes.records WHERE object = 'person' AND archived_at IS NULL AND data->>'user_id' = 'guest'").catch(() => [null]);
    step("the group Guests holds every role every published object declares, the designer's, the reviewer's, the query page's and sign-in administration (not the privacy officer's, nor the integrity reviewer's); the shared guest is in it and in every department, and approves for each; a second run changes nothing",
        declared.length > 10 && declared.every((r) => held.has(r)) && groups === 0 && departments === 0 && made.given === declared.length && again.given === 0, { made, again, missing: declared.filter((r) => !held.has(r)), groups, departments, person });
    const guestApp = await createApp({ db, dev: false, demo: true, demoAs: "guest", build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    apps.push(guestApp);
    const guestUrl = (await guestApp.listen({ port: 0 })).url;
    const [screen] = await db.query("SELECT name FROM mes.screens WHERE status = 'published' ORDER BY name LIMIT 1");
    const link = await fetch(`${guestUrl}/s/${screen.name}`, { redirect: "manual" });
    const landed = await fetch(new URL(link.headers.get("location") ?? "/", guestUrl), { redirect: "manual" });
    const guestCookie = (landed.headers.get("set-cookie") ?? "").split(";")[0];
    const [guestSession] = await db.query("SELECT user_id FROM mes.sessions WHERE id = $1", [sessionKey(decodeURIComponent(guestCookie.split("=")[1] ?? ""))]);
    const shown = await fetch(new URL(landed.headers.get("location") ?? "/", guestUrl), { headers: { cookie: guestCookie } });
    const objects = (await db.query("SELECT object FROM mes.definitions WHERE status = 'published' ORDER BY object")).map((d) => d.object);
    const refused = [];
    for (const object of objects) {
        const res = await fetch(`${guestUrl}/api/records.list`, { method: "POST", headers: { "content-type": "application/json", cookie: guestCookie }, body: JSON.stringify([{ object, as: "guest" }]) });
        if (!res.ok) refused.push(`${object}: ${res.status}`);
    }
    step("the demo opens as its guest: a link from the landing page to a screen lands on that screen as the guest, and every object's records are open to it",
        link.status === 302 && link.headers.get("location") === `/login?to=%2Fs%2F${screen.name}` && landed.status === 303 && landed.headers.get("location") === `/s/${screen.name}` && guestSession?.user_id === "guest" && shown.status === 200 && /Guest/.test(await shown.text()) && !refused.length,
        { link: [link.status, link.headers.get("location")], landed: [landed.status, landed.headers.get("location")], guestSession, shown: shown.status, refused });

    // ---- a guest of each visitor's own ----
    const ownApp = await createApp({ db, dev: false, demo: true, demoAs: "guest", build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, signIn: { guests: "session", guestLimits: { perAddress: 2 } } });
    apps.push(ownApp);
    const ownUrl = (await ownApp.listen({ port: 0 })).url;
    const visit = async (to = "/") => {
        const res = await fetch(`${ownUrl}/login?to=${encodeURIComponent(to)}`, { redirect: "manual" });
        const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
        const [row] = await db.query("SELECT s.user_id, u.name FROM mes.sessions s JOIN mes.users u ON u.id = s.user_id WHERE s.id = $1", [sessionKey(decodeURIComponent(cookie.split("=")[1] ?? ""))]);
        return { cookie, user: row?.user_id, name: row?.name, location: res.headers.get("location") };
    };
    const one = await visit(`/s/${screen.name}`);
    const two = await visit();
    const three = await visit();
    const inGuests = await db.query("SELECT DISTINCT user_id FROM mes.group_members WHERE group_id = 'guests' AND user_id = ANY($1)", [[one.user, two.user]]);
    const reps = await db.query("SELECT count(*)::int AS n FROM mes.department_reps WHERE user_id = $1", [one.user]);
    const ownPage = await fetch(`${ownUrl}${one.location}`, { headers: { cookie: one.cookie } });
    const arrivedAs = await db.query("SELECT after->>'method' AS method FROM mes.audit_log WHERE object = '$auth' AND actor = $1 ORDER BY seq DESC LIMIT 1", [one.user]).catch(() => []);
    step("each visitor arrives as a guest of their own (\"Guest 7F3K\"), in the group Guests and approving for every department, and a link lands on its page as them; past an address's share, a visitor is the shared guest",
        /^guest_[a-z2-9]{4}$/.test(one.user ?? "") && /^guest_[a-z2-9]{4}$/.test(two.user ?? "") && one.user !== two.user && one.name === `Guest ${one.user.slice(6).toUpperCase()}` && one.location === `/s/${screen.name}` && inGuests.length === 2 && reps[0].n === departmentCount && ownPage.status === 200 && (await ownPage.text()).includes(one.name) && three.user === "guest",
        { one, two, three, inGuests, reps, arrivedAs });
    const pick = async (cookie, recent) => (await (await fetch(`${ownUrl}/api/auth.users`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify([{ recent }]) })).json()).map((u) => u.id);
    const plainList = await pick(one.cookie, []);
    const mineListed = await pick(one.cookie, [one.user]);
    step("the picker lists no visitor's guest, but the one this browser arrived as (kept among its picks), so a visitor can come back to it",
        !plainList.some((id) => id.startsWith("guest_")) && mineListed.includes(one.user) && !mineListed.includes(two.user), { plainList: plainList.filter((id) => id.startsWith("guest")), mineListed: mineListed.filter((id) => id.startsWith("guest")) });
    // A training plant's guests follow what changes make live (DEMO_GUESTS_FOLLOW=1, §6.9): a role the group
    // lacks is given and audited; nothing when it lacks none.
    await db.query("DELETE FROM mes.assignments WHERE subject_kind = 'group' AND subject_id = 'guests' AND object = 'lot' AND role = 'viewer'");
    const followed = await keepGuestsWhole(db);
    const [back] = await db.query("SELECT 1 FROM mes.assignments WHERE subject_kind = 'group' AND subject_id = 'guests' AND object = 'lot' AND role = 'viewer'");
    const followedAgain = await keepGuestsWhole(db);
    const [said] = await db.query("SELECT after FROM mes.audit_log WHERE action = 'demo:guest roles' ORDER BY seq DESC LIMIT 1");
    step("a training plant's guests take up a role they lack once a change is executed, audited; nothing more when they lack none",
        followed.some(([o, r]) => o === "lot" && r === "viewer") && back && followedAgain.length === 0 && JSON.stringify(said?.after ?? null).includes("viewer"), { followed, followedAgain, said });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    for (const app of apps) await app.close();
    // The test database as it was for the suites after this one: the guest out of every group and role.
    await db.query(`DELETE FROM mes.assignments WHERE subject_kind = 'group' AND subject_id = 'guests'; DELETE FROM mes.group_members WHERE group_id = 'guests' OR user_id LIKE 'guest%';
        DELETE FROM mes.department_reps WHERE user_id LIKE 'guest%'; DELETE FROM mes.sessions WHERE user_id LIKE 'guest%'; DELETE FROM mes.groups WHERE id = 'guests'; UPDATE mes.users SET active = false WHERE id LIKE 'guest%'`).catch(() => {});
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
