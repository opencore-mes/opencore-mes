// A blank instance (a training one, `npm run training:reset`: reset.mjs --blank), end to end:
//   1. People only: the seeded people, departments and approval steps, roles on the designer and the
//      query page, and nothing modelled (no transactions, screens, records; no object but the built-in
//      Person, one record per person, which every department reads).
//   2. Dana designs the first object from nothing; it is routed to its steward (Production), reviewed
//      by Vera (Sam's review would leave Production nobody to sign) and approved by Sam. It is live,
//      but nobody holds its role yet.
//   3. A change to people & departments gives Production that role; Olga creates the first record.
//   4. Nobody left to change it: a change removing every role on the designer is refused. An
//      installation that got there anyway (here, by SQL) is recovered on the console
//      (db/recover-designer.mjs: a designer and a reviewer, audited), and puts the roles right through
//      an ordinary change.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/blank.mjs
// It resets a database of its own beside that one (its name + "_blank"), leaving that one as it is.
import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";

const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
const url = `${base}_blank`;
if (!/test/i.test(url)) { console.error(`refused: ${url} does not look like a test database`); process.exit(1); }
const tool = (file, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], { env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
});
const reset = await tool("../db/reset.mjs", ["--blank"]);

const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });

const app = await createApp({ db, dev: true, secure: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, instance: "training", sessionCookie: "mes_training_session" });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "eli", "vera", "sam", "olga"]) {
    sessions[user] = `blank-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args = {}) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", ...(user ? { cookie: `mes_training_session=${sessions[user]}` } : {}) }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const attempt = (p) => p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, status: e.status, message: e.message }));

try {
    // ---- 1. people only ----
    step("reset --blank: people only", reset.code === 0 && /people only \(blank\)/.test(reset.out) && /0 objects, 0 transactions, 0 screens, 0 records/.test(reset.out), reset.out);
    const home = await call("dana", "design.home", { as: "dana" });
    step("nothing modelled: no transactions, screens, services or connections, no object but the built-in ones (Person, one record per person; Desktop, none yet)",
        home.objects.map((o) => o.object).sort().join() === "desktop,person,report" && !(await db.query("SELECT 1 FROM mes.records WHERE object = 'desktop'")).length && !home.transactions.length && !home.screens.length && !home.services.length && !home.connections.length
        && (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'person'"))[0].n === 10, home.objects.map((o) => o.object));
    step("…but the people, departments and approval steps are there", Object.keys(home.organization.departments).sort().join() === "engineering,it,production,quality" && home.organization.departments.it.approval.length === 2 && home.organization.governance === "engineering", home.organization);
    const [roles] = await db.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE object NOT IN ('design', 'query', 'auth', 'person', 'desktop', 'report'))::int AS other FROM mes.assignments");
    step("roles only on the designer, the query page, sign-in administration and the built-in objects", roles.n > 0 && roles.other === 0, roles);
    const signIn = await attempt(call(null, "auth.users"));
    step("the sign-in list works, with nothing waiting for anyone", signIn.ok && signIn.value.length === 10 && signIn.value.every((u) => !u.waiting.sign.length && !u.waiting.review.length), signIn);
    step("Olga signs in to an empty plant: nothing but the built-in Person, and Report (Production reads what is shared)", (await call("olga", "defs.list", { as: "olga" })).map((d) => d.object).sort().join() === "person,report");

    // ---- 2. the first object ----
    const { id } = await call("dana", "design.start", { object: "part", label: "Part" });
    const draft = (await call("dana", "design.change", { id, as: "dana" })).content.definitions.part;
    draft.fields.number = { label: "Part number", type: "string", required: true, maxLength: 20 };
    draft.titleField = "number";
    draft.list.columns = ["number", "name"];
    draft.form.sections[0].fields = ["number", "name"];
    const saved = await call("dana", "design.save", { id, reason: "The plant's first model: its parts.", definitions: { part: draft } });
    step("the first object drafted from nothing, without problems", saved.problems.length === 0, saved.problems);
    const before = (await call("dana", "design.change", { id, as: "dana" })).reviewing;
    step("before submitting, Dana is told Sam's review would leave Production nobody to sign", before.strands.some((x) => x.reviewer === "sam" && x.where.join() === "production") && before.fine.includes("vera"), before);
    await call("dana", "design.submit", { id });
    const change = await call("dana", "design.change", { id, as: "dana" });
    step("routed to its steward, Production", change.route.map((r) => r.department).join() === "production", change.route);
    await call("vera", "design.review", { id, decision: "pass" });
    const done = await call("sam", "design.approve", { id, department: "production", decision: "approve", meaning: "Approved" });
    step("reviewed and approved: executed", done.state === "executed", done);
    const live = await call("dana", "design.home", { as: "dana" });
    step("part is live, version 1", live.objects.some((o) => o.object === "part" && o.version === 1), live.objects);
    const refused = await attempt(call("olga", "records.create", { object: "part", data: { number: "P-1", name: "Bracket" } }));
    step("…but nobody holds its role yet: Olga may not create one", !refused.ok && refused.status === 403, refused);

    // ---- 3. its role ----
    const org = await call("dana", "design.start", { organization: true });
    const people = (await call("dana", "design.change", { id: org.id, as: "dana" })).content.organization;
    people.roles.part = { user: ["group:production"] };
    const orgSaved = await call("dana", "design.save", { id: org.id, reason: "Production works with parts.", organization: people });
    step("Production is given the role on part", orgSaved.problems.length === 0, orgSaved.problems);
    await call("dana", "design.submit", { id: org.id });
    const orgRoute = (await call("dana", "design.change", { id: org.id, as: "dana" })).route.map((r) => r.department).sort();
    await call("vera", "design.review", { id: org.id, decision: "pass" });
    for (const d of orgRoute) await call(d === "engineering" ? "eli" : "sam", "design.approve", { id: org.id, department: d, decision: "approve", meaning: "Approved" });
    const [orgRow] = await db.query("SELECT state FROM mes.change_requests WHERE id = $1", [org.id]);
    step("approved and executed", orgRow.state === "executed", { orgRoute, orgRow });
    const created = await call("olga", "records.create", { object: "part", data: { number: "P-1", name: "Bracket" } });
    step("Olga creates the plant's first record", created?.id && (await call("olga", "defs.list", { as: "olga" })).some((d) => d.object === "part"), created);

    // ---- 4. nobody left to change it ----
    const lock = await call("dana", "design.start", { organization: true });
    const bare = (await call("dana", "design.change", { id: lock.id, as: "dana" })).content.organization;
    delete bare.roles.design;
    const bareSaved = await call("dana", "design.save", { id: lock.id, reason: "test no designer", organization: bare });
    const bareSubmit = await attempt(call("dana", "design.submit", { id: lock.id }));
    step("a change removing every role on the designer is a problem, and is not submitted", bareSaved.problems.some((p) => /Someone active must remain a designer/.test(p.message)) && !bareSubmit.ok, { problems: bareSaved.problems, bareSubmit });
    await call("dana", "design.withdraw", { id: lock.id });
    const early = await tool("../db/recover-designer.mjs", ["dana", "not locked out"]);
    step("recovery refuses while the system can still be changed", early.code === 1 && /can still be changed/.test(early.out), early.out);
    await db.query("DELETE FROM mes.assignments WHERE object = 'design'");       // got there anyway
    const locked = await attempt(call("dana", "design.start", { organization: true }));
    step("locked out: nobody may start a change, the fix included", !locked.ok && locked.status === 403, locked);
    const alone = await tool("../db/recover-designer.mjs", ["dana", "Roles removed by SQL"]);
    step("recovering a designer alone is refused: nobody else could review", alone.code === 1 && /name one with --reviewer/.test(alone.out), alone.out);
    const back = await tool("../db/recover-designer.mjs", ["dana", "--reviewer", "vera", "Roles removed by SQL"]);
    const trail = await db.query("SELECT actor, after FROM mes.audit_log WHERE action = 'recovery:design-role' ORDER BY seq");
    step("recovered on the console: Dana a designer, Vera a reviewer, each in the audit trail with why", back.code === 0 && trail.length === 2 && trail.every((t) => t.actor === "console" && t.after.reason === "Roles removed by SQL") && trail.map((t) => `${t.after.user}:${t.after.role}`).join() === "dana:design:designer,vera:design:reviewer", { out: back.out, trail });
    const fix = await call("dana", "design.start", { organization: true });
    const fixed = (await call("dana", "design.change", { id: fix.id, as: "dana" })).content.organization;
    fixed.roles.design = { designer: ["user:dana"], reviewer: ["user:eli", "user:vera", "user:sam"] };
    await call("dana", "design.save", { id: fix.id, reason: "Put the design roles right after the recovery.", organization: fixed });
    await call("dana", "design.submit", { id: fix.id });
    await call("vera", "design.review", { id: fix.id, decision: "pass" });
    const fixRoute = (await call("dana", "design.change", { id: fix.id, as: "dana" })).route.map((r) => r.department);
    for (const d of fixRoute) await call(d === "engineering" ? "eli" : "sam", "design.approve", { id: fix.id, department: d, decision: "approve", meaning: "Approved" });
    const reviewers = (await db.query("SELECT subject_id FROM mes.assignments WHERE object = 'design' AND role = 'reviewer' ORDER BY 1")).map((r) => r.subject_id).join();
    step("…then the roles are put right through an ordinary change", reviewers === "eli,sam,vera", { fixRoute, reviewers });
} catch (error) {
    step("the test ran to the end", false, { error: error.message, body: error.body });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
