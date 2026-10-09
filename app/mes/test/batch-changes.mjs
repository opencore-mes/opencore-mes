// Several designs in one change (§5.12), end to end:
//   1. Four objects are made live in one change (A and C stewarded by Production, B by Quality, D too).
//   2. Dana starts a change on A and brings B in: its live body is the draft, at its live version, and
//      the title says what the change holds. Again: already there. Refused, by name: a design that is
//      not live, a kind there is none of, someone who is not its author, a copy loaded before a save,
//      and one already in another open change (that change named); once that one is withdrawn, it comes.
//   3. The AI brings D in through /ai/v1 (add_to_change): the audit says it was the AI, for Dana, and
//      nothing is marked drafted by it, since nothing was.
//   4. A and B edited, C and D left as they were: one review, one approval from each department the
//      edits touch (Production for A, Quality for B, once each; C and D, unchanged, add none), executed
//      all at once: A and B at version 2, C and D not published again.
//   5. A change on C left as it is live: refused at submit, saying C is live already as drafted, and to withdraw
//      it or change it.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/batch-changes.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
    const { url: mes } = await app.listen({ port: 0 });
    const people = ["dana", "eli", "vera", "sam", "quinn"];
    const sessions = {};
    for (const user of people) {
        sessions[user] = `bc-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, code: body.code, status: res.status };
    };
    const approveAll = async (id) => {
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 3 && state !== "executed"; round++) for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
        return state;
    };
    const versionOf = async (object) => (await db.query("SELECT version FROM mes.definitions WHERE object = $1 AND status = 'published'", [object]))[0]?.version ?? null;

    // ---- 1. four live objects ----
    const [A, B, C, D] = ["a", "b", "c", "d"].map((x) => `bx_${x}_t${tag}`);
    const one = await call("dana", "design.start", { object: A, label: `Batch A ${tag}` });
    const first = await call("dana", "design.change", { id: one.id, as: "dana" });
    const base = first.content.definitions[A];
    const like = (object, label, stewards) => ({ ...JSON.parse(JSON.stringify(base)), object, label, stewards: { object: stewards }, policies: [{ id: `${object}-all`, roles: ["user"], record: { read: true, create: true }, fields: { "*": "write" } }] });
    const made = await call("dana", "design.save", { id: one.id, seen: first.draft_rev, reason: "Four objects to change together.", definitions: { [A]: like(A, `Batch A ${tag}`, ["production"]), [B]: like(B, `Batch B ${tag}`, ["quality"]), [C]: like(C, `Batch C ${tag}`, ["production"]), [D]: like(D, `Batch D ${tag}`, ["quality"]) } });
    await call("dana", "design.submit", { id: one.id });
    const madeState = await approveAll(one.id);
    step("four objects made live in one change", !made.problems?.length && madeState === "executed" && (await versionOf(A)) === 1 && (await versionOf(D)) === 1, { problems: made.problems, madeState });

    // ---- 2. a change on A, B brought in ----
    const two = await call("dana", "design.start", { object: A });
    let ch = await call("dana", "design.change", { id: two.id, as: "dana" });
    const inB = await call("dana", "design.include", { id: two.id, kind: "object", name: B, seen: ch.draft_rev });
    ch = await call("dana", "design.change", { id: two.id, as: "dana" });
    step("B brought into the change on A: its live body is its draft, at its live version, and the title says both",
        inB.ok && inB.version === 1 && ch.content.definitions[B]?.label === `Batch B ${tag}` && ch.base?.definitions?.[B] === 1 && ch.title === `Change Batch A ${tag}, Batch B ${tag}`, { inB, title: ch.title, base: ch.base });
    const again = await call("dana", "design.include", { id: two.id, kind: "object", name: B });
    step("…again: it is there already", again.ok && again.already === true, again);
    const none = await call("dana", "design.include", { id: two.id, kind: "object", name: `nope_t${tag}` });
    const kindless = await call("dana", "design.include", { id: two.id, kind: "widget", name: B });
    const notHers = await call("eli", "design.include", { id: two.id, kind: "object", name: C });
    const old = await call("dana", "design.include", { id: two.id, kind: "object", name: C, seen: ch.draft_rev - 1 });
    step("refused, by name: not live, no such kind, not its author, a copy loaded before the last save",
        none.status === 404 && /no live object/.test(none.error) && kindless.status === 400 && /Bring in a live/.test(kindless.error)
        && notHers.status === 403 && /Only its author/.test(notHers.error) && old.code === "design.stale", { none, kindless, notHers, old });
    const three = await call("dana", "design.start", { object: C });
    const taken = await call("dana", "design.include", { id: two.id, kind: "object", name: C });
    await call("dana", "design.withdraw", { id: three.id });
    const inC = await call("dana", "design.include", { id: two.id, kind: "object", name: C });
    step("one already in another open change is refused, that change named; withdrawn, it comes",
        taken.status === 409 && taken.code === "design.taken" && taken.error.includes(`Change Batch C ${tag}`) && inC.ok && inC.version === 1, { taken, inC });

    // ---- 3. the AI brings D in ----
    const { createTokens } = await import("../server/ai-api.js");
    const issued = await createTokens(db).issue("dana", { name: "batch test", agent: "test agent", scopes: ["design:read", "design:draft"] });
    const ai = await fetch(`${mes}/ai/v1/changes/${two.id}/include`, { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", "x-ai-agent": "test agent" }, body: JSON.stringify({ kind: "object", name: D }) });
    const aiBody = await ai.json();
    const [aiAudit] = await db.query("SELECT actor, after FROM mes.audit_log WHERE action = 'change:include' AND record_id = $1 AND after->>'object' = $2 ORDER BY seq DESC LIMIT 1", [two.id, D]);
    ch = await call("dana", "design.change", { id: two.id, as: "dana" });
    const contract = await (await fetch(`${mes}/ai/v1/contract`, { headers: { authorization: `Bearer ${issued.token}`, "x-ai-agent": "test agent" } })).json();
    step("the AI brings D in (add_to_change): the audit says how, nothing is marked drafted by it, and its contract says how a change holds several",
        ai.status === 200 && aiBody.ok && ch.content.definitions[D] && !(ch.ai_edits ?? ch.aiEdits ?? []).length && /add_to_change/.test(contract.lifecycle ?? "")
        && aiAudit?.actor === "dana" && aiAudit.after?.via?.agent === "test agent", { status: ai.status, aiBody, aiEdits: ch.ai_edits ?? ch.aiEdits, aiAudit, lifecycle: contract.lifecycle });

    // ---- 4. A and B edited; reviewed and approved once; executed together ----
    const content = ch.content.definitions;
    content[A].fields.note_a = { label: "Note A", type: "string" };
    content[B].fields.note_b = { label: "Note B", type: "string" };
    const saved = await call("dana", "design.save", { id: two.id, seen: ch.draft_rev, reason: "Two notes, one change.", definitions: content });
    const submitted = await call("dana", "design.submit", { id: two.id });
    const inReview = await call("vera", "design.change", { id: two.id, as: "vera" });
    const route = (inReview.route ?? []).map((a) => a.department).sort();
    const state = await approveAll(two.id);
    const signed = await db.query("SELECT department, count(*)::int AS n FROM mes.approvals WHERE change_id = $1 AND decision = 'approve' GROUP BY 1 ORDER BY 1", [two.id]);
    step("one route for all of it: Production (for A) and Quality (for B), each once; C and D, unchanged, add no approver; one review",
        !saved.problems?.length && !submitted.error && route.join() === "production,quality" && signed.length === 2 && signed.every((s) => s.n === 1), { saved: saved.problems, submitted, route, signed });
    const [vA, vB, vC, vD] = [await versionOf(A), await versionOf(B), await versionOf(C), await versionOf(D)];
    const [{ body: liveA }] = await db.query("SELECT body FROM mes.definitions WHERE object = $1 AND status = 'published'", [A]);
    step("executed together: A and B at version 2 with their notes; C and D, left as they were, not published again",
        state === "executed" && vA === 2 && vB === 2 && vC === 1 && vD === 1 && liveA.fields.note_a, { state, vA, vB, vC, vD });

    // ---- 5. a change that is live already as drafted ----
    const idle = await call("dana", "design.start", { object: C });
    await call("dana", "design.save", { id: idle.id, seen: (await call("dana", "design.change", { id: idle.id, as: "dana" })).draft_rev, reason: "Left as it is." });
    const nothing = await call("dana", "design.submit", { id: idle.id });
    step("a change whose draft is what is live already: refused at submit, naming it, and saying to withdraw it or change it",
        nothing.status >= 400 && new RegExp(`This change changes nothing: Batch C ${tag} is live already, exactly as drafted here.*Withdraw it`).test(nothing.error ?? ""), nothing);
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
