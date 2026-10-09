// Data retention and erasure (§27.8; COMPLIANCE.md G11), end to end, against a running server:
//   1. The report is for privacy officers (Ines, seeded): Olga is refused, in words; the page and its
//      link are Ines's. By default: records and the audit trail kept forever, sign-in leftovers 30 days.
//   2. The periods change through People & departments: an audit trail shorter than six years, or than
//      the records, is named; approved by governance alone; executed.
//   3. Data past them (made here, backdated): "what would go" counts it, per kind, and changes nothing.
//   4. The purge, run now by Ines: what is past its period goes; what is under way, scheduled, waiting,
//      fresh, or an instance's last event, stays; records and the audit trail are counted, never removed.
//      Summarised in the audit trail and the event log in numbers, never contents. A scheduled run with
//      nothing to remove writes neither.
//   5. The event log's copy stays append-only outside the purge, and inside it for anything under a year.
//   6. Erasure: Person gains an email and a phone marked erasable (the name cannot be: People &
//      departments keeps it). Ines finds Olga and erases them, with a reason: the fields read "[erased]",
//      the rest of the record and its history stay, the audit entry names the fields, not their values,
//      and the answers kept for retries that carried them are gone. Olga may not erase; a field not
//      marked is refused; erasing again finds nothing left.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/retention.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { sessionKey } from "../server/store.js";
import { purge } from "../server/retention.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const clone = (v) => JSON.parse(JSON.stringify(v));
const emitted = [];
const events = { emit: (kind, o = {}) => emitted.push({ kind, ...o }), flush: async () => 0, state: () => ({}) };
let app = null;
const people = ["dana", "eli", "vera", "sam", "quinn", "ivan", "ines", "olga", "iris"];
const sessions = {};

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, events, instance: `ret-${tag}` });
    const { url: mes } = await app.listen({ port: 0 });
    for (const user of people) {
        sessions[user] = `rt-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const page = async (user, path) => (await fetch(`${mes}${path}`, { headers: { cookie: `mes_session=${sessions[user]}` } })).text();
    const key = () => `rt-${randomBytes(8).toString("hex")}`;
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
    const auditCount = async () => Number((await db.query("SELECT count(*)::int AS n FROM mes.audit_log"))[0].n);
    const kindOf = (report, k) => report.kinds.find((x) => x.key === k);

    // ---- 1. for privacy officers ----
    const olgaReport = await call("olga", "retention.report", {});
    step("the report is for privacy officers: Olga is refused, in words", olgaReport.status === 403 && /privacy officers/.test(olgaReport.error), olgaReport);
    const first = await call("ines", "retention.report", {});
    step("Ines (a privacy officer) reads it: records and the audit trail kept forever, sign-in leftovers 30 days, answers 90",
        !first.error && kindOf(first, "records").days === null && kindOf(first, "audit").days === null && kindOf(first, "sign_in").days === 30 && kindOf(first, "answers").days === 90 && kindOf(first, "conversations").days === null && kindOf(first, "audit").purged === false, first);
    const inesPage = await page("ines", "/design/retention");
    const olgaPage = await page("olga", "/");
    step("the Data retention page and its link are Ines's, not Olga's", inesPage.includes("Data retention") && inesPage.includes('href="/design/retention"') && !olgaPage.includes('href="/design/retention"'));

    // ---- 2. the periods, through a change ----
    const setRetention = async (retention, reason) => {
        const { id } = await call("dana", "design.start", { organization: true });
        const org = (await call("dana", "design.change", { id, as: "dana" })).content.organization;
        const saved = await call("dana", "design.save", { id, reason, organization: { ...org, retention } });
        return { id, saved, org };
    };
    const wrong = await setRetention({ audit: 2190, events: 30, conversations: "a while" }, "Retention periods.");
    const words = (wrong.saved.problems ?? []).map((p) => p.message).join("\n");
    step("its mistakes are named: an audit trail shorter than the records, a period under its floor, one that is not a period",
        /at least as long as the records it describes/.test(words) && /The event log's copy: at least 1 year/.test(words) && /"a while" is not a period/.test(words), wrong.saved.problems);
    const PERIODS = { conversations: 30, saved: 30, integration: 30, answers: 30, events: 365, records: 2190, audit: 3650 };
    const fixed = await call("dana", "design.save", { id: wrong.id, organization: { ...wrong.org, retention: PERIODS } });
    const routed = await call("dana", "design.change", { id: wrong.id, as: "dana" });
    step("fixed; approved by governance alone", !fixed.problems?.length && routed.route.map((r) => r.department).join() === "engineering" && routed.footprint.some((e) => e.element === "retention"), { problems: fixed.problems, route: routed.route });
    const done = await approveAll(wrong.id);
    const [published] = await db.query("SELECT body->'retention' AS retention FROM mes.organization WHERE status = 'published'");
    step("executed: the plant's periods are published", done.state === "executed" && Object.entries(PERIODS).every(([k, v]) => published.retention?.[k] === v) && Object.keys(published.retention ?? {}).length === Object.keys(PERIODS).length, { done, retention: published?.retention });

    // ---- 3. data past them, and what would go ----
    // What was past them already (nothing, after a reset), so what follows counts this run's own.
    const already = Object.fromEntries((await call("ines", "retention.report", {})).kinds.map((k) => [k.key, k.count]));
    const OLD = "now() - interval '40 days'";
    const EV_A = `ret-a-${tag}`;
    const EV_B = `ret-b-${tag}`;
    const SECRET = `prompt-text-${tag}`;
    await db.query(`INSERT INTO mes.copilot_conversations (owner, change_id, messages, updated_at) VALUES ('dana', $1, '[{"text":"${SECRET}"}]', ${OLD}) ON CONFLICT (owner, change_id) DO UPDATE SET messages = excluded.messages, running = false, updated_at = ${OLD}`, [wrong.id]);
    await db.query(`INSERT INTO mes.copilot_conversations (owner, change_id, running, updated_at) VALUES ('iris', $1, true, ${OLD}) ON CONFLICT (owner, change_id) DO UPDATE SET running = true, updated_at = ${OLD}`, [wrong.id]);
    await db.query(`INSERT INTO mes.analyst_conversations (owner, updated_at) VALUES ('vera', ${OLD}) ON CONFLICT (owner) DO UPDATE SET updated_at = ${OLD}, running = false`);
    await db.query(`INSERT INTO mes.analyst_conversations (owner) VALUES ('sam') ON CONFLICT (owner) DO UPDATE SET updated_at = now()`);
    await db.query(`INSERT INTO mes.sandbox_selections (owner, name, updated_at) VALUES ('dana', $1, ${OLD})`, [`old-${tag}`]);
    const [oldPrompt] = await db.query(`INSERT INTO mes.report_prompts (owner, title, prompt, updated_at) VALUES ('sam', $1, $2, ${OLD}) RETURNING id`, [`old-${tag}`, SECRET]);
    const [scheduled] = await db.query(`INSERT INTO mes.report_prompts (owner, title, prompt, next_at, updated_at) VALUES ('sam', $1, 'weekly', now() + interval '300 days', ${OLD}) RETURNING id`, [`yearly-${tag}`]);
    const [doneRun] = await db.query(`INSERT INTO mes.integration_outbox (service, event, run_as, state, done_at, created_at) VALUES ($1, '{}', 'erp', 'done', ${OLD}, ${OLD}) RETURNING id`, [`svc_${tag}`]);
    const [waiting] = await db.query(`INSERT INTO mes.integration_outbox (service, event, run_as, state, created_at) VALUES ($1, '{}', 'erp', 'retry', ${OLD}) RETURNING id`, [`svc_${tag}`]);
    await db.query(`INSERT INTO mes.idempotency (key, user_id, result, at) VALUES ($1, 'olga', '{}', ${OLD}), ($2, 'olga', '{}', now())`, [`rt-old-${tag}`, `rt-new-${tag}`]);
    await db.query(`INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'olga', ${OLD})`, [`rt-gone-${tag}`]);
    await db.query(`INSERT INTO mes.password_tokens (token_hash, user_id, made_by, expires_at) VALUES ($1, 'olga', 'iris', ${OLD})`, [`rt-${tag}-${randomBytes(8).toString("hex")}`]);
    const ev = (instance, seq, at) => db.query(`INSERT INTO mes.event_log (instance, seq, at, kind, severity, message, prev_hash, hash) VALUES ($1, $2, ${at}, 'test.event', 'info', 'A test event.', 'x', 'y')`, [instance, seq]);
    await ev(EV_A, 1, "now() - interval '400 days'");
    await ev(EV_A, 2, "now() - interval '400 days'");
    await ev(EV_A, 3, "now()");
    await ev(EV_B, 1, "now() - interval '400 days'");
    // A record archived seven years ago: past its period, counted, never removed.
    const [archived] = await db.query("SELECT id, archived_at FROM mes.records WHERE object = 'work_order' ORDER BY created_at LIMIT 1");
    await db.query("UPDATE mes.records SET archived_at = now() - interval '7 years', archived_by = 'sam' WHERE object = 'work_order' AND id = $1", [archived.id]);

    const tables = async () => Object.fromEntries(await Promise.all(["copilot_conversations", "analyst_conversations", "sandbox_selections", "report_prompts", "integration_outbox", "idempotency", "sessions", "password_tokens", "event_log", "records"].map(async (t) => [t, (await db.query(`SELECT count(*)::int AS n FROM mes.${t}`))[0].n])));
    const beforeReport = await tables();
    const report = await call("ines", "retention.report", {});
    const counts = Object.fromEntries(report.kinds.map((k) => [k.key, k.count - already[k.key]]));
    step("what would go, per kind: 2 conversations, 2 saved, 1 integration run, 1 answer, 2 sign-in leftovers, 2 events; 1 archived record past its period",
        counts.conversations === 2 && counts.saved === 2 && counts.integration === 1 && counts.answers === 1 && counts.sign_in === 2 && counts.events === 2 && counts.records === 1 && counts.audit === 0, counts);
    step("…and asking changes nothing", JSON.stringify(await tables()) === JSON.stringify(beforeReport));

    // ---- 4. the purge ----
    const olgaRun = await call("olga", "retention.run", {});
    step("Olga may not run the purge", olgaRun.status === 403, olgaRun);
    const auditBefore = await auditCount();
    const run = await call("ines", "retention.run", {});
    step("Ines runs it now: what was past its period is removed, counted per kind",
        !run.error && run.by === "ines" && Object.entries({ events: 2, conversations: 2, saved: 2, sign_in: 2, integration: 1, answers: 1 }).every(([k, n]) => run.counts[k] === n + already[k]), { run, already });
    const left = async (sql, params) => (await db.query(sql, params)).length;
    step("gone: the old conversations, selection, prompt, finished run, answer, session, link and events",
        !(await left("SELECT 1 FROM mes.copilot_conversations WHERE owner = 'dana' AND change_id = $1", [wrong.id])) && !(await left("SELECT 1 FROM mes.analyst_conversations WHERE owner = 'vera'"))
        && !(await left("SELECT 1 FROM mes.sandbox_selections WHERE name = $1", [`old-${tag}`])) && !(await left("SELECT 1 FROM mes.report_prompts WHERE id = $1", [oldPrompt.id]))
        && !(await left("SELECT 1 FROM mes.integration_outbox WHERE id = $1", [doneRun.id])) && !(await left("SELECT 1 FROM mes.idempotency WHERE key = $1", [`rt-old-${tag}`]))
        && !(await left("SELECT 1 FROM mes.sessions WHERE id = $1", [sessionKey(`rt-gone-${tag}`)])) && !(await left("SELECT 1 FROM mes.event_log WHERE instance = $1 AND seq < 3", [EV_A])));
    step("kept: a conversation under way, a scheduled prompt, a run still waiting, a fresh answer, an instance's last event",
        await left("SELECT 1 FROM mes.copilot_conversations WHERE owner = 'iris' AND change_id = $1", [wrong.id]) && await left("SELECT 1 FROM mes.analyst_conversations WHERE owner = 'sam'")
        && await left("SELECT 1 FROM mes.report_prompts WHERE id = $1", [scheduled.id]) && await left("SELECT 1 FROM mes.integration_outbox WHERE id = $1", [waiting.id])
        && await left("SELECT 1 FROM mes.idempotency WHERE key = $1", [`rt-new-${tag}`]) && await left("SELECT 1 FROM mes.event_log WHERE instance = $1 AND seq = 3", [EV_A]) && await left("SELECT 1 FROM mes.event_log WHERE instance = $1", [EV_B]));
    step("records and the audit trail are never removed: the record archived seven years ago is still there", await left("SELECT 1 FROM mes.records WHERE object = 'work_order' AND id = $1", [archived.id]) && (await auditCount()) === auditBefore + 1);
    const [entry] = await db.query("SELECT actor, object, action, after FROM mes.audit_log WHERE object = '$retention' ORDER BY seq DESC LIMIT 1");
    step("in the audit trail, by Ines: counts per kind and the periods, never what was removed",
        entry?.actor === "ines" && entry.action === "purge" && entry.after.counts.conversations === 2 + already.conversations && entry.after.periods.conversations === 30 && !JSON.stringify(entry.after).includes(SECRET) && !JSON.stringify(entry.after).includes(`old-${tag}`), entry);
    const said = emitted.find((e) => e.kind === "retention.purged");
    step("in the event log too, in numbers", said && /Retention removed/.test(said.message) && said.details.counts.integration === 1 + already.integration && !JSON.stringify(said).includes(SECRET), said);
    const after = await call("ines", "retention.report", {});
    step("the report shows the run, and nothing past its period but the archived record",
        after.runs[0]?.id === run.id && after.runs[0].by === "ines" && after.kinds.filter((k) => k.purged).every((k) => k.count === 0) && kindOf(after, "records").count === 1, { runs: after.runs.slice(0, 2), kinds: after.kinds.map((k) => [k.key, k.count]) });
    const auditQuiet = await auditCount();
    const emittedBefore = emitted.length;
    const quiet = await purge(db, { events });
    step("a scheduled run with nothing to remove writes no audit entry and no event, only its run", !quiet.skipped && quiet.total === 0 && quiet.by === "platform:retention" && (await auditCount()) === auditQuiet && emitted.length === emittedBefore, quiet);

    // ---- 5. the event log's copy, append-only outside the purge ----
    const tryDelete = (sql) => db.transaction(async (tx) => { await tx.query(sql); }).then(() => "deleted", (e) => e.message);
    await ev(EV_B, 2, "now() - interval '400 days'");
    await ev(EV_B, 3, "now() - interval '30 days'");
    const plain = await tryDelete(`DELETE FROM mes.event_log WHERE instance = '${EV_B}' AND seq = 2`);
    const recent = await tryDelete(`SET LOCAL mes.retention_purge = 'on'; DELETE FROM mes.event_log WHERE instance = '${EV_B}' AND seq = 3`);
    const truncate = await tryDelete("TRUNCATE mes.event_log");
    step("the event log's copy refuses a delete outside the purge, a recent event's even inside it, and TRUNCATE",
        /append-only/.test(plain) && /append-only/.test(recent) && /append-only/.test(truncate), { plain, recent, truncate });

    // A kind its table refuses (the event log's copy, strict again) is named in the run; the others go on.
    await db.query("CREATE OR REPLACE FUNCTION mes.event_log_is_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'event_log is append-only'; END; $$ LANGUAGE plpgsql");
    await ev(EV_B, 4, "now() - interval '400 days'");
    await ev(EV_B, 5, "now()");
    await db.query(`INSERT INTO mes.idempotency (key, user_id, result, at) VALUES ($1, 'olga', '{}', ${OLD})`, [`rt-old2-${tag}`]);
    const partly = await purge(db, { events });
    await db.query(await readFile(new URL("../db/migrate-retention.sql", import.meta.url), "utf8"));
    step("a kind its table refuses is named in the run, the audit trail and the event log; the others are purged",
        /Not purged: The event log's copy: event_log is append-only/.test(partly.error ?? "") && partly.counts.answers === 1 && !(await left("SELECT 1 FROM mes.idempotency WHERE key = $1", [`rt-old2-${tag}`])) && emitted.at(-1)?.severity === "error", partly);

    // ---- 6. erasure ----
    const { id: personChange } = await call("dana", "design.start", { object: "person" });
    const body = (await call("dana", "design.change", { id: personChange, as: "dana" })).content.definitions.person;
    const withContact = clone(body);
    withContact.fields.email ??= { label: "Email", type: "string" };
    withContact.fields.phone ??= { label: "Phone", type: "string" };
    withContact.fields.badge ??= { label: "Badge", type: "string" };
    withContact.fields.email.erasable = true;
    withContact.fields.phone.erasable = true;
    const nameToo = clone(withContact);
    nameToo.fields.name.erasable = true;
    const refusedName = await call("dana", "design.save", { id: personChange, reason: "Contact details, erasable.", definitions: { person: nameToo } });
    step("the name cannot be marked erasable: People & departments keeps it", (refusedName.problems ?? []).some((p) => p.path === "definitions.person.fields.name.erasable" || /People & departments keeps it, so it is not erased/.test(p.message)), refusedName.problems);
    // (Run again on the same database, Person has them already: nothing to change.)
    const had = body.fields.email?.erasable && body.fields.phone?.erasable;
    const savedPerson = had ? {} : await call("dana", "design.save", { id: personChange, seen: (await call("dana", "design.change", { id: personChange, as: "dana" })).draft_rev, definitions: { person: withContact } });
    const personDone = had ? (await call("dana", "design.withdraw", { id: personChange }), { state: "executed" }) : await approveAll(personChange);
    step("Person gains an email and a phone marked erasable, approved and live", !savedPerson.problems?.length && personDone.state === "executed", { problems: savedPerson.problems, personDone });
    let [olga] = await db.query("SELECT id, row_version, data FROM mes.records WHERE object = 'person' AND data->>'user' = 'olga'");
    const EMAIL = `olga.${tag}@example.com`;
    const updateKey = key();
    const updated = await call("dana", "records.update", { object: "person", id: olga.id, rowVersion: Number(olga.row_version), data: { email: EMAIL, phone: "+1 555 0100", badge: `B-${tag}` }, key: updateKey });
    step("Engineering keeps Olga's email, phone and badge", !updated.error && updated.email === EMAIL, updated);

    const objects = await call("ines", "retention.find", {});
    const found = await call("ines", "retention.find", { object: "person", q: String(olga.data?.name ?? "olga ortiz").toLowerCase() });
    const row = found.rows?.find((r) => r.id === olga.id);
    step("Ines finds Olga: Person's erasable fields named, what she holds of them (never their values)",
        objects.objects?.some((o) => o.object === "person" && o.fields.map((f) => f.name).sort().join() === "email,phone") && row?.holding.join() === "email,phone" && !JSON.stringify(found).includes(EMAIL), { objects, found });
    const byOlga = await call("olga", "records.erase", { object: "person", id: olga.id, reason: "Mine." });
    const noReason = await call("ines", "records.erase", { object: "person", id: olga.id });
    const notMarked = await call("ines", "records.erase", { object: "person", id: olga.id, fields: ["badge"], reason: "R-1" });
    const onLot = await call("ines", "records.erase", { object: "lot", id: olga.id, reason: "R-1" });
    step("refused: Olga (not an officer), no reason, a field not marked erasable, an object with none",
        byOlga.status === 403 && noReason.fields?.reason && /badge: not marked as personal data/.test(notMarked.error ?? "") && onLot.status === 409 && /Nothing on a lot is marked/.test(onLot.error), { byOlga, noReason, notMarked, onLot });
    const eraseKey = key();
    const auditErase = await auditCount();
    const erased = await call("ines", "records.erase", { object: "person", id: olga.id, reason: `GDPR request R-${tag}`, key: eraseKey });
    const [olgaAfter] = await db.query("SELECT data, row_version, state, archived_at FROM mes.records WHERE object = 'person' AND id = $1", [olga.id]);
    step("Ines erases them: email and phone read \"[erased]\"; her name, badge and state stay",
        erased.erased?.join() === "email,phone" && olgaAfter.data.email === "[erased]" && olgaAfter.data.phone === "[erased]" && olgaAfter.data.name === olga.data.name && olgaAfter.data.badge === `B-${tag}` && olgaAfter.state === "active" && Number(olgaAfter.row_version) === Number(updated.row_version) + 1, { erased, data: olgaAfter?.data });
    const [eraseEntry] = await db.query("SELECT actor, action, after FROM mes.audit_log WHERE record_id = $1 AND action = 'erase' ORDER BY seq DESC LIMIT 1", [olga.id]);
    step("the audit entry names the fields, by whom and why, never what they held", (await auditCount()) === auditErase + 1 && eraseEntry?.actor === "ines" && eraseEntry.after.erased.join() === "email,phone" && eraseEntry.after.reason === `GDPR request R-${tag}` && !JSON.stringify(eraseEntry.after).includes(EMAIL), eraseEntry);
    step("the answer kept for Dana's retry, which carried the email, is gone", !(await left("SELECT 1 FROM mes.idempotency WHERE key = $1 AND user_id = 'dana'", [updateKey])));
    step("the audit trail's earlier entries are untouched (append-only, inside its period)", await left("SELECT 1 FROM mes.audit_log WHERE record_id = $1 AND action = 'update' AND after->>'email' = $2", [olga.id, EMAIL]));
    const again = await call("ines", "records.erase", { object: "person", id: olga.id, reason: `GDPR request R-${tag}`, key: eraseKey });
    const fresh = await call("ines", "records.erase", { object: "person", id: olga.id, reason: "Again." });
    step("a retry with the same key answers the first result; erasing again finds nothing left, and writes nothing",
        again.erased?.join() === "email,phone" && fresh.erased?.length === 0 && fresh.already?.join() === "email,phone" && (await auditCount()) === auditErase + 1, { again, fresh });
    const read = await call("dana", "records.get", { object: "person", id: olga.id, as: "dana" });
    step("the record reads as erased to those who may read it", read.email === "[erased]" && read.badge === `B-${tag}`, read);

    // ---- put back, for the suites after this one: the defaults, the work order as it was ----
    await db.query("UPDATE mes.records SET archived_at = $2, archived_by = NULL WHERE object = 'work_order' AND id = $1", [archived.id, archived.archived_at]);
    const back = await setRetention({}, "Back to the defaults.");
    step("put back: the defaults", !back.saved.problems?.length && (await approveAll(back.id)).state === "executed" && kindOf(await call("ines", "retention.report", {}), "conversations").days === null);
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
