// Co-designers and an object's name (§5.3, §6.2), end to end:
//   1. Eli is made a designer (a change to People & departments). Dana starts a new object: to Eli it
//      is read only, and his save is refused, naming who may add him.
//   2. Dana names Eli a co-designer (Vera, not a designer, cannot be one). Eli edits and saves; Dana's
//      save of her older copy is refused, naming Eli, so neither undoes the other.
//   3. The name: Eli renames the new object (the change's title follows); a name in use is refused;
//      a published object's name is fixed.
//   4. Co-designers are authors: with Dana and Eli both designing it, nobody could approve it for
//      Engineering, so it is refused at submission; stewarded by Production, Eli submits it, cannot
//      review it, Vera does, Sam approves. Once approved, its name is fixed.
//   5. Taken off, still a designer: Dana names Eli, he saves, she takes him off and submits; Eli may
//      not review it (nor is he offered as a reviewer), the change says he worked on it, and his save
//      is in its audit trail.
//   6. Only a save makes a copy old: a fitness run and a review move the change, not its draft_rev,
//      so a save made after them on the copy loaded before is not refused.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/codesign.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["dana", "eli", "vera", "sam"]) {
        sessions[user] = `cd-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code };
    };

    // ---- 1. Eli a designer; Dana's new object, read only to him ----
    const org = await call("dana", "design.start", { organization: true });
    const people = (await call("dana", "design.change", { id: org.id, as: "dana" })).content.organization;
    people.roles.design.designer = [...people.roles.design.designer, "user:eli"];
    await call("dana", "design.save", { id: org.id, reason: "Eli designs too.", organization: people });
    await call("dana", "design.submit", { id: org.id });
    await call("vera", "design.review", { id: org.id, decision: "pass" });
    const made = await call("eli", "design.approve", { id: org.id, department: "engineering", decision: "approve", meaning: "Approved" });
    step("Eli is made a designer, through a change", made.state === "executed", made);
    const OLD = `gadget_${tag}`;
    const NEW = `widget_${tag}`;
    const { id } = await call("dana", "design.start", { object: OLD, label: "Widget" });
    const asEli = await call("eli", "design.change", { id, as: "eli" });
    const eliSave = await call("eli", "design.save", { id, reason: "mine now" });
    step("to Eli, Dana's draft is read only; his save is refused, naming who may add him", asEli.can.edit === false && asEli.can.codesigners === false && eliSave.status === 403 && /ask dana to add you as a co-designer/.test(eliSave.error), { can: asEli.can, eliSave });

    // ---- 2. co-designers ----
    const vera = await call("dana", "design.codesigners", { id, users: ["vera"] });
    step("only a designer co-designs (Vera reviews)", vera.status === 400 && /vera is not a designer/.test(vera.error), vera);
    const notHers = await call("eli", "design.codesigners", { id, users: ["eli"] });
    step("only the author names co-designers", notHers.status === 403, notHers);
    const named = await call("dana", "design.codesigners", { id, users: ["eli"] });
    const now = await call("eli", "design.change", { id, as: "eli" });
    step("Dana names Eli a co-designer: he may edit and submit it", named.co_designers?.join() === "eli" && now.can.edit && now.can.submit && !now.can.withdraw && now.co_designers.join() === "eli", now.can);
    const danaSeen = (await call("dana", "design.change", { id, as: "dana" })).draft_rev;
    const body = now.content.definitions[OLD];
    const eliSaved = await call("eli", "design.save", { id, seen: now.draft_rev, definitions: { [OLD]: { ...body, description: "Eli's words." } } });
    const stale = await call("dana", "design.save", { id, seen: danaSeen, definitions: { [OLD]: { ...body, description: "Dana's words." } } });
    const kept = (await call("dana", "design.change", { id, as: "dana" })).content.definitions[OLD].description;
    step("Eli saves; Dana's save of her older copy is refused, naming Eli, and his words stay", eliSaved.ok && stale.status === 409 && stale.code === "design.stale" && /^eli saved this draft since you opened it/.test(stale.error) && kept === "Eli's words.", { stale, kept });

    // ---- 3. the name ----
    const taken = await call("eli", "design.renameObject", { id, from: OLD, to: "lot" });
    step("a name in use is refused", taken.status === 400 && /An object "lot" exists already/.test(taken.error), taken);
    const renamed = await call("eli", "design.renameObject", { id, from: OLD, to: NEW });
    const after = await call("dana", "design.change", { id, as: "dana" });
    step("renamed while never approved: its key, its name, the change's title", renamed.object === NEW && after.content.definitions[NEW]?.object === NEW && !after.content.definitions[OLD] && after.base.definitions[NEW] === null && after.objects.join() === NEW, { title: after.title, objects: after.objects });
    const machine = await call("dana", "design.start", { object: "machine" });
    const fixed = await call("dana", "design.renameObject", { id: machine.id, from: "machine", to: "equipment" });
    step("a published object's name is fixed", fixed.status === 409 && fixed.code === "design.name_fixed" && /approved as version \d+/.test(fixed.error), fixed);
    await call("dana", "design.withdraw", { id: machine.id });

    // ---- 4. co-designers are authors ----
    const def = after.content.definitions[NEW];
    await call("eli", "design.save", { id, seen: after.draft_rev, reason: "Widgets.", definitions: { [NEW]: { ...def, stewards: { object: ["engineering"] } } } });
    const stuck = await call("eli", "design.submit", { id });
    step("stewarded by Engineering, whose approvers both design it: refused at submission", stuck.status === 409 && /Nobody could review it and still leave someone to approve it/.test(stuck.error), stuck);
    const fresh = await call("eli", "design.change", { id, as: "eli" });
    await call("eli", "design.save", { id, seen: fresh.draft_rev, definitions: { [NEW]: { ...def, stewards: { object: ["production"] } } } });
    const submitted = await call("eli", "design.submit", { id });
    const ownReview = await call("eli", "design.review", { id, decision: "pass" });
    step("Eli, a co-designer, submits it, and cannot review it", submitted.ok && ownReview.status === 403 && /A co-designer does not review/.test(ownReview.error), { submitted, ownReview });
    await call("vera", "design.review", { id, decision: "pass" });
    // Who may not sign it (§5): its author, a co-designer, its reviewer, someone for a department that
    // is not asked, someone who does not approve for the one that is; and nobody without saying what
    // the signature means. Each is refused, and it still awaits approval.
    const sign = (who, department = "production", extra = {}) => call(who, "design.approve", { id, department, decision: "approve", meaning: "Approved", ...extra });
    const refusals = { author: await sign("dana"), coDesigner: await sign("eli"), reviewer: await sign("vera"), notAsked: await sign("sam", "quality"), noMeaning: await sign("sam", "production", { meaning: " " }) };
    const waiting = await call("dana", "design.change", { id, as: "dana" });
    step("its author, a co-designer, its reviewer, an unasked department and a signature without a meaning are each refused; it still awaits approval",
        Object.values(refusals).every((r) => r.status >= 400 && r.status < 500 && r.error) && waiting.state === "approval", { refusals, state: waiting.state });
    const live = await call("sam", "design.approve", { id, department: "production", decision: "approve", meaning: "Approved" });
    const twice = await sign("sam");
    const retract = await call("vera", "design.retractReview", { id });
    step("once it is live, a second signature and taking the review back are refused", twice.status === 409 && retract.status === 409, { twice, retract });
    step("reviewed by Vera, approved by Sam: live under its new name", live.state === "executed" && (await db.query("SELECT 1 FROM mes.definitions WHERE object = $1", [NEW])).length === 1, live);
    const again = await call("dana", "design.start", { object: NEW });
    const nowFixed = await call("dana", "design.renameObject", { id: again.id, from: NEW, to: `${NEW}_2` });
    step("once approved, its name is fixed", nowFixed.code === "design.name_fixed", nowFixed);
    await call("dana", "design.withdraw", { id: again.id });

    // ---- 5. taken off, still a designer ----
    const later = await call("dana", "design.start", { object: `gizmo_${tag}`, label: "Gizmo" });
    await call("dana", "design.codesigners", { id: later.id, users: ["eli"] });
    const g = await call("eli", "design.change", { id: later.id, as: "eli" });
    const gDef = g.content.definitions[`gizmo_${tag}`];
    const eliWorked = await call("eli", "design.save", { id: later.id, seen: g.draft_rev, reason: "Gizmos.", definitions: { [`gizmo_${tag}`]: { ...gDef, description: "Eli's part.", stewards: { object: ["production"] } } } });
    const off = await call("dana", "design.codesigners", { id: later.id, users: [] });
    const offView = await call("dana", "design.change", { id: later.id, as: "dana" });
    const eliNow = await call("eli", "design.change", { id: later.id, as: "eli" });
    step("Dana takes Eli off: he edits no more, and the change says he worked on it", eliWorked.ok && off.co_designers?.length === 0 && eliNow.can.edit === false && offView.contributors.includes("eli"), { contributors: offView.contributors, can: eliNow.can });
    const gSubmitted = await call("dana", "design.submit", { id: later.id });
    const inReview = await call("dana", "design.change", { id: later.id, as: "dana" });
    const eliReview = await call("eli", "design.review", { id: later.id, decision: "pass" });
    step("…so he may not review it, nor is he offered as its reviewer", gSubmitted.ok && eliReview.status === 403 && /You designed part of this change/.test(eliReview.error) && !(inReview.reviewing?.fine ?? []).includes("eli"), { eliReview, reviewing: inReview.reviewing });
    const hisSaves = await db.query("SELECT after FROM mes.audit_log WHERE object = '$change' AND record_id = $1 AND action = 'change:save' AND actor = 'eli'", [later.id]);
    step("…and his save is in the change's audit trail, with the version it made", hisSaves.length === 1 && hisSaves[0].after.draft_rev === eliWorked.draft_rev, hisSaves);
    await call("dana", "design.withdraw", { id: later.id });

    // ---- 6. only a save makes a copy old ----
    const kept6 = await call("dana", "design.start", { object: `doohickey_${tag}`, label: "Doohickey" });
    const loaded = await call("dana", "design.change", { id: kept6.id, as: "dana" });
    const k = loaded.content.definitions[`doohickey_${tag}`];
    await call("dana", "design.fitness", { id: kept6.id });
    const moved = await call("dana", "design.change", { id: kept6.id, as: "dana" });
    const afterFitness = await call("dana", "design.save", { id: kept6.id, seen: loaded.draft_rev, definitions: { [`doohickey_${tag}`]: { ...k, description: "After a fitness run." } } });
    step("a fitness run moves the change, not its draft: a save on the copy loaded before it is not refused", moved.updated_at !== loaded.updated_at && moved.draft_rev === loaded.draft_rev && afterFitness.ok && afterFitness.draft_rev === loaded.draft_rev + 1, { afterFitness, before: loaded.draft_rev, moved: moved.draft_rev });
    await call("dana", "design.withdraw", { id: kept6.id });
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
