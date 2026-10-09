// Setup codes and the move to the plant's directory (§8.2), end to end, on a plant of its own (an empty
// installation, its first administrator), with passwords kept here and a directory (LDAP) beside them:
//   1. Ann loads people into two departments. Everyone with no password who has never signed in is
//      counted; codes are made for one department at once (five capital letters, no I or O), audited as one
//      entry that names who was given one and holds no code. Someone not a sign-in administrator may not.
//   2. A code sets a first password with the sign-in id, typed loosely (lower case, a space); once only;
//      not as a link; a wrong pair of passwords keeps it; wrong codes lock the id and spend the code.
//   3. Codes made again: the earlier ones stop working; one person's code alone.
//   4. Eli, with a password here, moves to the directory from his own page: a wrong directory password
//      changes nothing; the right one takes his password here off, and he signs in with the directory's.
//   5. The sign-in id as the plant calls it: a label and hint of its own on the sign-in page, and the
//      plant's domains dropped from what is typed (PLANT\p1, p1@plant.local); another domain is refused.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/setup-codes.mjs
// It resets a database of its own beside that one (its name + "_codes"), leaving that one as it is.
import pg from "pg";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { berRead, LOCK_AFTER, CODE_TRIES } from "../server/sign-in.js";

const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
const url = `${base}_codes`;
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

// ---- the plant's directory: binds as uid=<id>,ou=people,dc=test ----
const DIRECTORY = { "uid=eli,ou=people,dc=test": "eli's directory password" };
const ldap = net.createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        const msg = berRead(data);
        if (!msg) return;
        const id = berRead(data, msg.start), op = berRead(data, id.end);
        if (op.tag !== 0x60) { data = data.subarray(msg.end); return; }
        const version = berRead(data, op.start), dn = berRead(data, version.end), pw = berRead(data, dn.end);
        const name = data.toString("utf8", dn.start, dn.end), password = data.toString("utf8", pw.start, pw.end);
        const code = DIRECTORY[name] && DIRECTORY[name] === password ? 0 : 49;
        socket.write(Buffer.from([0x30, 0x0c, 0x02, 0x01, data[id.start], 0x61, 0x07, 0x0a, 0x01, code, 0x04, 0x00, 0x04, 0x00]));
        data = data.subarray(msg.end);
    });
    socket.on("error", () => {});
});
await new Promise((r) => ldap.listen(0, "127.0.0.1", r));

const reset = await tool("../db/reset.mjs", ["--empty"]);
const named = await tool("../db/admin.mjs", ["ann", "Ann Example", "--no-password"]);
const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
let app = null;
const sessions = {};
const PW = (who) => `copper kettle ${[...who].reverse().join("")} morning`;

