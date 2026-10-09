// Setup (§5.15), end to end, on a new installation of its own:
//   1. IT opens it at install (SETUP=1, openSetupAtInstall): once, as the platform, audited; refused where
//      the organization has said either way already, or where a change was already reviewed and approved.
//   2. While it is open, a designer's change executes on their signature (the same checks and fitness test),
//      without review or approval: marked, audited, listed. Never by the AI; never by someone not its
//      designer. A change may still be submitted for review as usual.
//   3. Ending it is a change to People & departments, executed the same way: said in the audit trail and the
//      event log. After it, every change is reviewed and approved, and executing in setup is refused.
//   4. Opening it again is a change governance approves, like any other.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/setup.mjs
// It resets a database of its own beside that one (its name + "_setup"), leaving that one as it is.
import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";
import { createApp } from "../app.mjs";
import { createStore } from "../server/store.js";
import { createDesign } from "../server/design.js";
import { openSetupAtInstall, setupRefusal } from "../server/setup.js";

const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
const url = `${base}_setup`;
if (!/test/i.test(url)) { console.error(`refused: ${url} does not look like a test database`); process.exit(1); }
const reset = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../db/reset.mjs", import.meta.url)), "--blank"], { env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
});

const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const emitted = [];
const events = { emit: (kind, o = {}) => emitted.push({ kind, ...o }), flush: async () => 0, state: () => ({}) };
let app = null;
const sessions = {};

