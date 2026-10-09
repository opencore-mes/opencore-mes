// Rolling a change back (§5.14), end to end against a running server:
//   1. A change executes: a field on machines, and a new screen. A record takes a value in the field.
//   2. Its rollback is planned and drafted by the platform: the object as it was before, the screen
//      retired. It is tried in a sandbox at once; nothing breaks.
//   3. It is not reviewed again: submitted, it goes straight to approval, and ONE approval executes it
//      (not its author's), though two departments are on its route. The object is as before, under a new
//      version; the screen is retired; the record keeps what it held; both changes say so.
//   4. Conflicts are found in a sandbox: a rollback that takes a field from under a screen made since
//      is not submitted, naming the screen.
//   5. A design changed again since is left alone, unless asked for; then the rollback says what it
//      undoes. A rollback edited by hand is a change like any other: reviewed, and approved in full.
//   6. Who may: only a designer rolls back, only an executed change; its author does not approve it.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/rollback.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
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
    const people = ["dana", "eli", "vera", "sam", "quinn", "olga", "iris", "ivan", "ines"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `rb-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args ?? {}]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `rb-${randomBytes(8).toString("hex")}`;
    const seen = (id, who = "dana") => call(who, "design.change", { id, as: who });
    // Through review and every approval, by whoever may: → its last state.
    const through = async (id, author = "dana") => {
        const sub = await call(author, "design.submit", { id });
        if (sub.error) return { state: "not submitted", error: sub.error };
        for (const r of ["vera", "eli", "ines"]) if ((await seen(id, r)).can?.review) { await call(r, "design.review", { id, decision: "pass" }); break; }
        let state = (await seen(id)).state;
        for (let round = 0; round < 4 && state === "approval"; round++) {
            for (const user of people) {
                const c = await seen(id, user);
                for (const department of c.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
            }
        }
        return { state };
    };
    const machineLive = async () => (await db.query("SELECT version, body FROM mes.definitions WHERE object = 'machine' AND status = 'published'"))[0];

    // ---- 1. a change executes ----
    const F = `note_t${tag}`;
    const SCREEN = `rb_board_t${tag}`;
    const before = await machineLive();
    const a = await call("dana", "design.start", { object: "machine" });
    const draftA = (await seen(a.id)).content.definitions.machine;
    const board = (title, columns) => ({ name: SCREEN, label: title, description: "", params: {}, blocks: [{ block: "table", title: "Machines", object: "machine", columns, width: 12 }], callers: { users: ["sam"], groups: [] }, stewards: ["quality"] });
    await call("dana", "design.save", { id: a.id, reason: "A note on each machine, and a board of them.", definitions: { machine: { ...draftA, fields: { ...draftA.fields, [F]: { label: "Note", type: "string" } } } }, screens: { [SCREEN]: board("Machine notes", ["machine_id", F]) } });
    const didA = await through(a.id);
    const afterA = await machineLive();
    const m = await call("sam", "records.create", { object: "machine", data: { machine_id: `RB-${tag}`, name: "Rollback press", kind: "press", capacity: 1, [F]: "kept" }, key: key() });
    step("a change executes: machines gain a field, and a new screen shows it; a record takes a value in the field", didA.state === "executed" && afterA.version === before.version + 1 && Boolean(afterA.body.fields[F]) && m[F] === "kept", { didA, version: [before.version, afterA.version], m: m.error ?? m[F] });

    // ---- 2. its rollback, planned and drafted ----
    const notYet = await call("dana", "design.rollbackPlan", { id: (await call("dana", "design.start", { layout: `rb_open_t${tag}`, label: "Open" })).id });
    const plan = await call("dana", "design.rollbackPlan", { id: a.id });
    const notDesigner = await call("olga", "design.rollback", { id: a.id });
    const rb = await call("dana", "design.rollback", { id: a.id });
    const rbSeen = await seen(rb.id);
    step("its rollback is planned: the object as it was before, the screen (which the change created) retired; only an executed change is rolled back, and only by a designer",
        notYet.status === 409 && plan.restores?.length === 1 && plan.restores[0].what === "object machine" && plan.restores[0].to === before.version && plan.retires?.[0]?.what === `screen ${SCREEN}` && plan.skipped.length === 0 && notDesigner.status === 403, { notYet, plan, notDesigner });
    const sandboxCheck = rbSeen.fitness?.checks?.find((c) => c.id === "rollback");
    step("the platform drafts it as a change: what was live before as its content, the screen to retire, saying what it rolls back; it is tried in a sandbox at once, and nothing else breaks",
        rb.id && rbSeen.state === "design" && rbSeen.author === "dana" && /^Roll back: /.test(rbSeen.title) && rbSeen.rollback?.of === a.id && rbSeen.rollback.pure === true && !rbSeen.content.definitions.machine.fields[F] && rbSeen.content.retire?.screens?.[0] === SCREEN
        && rb.fitness?.passed === true && sandboxCheck?.status === "pass", { rb, title: rbSeen.title, rollback: rbSeen.rollback, fitness: rbSeen.fitness?.checks?.map((c) => [c.id, c.status, c.items]) });

    // ---- 3. no review; one approval ----
    const submitted = await call("dana", "design.submit", { id: rb.id });
    const waiting = await seen(rb.id);
    const own = await call("dana", "design.approve", { id: rb.id, department: waiting.route?.[0]?.department, decision: "approve", meaning: "Approved" });
    let one = null;
    let by = null;
    for (const user of people) {
        const c = await seen(rb.id, user);
        if (c.can?.approveFor?.length) { by = user; one = await call(user, "design.approve", { id: rb.id, department: c.can.approveFor[0], decision: "approve", meaning: "Rolled back" }); break; }
    }
    const done = await seen(rb.id);
    const [signatures] = await db.query("SELECT count(*)::int AS n FROM mes.approvals WHERE change_id = $1", [rb.id]);
    const afterRb = await machineLive();
    const [screenRow] = await db.query("SELECT status FROM mes.screens WHERE name = $1 ORDER BY version DESC LIMIT 1", [SCREEN]);
    const [rec] = await db.query("SELECT data FROM mes.records WHERE id = $1", [m.id]);
    const read = await call("sam", "records.get", { object: "machine", id: m.id, as: "sam" });
    const original = await seen(a.id);
    const trail = (await db.query("SELECT action, after FROM mes.audit_log WHERE object = '$change' AND record_id = $1 ORDER BY seq", [rb.id])).map((t) => t.action);
    step("it is not reviewed again: submitted, it waits for approval at once; its author does not approve it; ONE approval executes it, though two departments are on its route",
        submitted.ok && waiting.state === "approval" && waiting.reviewer == null && waiting.route?.length === 2 && own.status === 403 && one?.state === "executed" && done.state === "executed" && signatures.n === 1,
        { submitted, state: waiting.state, route: waiting.route?.map((r) => r.department), own: own.status, by, one, signatures });
    step("rolled back: the object is as it was before, under a new version; the screen is retired; the record keeps what it held, unseen; the change rolled back names its rollback; all of it is in the audit trail",
        afterRb.version === afterA.version + 1 && !afterRb.body.fields[F] && JSON.stringify(afterRb.body) === JSON.stringify(before.body) && screenRow?.status === "retired" && rec.data[F] === "kept" && read.machine_id === `RB-${tag}` && read[F] === undefined && rbSeen.rollback.keeps?.[0]?.what === `machine.${F}` && rbSeen.rollback.keeps[0].records === 1
        && original.rolledBackBy?.[0]?.id === rb.id && original.rolledBackBy[0].state === "executed" && trail.includes("change:start") && trail.includes("change:submit") && trail.includes("change:execute"),
        { versions: [before.version, afterA.version, afterRb.version], same: JSON.stringify(afterRb.body) === JSON.stringify(before.body), screen: screenRow, rec: rec.data[F], read: read[F] ?? "unseen", keeps: rbSeen.rollback.keeps, rolledBackBy: original.rolledBackBy, trail });

    // ---- 4. conflicts, found in a sandbox ----
    const G = `gap_t${tag}`;
    const b = await call("dana", "design.start", { object: "machine" });
    const draftB = (await seen(b.id)).content.definitions.machine;
    await call("dana", "design.save", { id: b.id, reason: "A gap on each machine.", definitions: { machine: { ...draftB, fields: { ...draftB.fields, [G]: { label: "Gap", type: "decimal" } } } } });
    const didB = await through(b.id);
    const SCREEN2 = `rb_gaps_t${tag}`;
    const c = await call("dana", "design.start", { screen: SCREEN2, label: "Gaps" });
    await call("dana", "design.save", { id: c.id, reason: "A board of the gaps.", screens: { [SCREEN2]: { ...board("Gaps", ["machine_id", G]), name: SCREEN2 } } });
    const didC = await through(c.id);
    const rbB = await call("dana", "design.rollback", { id: b.id });
    const conflict = (await seen(rbB.id)).fitness?.checks?.find((x) => x.id === "rollback");
    const refused = await call("dana", "design.submit", { id: rbB.id });
    step("a conflict is found in a sandbox: rolling back the field would take it from under a screen made since; the rollback says which, and is not submitted",
        didB.state === "executed" && didC.state === "executed" && rbB.fitness?.passed === false && conflict?.status === "fail" && conflict.items.some((i) => new RegExp(`machine has no field "${G}"`).test(i)) && refused.status === 409 && refused.code === "design.unfit" && (await seen(rbB.id)).state === "design",
        { didB, didC, fitness: rbB.fitness, conflict, refused });
    await call("dana", "design.withdraw", { id: rbB.id });

    // ---- 5. changed again since; edited by hand ----
    const H = `hue_t${tag}`;
    const d = await call("dana", "design.start", { object: "machine" });
    const draftD = (await seen(d.id)).content.definitions.machine;
    await call("dana", "design.save", { id: d.id, reason: "A hue on each machine.", definitions: { machine: { ...draftD, fields: { ...draftD.fields, [H]: { label: "Hue", type: "string" } } } } });
    const didD = await through(d.id);
    const planB = await call("dana", "design.rollbackPlan", { id: b.id });
    const nothing = await call("dana", "design.rollback", { id: b.id });
    const asked = await call("dana", "design.rollback", { id: b.id, includeChanged: true });
    const askedSeen = await seen(asked.id);
    step("a design changed again since is left alone: there is then nothing to roll back, and it says why; asked for, the rollback puts it back and says it undoes the later change too",
        didD.state === "executed" && planB.restores.length === 0 && planB.skipped[0]?.changed === true && /was changed again since/.test(planB.skipped[0].why) && nothing.status === 409 && nothing.code === "rollback.nothing"
        && asked.plan?.restores?.[0]?.undoesLater === true && !askedSeen.content.definitions.machine.fields[G] && !askedSeen.content.definitions.machine.fields[H], { didD, planB, nothing, asked: asked.plan ?? asked });
    // Edited by hand, it is no longer what was live before: a change like any other.
    const kept = { ...askedSeen.content.definitions.machine, description: `${askedSeen.content.definitions.machine.description ?? ""} (rolled back by hand)` };
    await call("dana", "design.save", { id: asked.id, reason: askedSeen.reason, definitions: { machine: kept } });
    const edited = await seen(asked.id);
    const busy = await call("dana", "design.rollback", { id: d.id });
    step("a rollback edited by hand is a change like any other (its sandbox check still runs); a design already in an open change is not drafted twice",
        edited.rollback?.pure === false && busy.status === 409 && busy.code === "rollback.busy", { pure: edited.rollback?.pure, busy });
    await call("dana", "design.withdraw", { id: asked.id });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.();
    await pool.end();
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