try {
    step("an empty installation, and Ann its first administrator", reset.code === 0 && named.code === 0, { reset: reset.out.slice(-200), named: named.out });
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, instance: "codes",
        signIn: { passwords: true, linkDays: 5, ldap: { url: `ldap://127.0.0.1:${ldap.address().port}`, userDn: "uid={user},ou=people,dc=test", label: "the plant directory" } } });
    const { url: mes } = await app.listen({ port: 0 });
    const signIn = async (user) => {
        sessions[user] = `sc-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    };
    const call = async (user, name, args = {}) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status };
    };
    // A form posted as a browser would (same origin), the redirect it answers with.
    const post = async (path, form, cookie = "") => {
        const res = await fetch(`${mes}${path}`, { method: "POST", redirect: "manual", headers: { origin: mes, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form) });
        const location = res.headers.get("location") ?? "";
        const q = new URL(location || "/", mes);
        return { status: res.status, path: q.pathname, e: q.searchParams.get("e"), m: q.searchParams.get("m"), cookie: (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("mes_session=")) ?? null };
    };
    const setWith = (user, code, password = PW(user), again = password) => post("/password", { user, code, next: password, again });
    const login = (user, password) => post("/login", { user, password, to: "" });
    await signIn("ann");

    // ---- 1. people loaded, codes made ----
    const { id: change } = await call("ann", "design.start", { organization: true });
    const org = (await call("ann", "design.change", { id: change, as: "ann" })).content.organization;
    for (const p of ["p1", "p2", "p3", "p4", "p5", "eli", "p6", "p7"]) org.users[p] = { name: `Person ${p.toUpperCase()}`, active: true };
    org.departments.assembly = { name: "Assembly", members: ["p1", "p2", "p3", "p4", "p5", "eli"], approval: [{ label: "Lead", approvers: ["p5"] }] };
    org.departments.paint = { name: "Paint", members: ["p6", "p7"], approval: [{ label: "Lead", approvers: ["p6"] }] };
    const saved = await call("ann", "design.save", { id: change, reason: "The people of Assembly and Paint.", organization: org });
    const loaded = await call("ann", "design.submit", { id: change, setup: true });
    step("Ann loads eight people into Assembly and Paint (setup)", !saved.problems?.length && loaded.state === "executed", { problems: saved.problems, loaded });
    const methods = await call("ann", "auth.methods");
    step("the sign-in page offers a setup code where passwords are kept here", methods.codes === true, methods);
    const everyone = await call("ann", "auth.admin.setupCodes", { count: true });
    const assemblyCount = await call("ann", "auth.admin.setupCodes", { department: "assembly", count: true });
    step("counted: everyone with no password who has never signed in (9, Ann too), Assembly alone 6", everyone.count === 9 && assemblyCount.count === 6, { everyone, assemblyCount });
    const depts = await call("ann", "auth.admin.departments");
    step("the departments to choose from", ["assembly", "engineering", "paint"].every((d) => depts.some?.((x) => x.id === d)), depts);
    await signIn("p6");
    const notAdmin = await call("p6", "auth.admin.setupCodes", { department: "paint" });
    step("someone not a sign-in administrator may not make codes", notAdmin.status === 403, notAdmin);
    const tooLong = await call("ann", "auth.admin.setupCodes", { department: "assembly", days: 15 });
    step("a code lasts 1 to 14 days", tooLong.status === 400 || /1 to 14/.test(tooLong.error ?? ""), tooLong);
    const made = await call("ann", "auth.admin.setupCodes", { department: "assembly" });
    const codes = Object.fromEntries((made.people ?? []).map((p) => [p.id, p.code]));
    const lasts = (new Date(made.expiresAt) - Date.now()) / 86400_000;
    step("codes for Assembly: six, five capital letters each (no I or O), with names and departments, good for the plant's 5 days",
        made.people?.length === 6 && made.people.every((p) => /^[A-HJ-NP-Z]{5}$/.test(p.code) && p.name && p.departments === "Assembly") && made.days === 5 && lasts > 4.9 && lasts <= 5,
        { made, lasts });
    const kept = await db.query("SELECT token_hash, kind FROM mes.password_tokens WHERE user_id = ANY($1::text[]) AND used_at IS NULL", [Object.keys(codes)]);
    step("only their hashes are kept, as codes", kept.length === 6 && kept.every((k) => k.kind === "code" && !Object.values(codes).includes(k.token_hash)), kept);
    const [entry] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$auth' AND action = 'setup codes' AND actor = 'ann' ORDER BY seq DESC LIMIT 1");
    const said = JSON.stringify(entry?.after ?? null);
    step("one audit entry by Ann, naming who was given one, holding no code", entry?.after?.count === 6 && entry.after.users?.length === 6 && entry.after.about?.department === "assembly" && !Object.values(codes).some((c) => said.includes(c)), entry);

    // ---- 2. a code sets a first password ----
    const loose = `${codes.p1.slice(0, 2).toLowerCase()} ${codes.p1.slice(2).toLowerCase()}`;
    const p1set = await setWith("p1", loose);
    step("P1 sets a password with his sign-in id and the code typed loosely (lower case, a space)", p1set.path === "/login" && p1set.m === "password", p1set);
    const p1in = await login("p1", PW("p1"));
    step("and signs in with it", [302, 303].includes(p1in.status) && p1in.path === "/" && Boolean(p1in.cookie), p1in);
    const p1again = await setWith("p1", codes.p1, `${PW("p1")} again`);
    step("the code works once: used, it says to ask for a new one", p1again.e === "spent", p1again);
    const asLink = await post("/password", { token: codes.p3, next: PW("p3"), again: PW("p3") });
    step("a code is not a link", asLink.e === "link", asLink);
    const mismatch = await setWith("p3", codes.p3, PW("p3"), `${PW("p3")}x`);
    const p3set = await setWith("p3", codes.p3);
    step("two passwords that differ are said, and the code still works after", mismatch.e === "again" && p3set.m === "password", { mismatch, p3set });
    const someoneElse = await setWith("p4", codes.p5);
    step("one person's code does not work for another", someoneElse.e === "code", someoneElse);
    const wrong = [];
    for (let i = 0; i < LOCK_AFTER - 1; i++) wrong.push((await setWith("p2", "ZZZZZ")).e);
    const last = await setWith("p2", "ZZZZZ");
    const p2live = await db.query("SELECT 1 FROM mes.password_tokens WHERE user_id = 'p2' AND used_at IS NULL");
    step(`wrong codes: said as wrong, then the id locked at ${LOCK_AFTER} and the code spent at ${CODE_TRIES}`, wrong.every((e) => e === "code") && last.e === "locked" && !p2live.length, { wrong, last, live: p2live.length });
    await call("ann", "auth.admin.unlock", { id: "p2" });
    const p2late = await setWith("p2", codes.p2);
    step("unlocked, the right code is spent all the same: a new one is asked for", p2late.e === "spent", p2late);
    const [refused] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE object = '$auth' AND action = 'setup code refused' AND actor = 'p2'");
    step("each refusal is in the audit trail", refused.n >= LOCK_AFTER, refused);

    // ---- 3. made again ----
    const again = await call("ann", "auth.admin.setupCodes", { department: "assembly" });
    const old = await setWith("p4", codes.p4);
    step("made again for Assembly: four now (P1 and P3 have passwords), and an earlier code no longer works", again.people?.length === 4 && !again.people.some((p) => ["p1", "p3"].includes(p.id)) && old.e === "code", { again: again.people?.map((p) => p.id), old });
    const p4new = await setWith("p4", again.people.find((p) => p.id === "p4").code);
    step("the new one does", p4new.m === "password", p4new);
    const one = await call("ann", "auth.admin.setupCodes", { id: "p7", days: 1 });
    const p7set = await setWith("p7", one.people?.[0]?.code ?? "");
    step("one person's code alone (Paint's P7), good for a day, works", one.people?.length === 1 && one.days === 1 && p7set.m === "password", { one, p7set });
    const nobody = await call("ann", "auth.admin.setupCodes", { id: "nobody" });
    step("someone not in People & departments gets none", nobody.status === 404, nobody);

    // ---- 4. Eli moves to the directory ----
    const eliCode = again.people.find((p) => p.id === "eli").code;
    await setWith("eli", eliCode);
    const eliIn = await login("eli", PW("eli"));
    const eliCookie = eliIn.cookie?.split(";")[0] ?? "";
    sessions.eli = eliCookie.split("=")[1];
    const account = await call("eli", "auth.account");
    step("Eli signs in with his password here; his page offers the directory", eliIn.path === "/" && account.password === true && account.directory === "the plant directory", { eliIn, account });
    const wrongDir = await call("eli", "auth.useDirectory", { password: "not it" });
    const stillOwn = await db.query("SELECT 1 FROM mes.credentials WHERE user_id = 'eli'");
    step("a wrong directory password changes nothing, and says so", wrongDir.status === 403 && /did not accept/.test(wrongDir.error ?? "") && stillOwn.length === 1, wrongDir);
    const moved = await call("eli", "auth.useDirectory", { password: "eli's directory password" });
    const ownGone = await db.query("SELECT 1 FROM mes.credentials WHERE user_id = 'eli'");
    const [removed] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$auth' AND action = 'password removed' AND actor = 'eli'");
    step("the right one: his password here is taken off, audited", moved.ok === true && !ownGone.length && removed?.after?.now === "directory", { moved, removed });
    const after = await call("eli", "auth.account");
    step("he stays signed in, now with no password here", after.id === "eli" && after.password === false, after);
    const byDirectory = await login("eli", "eli's directory password");
    const byOld = await login("eli", PW("eli"));
    step("he signs in with the directory's password, no longer with the old one", byDirectory.path === "/" && Boolean(byDirectory.cookie) && byOld.e === "wrong", { byDirectory, byOld });
    const twice = await call("eli", "auth.useDirectory", { password: "eli's directory password" });
    step("asked again: he already signs in through the directory", twice.status === 409, twice);
    const noAccount = await call("p1", "auth.useDirectory", { password: "anything" }).catch((e) => ({ error: e.message }));
    step("someone not signed in may not", noAccount.status === 401, noAccount);

    // ---- 5. the sign-in id as the plant calls it ----
    const { id: renamed } = await call("ann", "design.start", { organization: true });
    const bad = await call("ann", "design.save", { id: renamed, reason: "Windows user names.", organization: { ...(await call("ann", "design.change", { id: renamed, as: "ann" })).content.organization, signIn: { idLabel: "Windows user name", domains: ["plant_local"] } } });
    step("a domain that is not one is said before it is saved", bad.problems?.some((p) => /"plant_local" is not a domain/.test(p.message)), bad.problems);
    const good = await call("ann", "design.save", { id: renamed, organization: { ...(await call("ann", "design.change", { id: renamed, as: "ann" })).content.organization, signIn: { idLabel: "Windows user name", idHint: "PLANT\\username", domains: ["PLANT", "plant.local"] } } });
    const namedDone = !good.problems?.length ? await call("ann", "design.submit", { id: renamed, setup: true }) : good;
    const words = await call("ann", "auth.methods");
    step("approved (in setup): the sign-in page calls it Windows user name, PLANT\\username in the box", namedDone.state === "executed" && words.idLabel === "Windows user name" && words.idHint === "PLANT\\username", { namedDone, words });
    const page = await (await fetch(`${mes}/login`)).text();
    step("the sign-in page drawn with them", page.includes("Windows user name") && page.includes('placeholder="PLANT\\username"'), page.slice(0, 200));
    const withDomain = await login("PLANT\\p1", PW("p1"));
    const withAt = await login("P1@plant.local", PW("p1"));
    const otherDomain = await login("OTHER\\p1", PW("p1"));
    step("PLANT\\p1 and p1@plant.local sign in as p1; another domain does not", withDomain.path === "/" && Boolean(withDomain.cookie) && withAt.path === "/" && otherDomain.e === "wrong", { withDomain, withAt, otherDomain });
    const p6code = (await call("ann", "auth.admin.setupCodes", { id: "p6" })).people[0].code;
    const p6set = await setWith("plant\\p6", p6code);
    step("a setup code takes the id with its domain too", p6set.m === "password", p6set);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await pool.end();
    ldap.close();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
