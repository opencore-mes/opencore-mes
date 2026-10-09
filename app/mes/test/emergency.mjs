// Emergency changes (§5.7, COMPLIANCE.md G15), end to end against a running server:
//   1. Dana changes machines (a field) and adds a screen stewarded by Quality: two departments on its
//      route. Submitted as an emergency it needs a reason of its own; where the organization forbids
//      emergencies, it is refused, and the page offers none.
//   2. Submitted as an emergency: it skips review and waits for ONE signature; its author may not give
//      it. Sam signs for Production and it executes at once, Quality not waited for. It is recorded as
//      an emergency (audit trail, event log), and due to be reviewed afterwards in 3 days.
//   3. Reviewed afterwards: it is in the inbox and the approvals list of those who may review it; its
//      author and its signer may not; a flag needs a note. Vera passes it; then each department
//      confirms it (Sam, its signer, now with the review before him, for Production; Quinn for Quality),
//      signed, and it is closed.
//   4. Overdue and flagged: a second emergency left unreviewed past its day is flagged overdue by the
//      scheduled job, once (the change, the audit trail, the event log). Vera flags it; a designer rolls
//      it back, by the rollback the platform drafts (§5.14), which is not itself an emergency.
//   5. A rejected emergency goes no further: nothing is executed.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/emergency.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const emitted = [];
const events = { emit: (kind, detail) => { emitted.push({ kind, ...detail }); return null; }, flush: async () => {}, state: () => ({}) };
let app = null;
let scheduled = null;

