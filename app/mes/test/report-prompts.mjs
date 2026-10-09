// Kept prompts of the analytics copilot (§34.7), end to end against a running server, with a scripted
// model:
//   1. Sam keeps what he asks as a prompt: its mistakes are named by field; someone who may not query
//      keeps none; a prompt is its owner's alone.
//   2. He changes it and gives it a schedule: it says when it runs next, in words and as a time. One
//      that would run more than once an hour is refused.
//   3. Generated now: asked as Sam beside his own conversation (which is not touched); the report it
//      draws is kept as his, a record of Report, titled with the moment; the trail says so.
//   4. By the clock: when its time has come the scheduler asks it, keeps another report, and sets
//      its next run.
//   4b. Made sure of: the server down across several of its times makes one run, late, which says when it
//      was due and how many runs were not made; a run cut off by a stop is made again at the next start; one
//      that fails because the AI is away is tried again a little later, and succeeds.
//   5. A run that draws nothing says why, and keeps nothing.
//   6. Reports picked for the copilot: it is handed each as Sam may read it, with what he asks; one
//      he may not read, or too many, is refused.
//   7. Removed: the prompt is gone, the reports it generated stay.
//   8. Tags (§34.8): a report is filed under tags by its author; a prompt's tags go onto the reports
//      it generates.
//   9. An installation from before tags gets the field at its next start, by the platform, and keeps
//      what the plant made of the Report object.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/report-prompts.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null;