try {
    step("a new installation of its own (a blank reset)", reset.code === 0, reset.out.slice(-400));

    // ---- 1. opened at install ----
    const fake = await db.transaction(async (tx) => {
        await tx.query("INSERT INTO mes.change_requests (title, reason, state, author, content, base) VALUES ('Approved before', 'x', 'executed', 'dana', '{}', '{}')");
        // (Asked, then undone: the change was never there.)
        throw Object.assign(new Error("undo"), { why: await setupRefusal(tx) });
    }).catch((e) => (e.message === "undo" ? e.why : Promise.reject(e)));
    step("refused where a change was already reviewed and approved", /already reviewed and approved/.test(fake ?? ""), fake);
    const quiet = { warn() {}, info() {} };
    const opened = await openSetupAtInstall(db, { events, log: quiet });
    const [org] = await db.query("SELECT version, body FROM mes.organization WHERE status = 'published'");
    const [said] = await db.query("SELECT actor, after FROM mes.audit_log WHERE action = 'setup:opened' ORDER BY seq DESC LIMIT 1");
    step("IT's SETUP=1 at the first start opens it: a new organization version, as the platform, audited, said in the event log",
        opened.opened === true && org.body.setup?.open === true && said?.actor === "platform:install" && emitted.some((e) => e.kind === "setup.opened" && e.severity === "warning"), { opened, org: org.body.setup, said });
    const again = await openSetupAtInstall(db, { events, log: quiet });
    step("started again with SETUP=1: nothing more", again.already === true && (await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE action = 'setup:opened'"))[0].n === 1, again);

    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, events, instance: "setup" });
    const { url: mes } = await app.listen({ port: 0 });
    for (const user of ["dana", "eli", "vera", "sam", "olga"]) {
        sessions[user] = `su-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args = {}) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const home = await call("dana", "design.home", { as: "dana" });
    step("the designer knows: setup is open", home.setupOpen === true);
    const designerPage = await (await fetch(`${mes}/design`, { headers: { cookie: `mes_session=${sessions.dana}` } })).text();
    step("…and its page says so", designerPage.includes("The plant is being set up"));

    // ---- 2. a change executed on its designer's signature ----
    const { id } = await call("dana", "design.start", { object: "part", label: "Part" });
    const draft = (await call("dana", "design.change", { id, as: "dana" })).content.definitions.part;
    draft.fields.number = { label: "Part number", type: "string", required: true, maxLength: 20 };
    draft.titleField = "number";
    draft.list.columns = ["number", "name"];
    draft.form.sections[0].fields = ["number", "name"];
    const saved = await call("dana", "design.save", { id, reason: "The plant's first model: its parts.", definitions: { part: draft } });
    const view = await call("dana", "design.change", { id, as: "dana" });
    const vera = await call("vera", "design.change", { id, as: "vera" });
    step("Dana, its designer, may execute it now; Vera, not its designer, may not", !saved.problems?.length && view.can.setup === true && view.setupOpen === true && vera.can.setup === false, { problems: saved.problems, dana: view.can.setup, vera: vera.can.setup });
    const notTheirs = await call("vera", "design.submit", { id, setup: true });
    step("someone not its designer cannot", notTheirs.status === 409, notTheirs);
    // As the AI design API calls (ai-api.js: the token's person, `via` naming the AI): refused, in words.
    const store = createStore(db);
    const design = createDesign({ store, log: { error() {}, info() {} } });
    const [dana] = await db.query("SELECT id, name FROM mes.users WHERE id = 'dana'");
    const ai = await design.services["design.submit"].call({ [CALL_KIND]: "direct", apiUser: dana, via: { agent: "test" } }, { id, setup: true }).then((v) => v, (e) => ({ error: e.message, status: e.status, code: e.code }));
    step("the AI cannot execute a change during setup: a person signs it", ai.status === 403 && ai.code === "design.setup_ai", ai);
    const done = await call("dana", "design.submit", { id, setup: true });
    const after = await call("dana", "design.change", { id, as: "dana" });
    const approvals = await db.query("SELECT 1 FROM mes.approvals WHERE change_id = $1", [id]);
    const trail = (await db.query("SELECT action, actor, after FROM mes.audit_log WHERE object = '$change' AND record_id = $1 ORDER BY seq", [id])).map((r) => r.action);
    step("submitted in setup: executed at once, without review or approval",
        done.state === "executed" && done.setup === true && after.state === "executed" && after.setup?.by === "dana" && !after.reviewer && !approvals.length, { done, setup: after.setup });
    step("the audit trail says how: submitted, executed, executed during setup by Dana",
        ["change:submit", "change:execute", "change:setup:executed"].every((a) => trail.includes(a)), trail);
    const live = await call("dana", "design.home", { as: "dana" });
    step("part is live, version 1, and the change is listed as a setup change",
        live.objects.some((o) => o.object === "part" && o.version === 1) && live.changes.some((c) => c.id === id && c.setup?.by === "dana"), live.changes.find((c) => c.id === id));
    const second = await call("dana", "design.start", { object: "bin", label: "Bin" });
    const bin = (await call("dana", "design.change", { id: second.id, as: "dana" })).content.definitions.bin;
    await call("dana", "design.save", { id: second.id, reason: "Where parts are kept.", definitions: { bin } });
    const routed = await call("dana", "design.submit", { id: second.id });
    step("a change may still be submitted for review as usual during setup", routed.state === "review", routed);
    await call("dana", "design.withdraw", { id: second.id });

    // ---- 3. ending it ----
    const end = await call("dana", "design.start", { organization: true });
    const people = (await call("dana", "design.change", { id: end.id, as: "dana" })).content.organization;
    const endSaved = await call("dana", "design.save", { id: end.id, reason: "The plant is set up: from now on changes are reviewed and approved.", organization: { ...people, setup: { open: false } } });
    const ended = !endSaved.problems?.length ? await call("dana", "design.submit", { id: end.id, setup: true }) : endSaved;
    const [orgAfter] = await db.query("SELECT body FROM mes.organization WHERE status = 'published'");
    step("ending it is a change to People & departments, executed in setup",
        ended.state === "executed" && ended.outcome?.setup === "ended" && orgAfter.body.setup?.open === false, { problems: endSaved.problems, ended });
    step("said in the audit trail and the event log",
        (await db.query("SELECT 1 FROM mes.audit_log WHERE action = 'setup:ended'")).length === 1 && emitted.some((e) => e.kind === "setup.ended" && e.severity === "warning"), emitted.map((e) => e.kind));
    const third = await call("dana", "design.start", { object: "tool", label: "Tool" });
    const tool = (await call("dana", "design.change", { id: third.id, as: "dana" })).content.definitions.tool;
    await call("dana", "design.save", { id: third.id, reason: "Tools.", definitions: { tool } });
    const v3 = await call("dana", "design.change", { id: third.id, as: "dana" });
    const late = await call("dana", "design.submit", { id: third.id, setup: true });
    step("after it, executing in setup is offered no more, and refused", v3.can.setup === false && (await call("dana", "design.home", { as: "dana" })).setupOpen === false && late.status === 409 && late.code === "design.setup_closed", { can: v3.can.setup, late });
    await call("dana", "design.withdraw", { id: third.id });

    // ---- 4. opened again: governance approves it ----
    const reopen = await call("dana", "design.start", { organization: true });
    const org2 = (await call("dana", "design.change", { id: reopen.id, as: "dana" })).content.organization;
    await call("dana", "design.save", { id: reopen.id, reason: "A new line is commissioned.", organization: { ...org2, setup: { open: true } } });
    await call("dana", "design.submit", { id: reopen.id });
    const routedAgain = await call("dana", "design.change", { id: reopen.id, as: "dana" });
    const gov = (await db.query("SELECT body->>'governance' AS g FROM mes.organization WHERE status = 'published'"))[0].g;
    step("opening it again is reviewed, and approved by governance", routedAgain.state === "review" && routedAgain.route.some((r) => r.department === gov) && routedAgain.footprint.some((e) => e.element === "setup"), { state: routedAgain.state, route: routedAgain.route, gov });
    await call("vera", "design.review", { id: reopen.id, decision: "pass" });
    let state = null;
    for (let round = 0; round < 3 && state !== "executed"; round++) {
        for (const user of ["eli", "sam", "vera", "olga"]) {
            const seen = await call(user, "design.change", { id: reopen.id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id: reopen.id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
    }
    step("approved: setup is open again, said in the event log", state === "executed" && (await call("dana", "design.home", { as: "dana" })).setupOpen === true && emitted.filter((e) => e.kind === "setup.opened").length === 2, { state });
    const atInstall = await openSetupAtInstall(db, { events, log: quiet });
    step("SETUP=1 is for a new installation only: here it changes nothing", atInstall.already === true || Boolean(atInstall.refused), atInstall);
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