try {
    const [column] = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'mes' AND table_name = 'change_requests' AND column_name = 'emergency'");
    step("the database has the emergency column (migrate-emergency.sql, listed in migrate.mjs)", Boolean(column));
    if (!column) throw new Error("migrate-emergency.sql has not run on this database");
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, events });
    const { url: mes } = await app.listen({ port: 0 });
    const people = ["dana", "eli", "vera", "sam", "quinn", "olga", "iris"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `em-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args ?? {}]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const seen = (id, who = "dana") => call(who, "design.change", { id, as: who });
    const trail = async (id) => (await db.query("SELECT actor, action, after FROM mes.audit_log WHERE object = '$change' AND record_id = $1 ORDER BY seq", [id]));
    const inbox = async (who) => (await call(who, "inbox.mine", { as: who })).items ?? [];
    const listed = async (who, id) => (await call(who, "design.approvals", { as: who })).changes?.find((c) => c.id === id) ?? null;
    const machineLive = async () => (await db.query("SELECT version, body FROM mes.definitions WHERE object = 'machine' AND status = 'published'"))[0];
    const organization = async (patch) => db.query("UPDATE mes.organization SET body = body || $1::jsonb WHERE status = 'published'", [JSON.stringify(patch)]);

    // ---- 1. a change, and what an emergency asks ----
    const F = `cause_t${tag}`;
    const SCREEN = `em_board_t${tag}`;
    const a = await call("dana", "design.start", { object: "machine" });
    const draftA = (await seen(a.id)).content.definitions.machine;
    await call("dana", "design.save", { id: a.id, reason: "Record why each machine stopped.", definitions: { machine: { ...draftA, fields: { ...draftA.fields, [F]: { label: "Stop cause", type: "string" } } } },
        screens: { [SCREEN]: { name: SCREEN, label: "Stop causes", description: "", params: {}, blocks: [{ block: "table", title: "Machines", object: "machine", columns: ["machine_id", F], width: 12 }], callers: { users: ["sam"], groups: [] }, stewards: ["quality"] } } });
    const designing = await seen(a.id);
    const reading = await seen(a.id, "vera");
    const noReason = await call("dana", "design.submit", { id: a.id, emergency: { reason: "  " } });
    await organization({ emergency: { allowed: false } });
    const forbidding = await seen(a.id);
    const forbidden = await call("dana", "design.submit", { id: a.id, emergency: { reason: "Line 3 is down." } });
    await organization({ emergency: { allowed: true, reviewDays: 3 } });
    step("an emergency is offered to its designer only, needs a reason of its own, and is refused where the organization forbids it",
        designing.can?.emergency === true && designing.emergencyPolicy?.allowed === true && designing.emergencyPolicy.reviewDays === 3 && reading.can?.emergency === false
        && noReason.status === 400 && noReason.fields?.emergency && forbidding.can?.emergency === false && forbidden.status === 409 && forbidden.code === "design.emergency_off" && (await seen(a.id)).state === "design",
        { can: designing.can?.emergency, policy: designing.emergencyPolicy, reading: reading.can?.emergency, noReason, forbidding: forbidding.can?.emergency, forbidden });

    // ---- 2. one signature executes it ----
    const before = await machineLive();
    const submitted = await call("dana", "design.submit", { id: a.id, emergency: { reason: "Line 3 is down: maintenance must record the stop cause before restarting it." } });
    const waiting = await seen(a.id);
    const samInbox = await inbox("sam");
    const own = await call("dana", "design.approve", { id: a.id, department: "production", decision: "approve", meaning: "Approved" });
    step("submitted as an emergency, it skips review and waits for one signature, from any department on its route (two here); its author may not give it",
        submitted.ok && submitted.state === "approval" && waiting.state === "approval" && waiting.reviewer == null && waiting.emergency?.stage === "approval" && /Line 3 is down/.test(waiting.emergency.reason) && waiting.emergency.by === "dana"
        && waiting.route?.map((r) => r.department).sort().join() === "production,quality" && waiting.can?.approveFor?.length === 0 && (await seen(a.id, "sam")).can?.approveFor?.includes("production") && (await seen(a.id, "quinn")).can?.approveFor?.includes("quality")
        && samInbox.some((i) => i.id === a.id && i.kind === "sign" && i.emergency === "approve") && own.status === 403,
        { submitted, state: waiting.state, emergency: waiting.emergency, route: waiting.route?.map((r) => r.department), samInbox, own });
    const signed = await call("sam", "design.approve", { id: a.id, department: "production", decision: "approve", meaning: "Approved" });
    const done = await seen(a.id);
    const after = await machineLive();
    const [{ n: signatures }] = await db.query("SELECT count(*)::int AS n FROM mes.approvals WHERE change_id = $1", [a.id]);
    const [screenRow] = await db.query("SELECT status FROM mes.screens WHERE name = $1 AND status = 'published'", [SCREEN]);
    const t = await trail(a.id);
    const event = emitted.find((e) => e.kind === "change.emergency" && e.details?.change === a.id);
    const dueIn = (Date.parse(done.emergency?.due) - Date.parse(done.executed_at)) / 86_400_000;
    step("ONE signature executes it, Quality not waited for: the field and the screen are live",
        signed.state === "executed" && done.state === "executed" && signatures === 1 && after.version === before.version + 1 && Boolean(after.body.fields[F]) && screenRow?.status === "published",
        { signed, state: done.state, signatures, versions: [before.version, after.version], screen: screenRow });
    step("it is recorded as an emergency: why, who signed it for which department, when it is due to be reviewed (3 days on); the audit trail and the event log say so",
        done.emergency?.stage === "review" && done.emergency.approved?.user === "sam" && done.emergency.approved.department === "production" && Math.abs(dueIn - 3) < 0.001 && done.emergency.open === true && done.emergency.overdue === false
        && t.some((x) => x.action === "change:emergency" && /Line 3 is down/.test(x.after.reason) && x.actor === "dana") && t.some((x) => x.action === "change:submit" && x.after.emergency === true)
        && t.some((x) => x.action === "change:execute") && t.some((x) => x.action === "change:emergency:executed" && x.after.approvedBy === "sam")
        && event?.severity === "warning" && /Line 3 is down/.test(event.message) && /sam/.test(event.message),
        { emergency: done.emergency, dueIn, trail: t.map((x) => x.action), event });

    // ---- 3. reviewed afterwards ----
    const veraInbox = await inbox("vera");
    const veraList = await listed("vera", a.id);
    const home = (await call("dana", "design.home", { as: "dana" })).changes?.find((c) => c.id === a.id);
    const tooEarly = await call("quinn", "design.emergencyConfirm", { id: a.id, department: "quality", decision: "confirm" });
    const byAuthor = await call("dana", "design.emergencyReview", { id: a.id, decision: "pass" });
    const bySigner = await call("sam", "design.emergencyReview", { id: a.id, decision: "pass" });
    const noNote = await call("vera", "design.emergencyReview", { id: a.id, decision: "flag", note: "" });
    step("awaiting review afterwards: in the inbox and the approvals list of who may review it, marked in the designer's list; not its author nor its signer; a flag needs a note; nobody confirms before the review",
        veraInbox.some((i) => i.id === a.id && i.kind === "review" && i.emergency === "review") && veraList?.state === "executed" && veraList.emergency?.stage === "review" && veraList.mine === true && !veraList.reviewableBy.includes("sam") && !veraList.reviewableBy.includes("dana")
        && home?.emergency?.stage === "review" && (await seen(a.id, "vera")).can?.afterReview === true && tooEarly.status === 409 && byAuthor.status === 403 && bySigner.status === 403 && noNote.status === 400,
        { veraInbox, veraList, home: home?.emergency, tooEarly, byAuthor, bySigner, noNote });
    const passed = await call("vera", "design.emergencyReview", { id: a.id, decision: "pass", note: "The field is what maintenance asked for." });
    const confirming = await seen(a.id, "quinn");
    const quinnInbox = await inbox("quinn");
    const byReviewer = await call("vera", "design.emergencyConfirm", { id: a.id, department: "quality", decision: "confirm" });
    const notTheirs = await call("eli", "design.emergencyConfirm", { id: a.id, department: "production", decision: "confirm" });
    const one = await call("sam", "design.emergencyConfirm", { id: a.id, department: "production", decision: "confirm" });
    const twice = await call("sam", "design.emergencyConfirm", { id: a.id, department: "production", decision: "confirm" });
    const last = await call("quinn", "design.emergencyConfirm", { id: a.id, department: "quality", decision: "confirm" });
    const closed = await seen(a.id);
    const t2 = await trail(a.id);
    step("passed, each department confirms it, signed: its signer may, the review before him; its reviewer and other departments' approvers may not; each once",
        passed.stage === "confirm" && confirming.emergency?.stage === "confirm" && confirming.can?.confirmFor?.join() === "quality" && quinnInbox.some((i) => i.id === a.id && i.emergency === "confirm" && i.department === "quality")
        && byReviewer.status === 403 && notTheirs.status === 403 && one.stage === "confirm" && twice.status === 409 && last.stage === "confirmed",
        { passed, confirmFor: confirming.can?.confirmFor, quinnInbox, byReviewer, notTheirs, one, twice, last });
    step("every department confirmed: it is closed, waits for nobody, and the audit trail holds the review and both confirmations",
        closed.emergency?.stage === "confirmed" && Boolean(closed.emergency.closedAt) && closed.emergency.open === false && closed.emergency.departments?.production?.user === "sam" && closed.emergency.departments.quality?.meaning === "Confirmed"
        && !(await listed("vera", a.id)) && !(await inbox("quinn")).some((i) => i.id === a.id)
        && t2.some((x) => x.action === "change:emergency:review:pass" && x.actor === "vera") && t2.filter((x) => x.action === "change:emergency:confirm").length === 2 && t2.some((x) => x.after?.closed === "confirmed"),
        { emergency: closed.emergency, trail: t2.map((x) => x.action) });

    // ---- 4. overdue, flagged, rolled back ----
    const G = `hold_t${tag}`;
    const b = await call("dana", "design.start", { object: "machine" });
    const draftB = (await seen(b.id)).content.definitions.machine;
    await call("dana", "design.save", { id: b.id, reason: "A hold reason on each machine.", definitions: { machine: { ...draftB, fields: { ...draftB.fields, [G]: { label: "Hold reason", type: "string" } } } } });
    await call("dana", "design.submit", { id: b.id, emergency: { reason: "Audit tomorrow: holds must be recorded today." } });
    const didB = await call("sam", "design.approve", { id: b.id, department: "production", decision: "approve", meaning: "Approved" });
    // Three days pass (the review was due yesterday): the scheduled job flags it, once.
    await db.query("UPDATE mes.change_requests SET emergency = jsonb_set(emergency, '{due}', to_jsonb($2::text)) WHERE id = $1", [b.id, new Date(Date.now() - 86_400_000).toISOString()]);
    scheduled = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 60_000, events });
    await scheduled.listen({ port: 0 });
    let late = null;
    for (let i = 0; i < 50 && !late?.emergency?.overdue; i++) { await new Promise((r) => setTimeout(r, 100)); late = await seen(b.id); }
    await scheduled.close();
    // Its next run, on another instance, says nothing new.
    scheduled = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 60_000, events });
    await scheduled.listen({ port: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    await scheduled.close();
    scheduled = null;
    const overdueEvents = emitted.filter((e) => e.kind === "change.emergency.overdue" && e.details?.change === b.id);
    const t3 = await trail(b.id);
    const lateListed = await listed("vera", b.id);
    step("left unreviewed past its day, the scheduled job flags it overdue, once: the change, the approvals list, the audit trail and the event log say so",
        didB.state === "executed" && late?.emergency?.overdue === true && lateListed?.emergency?.overdue === true && overdueEvents.length === 1 && overdueEvents[0].severity === "warning"
        && t3.filter((x) => x.action === "change:emergency:overdue" && x.actor === "platform").length === 1 && (await inbox("vera")).some((i) => i.id === b.id && i.overdue === true),
        { didB, emergency: late?.emergency, listed: lateListed?.emergency, overdueEvents, trail: t3.map((x) => x.action) });
    const flagged = await call("vera", "design.emergencyReview", { id: b.id, decision: "flag", note: "Holds belong on the lot, not the machine." });
    const flaggedSeen = await seen(b.id);
    const rb = await call("dana", "design.rollback", { id: b.id });
    const rbSeen = await seen(rb.id);
    const asEmergency = await call("dana", "design.submit", { id: rb.id, emergency: { reason: "Undo it now." } });
    const rbSubmitted = await call("dana", "design.submit", { id: rb.id });
    const rbDone = await call("sam", "design.approve", { id: rb.id, department: "production", decision: "approve", meaning: "Rolled back" });
    const back = await machineLive();
    step("flagged with a note, it is closed as flagged and offered for rolling back; the event log says so; the rollback is drafted by the platform, is no emergency, and one approval executes it",
        flagged.stage === "flagged" && flaggedSeen.emergency?.stage === "flagged" && flaggedSeen.emergency.flagged?.by === "vera" && flaggedSeen.emergency.open === false && flaggedSeen.can?.rollback === true
        && emitted.some((e) => e.kind === "change.emergency.flagged" && e.details?.change === b.id) && rbSeen.rollback?.pure === true && rbSeen.can?.emergency === false
        && asEmergency.status === 409 && asEmergency.code === "design.emergency_rollback" && rbSubmitted.state === "approval" && rbDone.state === "executed" && !back.body.fields[G] && Boolean(back.body.fields[F]),
        { flagged, emergency: flaggedSeen.emergency, rollback: rb.error ?? rbSeen.rollback?.pure, asEmergency, rbSubmitted, rbDone, fields: Object.keys(back.body.fields) });

    // ---- 5. rejected ----
    const H = `spare_t${tag}`;
    const c = await call("dana", "design.start", { object: "machine" });
    const draftC = (await seen(c.id)).content.definitions.machine;
    await call("dana", "design.save", { id: c.id, reason: "A spare flag.", definitions: { machine: { ...draftC, fields: { ...draftC.fields, [H]: { label: "Spare", type: "boolean" } } } } });
    await call("dana", "design.submit", { id: c.id, emergency: { reason: "Spares are short." } });
    const rejected = await call("sam", "design.approve", { id: c.id, department: "production", decision: "reject", meaning: "Rejected", note: "This can wait for review." });
    const rejectedSeen = await seen(c.id);
    step("a rejected emergency goes no further: nothing executed, nothing to review afterwards",
        rejected.state === "rejected" && rejectedSeen.state === "rejected" && rejectedSeen.emergency?.open === false && !(await machineLive()).body.fields[H] && !(await listed("vera", c.id)),
        { rejected, state: rejectedSeen.state, emergency: rejectedSeen.emergency });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await scheduled?.close?.();
    await app?.close?.();
    await pool.end();
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