// The model: draws one small report for whatever it is asked, then says so. Asked for "nothing", it
// only answers in words. What it was handed is kept, to see what reached it.
const asked = [];
let failNext = 0; // the AI away for so many asks
const scripted = {
    name: "scripted", model: "scripted-model", available: true,
    async complete({ messages }) {
        if (failNext > 0) { failNext--; throw new Error("network down"); }
        const first = messages[0].content.map((b) => b.text ?? "").join("\n");
        const last = messages[messages.length - 1];
        if (last.content?.some?.((b) => b.type === "tool_result")) return { stop: "end", content: [{ type: "text", text: "Drawn." }] };
        asked.push(messages.filter((m) => m.role === "user").at(-1).content.map((b) => b.text ?? "").join("\n"));
        if (/nothing/.test(first) && messages.length === 1) return { stop: "end", content: [{ type: "text", text: "There is nothing to draw." }] };
        return { stop: "tools", content: [{ type: "tool_use", id: `r${asked.length}`, name: "render_report", input: { title: `Lots ${tag}`, blocks: [{ block: "text", text: `Asked: ${asked.at(-1).slice(0, 40)}` }, { block: "figure", title: "Lots", query: { sql: "SELECT count(*) AS lots FROM lot" }, value: "lots" }] } }] };
    },
};

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 100, ai: scripted, plantTz: "UTC" });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["sam", "olga", "dana"]) {
        sessions[user] = `pr-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const settled = async (user, id) => { for (let i = 0; i < 100; i++) { const p = (await call(user, "prompts.list", {})).find((x) => x.id === id); if (p && !p.running) return p; await sleep(100); } return null; };
    const reportsOf = () => db.query("SELECT id, data, created_by FROM mes.records WHERE object = 'report' AND archived_at IS NULL AND data->>'title' LIKE $1 ORDER BY created_at", [`Lots by state ${tag}%`]);
    await db.query("DELETE FROM mes.analyst_conversations WHERE owner = 'sam'");

    // ---- 1. kept ----
    const bad = await call("sam", "prompts.save", { title: " ", prompt: "", schedule: { every: { minutes: 30 } } });
    const notHers = await call("olga", "prompts.save", { title: "x", prompt: "y" });
    const kept = await call("sam", "prompts.save", { title: `Lots by state ${tag}`, prompt: "How many lots are in each state?" });
    const mine = await call("sam", "prompts.list", {});
    const theirs = await call("dana", "prompts.list", {});
    step("a prompt is kept under a title; its mistakes are named by field; who may not query keeps none; it is its owner's alone",
        bad.status >= 400 && bad.fields?.title && bad.fields.prompt && /at most once every 60 minutes/.test(bad.fields.schedule ?? "") && notHers.status === 403
        && kept.id && kept.schedule === null && kept.next_at === null && mine.some((p) => p.id === kept.id) && !theirs.some((p) => p.id === kept.id),
        { bad, notHers, kept });

    // ---- 2. changed, scheduled ----
    // A time three hours from now (UTC, as the test's plant): a failed run's retry, minutes later, comes
    // before it whenever the suite runs (a retry never goes past the prompt's next time).
    const AT = new Date(Date.now() + 3 * 3600_000).toISOString().slice(11, 16);
    const often = await call("sam", "prompts.save", { id: kept.id, title: kept.title, prompt: kept.prompt, schedule: { at: [AT, AT] } });
    // Asked by the clock, its reports are filed under tags: none given, refused, in words.
    const untagged = await call("sam", "prompts.save", { id: kept.id, title: kept.title, prompt: kept.prompt, schedule: { at: [AT] } });
    const scheduled = await call("sam", "prompts.save", { id: kept.id, title: kept.title, prompt: "How many lots are in each state, and which wait longest?", tags: " Daily,  Floor , daily", schedule: { at: [AT], days: ["mon", "tue", "wed", "thu", "fri"] } });
    const notMine = await call("dana", "prompts.save", { id: kept.id, title: "Taken", prompt: "x" });
    const [changed] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$report-prompt' AND action = 'prompt:changed' ORDER BY seq DESC LIMIT 1");
    step("changed and given a schedule (with tags: one asked by the clock without any is refused, in words): it says when it runs, in words and as its next time; another's is not theirs to change; the change is in the trail",
        often.status >= 400 && untagged.status === 400 && /files its reports under tags/.test(untagged.fields?.tags ?? "") && scheduled.id === kept.id && (scheduled.scheduleWords ?? "").includes(AT) && new Date(scheduled.next_at) > new Date() && /wait longest/.test(scheduled.prompt) && notMine.status === 404 && changed?.after.prompt === kept.id,
        { often, untagged, scheduled, notMine, changed });

    // ---- 3. generated now ----
    const started = await call("sam", "prompts.run", { id: kept.id });
    const twice = await call("sam", "prompts.run", { id: kept.id });
    const done = await settled("sam", kept.id);
    const first = await reportsOf();
    const conversation = await call("sam", "analyst.get", {});
    const [generated] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = '$report-prompt' AND action = 'prompt:generated' ORDER BY seq DESC LIMIT 1");
    const opened = done?.last_report ? await call("sam", "reports.run", { id: done.last_report }) : null;
    const hers = done?.last_report ? await call("dana", "reports.run", { id: done.last_report }) : null;
    step("generated now, as Sam, beside his conversation: the report is kept as his, titled with the moment, and opens; the trail says which prompt drew it",
        started.running === true && (twice.status === 409 || twice.running === true) && done && !done.last_error && first.length === 1 && first[0].id === done.last_report && first[0].data.owner === "sam" && first[0].data.shared === false && first[0].created_by === "sam"
        && /^Lots by state \d+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(first[0].data.title) && conversation.transcript.length === 0 && generated?.actor === "sam" && generated.after.report === done.last_report && generated.after.by === "now"
        && opened?.blocks?.length === 2 && /wait longest/.test(asked.at(-1)) && hers?.status === 404,
        { started, twice, done, first: first.map((r) => r.data.title), conversation: conversation.transcript, generated, opened: opened?.blocks?.length ?? opened, hers });

    // ---- 4. by the clock ----
    await db.query("UPDATE mes.report_prompts SET next_at = now() - interval '1 minute' WHERE id = $1", [kept.id]);
    let second = [];
    for (let i = 0; i < 80 && second.length < 2; i++) { await sleep(150); second = await reportsOf(); }
    const after = await settled("sam", kept.id);
    const [clocked] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$report-prompt' AND action = 'prompt:generated' ORDER BY seq DESC LIMIT 1");
    step("when its time has come the scheduler asks it as Sam, keeps another report, and sets its next run", second.length === 2 && after && !after.last_error && after.last_report === second[1].id && new Date(after.next_at) > new Date() && clocked?.after.by === "clock", { reports: second.length, after, clocked });

    // ---- 4b. made sure of ----
    const waitReports = async (n) => { let r = []; for (let i = 0; i < 100 && r.length < n; i++) { await sleep(150); r = await reportsOf(); } return r; };
    await db.query("UPDATE mes.report_prompts SET next_at = date_trunc('day', now()) - interval '3 days' + interval '6 hours', tries = 0, due_at = NULL WHERE id = $1", [kept.id]);
    const third = await waitReports(3);
    const late = await settled("sam", kept.id);
    const [lateRow] = await db.query("SELECT data->>'description' AS description FROM mes.records WHERE id = $1", [late?.last_report]);
    step("the server down across several of its times: one run, late, saying when it was due and how many runs were not made (in the prompt and in its report)",
        third.length === 3 && late && !late.last_error && /^Due at \d{4}-\d{2}-\d{2} \d{2}:\d{2}, made at .+: the server was not running then, and [1-9] later runs? (was|were) not made\.$/.test(late.last_note ?? "")
        && (lateRow?.description ?? "").includes("the server was not running then") && new Date(late.next_at) > new Date(), { late, description: lateRow?.description });
    // A run this server had started when it stopped (begun before it started again): made again, as its due time's.
    await db.query("UPDATE mes.report_prompts SET running = true, started_at = now() - interval '2 minutes', due_at = now() - interval '2 minutes', run_by = 'local', tries = 0 WHERE id = $1", [kept.id]);
    const fourth = await waitReports(4);
    const remade = await settled("sam", kept.id);
    step("a run cut off by a stop is made again at the next start, and says nothing went wrong", fourth.length === 4 && remade && !remade.last_error && remade.tries === 0, remade);
    // The AI away: tried again in five minutes; then (its time come) it succeeds.
    failNext = 1;
    await db.query("UPDATE mes.report_prompts SET next_at = now() - interval '1 minute', tries = 0, due_at = NULL WHERE id = $1", [kept.id]);
    let failed = null;
    for (let i = 0; i < 100 && !failed?.last_error; i++) { await sleep(150); failed = (await call("sam", "prompts.list", {})).find((x) => x.id === kept.id); }
    const retryIn = (new Date(failed?.next_at) - Date.now()) / 60_000;
    step("a run that fails because the AI is away is tried again in five minutes, and says so", failed && failed.tries === 1 && /could not be reached.*It is tried again at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./.test(failed.last_error ?? "") && retryIn > 4 && retryIn < 5.5, { failed, retryIn });
    await db.query("UPDATE mes.report_prompts SET next_at = now() - interval '1 second' WHERE id = $1", [kept.id]);
    const fifth = await waitReports(5);
    const retried = await settled("sam", kept.id);
    step("tried again, it succeeds: its tries start over", fifth.length === 5 && retried && !retried.last_error && retried.tries === 0, retried);

    // ---- 5. nothing drawn ----
    const none = await call("sam", "prompts.save", { title: `Nothing ${tag}`, prompt: "Draw nothing, please." });
    await call("sam", "prompts.run", { id: none.id });
    const empty = await settled("sam", none.id);
    step("a run that draws no report says why, and keeps nothing", empty && /without drawing a report/.test(empty.last_error ?? "") && !empty.last_report && (await reportsOf()).length === 5, empty);

    // ---- 6. reports picked for the copilot ----
    const ids = second.map((r) => r.id);
    const tooMany = await call("sam", "analyst.send", { text: "Summarize.", reports: Array.from({ length: 13 }, () => ids[0]) });
    const notShared = await call("dana", "analyst.send", { text: "Summarize.", reports: [ids[0]] });
    const sent = await call("sam", "analyst.send", { text: "Summarize these two: what changed?", reports: ids });
    let talk = sent;
    for (let i = 0; i < 80 && talk.running; i++) { await sleep(100); talk = await call("sam", "analyst.get", {}); }
    const handed = asked.at(-1) ?? "";
    step("the copilot is handed the picked reports, each as Sam may read it now, with what he asks; too many, or one he may not read, is refused",
        tooMany.status >= 400 && notShared.status === 404 && !talk.running && talk.report?.blocks?.length === 2 && talk.transcript.some((m) => m.role === "note" && /With 2 kept report\(s\)/.test(m.text))
        && /picked these 2 kept report\(s\)/.test(handed) && handed.includes(second[0].data.title) && /"rows":\[\[/.test(handed) && /Asked: /.test(handed),
        { tooMany, notShared, transcript: talk.transcript, handed: handed.slice(0, 600) });

    // ---- 8. tags (§34.8) ----
    const long = await call("sam", "reports.tag", { id: ids[0], tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(","), key: `pr-${randomBytes(6).toString("hex")}` });
    const tagged = await call("sam", "reports.tag", { id: ids[0], tags: "Weekly , daily,weekly", key: `pr-${randomBytes(6).toString("hex")}` });
    const notHis = await call("dana", "reports.tag", { id: ids[0], tags: "mine", key: `pr-${randomBytes(6).toString("hex")}` });
    const listed = await call("sam", "records.list", { object: "report", as: "sam" });
    const byId = Object.fromEntries((listed.rows ?? []).map((r) => [r.id, r]));
    step("a report is filed under tags by its author, kept tidy; the reports a prompt generates carry the prompt's; another's report is not theirs to tag",
        scheduled.tags === "daily, floor" && second.every((r) => r.data.tags === "daily, floor") && long.status >= 400 && /At most 10 tags/.test(long.error ?? "") && tagged.tags === "weekly, daily" && notHis.status === 404
        && byId[ids[0]]?.tags === "weekly, daily" && byId[ids[1]]?.tags === "daily, floor",
        { scheduled: scheduled.tags, generated: second.map((r) => r.data.tags), long, tagged, notHis, listed: [byId[ids[0]]?.tags, byId[ids[1]]?.tags] });

    // ---- 7. removed ----
    const gone = await call("sam", "prompts.remove", { id: kept.id });
    const left = await call("sam", "prompts.list", {});
    step("removed, the prompt is gone and the reports it generated stay", gone.ok && !left.some((p) => p.id === kept.id) && (await reportsOf()).length === 5, { gone, left: left.map((p) => p.title) });
    await call("sam", "prompts.remove", { id: none.id });
    await call("sam", "analyst.reset", {});

    // ---- 9. an installation from before tags ----
    // Its Report has no tags field, and a field of the plant's own: at the next start the platform
    // adds what is missing, as a new version, and keeps the rest.
    await app.close?.();
    app = null;
    const { ensureBuiltIns } = await import("../db/migrate.mjs");
    const liveReport = async () => (await db.query("SELECT version, body FROM mes.definitions WHERE object = 'report' AND status = 'published'"))[0];
    const now = await liveReport();
    const older = JSON.parse(JSON.stringify(now.body));
    delete older.fields.tags;
    older.fields.site = { label: "Site", type: "string" };
    older.form.sections[0].fields = older.form.sections[0].fields.filter((f) => f !== "tags");
    older.list.columns = older.list.columns.filter((c) => c !== "tags");
    const publish = (body, version) => db.transaction(async (tx) => {
        await tx.query("UPDATE mes.definitions SET status = 'superseded' WHERE object = 'report' AND status = 'published'");
        await tx.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ('report', $1, 'published', $2)", [version, JSON.stringify(body)]);
    });
    await publish(older, now.version + 1);
    const grown = await db.transaction((tx) => ensureBuiltIns(tx));
    const after9 = await liveReport();
    const again = await db.transaction((tx) => ensureBuiltIns(tx));
    const [grew] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = 'report' AND action = 'publish:built-in' ORDER BY seq DESC LIMIT 1");
    step("an installation from before tags is given the field at its next start, as a new version by the platform, with what the plant made of the object kept; once",
        grown.some((d) => d.name === "built-in:report" && d.action === "applied" && /tags/.test(d.note ?? "")) && after9.version === now.version + 2 && after9.body.fields.tags?.type === "string" && after9.body.fields.site?.label === "Site"
        && after9.body.form.sections[0].fields.includes("tags") && !again.some((d) => d.name === "built-in:report" && d.action === "applied") && grew?.actor === "platform" && grew.after.added?.join() === "tags",
        { grown, version: [now.version, after9.version], fields: Object.keys(after9.body.fields), again, grew });
    // (Left as it was: without the plant's field of this test.)
    await publish(now.body, after9.version + 1);
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app?.close?.().catch(() => {});
    await pool.end();
}

for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
