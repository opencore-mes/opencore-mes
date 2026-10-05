// The same report each run (DESIGN.md §34.11), end to end against a running server, with a scripted model:
//   1. Sam's kept prompt draws a report through the copilot; he pins the prompt to it. A report he may not
//      read is not his to pin; words written fresh need a pinned report.
//   2. Pinned, words as written: generated with no AI at all (none configured), the report kept has the
//      pinned report's blocks exactly, its queries run again as Sam (today's answer), titled with the
//      moment; the pin is in the trail. An unpinned prompt still needs the AI.
//   3. By the clock: the same, with no AI asked.
//   4. Words written fresh: the copilot is asked once, only for the words (no query, no drawing), handed
//      what each block answers now; the blocks stay, the words are new; the trail says so. One that does
//      not write them keeps nothing, and says why.
//   5. A block whose query fails now is kept in its place, and the run says which.
//   6. Unpinned: the copilot is asked again.
//   7. A layout made from a report: a designer starts a change holding it (the report's kinds, order,
//      widths, titles and chart kinds, in words, no query), never over a live layout or another draft;
//      only a layout starts from a body; it passes the design check, is approved like any design, and
//      is offered to whoever asks for a report.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/report-pinned.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { layoutOfReport, layoutName } from "../client/report.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => `pn-${randomBytes(6).toString("hex")}`;
// The same, whatever order its keys were stored in (a jsonb column keeps its own).
const same = (a, b) => { const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)); return canon(a) === canon(b); };
let app = null;

