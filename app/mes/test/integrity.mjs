// The data integrity review (§7.7; COMPLIANCE.md G16), end to end, against a running server:
//   1. For integrity reviewers (Quinn, a design reviewer, given it by the migration): Dana is refused, in words;
//      the page and its link are Quinn's. The reset took the baseline: every record sealed.
//   2. Writes through the platform are never findings: a lot created, held, updated, archived and restored; a
//      change to People & departments executed (it names the deviation object for the reports).
//   3. Writes around it are, each with what it changed and, where the tripwire saw it, the database user:
//      a lot's quantity changed by SQL; a lot inserted by SQL; a lot deleted by SQL; a lot put back as an
//      earlier version (its old, valid seal with it); a lot changed with the tripwire told it was the platform
//      (the seal still finds it); a role given by SQL; a design's body changed by SQL. A critical event says so.
//   4. Closing: only reviewers; a report needs what, why, a decision and the action; "corrected" is refused
//      until it was put right through the platform, and for a removal; accepted seals it as it stands. The
//      organization's report object (deviation) gets a record of each report, through the record services.
//      Scanned again, nothing closed comes back.
//   5. The periodic review, signed for a period.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/integrity.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { sessionKey } from "../server/store.js";
import { platformWrites, resealRecords, sealDesigns } from "../server/integrity.js";
import { liveKey } from "@opencore-mes/juris-kit/live-protocol.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const emitted = [];
const events = { emit: (kind, o = {}) => emitted.push({ kind, ...o }), flush: async () => 0, state: () => ({}) };
let app = null;
const people = ["dana", "eli", "vera", "sam", "quinn", "ivan", "ines", "olga", "iris"];
const sessions = {};

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, events, instance: `int-${tag}` });
    const { url: mes } = await app.listen({ port: 0 });
    for (const user of people) {
        sessions[user] = `in-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const page = async (user, path) => (await fetch(`${mes}${path}`, { headers: { cookie: `mes_session=${sessions[user]}` } })).text();
    const key = () => `in-${randomBytes(8).toString("hex")}`;
    const approveAll = async (id) => {
        const submitted = await call("dana", "design.submit", { id });
        if (submitted.error) return submitted;
        await call("vera", "design.review", { id, decision: "pass" });
        let state = null;
        for (let round = 0; round < 4 && state !== "executed"; round++) {
            for (const user of people) {
                const seen = await call(user, "design.change", { id, as: user });
                for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
            }
        }
        return { state };
    };
    const report = () => call("quinn", "integrity.report", { as: "quinn" });
    // As the page reads it: a live query over the event stream, naming its reader (→ the first answer, or its error).
    const liveRead = async (user, name, args) => {
        const res = await fetch(`${mes}/api/events`, { headers: { cookie: `mes_session=${sessions[user]}` } });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sent = false;
        const deadline = setTimeout(() => reader.cancel(), 5000);
        try {
            for (;;) {
                const { value, done } = await reader.read().catch(() => ({ done: true }));
                if (done) return { error: "no answer" };
                buffer += decoder.decode(value, { stream: true });
                let at;
                while ((at = buffer.indexOf("\n\n")) >= 0) {
                    const event = buffer.slice(0, at);
                    buffer = buffer.slice(at + 2);
                    const data = event.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
                    if (!data) continue;
                    const msg = JSON.parse(data);
                    if (event.startsWith("event: hello") && !sent) {
                        sent = true;
                        const sub = await fetch(`${mes}/api/_live`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify({ client: msg.client, subscribe: { key: liveKey(name, [args]), name, args: [args] } }) });
                        if (!sub.ok) return { error: await sub.text() };
                        continue;
                    }
                    if (msg.full !== undefined) return { full: msg.full };
                    if (msg.error) return { error: msg.error };
                }
            }
        } finally { clearTimeout(deadline); reader.cancel().catch(() => {}); }
    };
    const scan = (full = true) => call("quinn", "integrity.scan", { full });
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' ORDER BY data->>'wo_no' LIMIT 1");
    const newLot = async (no) => call("sam", "records.create", { object: "lot", data: { lot_no: no, item: "PA66-NAT-25", work_order: wo.id, qty: 10, uom: "kg" }, key: key() });
    // What the suites before this one wrote by hand to set their scenes (thousands of rows, for long lists):
    // sealed as it stands, its findings closed, as a fresh baseline would, so this one starts clean.
    await db.transaction(async (tx) => {
        await platformWrites(tx);
        for (const { object } of await tx.query("SELECT DISTINCT object FROM mes.records")) {
            await resealRecords(tx, object, (await tx.query("SELECT id FROM mes.records WHERE object = $1", [object])).map((r) => r.id));
        }
        await sealDesigns(tx);
        await tx.query(`UPDATE mes.integrity_state SET tripwire_seq = (SELECT COALESCE(max(seq), 0) FROM mes.integrity_tripwire),
                        key_from_seq = (SELECT COALESCE(max(seq), 0) FROM mes.audit_log), last_scan_at = now() WHERE id`);
    });
    // (Rows they deleted by hand, found by a full scan; then everything found so far closed.)
    for (let k = 0; k < 5 && (await scan(true)).fresh; k++);
    await db.query("UPDATE mes.integrity_findings SET state = 'closed', closed_at = now(), closed_by = 'test', report = '{\"what\": \"the earlier suites'' scenes\"}' WHERE state = 'open'");
    const before = new Set((await report()).open.map((f) => f.id));
    const fresh = async () => (await report()).open.filter((f) => !before.has(f.id));

    // ---- 1. for integrity reviewers ----
    const danaReport = await call("dana", "integrity.report", { as: "dana" });
    step("the review is for integrity reviewers: Dana is refused, in words", danaReport.status === 403 && /integrity reviewers/.test(danaReport.error), danaReport);
    const first = await report();
    step("Quinn (a design reviewer, given the role by the migration) reads it: the reset took the baseline", !first.error && Boolean(first.baselineAt) && first.baselineBy === "seed", first);
    const asPage = await liveRead("quinn", "integrity.report", { as: "quinn" });
    const danaLive = await liveRead("dana", "integrity.report", { as: "dana" });
    step("read as the page reads it (a live query naming its reader): Quinn's report, Dana refused", Boolean(asPage.full?.baselineAt) && !asPage.full?.error && !danaLive.full, { asPage: asPage.error ?? Object.keys(asPage.full ?? {}), danaLive });
    const quinnPage = await page("quinn", "/design/integrity");
    const danaPage = await page("dana", "/");
    step("the Data integrity page and its link are Quinn's, not Dana's", quinnPage.includes("Data integrity") && quinnPage.includes('href="/design/integrity"') && !danaPage.includes('href="/design/integrity"'));
    const [{ unsealed }] = await db.query("SELECT count(*)::int AS unsealed FROM mes.records WHERE seal IS NULL");
    step("every record is sealed", unsealed === 0, { unsealed });

    // ---- 2. the platform's own writes ----
    let lot = await newLot(`IN-A-${tag}`);
    const lotA = lot.id;
    lot = await call("sam", "records.action", { object: "lot", id: lotA, action: "hold", rowVersion: lot.row_version, key: key() });
    lot = await call("quinn", "records.update", { object: "lot", id: lotA, rowVersion: lot.row_version, data: { disposition: "reject" }, key: key() });
    lot = await call("sam", "records.archive", { object: "lot", id: lotA, rowVersion: lot.row_version, key: key() });
    lot = await call("sam", "records.restore", { object: "lot", id: lotA, rowVersion: lot.row_version, key: key() });
    step("a lot created, held, updated, archived and restored through the platform", !lot.error && lot.row_version >= 5, lot);
    const { id: orgChange } = await call("dana", "design.start", { organization: true });
    const org = (await call("dana", "design.change", { id: orgChange, as: "dana" })).content.organization;
    const wrong = await call("dana", "design.save", { id: orgChange, reason: "Integrity reports raised as deviations.", organization: { ...org, integrity: { reportObject: "deviation", fields: { title: "finding", description: "nothing" } } } });
    step("a report part that is not one is named", (wrong.problems ?? []).some((p) => /description takes one of what, why, decision, action, finding/.test(p.message)), wrong.problems);
    const integrity = { reportObject: "deviation", fields: { title: "finding", description: "what", root_cause: "why" }, values: { severity: "major" } };
    const saved = await call("dana", "design.save", { id: orgChange, organization: { ...org, integrity } });
    const done = !saved.problems?.length ? await approveAll(orgChange) : saved;
    step("People & departments names the deviation object for the reports, through a change, executed", done.state === "executed", { saved: saved.problems, done });
    const s2 = await scan(true);
    const after2 = await fresh();
    step("scanned (all of it): the platform's writes are no findings", !s2.error && s2.fresh === 0 && !after2.length, { s2, after2 });

    // ---- 3. around the platform ----
    const lotB = (await newLot(`IN-B-${tag}`)).id;
    const lotC = (await newLot(`IN-C-${tag}`)).id;
    let lotD = await newLot(`IN-D-${tag}`);
    const lotE = (await newLot(`IN-E-${tag}`)).id;
    const [{ who }] = await db.query("SELECT session_user AS who");
    await db.query("UPDATE mes.records SET data = jsonb_set(data, '{qty}', '999') WHERE object = 'lot' AND id = $1", [lotB]);
    const [ins] = await db.query("INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) SELECT object, def_version, 'created', jsonb_set(data, '{lot_no}', to_jsonb($2::text)), 'nobody', 'nobody' FROM mes.records WHERE object = 'lot' AND id = $1 RETURNING id", [lotC, `IN-X-${tag}`]);
    await db.query("DELETE FROM mes.records WHERE object = 'lot' AND id = $1", [lotC]);
    const [old] = await db.query("SELECT * FROM mes.records WHERE object = 'lot' AND id = $1", [lotD.id]);
    lotD = await call("sam", "records.action", { object: "lot", id: lotD.id, action: "hold", rowVersion: lotD.row_version, key: key() });
    await db.query("UPDATE mes.records SET data = $2, row_version = $3, seal = $4, updated_at = $5, updated_by = $6, state = $7 WHERE object = 'lot' AND id = $1", [old.id, old.data, old.row_version, old.seal, old.updated_at, old.updated_by, old.state]);
    await db.transaction(async (tx) => {
        await tx.query("SELECT set_config('mes.integrity_reseal', 'on', true)");
        await tx.query("UPDATE mes.records SET data = jsonb_set(data, '{qty}', '1') WHERE object = 'lot' AND id = $1", [lotE]);
    });
    await db.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('user', 'olga', 'design', 'designer')");
    const [liveLot] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    await db.query("UPDATE mes.definitions SET body = jsonb_set(body, '{label}', '\"Lot (by hand)\"') WHERE object = 'lot' AND version = $1", [liveLot.version]);
    const quick = await scan(false);
    const found = await fresh();
    const one = (pred) => found.find(pred);
    const changedB = one((f) => f.kind === "record" && f.ref === lotB && f.problem === "changed");
    step("a lot's quantity changed by SQL: found, with the database user and the change (10 → 999)",
        changedB?.detail?.by === who && changedB.detail.op === "UPDATE" && changedB.detail.changes?.some((c) => c.field === "qty" && c.before === 10 && c.after === 999) && changedB.title === `IN-B-${tag}`, changedB ?? found);
    step("a lot inserted by SQL: found as added", Boolean(one((f) => f.ref === ins.id && f.problem === "unsealed" && f.detail.by === who)), found.map((f) => [f.ref, f.problem]));
    step("a lot deleted by SQL: found as removed, by whom", Boolean(one((f) => f.ref === lotC && f.problem === "removed" && f.detail.by === who)));
    step("each was found by the quick scan (the tripwire), and a critical event says so",
        quick.fresh >= 3 && emitted.some((e) => e.kind === "integrity.violation" && e.severity === "critical" && /made outside the platform/.test(e.message)), { quick, emitted });
    step("a lot put back as an earlier version, its old seal with it: found as replaced", Boolean(one((f) => f.ref === lotD.id && f.problem === "replaced")), found.map((f) => [f.ref, f.problem]));
    step("a lot changed with the tripwire told it was the platform: the seal still finds it", Boolean(one((f) => f.ref === lotE && f.problem === "changed" && !f.detail.by)));
    step("a role given by SQL: found in the table it was written to, and as people and roles changed",
        Boolean(one((f) => f.kind === "access" && f.object === "assignments" && f.ref === "user:olga:design:designer" && f.detail.op === "INSERT")) && Boolean(one((f) => f.kind === "access" && f.ref === "people and roles" && f.problem === "changed")), found.filter((f) => f.kind === "access"));
    step("a design's body changed by SQL: found, in its table and by its seal",
        Boolean(one((f) => f.kind === "design" && f.object === "definitions" && f.ref === `lot:${liveLot.version}`)) && Boolean(one((f) => f.kind === "design" && f.ref === "lot" && f.problem === "changed")), found.filter((f) => f.kind === "design"));
    const again = await scan(true);
    step("found once: scanned again, nothing new", again.fresh === 0 && (await fresh()).length === found.length, { again, n: (await fresh()).length, was: found.length });

    // ---- 4. closing, with a non-conformance report ----
    const report1 = { what: "Quantity changed to 999 in the database.", why: "A script run by hand by IT, by mistake.", decision: "corrected", action: "Put back through the lot's form; IT's access reviewed." };
    const refusedDana = await call("dana", "integrity.close", { id: changedB.id, report: report1, signature: {} });
    step("only reviewers close", refusedDana.status === 403, refusedDana);
    const empty = await call("quinn", "integrity.close", { id: changedB.id, report: { what: "", decision: "maybe" }, signature: {} });
    step("a report needs what, why, a decision and the action", empty.status === 400 && ["what", "why", "decision", "action"].every((k) => empty.fields?.[k]), empty);
    const early = await call("quinn", "integrity.close", { id: changedB.id, report: report1, signature: {} });
    step("corrected is refused until it is put right through the platform", early.status === 400 && /not corrected yet/.test(early.error), early);
    const [rowB] = await db.query("SELECT row_version FROM mes.records WHERE object = 'lot' AND id = $1", [lotB]);
    const putRight = await call("sam", "records.update", { object: "lot", id: lotB, rowVersion: Number(rowB.row_version), data: { qty: 10 }, key: key() });
    const closedB = await call("quinn", "integrity.close", { id: changedB.id, report: report1, signature: {}, key: key() });
    const [ncr] = closedB.raised ? await db.query("SELECT state, created_by, data FROM mes.records WHERE object = 'deviation' AND id = $1", [closedB.raised.id]) : [];
    step("put right through its form, then closed as corrected: a deviation raised with the report, as Quinn",
        !putRight.error && closedB.ok && ncr?.created_by === "quinn" && ncr.data.description === report1.what && ncr.data.root_cause === report1.why && ncr.data.severity === "major" && ncr.data.title === `changed record lot ${lotB}`, { putRight, closedB, ncr });
    const removed = one((f) => f.ref === lotC && f.problem === "removed");
    const corrRemoved = await call("quinn", "integrity.close", { id: removed.id, report: { ...report1, what: "A lot deleted in the database." }, signature: {} });
    step("a removal cannot be closed as corrected", corrRemoved.status === 400 && /cannot be corrected here/.test(corrRemoved.error), corrRemoved);
    const accept = (f, what) => call("quinn", "integrity.close", { id: f.id, report: { what, why: "Found in the review; the cause is known.", decision: "accepted", action: "Accepted as it is; noted for IT." }, signature: {}, key: key() });
    const results = [];
    for (const f of found.filter((x) => x.id !== changedB.id)) {
        if (f.kind === "access" || f.kind === "design") continue;
        results.push(await accept(f, `${f.problem} ${f.ref}`));
    }
    // The role and the design's label, put back by IT (as the platform: let by the tripwire), then accepted.
    await db.transaction(async (tx) => {
        await tx.query("SELECT set_config('mes.integrity_reseal', 'on', true)");
        await tx.query("DELETE FROM mes.assignments WHERE subject_kind = 'user' AND subject_id = 'olga' AND object = 'design' AND role = 'designer'");
        await tx.query("UPDATE mes.definitions SET body = $2 WHERE object = 'lot' AND version = $1", [liveLot.version, liveLot.body]);
    });
    for (const f of found.filter((x) => x.kind === "access" || x.kind === "design")) results.push(await accept(f, `${f.problem} ${f.object} ${f.ref}`));
    step("the rest accepted as they are, each with its report", results.every((r) => r.ok), results.filter((r) => !r.ok));
    const [sealedIns] = await db.query("SELECT seal FROM mes.records WHERE id = $1", [ins.id]);
    const [{ n: closes }] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE object = '$integrity' AND action = 'close' AND actor = 'quinn' AND after->>'what' IS NOT NULL");
    step("accepted: the inserted lot sealed as it stands; every report in the audit trail, by Quinn", Boolean(sealedIns?.seal) && closes >= found.length, { sealedIns, closes });
    const last = await scan(true);
    step("scanned again (all of it): nothing closed comes back", last.fresh === 0 && !(await fresh()).length, { last, open: await fresh() });
    const r4 = await report();
    step("the closed ones are listed with their decision and who signed", r4.closed.some((f) => f.id === changedB.id && f.report?.decision === "corrected" && f.report.by === "quinn"));

    // ---- 5. the periodic review ----
    const today = new Date().toISOString().slice(0, 10);
    const badReview = await call("quinn", "integrity.review", { from: today, to: today, note: "" });
    const review = await call("quinn", "integrity.review", { from: `${today}T00:00:00Z`, to: new Date().toISOString(), note: `Reviewed the findings of ${today}: all closed.`, signature: {} });
    step("the periodic review: what was reviewed is required; signed, with the period's open and closed", badReview.status === 400 && review.ok && review.closed >= found.length && Number.isInteger(review.open), { badReview, review });

    // ---- put back, for the suites after this one: no report object ----
    const { id: backId } = await call("dana", "design.start", { organization: true });
    const orgNow = (await call("dana", "design.change", { id: backId, as: "dana" })).content.organization;
    const { integrity: _, ...withoutIt } = orgNow;
    const back = await call("dana", "design.save", { id: backId, reason: "Integrity reports kept on the page.", organization: withoutIt });
    step("put back: no report object", !back.problems?.length && (await approveAll(backId)).state === "executed");
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close();
    await db.query("DELETE FROM mes.sessions WHERE id = ANY($1)", [Object.values(sessions).map(sessionKey)]).catch(() => {});
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
