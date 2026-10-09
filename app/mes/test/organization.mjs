// People & departments (§5.6, §8) as a design element, and departments that approve in steps, end
// to end against a running server:
//   1. Dana starts a change to the organization: its draft is the organization as it is (IT approves
//      in two steps, Specialist then Manager).
//   2. Her mistakes are named: a role an object does not declare, a department removed, one person
//      in two steps; and leaving nobody a designer is refused (nothing could be changed again).
//   3. She makes IT a standing approver of every connection and service, and adds Mark to
//      Production as a lot operator. The route: governance (Engineering), IT (it joins the standing
//      approvers), Production (Mark joins it) and the lot's stewards (his role on lots).
//   4. Approval in steps: Ines (IT's manager) cannot sign before Ivan (its specialist); Ivan cannot
//      sign both steps; then it executes, and the tables follow.
//   5. The standing approvers apply at once: a new connection's change is routed to IT too.
//   6. An approver needs no role on the designer: Olga (an operator, made a Production approver in 3)
//      opens the change waiting for her and signs it, but cannot start or review one.
//   7. Who reads every record (§27.7): Iris, IT's designer, reads lots and deviations with no role on
//      either, writes none, and designs. Granting Vera the same is approved by governance alone, and
//      she then reads deviations, which no role of hers shows.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/organization.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
// The development sign-in list (auth.users), with what waits for each person.
const devApp = await createApp({ db, dev: true, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: devUrl } = await devApp.listen({ port: 0 });
const signInList = async () => Object.fromEntries((await (await fetch(`${devUrl}/api/auth.users`, { method: "POST", headers: { "content-type": "application/json" }, body: "[{}]" })).json()).map((u) => [u.id, u.waiting]));
const sessions = {};
for (const user of ["dana", "eli", "vera", "sam", "quinn", "ivan", "ines", "olga", "iris"]) {
    sessions[user] = `org-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const attempt = (p) => p.then((value) => ({ ok: true, value }), (e) => ({ ok: false, status: e.status, message: e.message }));
const approve = (user, id, department) => call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" });
const MARK = `mark_t${tag}`;

try {
    // ---- 1. the draft is the organization as it is ----
    // The version it starts from (an earlier suite on this database may have changed it already).
    const [{ version: before }] = await db.query("SELECT version FROM mes.organization WHERE status = 'published'");
    const { id } = await call("dana", "design.start", { organization: true });
    let change = await call("dana", "design.change", { id, as: "dana" });
    const org = change.content.organization;
    step("the draft: IT approves in two steps, Specialist (ivan) then Manager (ines)", JSON.stringify(org.departments.it.approval) === JSON.stringify([{ label: "Specialist", approvers: ["ivan"] }, { label: "Manager", approvers: ["ines"] }]), org.departments.it);
    step("…with the people, the roles on each object and the governance department", org.users.olga?.name === "Olga Ortiz" && org.roles.lot.operator.includes("group:production") && org.governance === "engineering");

    // ---- 2. mistakes ----
    const wrong = clone(org);
    wrong.roles.lot.pilot = ["user:olga"];
    delete wrong.departments.quality;
    wrong.departments.it.approval[1].approvers.push("ivan");
    const saved = await call("dana", "design.save", { id, reason: "IT approves integration; Mark joins Production.", organization: wrong });
    const words = saved.problems.map((p) => p.message).join("\n");
    step("mistakes named: a role lot does not declare, a department removed, one person in two steps", /lot has no role "pilot"/.test(words) && /Department quality cannot be removed/.test(words) && /ivan approves in two steps/.test(words), saved.problems);
    step("the draft names the designers: Dana, and Iris (IT)", JSON.stringify(org.roles.design?.designer) === JSON.stringify(["user:dana", "user:iris"]), org.roles.design);
    const noDesigner = clone(org);
    noDesigner.roles.design.designer = [];
    const lockedOut = await call("dana", "design.save", { id, organization: noDesigner });
    step("leaving nobody a designer is a problem: nothing could be changed again", lockedOut.problems.some((p) => /Someone active must remain a designer/.test(p.message)), lockedOut.problems);
    const refused = await attempt(call("dana", "design.submit", { id }));
    step("…and such a change cannot be submitted", !refused.ok && refused.status >= 400, refused);

    // ---- 3. IT stands for integration; Mark joins Production ----
    const next = clone(org);
    next.standing = { connection: ["it"], service: ["it"] };
    next.users[MARK] = { name: "Mark Test", active: true };
    next.departments.production.members.push(MARK);
    next.roles.lot.operator.push(`user:${MARK}`);
    next.departments.production.approval[0].approvers.push("olga");
    const ok = await call("dana", "design.save", { id, organization: next });
    step("fixed: no problems", ok.problems.length === 0, ok.problems);
    await call("dana", "design.submit", { id });
    change = await call("dana", "design.change", { id, as: "dana" });
    const route = change.route.map((r) => r.department).sort().join(",");
    step("routed to governance, IT (joins the standing approvers), Production (Mark joins it) and the lot's stewards", route === "engineering,it,production,quality", change.route);
    step("IT's approval shows its two steps", change.route.find((r) => r.department === "it").steps.map((s) => s.label).join(" → ") === "Specialist → Manager");

    // ---- 4. in steps ----
    const inbox = async (who) => (await call(who, "design.approvals", { as: who })).changes.find((c) => c.id === id);
    const r0 = await inbox("vera");
    step("the approvals list: in review, whom it waits for, and that it is Vera's to review", r0?.state === "review" && r0.mine === true && r0.reviewableBy.includes("vera") && !r0.reviewableBy.includes("dana"), r0);
    const l0 = await signInList();
    step("the sign-in list: the change waits for Vera's review, not for its author's", l0.vera.review.some((c) => c.id === id) && !l0.dana.review.some((c) => c.id === id), l0);
    await call("vera", "design.review", { id, decision: "pass" });
    const l1 = await signInList();
    step("…then for the next approvers: Ivan (IT, Specialist), not yet Ines", l1.ivan.sign.some((c) => c.id === id && c.department === "it" && c.step === "Specialist") && !l1.ines.sign.some((c) => c.id === id) && !l1.vera.review.some((c) => c.id === id), l1);
    const a1 = await inbox("ines");
    const it1 = a1.departments.find((d) => d.department === "it");
    step("in approval: each department pending, IT at Specialist (1 of 2) waiting for Ivan, not yet Ines's", it1.status === "pending" && it1.step === "Specialist" && it1.stepNo === 1 && it1.of === 2 && it1.waitingFor.join() === "ivan" && a1.mine === false, a1.departments);
    step("…and Ivan's to sign", (await inbox("ivan")).mine === true);
    const early = await attempt(approve("ines", id, "it"));
    step("the manager cannot sign before the specialist", !early.ok && early.status === 403 && /at its step "Specialist" \(1 of 2\): ivan signs it/.test(early.message), early);
    await approve("ivan", id, "it");
    step("…and after Ivan signs, Ines is next", (await signInList()).ines.sign.some((c) => c.id === id && c.step === "Manager"));
    const a2 = await inbox("ines");
    const it2 = a2.departments.find((d) => d.department === "it");
    step("after Ivan: IT at Manager (2 of 2), now Ines's to sign", it2.step === "Manager" && it2.stepNo === 2 && it2.mine === true && a2.mine === true, it2);
    const twice = await attempt(approve("ivan", id, "it"));
    step("the specialist cannot sign the manager's step too", !twice.ok && /at its step "Manager" \(2 of 2\): ines signs it/.test(twice.message), twice);
    change = await call("ines", "design.change", { id, as: "ines" });
    step("the manager now sees it is hers to sign", change.can.approveFor.includes("it") && change.can.approveSteps.it.label === "Manager", change.can);
    await approve("ines", id, "it");
    await approve("eli", id, "engineering");
    await approve("sam", id, "production");
    const almost = await inbox("quinn");
    step("the others show as approved, by whom, while Quality is pending", almost.departments.filter((d) => d.status === "approved").map((d) => `${d.department}:${d.by}`).sort().join() === "engineering:eli,it:ines,production:sam" && almost.departments.find((d) => d.department === "quality").mine === true, almost.departments);
    const done = await approve("quinn", id, "quality");
    step("once executed it leaves the approvals list", !(await inbox("quinn")));
    step("every department's every step signed: executed", done.state === "executed", done);
    const [mark] = await db.query("SELECT name, active FROM mes.users WHERE id = $1", [MARK]);
    const [role] = await db.query("SELECT 1 FROM mes.assignments WHERE subject_kind = 'user' AND subject_id = $1 AND object = 'lot' AND role = 'operator'", [MARK]);
    const [settings] = await db.query("SELECT version, body FROM mes.organization WHERE status = 'published'");
    step("the tables follow: Mark exists, in Production, a lot operator; the organization is one version on", mark?.active && role && settings.version === before + 1 && settings.body.standing.service?.includes("it"), { mark, settings });
    const audit = await db.query("SELECT after FROM mes.audit_log WHERE object = '$change' AND record_id = $1 AND action = 'change:approve' ORDER BY seq", [id]);
    step("each step's signature is audited with its step", audit.some((a) => a.after.department === "it" && a.after.step === "Specialist") && audit.some((a) => a.after.step === "Manager"), audit);

    // ---- 5. standing approvers, at once ----
    const conn = await call("dana", "design.start", { connection: `mes_t${tag}`, label: "Test system" });
    await call("dana", "design.save", { id: conn.id, reason: "A test system." });
    const c = await call("dana", "design.change", { id: conn.id, as: "dana" });
    step("a new connection is routed to IT as well, whoever stewards it", c.route.some((r) => r.department === "it") && c.route.some((r) => r.department === "engineering"), c.route);
    await call("dana", "design.withdraw", { id: conn.id });

    // ---- 6. an approver without a role on the designer ----
    const [olgaRole] = await db.query("SELECT 1 FROM mes.assignments WHERE subject_id = 'olga' AND object = 'design'");
    const later = await call("dana", "design.start", { organization: true });
    const again = (await call("dana", "design.change", { id: later.id, as: "dana" })).content.organization;
    again.users[`${MARK}b`] = { name: "Mark Two", active: true };
    again.departments.production.members.push(`${MARK}b`);
    await call("dana", "design.save", { id: later.id, reason: "Another operator.", organization: again });
    await call("dana", "design.submit", { id: later.id });
    await call("vera", "design.review", { id: later.id, decision: "pass" });
    const olgaSees = await attempt(call("olga", "design.change", { id: later.id, as: "olga" }));
    step("Olga has no role on the designer, yet opens the change waiting for her, hers to sign for Production", !olgaRole && olgaSees.ok && olgaSees.value.can.approveFor.includes("production"), olgaSees);
    step("…and it is on her approvals list", (await call("olga", "design.approvals", { as: "olga" })).changes.find((c) => c.id === later.id)?.mine === true);
    const olgaStarts = await attempt(call("olga", "design.start", { organization: true }));
    const olgaReviews = await attempt(call("olga", "design.review", { id: later.id, decision: "changes", note: "no" }));
    step("…but cannot start a change, nor review one", olgaStarts.status === 403 && olgaReviews.status === 403, { olgaStarts, olgaReviews });
    await approve("olga", later.id, "production");
    await approve("eli", later.id, "engineering");
    const [olgaSigned] = await db.query("SELECT state FROM mes.change_requests WHERE id = $1", [later.id]);
    step("she signs for Production, and it executes", olgaSigned.state === "executed", olgaSigned);

    // ---- 7. who reads every record ----
    // The seed's deviation (made nothing new: the suites after this one count what is in use).
    const [dev] = await db.query("SELECT id FROM mes.records WHERE object = 'deviation' AND archived_at IS NULL ORDER BY created_at LIMIT 1");
    const irisLots = await call("iris", "records.list", { object: "lot", as: "iris" });
    const irisDev = await call("iris", "records.get", { object: "deviation", id: dev.id, as: "iris" });
    const [irisRoles] = await db.query("SELECT count(*)::int AS n FROM mes.assignments WHERE subject_id = 'iris' AND object IN ('lot', 'deviation')");
    const lotRow = irisLots.rows[0];
    const irisWrites = await attempt(call("iris", "records.update", { object: "lot", id: lotRow.id, rowVersion: lotRow.row_version, data: { qty: 1 }, key: `org-${randomBytes(6).toString("hex")}` }));
    const irisDesigns = await attempt(call("iris", "design.start", { object: `itx_t${tag}`, label: "IT test" }));
    if (irisDesigns.ok) await call("iris", "design.withdraw", { id: irisDesigns.value.id });
    step("Iris, IT's designer, holds no role on lots or deviations, yet reads them (every record); she may not write one, and she designs",
        irisRoles.n === 0 && irisLots.rows.length > 0 && irisDev?.id === dev.id && !irisWrites.ok && irisWrites.status === 403 && irisDesigns.ok,
        { irisRoles, lots: irisLots.rows.length, dev: irisDev?.id, irisWrites, irisDesigns });
    const veraBefore = await attempt(call("vera", "records.get", { object: "deviation", id: dev.id, as: "vera" }));
    const { id: grant } = await call("dana", "design.start", { organization: true });
    const gc = await call("dana", "design.change", { id: grant, as: "dana" });
    const granted = { ...gc.content.organization, readers: [...(gc.content.organization.readers ?? []), "user:vera"] };
    const gs = await call("dana", "design.save", { id: grant, seen: gc.draft_rev, reason: "Vera audits: she reads every record.", organization: granted });
    await call("dana", "design.submit", { id: grant });
    await call("quinn", "design.review", { id: grant, decision: "pass" });
    const routed = await call("dana", "design.change", { id: grant, as: "dana" });
    await approve("eli", grant, "engineering");
    const [grantState] = await db.query("SELECT state FROM mes.change_requests WHERE id = $1", [grant]);
    const veraAfter = await attempt(call("vera", "records.get", { object: "deviation", id: dev.id, as: "vera" }));
    step("granting Vera every record is approved by governance alone; then she reads a deviation no role of hers shows",
        !gs.problems?.length && JSON.stringify(routed.route?.map((r) => r.department)) === JSON.stringify(["engineering"]) && grantState.state === "executed" && !(veraBefore.ok && veraBefore.value) && veraAfter.ok && veraAfter.value?.id === dev.id,
        { problems: gs.problems, route: routed.route?.map((r) => r.department), grantState, veraBefore, veraAfter: veraAfter.ok ? veraAfter.value?.id : veraAfter });
} catch (error) {
    step("the test ran to the end", false, { error: error.message, body: error.body });
} finally {
    await app.close();
    await devApp.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
