// The first administrator of a plant's own installation (§27.1a), end to end, on an empty database of its own:
//   1. `reset.mjs --empty`: nobody in it, only the platform's built-ins. Signing in is refused, saying that
//      nobody has been added yet and what IT runs.
//   2. `db/admin.mjs ann "Ann Example"` (opencore-mes admin): Ann is designer, reviewer and sign-in
//      administrator, member and approver of Engineering, which governs; Person has her record; setup is
//      open; a one-time password link is printed; all of it audited as IT, and sealed (no tripwire).
//   3. Run again, or with a bad id: refused, in words, nothing written.
//   4. Ann signs in, and in setup adds the people the plant needs and ends setup, through changes.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/first-admin.mjs
// It resets a database of its own beside that one (its name + "_admin"), leaving that one as it is.
import pg from "pg";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
const url = `${base}_admin`;
if (!/test/i.test(url)) { console.error(`refused: ${url} does not look like a test database`); process.exit(1); }
const tool = (file, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], { env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
});

const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const reset = await tool("../db/reset.mjs", ["--empty"]);
const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
let app = null;
const sessions = {};

try {
    // ---- 1. empty ----
    const [{ users }] = await db.query("SELECT count(*)::int AS users FROM mes.users");
    const [{ groups }] = await db.query("SELECT count(*)::int AS groups FROM mes.groups");
    const builtIns = (await db.query("SELECT object FROM mes.definitions WHERE status = 'published' AND (body->>'builtIn')::boolean ORDER BY object")).map((r) => r.object);
    step("reset --empty: nobody, no department, only the platform's built-ins", reset.code === 0 && users === 0 && groups === 0 && builtIns.includes("person") && /empty/.test(reset.out), { code: reset.code, users, groups, builtIns, out: reset.out.slice(-300) });
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, instance: "first-admin", signIn: { passwords: true } });
    const { url: mes } = await app.listen({ port: 0 });
    const tryIn = await fetch(`${mes}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: mes }, body: "user=ann&password=whatever-it-is", redirect: "manual" });
    step("signing in is refused: nobody has been added yet", tryIn.status >= 300 && tryIn.status < 400 && /e=empty/.test(tryIn.headers.get("location") ?? ""), { status: tryIn.status, location: tryIn.headers.get("location") });

    // ---- 2. the first administrator ----
    const named = await tool("../db/admin.mjs", ["104523", "Ann Example", "--url", "https://mes.plant.example"]);
    const [ann] = await db.query("SELECT id, name, active FROM mes.users WHERE id = '104523'");
    const roles = (await db.query("SELECT object || ':' || role AS r FROM mes.assignments WHERE subject_kind = 'user' AND subject_id = '104523' ORDER BY 1")).map((r) => r.r);
    const [dept] = await db.query("SELECT g.id, g.name, g.kind, (SELECT array_agg(user_id) FROM mes.group_members m WHERE m.group_id = g.id) AS members, (SELECT array_agg(user_id) FROM mes.department_reps r WHERE r.group_id = g.id) AS reps FROM mes.groups g");
    const [org] = await db.query("SELECT body FROM mes.organization WHERE status = 'published'");
    step("Ann is the first administrator: designer, reviewer and sign-in administrator",
        named.code === 0 && ann?.active && ann.name === "Ann Example" && roles.join() === "auth:administrator,design:designer,design:reviewer", { code: named.code, out: named.out, roles });
    step("…member and approver of Engineering, which governs the organization",
        dept?.id === "engineering" && dept.kind === "department" && dept.members?.join() === "104523" && dept.reps?.join() === "104523" && org.body.governance === "engineering", { dept, governance: org.body.governance });
    step("setup is open, so that alone she can build the rest", org.body.setup?.open === true && /Setup is open/.test(named.out));
    step("a one-time link to set her password is printed", /https:\/\/mes\.plant\.example\/password\?token=/.test(named.out) && (await db.query("SELECT 1 FROM mes.password_tokens WHERE user_id = '104523' AND used_at IS NULL AND expires_at > now()")).length === 1, named.out);
    const [person] = await db.query("SELECT data FROM mes.records WHERE object = 'person' AND data->>'user' = '104523'");
    const stewards = (await db.query("SELECT DISTINCT jsonb_array_elements_text(body->'stewards'->'object') AS s FROM mes.definitions WHERE status = 'published' AND (body->>'builtIn')::boolean")).map((r) => r.s);
    step("Person has her record, and the built-ins are stewarded by Engineering", person?.data?.name === "Ann Example" && stewards.join() === "engineering", { person, stewards });
    const [said] = await db.query("SELECT actor, after FROM mes.audit_log WHERE action = 'admin:first'");
    const [{ trips }] = await db.query("SELECT count(*)::int AS trips FROM mes.integrity_tripwire WHERE seq > (SELECT tripwire_seq FROM mes.integrity_state WHERE id)");
    step("audited as the IT person who ran it, and written as the platform (the integrity tripwire saw nothing)",
        said?.actor === `it:${os.userInfo().username}` && said.after.user === "104523" && (await db.query("SELECT 1 FROM mes.audit_log WHERE action = 'setup:opened'")).length === 1 && trips === 0, { said, trips });

    // ---- 3. only once ----
    const twice = await tool("../db/admin.mjs", ["bob", "Bob Second"]);
    const bad = await tool("../db/admin.mjs", ["Bob Smith!", "Bob"]);
    step("run again: refused, nothing written", twice.code === 1 && /empty installation only/.test(twice.out) && !(await db.query("SELECT 1 FROM mes.users WHERE id = 'bob'")).length, twice.out);
    step("a sign-in id that is not one: refused, in words", bad.code === 1 && /is not a sign-in id/.test(bad.out), bad.out);

    // ---- 4. Ann builds the organization, in setup ----
    sessions.ann = `fa-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, '104523', now() + interval '1 hour')", [sessions.ann]);
    const call = async (name, args = {}) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions.ann}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, fields: body.fields };
    };
    const home = await call("design.home", { as: "104523" });
    step("Ann designs, and sees that setup is open", home.setupOpen === true && home.me?.roles?.includes("designer"), home.me);
    const { id } = await call("design.start", { organization: true });
    const org1 = (await call("design.change", { id, as: "104523" })).content.organization;
    org1.users = { ...org1.users, vera: { name: "Vera Novak", active: true }, sam: { name: "Sam Lee", active: true } };
    org1.departments.production = { name: "Production", members: ["sam"], approval: [{ label: "Supervisor", approvers: ["sam"] }] };
    org1.departments.engineering.members = [...org1.departments.engineering.members, "vera"];
    org1.roles.design = { ...org1.roles.design, reviewer: [...(org1.roles.design.reviewer ?? []), "user:vera"] };
    const saved = await call("design.save", { id, reason: "The plant's people: a reviewer, and Production.", organization: org1 });
    const added = !saved.problems?.length ? await call("design.submit", { id, setup: true }) : saved;
    step("she adds Vera (a reviewer) and Production, executed on her signature", added.state === "executed" && (await db.query("SELECT 1 FROM mes.users WHERE id IN ('vera', 'sam')")).length === 2, { problems: saved.problems, added });
    const end = await call("design.start", { organization: true });
    const org2 = (await call("design.change", { id: end.id, as: "104523" })).content.organization;
    const ending = await call("design.save", { id: end.id, reason: "Set up: from now on changes are reviewed and approved.", organization: { ...org2, setup: { open: false } } });
    const ended = !ending.problems?.length ? await call("design.submit", { id: end.id, setup: true }) : ending;
    step("…and ends setup: the plant governs itself from here", ended.state === "executed" && ended.outcome?.setup === "ended" && (await call("design.home", { as: "104523" })).setupOpen === false, { problems: ending.problems, ended });
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