// The model: asked for a report, draws one (text, a figure, a chart, a table); asked for words only
// (write_words), writes each block it is asked for from the figure's answer it was handed. `mute`: it
// answers in words and writes nothing.
const calls = [];
const scripted = {
    name: "scripted", model: "scripted-model", available: true, mute: false,
    async complete({ messages, tools }) {
        const names = (tools ?? []).map((t) => t.name);
        calls.push(names);
        if (names.includes("write_words")) {
            if (scripted.mute) return { stop: "end", content: [{ type: "text", text: "I would rather not." }] };
            const text = messages[0].content[0].text;
            const digest = JSON.parse(text.slice(text.indexOf("answer now:\n") + 12));
            const wanted = text.match(/Write the words of block\(s\) ([0-9, ]+)\./)[1].split(",").map((n) => Number(n.trim()));
            const figure = digest.find((b) => b.kind === "figure");
            return { stop: "tools", content: [{ type: "tool_use", id: `w${calls.length}`, name: "write_words", input: { words: wanted.map((block) => ({ block, text: `Fresh: ${figure?.rows?.[0]?.[0]} lots now.` })) } }] };
        }
        const last = messages[messages.length - 1];
        if (last.content?.some?.((b) => b.type === "tool_result")) return { stop: "end", content: [{ type: "text", text: "Drawn." }] };
        return { stop: "tools", content: [{ type: "tool_use", id: `r${calls.length}`, name: "render_report", input: { title: `Morning ${tag}`, description: "The lots this morning.", blocks: [
            { block: "text", title: "Situation", text: "There are 12 lots this morning." },
            { block: "figure", title: "Lots", query: { sql: "SELECT count(*) AS lots FROM lot" }, value: "lots", unit: "lots" },
            { block: "chart", title: "By state", chart: "bar", query: { sql: "SELECT state, count(*) AS lots FROM lot GROUP BY state ORDER BY state" }, x: "state", y: ["lots"] },
            { block: "table", title: "The lots", query: { sql: "SELECT lot_no, state FROM lot ORDER BY lot_no" }, columns: ["lot_no", "state"] },
        ] } }] };
    },
};
const people = ["olga", "sam", "quinn", "dana", "eli", "vera", "ivan", "ines", "iris"];

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 100, ai: scripted, plantTz: "UTC" });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of people) {
        sessions[user] = `pn-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const settled = async (id) => { for (let i = 0; i < 100; i++) { const p = (await call("sam", "prompts.list", {})).find((x) => x.id === id); if (p && !p.running) return p; await sleep(100); } return null; };
    const specOf = async (id) => JSON.parse((await db.query("SELECT data->>'spec' AS spec FROM mes.records WHERE id = $1", [id]))[0]?.spec ?? "null");
    const [{ lots }] = await db.query("SELECT count(*)::int AS lots FROM mes.records WHERE object = 'lot' AND archived_at IS NULL");
    await db.query("DELETE FROM mes.analyst_conversations WHERE owner = 'sam'");

    // ---- 1. drawn by the copilot, then pinned ----
    const kept = await call("sam", "prompts.save", { title: `Morning ${tag}`, prompt: "How are the lots this morning?", tags: "daily" });
    await call("sam", "prompts.run", { id: kept.id });
    const first = await settled(kept.id);
    const firstSpec = await specOf(first?.last_report);
    const other = await call("sam", "prompts.save", { title: `Other ${tag}`, prompt: "Anything." });
    const freshUnpinned = await call("sam", "prompts.fix", { id: other.id, words: "fresh" });
    // Dana's own report, not shared: not Sam's to read, nor to pin.
    const danas = (await db.query("INSERT INTO mes.records (object, def_version, state, data, created_by, updated_by) SELECT 'report', version, 'kept', $1, 'dana', 'dana' FROM mes.definitions WHERE object = 'report' ORDER BY version DESC LIMIT 1 RETURNING id", [JSON.stringify({ title: `Dana's ${tag}`, owner: "dana", shared: false, spec: firstSpec ? JSON.stringify(firstSpec) : "{}" })]))[0];
    const notHis = await call("sam", "prompts.fix", { id: kept.id, report: danas?.id });
    const pinned = await call("sam", "prompts.fix", { id: kept.id, report: first?.last_report });
    const [pinAudit] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$report-prompt' AND action = 'prompt:pinned' ORDER BY seq DESC LIMIT 1");
    step("a kept prompt's report, drawn by the copilot, pins the prompt; a report he may not read is not his to pin; words written fresh need a pinned report; the pin is in the trail",
        first?.last_report && firstSpec?.blocks?.length === 4 && pinned.fixed?.from === first.last_report && pinned.fixed.blocks === 4 && pinned.words === "kept"
        && notHis.status === 404 && freshUnpinned.status >= 400 && freshUnpinned.fields?.words && pinAudit?.after.report === first.last_report,
        { first, pinned, notHis, freshUnpinned, pinAudit });

    // ---- 2. pinned, words as written: no AI ----
    scripted.available = false;
    const before = calls.length;
    const run = await call("sam", "prompts.run", { id: kept.id });
    const again = await settled(kept.id);
    const againSpec = await specOf(again?.last_report);
    const opened = await call("sam", "reports.run", { id: again?.last_report });
    const unpinnedNoAi = await call("sam", "prompts.run", { id: other.id });
    const [{ title: againTitle }] = again?.last_report ? await db.query("SELECT data->>'title' AS title FROM mes.records WHERE id = $1", [again.last_report]) : [{}];
    step("pinned with its words as written, it is generated with no AI configured and none asked: the report kept has the pinned blocks exactly, its queries run again as Sam (today's count), titled with the moment; an unpinned prompt still needs the AI",
        !run.error && again && !again.last_error && again.last_report !== first.last_report && calls.length === before && same(againSpec.blocks, firstSpec.blocks)
        && opened.blocks?.[1]?.data?.rows?.[0]?.[0] === lots && new RegExp(`^Morning ${tag} · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`).test(againTitle) && unpinnedNoAi.status === 503,
        { run, again, calls: calls.length - before, figure: opened.blocks?.[1], againTitle, unpinnedNoAi });

    // ---- 3. by the clock ----
    await call("sam", "prompts.save", { id: kept.id, title: kept.title, prompt: kept.prompt, tags: "daily", schedule: { every: { hours: 1 } } });
    await db.query("UPDATE mes.report_prompts SET next_at = now() - interval '1 minute' WHERE id = $1", [kept.id]);
    let byClock = null;
    for (let i = 0; i < 60 && !byClock; i++) { await sleep(100); const p = (await call("sam", "prompts.list", {})).find((x) => x.id === kept.id); if (p && !p.running && p.last_report !== again.last_report) byClock = p; }
    const clockSpec = await specOf(byClock?.last_report);
    step("by the clock, pinned, it keeps another report of the same blocks, with no AI asked, and sets its next run",
        byClock?.last_report && !byClock.last_error && same(clockSpec?.blocks, firstSpec.blocks) && calls.length === before && new Date(byClock.next_at) > new Date(),
        { byClock });
    await call("sam", "prompts.save", { id: kept.id, title: kept.title, prompt: kept.prompt, tags: "daily", schedule: null });

    // ---- 4. words written fresh ----
    scripted.available = true;
    const fresh = await call("sam", "prompts.fix", { id: kept.id, words: "fresh" });
    const before4 = calls.length;
    await call("sam", "prompts.run", { id: kept.id });
    const freshRun = await settled(kept.id);
    const freshSpec = await specOf(freshRun?.last_report);
    const [wordsAudit] = await db.query("SELECT actor, after FROM mes.audit_log WHERE object = '$query' AND action = 'ai-report-words' ORDER BY seq DESC LIMIT 1");
    step("its words written fresh: the copilot is asked once, only to write words (no query, no drawing), from what the blocks answer now; the blocks stay, the words are new; the trail says so",
        fresh.words === "fresh" && freshRun && !freshRun.last_error && calls.length === before4 + 1 && calls.at(-1).join() === "write_words"
        && freshSpec.blocks[0].text === `Fresh: ${lots} lots now.` && freshSpec.blocks[0].title === "Situation" && same(freshSpec.blocks.slice(1), firstSpec.blocks.slice(1))
        && wordsAudit?.actor === "sam" && wordsAudit.after.blocks === 1,
        { fresh, freshRun, freshSpec: freshSpec?.blocks?.[0], calls: calls.slice(before4), wordsAudit });
    scripted.mute = true;
    await call("sam", "prompts.run", { id: kept.id });
    const muted = await settled(kept.id);
    scripted.mute = false;
    step("a copilot that does not write the words keeps nothing, and the prompt says why",
        muted?.last_error && /did not write the report's words/.test(muted.last_error) && muted.last_report === freshRun.last_report, { muted });

    // ---- 5. a block that fails now ----
    const broken = await call("sam", "reports.keep", { report: { title: `Broken ${tag}`, blocks: [{ block: "text", text: "Hello." }, { block: "figure", title: "Gone", query: { sql: "SELECT no_such_column AS n FROM lot" }, value: "n" }] }, key: key() });
    await call("sam", "prompts.fix", { id: kept.id, report: broken.id, words: "kept" });
    await call("sam", "prompts.run", { id: kept.id });
    const half = await settled(kept.id);
    step("a block whose query fails now is kept in its place, and the run says which block and why",
        half?.last_report && half.last_report !== freshRun.last_report && /Kept, but 1 of 2 block\(s\) could not be read: block 2 \(Gone\)/.test(half.last_error ?? ""), { half });

    // ---- 6. unpinned ----
    const unpinned = await call("sam", "prompts.fix", { id: kept.id, report: null });
    const before6 = calls.length;
    await call("sam", "prompts.run", { id: kept.id });
    const asked = await settled(kept.id);
    step("unpinned, the copilot is asked again to draw the report", unpinned.fixed === null && asked?.last_report && calls.length > before6 && calls[before6].includes("render_report"), { unpinned, asked });

    // ---- 7. a layout made from a report ----
    const report = { ...firstSpec, title: `Morning ${tag}` };
    const { body } = layoutOfReport(report, { label: `Morning ${tag}` });
    const name = layoutName(report.title);
    const notDesigner = await call("sam", "design.start", { layout: name, label: body.label, draft: { ...body, name } });
    const started = await call("dana", "design.start", { layout: name, label: body.label, draft: { ...body, name } });
    const change = await call("dana", "design.change", { id: started.id, as: "dana" });
    const drafted = change.content?.layouts?.[name];
    const twice = await call("dana", "design.start", { layout: name, label: body.label, draft: { ...body, name } });
    const notLayout = await call("dana", "design.start", { screen: `s_${name}`, draft: { name: `s_${name}` } });
    const checkedChange = await call("dana", "design.check", { layouts: { [name]: drafted } });
    step("a designer makes a layout from the report: a new change holding it, the report's kinds, order, widths, titles and chart kinds, in words, no query, stewarded by her department; never over another draft; only a layout starts from a body; who does not design starts none; it passes the design check",
        started.id && !started.existing && drafted?.blocks?.map((b) => `${b.block}:${b.width}:${b.title ?? ""}:${b.chart ?? ""}`).join() === "text:full:Situation:,figure:quarter:Lots:,chart:half:By state:bar,table:full:The lots:"
        && !JSON.stringify(drafted).includes("SELECT") && drafted.stewards?.length === 1 && twice.code === "design.taken" && notLayout.status >= 400 && notDesigner.status === 403 && (checkedChange.problems ?? []).length === 0,
        { started, drafted, twice, notLayout, notDesigner, checkedChange });

    await call("dana", "design.save", { id: started.id, reason: "The morning report, as a layout." });
    await call("dana", "design.submit", { id: started.id });
    await call("iris", "design.review", { id: started.id, decision: "pass" });
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id: started.id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id: started.id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
    }
    const offered = await call("sam", "reports.layouts", { as: "sam" });
    const liveTaken = await call("dana", "design.start", { layout: name, label: body.label, draft: { ...body, name } });
    step("approved like any design, it is offered to whoever asks for a report; a live layout is never started over from a body",
        state === "executed" && offered.some?.((l) => l.name === name && l.blocks.length === 4) && liveTaken.code === "design.taken", { state, offered: offered.map?.((l) => l.name), liveTaken });
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
