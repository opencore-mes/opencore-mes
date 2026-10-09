// Approval levels (§5.16), end to end, on a small plant of its own (an empty installation, its first administrator):
//   1. Set up: Ann (the first administrator) adds Bob, an approver of Production, and sets the level to None as
//      she ends setup: one designer is enough, nobody reviews.
//   2. None: Ann's change executes on her signature, marked as signed alone; no emergency is offered.
//   3. One: Ann moves the level to One (on her signature still). A change of hers goes straight to approval; one
//      signature by Bob (an approver of a department it touches) executes it; a change only Ann could approve is
//      refused at submission, in words.
//   4. Full: going back needs someone besides the designers to review (said before it is saved); Carl made a
//      reviewer, the level Full is approved by Bob's one signature; from then on a change goes to review.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/approval-levels.mjs
// It resets a database of its own beside that one (its name + "_levels"), leaving that one as it is.
import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const base = process.env.DATABASE_URL ?? "postgres:///openmes_test";
const url = `${base}_levels`;
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
const named = await tool("../db/admin.mjs", ["ann", "Ann Example", "--no-password"]);
const pool = new pg.Pool({ connectionString: url });
const db = fromPg(pool);
let app = null;
const sessions = {};

try {
    step("an empty installation, and Ann its first administrator (setup open)", reset.code === 0 && named.code === 0, { reset: reset.out.slice(-200), named: named.out });
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, instance: "levels" });
    const { url: mes } = await app.listen({ port: 0 });
    const signIn = async (user) => {
        sessions[user] = `lv-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    };
    const call = async (user, name, args = {}) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code };
    };
    await signIn("ann");
    // A change to People & departments: the live organization, edited.
    const orgChange = async (reason, edit) => {
        const { id } = await call("ann", "design.start", { organization: true });
        const org = (await call("ann", "design.change", { id, as: "ann" })).content.organization;
        edit(org);
        const saved = await call("ann", "design.save", { id, reason, organization: org });
        return { id, saved };
    };
    const newObject = async (name, label) => {
        const { id } = await call("ann", "design.start", { object: name, label });
        const draft = (await call("ann", "design.change", { id, as: "ann" })).content.definitions[name];
        await call("ann", "design.save", { id, reason: `${label}s.`, definitions: { [name]: draft } });
        return id;
    };

    // ---- 1. set up ----
    const people = await orgChange("Bob approves for Production; nobody reviews here.", (org) => {
        org.users.bob = { name: "Bob Approver", active: true };
        org.departments.production = { name: "Production", members: ["bob"], approval: [{ label: "Supervisor", approvers: ["bob"] }] };
    });
    const peopleDone = await call("ann", "design.submit", { id: people.id, setup: true });
    step("in setup, Ann adds Bob, an approver of Production", !people.saved.problems?.length && peopleDone.state === "executed", { problems: people.saved.problems, peopleDone });
    const ending = await orgChange("Set up: a small plant, each designer signs their own changes.", (org) => { org.setup = { open: false }; org.approval = { level: "none" }; });
    step("ending setup at level None needs nobody to review (one designer is enough)", !ending.saved.problems?.length, ending.saved.problems);
    const ended = await call("ann", "design.submit", { id: ending.id, setup: true });
    const home1 = await call("ann", "design.home", { as: "ann" });
    step("executed: setup is over, the level is None", ended.state === "executed" && home1.setupOpen === false && home1.approvalLevel === "none", { ended, level: home1.approvalLevel });
    await signIn("bob");

    // ---- 2. none ----
    const part = await newObject("part", "Part");
    const partView = await call("ann", "design.change", { id: part, as: "ann" });
    step("at None, Ann may execute her change on her signature, and no emergency is offered", partView.can.setup === true && partView.can.emergency === false && partView.approvalLevel === "none", partView.can);
    const partDone = await call("ann", "design.submit", { id: part, setup: true });
    const partAfter = await call("ann", "design.change", { id: part, as: "ann" });
    step("executed on her signature alone, marked so", partDone.state === "executed" && partAfter.setup?.because === "approval level none" && (await call("ann", "design.home", { as: "ann" })).changes.some((c) => c.id === part && c.setup?.because === "approval level none"), partAfter.setup);

    // ---- 3. one ----
    const toOne = await orgChange("One approval from now on.", (org) => { org.approval = { level: "one" }; });
    step("moving to One while Ann alone approves for Engineering (governance) is refused before it is saved: nobody could approve her next change to People & departments",
        toOne.saved.problems?.some((p) => /At approval level One, someone besides Ann Example must approve for Engineering/.test(p.message)), toOne.saved.problems);
    const oneOrg = (await call("ann", "design.change", { id: toOne.id, as: "ann" })).content.organization;
    oneOrg.departments.engineering.members = [...oneOrg.departments.engineering.members, "bob"];
    oneOrg.departments.engineering.approval[0].approvers = [...oneOrg.departments.engineering.approval[0].approvers, "bob"];
    // A department only Ann approves for, to see a change routed there refused.
    oneOrg.departments.quality = { name: "Quality", members: ["ann"], approval: [{ label: "Lead", approvers: ["ann"] }] };
    const oneSaved = await call("ann", "design.save", { id: toOne.id, organization: oneOrg });
    const toOneDone = !oneSaved.problems?.length ? await call("ann", "design.submit", { id: toOne.id, setup: true }) : oneSaved;
    step("with Bob approving for Engineering too, the level moves to One (at None, on Ann's signature)", toOneDone.state === "executed" && (await call("ann", "design.home", { as: "ann" })).approvalLevel === "one", { problems: oneSaved.problems, toOneDone });
    const bin = await newObject("bin", "Bin");
    const binView = await call("ann", "design.change", { id: bin, as: "ann" });
    const alone = await call("ann", "design.submit", { id: bin, setup: true });
    step("at One, executing alone is no longer offered, and refused", binView.can.setup === false && alone.status === 409, { can: binView.can.setup, alone });
    const binSubmitted = await call("ann", "design.submit", { id: bin });
    const binState = await call("ann", "design.change", { id: bin, as: "ann" });
    step("submitted at One: straight to approval, no review", binSubmitted.state === "approval" && binSubmitted.approvalLevel === "one" && binState.submittedLevel === "one", { binSubmitted, submittedLevel: binState.submittedLevel });
    const annSigns = await call("ann", "design.approve", { id: bin, department: binState.route[0].department, decision: "approve", meaning: "Approved" });
    step("Ann, its author, may not sign it", annSigns.status === 403, annSigns);
    const bobView = await call("bob", "design.change", { id: bin, as: "bob" });
    const bobSigns = await call("bob", "design.approve", { id: bin, department: bobView.can.approveFor[0], decision: "approve", meaning: "Approved" });
    step("Bob's one signature executes it", bobSigns.state === "executed", { bobSigns, approveFor: bobView.can.approveFor });
    const gauge = await newObject("gauge", "Gauge");
    const gaugeDraft = (await call("ann", "design.change", { id: gauge, as: "ann" })).content.definitions.gauge;
    await call("ann", "design.save", { id: gauge, definitions: { gauge: { ...gaugeDraft, stewards: { object: ["quality"] } } } });
    const onlyAnn = await call("ann", "design.submit", { id: gauge });
    step("a change only its author approves for (Quality: Ann alone) is refused at submission, in words", onlyAnn.status === 409 && /Nobody but its author approves for quality/.test(onlyAnn.error ?? ""), onlyAnn);

    // ---- 4. full ----
    const toFull = await orgChange("Full approval: the plant grows.", (org) => { org.approval = { level: "full" }; });
    step("back to Full needs someone besides the designers to review: said before it is saved", toFull.saved.problems?.some((p) => /must be able to review/.test(p.message)), toFull.saved.problems);
    const fixed = (await call("ann", "design.change", { id: toFull.id, as: "ann" })).content.organization;
    // Full needs three people for a change: its designer, a reviewer, and an approver who is neither: Carl reviews.
    fixed.users.carl = { name: "Carl Reviewer", active: true };
    fixed.roles.design = { ...fixed.roles.design, reviewer: [...(fixed.roles.design.reviewer ?? []), "user:carl"] };
    const fullSaved = await call("ann", "design.save", { id: toFull.id, organization: fixed });
    const fullSubmitted = await call("ann", "design.submit", { id: toFull.id });
    const fullBob = await call("bob", "design.change", { id: toFull.id, as: "bob" });
    const fullDone = await call("bob", "design.approve", { id: toFull.id, department: fullBob.can.approveFor[0], decision: "approve", meaning: "Approved" });
    step("Carl made a reviewer, the level Full approved by Bob's one signature (still at One)", !fullSaved.problems?.length && fullSubmitted.state === "approval" && fullDone.state === "executed" && (await call("ann", "design.home", { as: "ann" })).approvalLevel === "full", { problems: fullSaved.problems, fullSubmitted, fullDone });
    const tool2 = await newObject("tool", "Tool");
    const toolSubmitted = await call("ann", "design.submit", { id: tool2 });
    step("at Full, a change goes to review again", toolSubmitted.state === "review", toolSubmitted);
    const trail = (await db.query("SELECT action FROM mes.audit_log WHERE object = '$change' AND record_id = $1 ORDER BY seq", [bin])).map((r) => r.action);
    step("every change is in the audit trail: submitted, approved, executed", ["change:submit", "change:approve", "change:execute"].every((a) => trail.includes(a)), trail);
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
