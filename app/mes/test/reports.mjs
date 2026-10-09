// Reports and the analytics copilot (§34), end to end against a running server, with a scripted model:
//   1. Report is a built-in object: those who query are its authors; Production and Quality read.
//   2. Sam asks the copilot. It reads the schema (no rows), runs a query as Sam, tries to write (refused:
//      the views cannot be written to), draws a report with a block that fails, is told which, and
//      draws it again. What it was handed is a few rows; each query it ran is in the audit trail, as
//      Sam, marked as the copilot's.
//   3. The report it drew is run for Sam: words, a figure, a chart, a table, each from its own query.
//   4. Sam keeps it (a record of Report, his), then shares it. Quinn, who reads reports, opens it: its
//      queries run as her, so the block on machines, which she has no role on, shows her nothing.
//   5. Who may not: someone who does not query cannot ask the copilot, run a report that is not kept,
//      or keep one; another analyst cannot change or share Sam's; a report cannot be given away.
//   6. A report's mistakes are named; past the hourly ceiling a message is refused.
//   7. A report layout (§34.5) is a design element: Dana drafts one, its mistakes are named, it is
//      reviewed, approved by its steward and published. Sam picks it: the copilot is told it, a
//      report that departs from it is handed back, and one that follows it is drawn as wide as the
//      layout says, under the layout's titles. Kept, it stays so drawn.
//   8. An AI assisted line (§34.6): a block about a set of records the designer picked (two machines)
//      and a goal. Its mistakes are named; the layout is changed through a second change; the copilot
//      is told which records and the goal; the block is drawn with its advice and the rows to act
//      on, about the layout's records whatever the copilot claimed; the report kept before stays as
//      it was.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/reports.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { reportProblems, blockView, scaleOf, validateReportLayout, layoutDepartures } from "../client/report.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
let app = null;

// The model, scripted: what it asks for at each turn, and what it was handed back.
const handed = [];
const REPORT = (fixed) => ({
    title: `Floor ${tag}`, description: "Lots and machines, now.",
    blocks: [
        { block: "text", title: "Situation", text: "Most lots are waiting to start." },
        { block: "figure", title: "Lots in use", query: { sql: "SELECT count(*) AS lots FROM lot" }, value: "lots", unit: "lots" },
        { block: "chart", title: "Lots by state", chart: "bar", query: { json: { from: "lot", select: ["state", { count: "*", as: "lots" }], groupBy: ["state"] } }, x: "state", y: ["lots"] },
        { block: "table", title: "Machines", query: { sql: fixed ? "SELECT machine_id, name, state FROM machine ORDER BY machine_id" : "SELECT machine_id, colour FROM machine" }, ...(fixed ? { columns: ["machine_id", "state"] } : {}) },
    ],
});
// On a layout: a figure, a line chart, a table. First the report above (which departs from it), then one that follows.
const systems = [];
const LAID = {
    title: `Shift ${tag}`,
    blocks: [
        { block: "figure", title: "Mine", query: { sql: "SELECT count(*) AS lots FROM lot" }, value: "lots", width: "full" },
        { block: "chart", title: "Lots by state", chart: "line", query: { sql: "SELECT state, count(*) AS lots FROM lot GROUP BY state ORDER BY state" }, x: "state", y: ["lots"] },
        { block: "table", title: "Machines", query: { sql: "SELECT machine_id, state FROM machine ORDER BY machine_id" } },
    ],
};
const scripted = {
    name: "scripted", model: "scripted-model", available: true,
    async complete({ system, messages, tools }) {
        const n = messages.filter((m) => m.role === "assistant").length;
        const last = messages[messages.length - 1];
        if (/The whole report is about one line/.test(system)) {
            systems.push(system);
            if (!last.content?.some?.((b) => b.type === "tool_result")) return { stop: "tools", content: [{ type: "tool_use", id: "w1", name: "render_report", input: { title: `Wirebond ${tag}`, scope: { object: "lot", values: ["forged"] }, blocks: [{ block: "text", text: "Process the lot on M-101 first." }, { block: "table", title: "To process", query: { sql: "SELECT lot_no, state FROM lot ORDER BY lot_no" } }] } }] };
            return { stop: "end", content: [{ type: "text", text: "Drawn for the line." }] };
        }
        if (/It is about these/.test(system)) {
            systems.push(system);
            if (!last.content?.some?.((b) => b.type === "tool_result")) return { stop: "tools", content: [{ type: "tool_use", id: "s1", name: "render_report", input: { title: `Line ${tag}`, blocks: [...LAID.blocks, { block: "assist", title: "Mine", text: "Start the lot waiting on M-101 first: it is due soonest.", query: { sql: "SELECT l.lot_no, l.state FROM lot l JOIN machine m ON m.id = l.machine WHERE m.machine_id IN ('M-101', 'M-102') ORDER BY l.lot_no" }, columns: ["lot_no", "state"], scope: { object: "lot", values: ["forged"] } }] } }] };
            return { stop: "end", content: [{ type: "text", text: "Drawn, with the line's advice." }] };
        }
        if (/picked the report layout/.test(system)) {
            systems.push(system);
            const tried = messages.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")).flatMap((m) => m.content);
            if (!tried.length) return { stop: "tools", content: [{ type: "tool_use", id: "l1", name: "render_report", input: REPORT(true) }] };
            if (tried.length === 1) { handed.push({ layout: true, text: tried[0].content, error: Boolean(tried[0].is_error) }); return { stop: "tools", content: [{ type: "tool_use", id: "l2", name: "render_report", input: LAID }] }; }
            return { stop: "end", content: [{ type: "text", text: "Drawn on the layout." }] };
        }
        if (n > 0) handed.push({ turn: n, tools: tools.map((t) => t.name), results: (last.content ?? []).filter((b) => b.type === "tool_result").map((b) => ({ error: Boolean(b.is_error), text: b.content })) });
        if (n === 0) return { stop: "tools", content: [{ type: "text", text: "Let me see what can be queried." }, { type: "tool_use", id: "a1", name: "get_schema", input: {} }] };
        if (n === 1) return { stop: "tools", content: [
            { type: "tool_use", id: "a2", name: "run_query", input: { query: { sql: "SELECT state, count(*) AS lots FROM lot GROUP BY state ORDER BY lots DESC" } } },
            { type: "tool_use", id: "a3", name: "run_query", input: { query: { sql: "SELECT lot_no FROM lot" } } },
            { type: "tool_use", id: "a4", name: "run_query", input: { query: { sql: "UPDATE lot SET state = 'released' RETURNING lot_no" } } },
            { type: "tool_use", id: "a5", name: "run_query", input: { query: { sql: "SELECT * FROM mes.users" } } },
            { type: "tool_use", id: "a6", name: "save_report", input: {} },
        ] };
        if (n === 2) return { stop: "tools", content: [{ type: "tool_use", id: "a7", name: "render_report", input: REPORT(false) }] };
        if (n === 3) return { stop: "tools", content: [{ type: "tool_use", id: "a8", name: "render_report", input: REPORT(true) }] };
        return { stop: "end", content: [{ type: "text", text: "Drawn: lots by state and the machines. Keep it if it is what you want." }] };
    },
};

try {
    app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0, ai: scripted });
    const { url: mes } = await app.listen({ port: 0 });
    const sessions = {};
    for (const user of ["sam", "quinn", "olga", "dana", "vera", "ivan", "eli"]) {
        sessions[user] = `rp-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
    }
    await db.query("DELETE FROM mes.analyst_conversations WHERE owner IN ('sam', 'quinn', 'dana')");
    const call = async (user, name, args) => {
        const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args ?? {}]) });
        const body = await res.json();
        return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields };
    };
    const key = () => `rp-${randomBytes(8).toString("hex")}`;
    const finished = async (user) => { for (let i = 0; i < 200; i++) { const v = await call(user, "analyst.get"); if (!v.running) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error("the copilot never finished"); };

    // ---- 1. the object ----
    const [live] = await db.query("SELECT body FROM mes.definitions WHERE object = 'report' AND status = 'published'");
    const authors = (await db.query("SELECT subject_id FROM mes.assignments WHERE object = 'report' AND role = 'author'")).map((r) => r.subject_id);
    const analysts = (await db.query("SELECT subject_id FROM mes.assignments WHERE object = 'query' AND role = 'analyst'")).map((r) => r.subject_id);
    step("Report is the platform's object; everyone who may query is one of its authors", live?.body.builtIn === true && analysts.length > 0 && analysts.every((a) => authors.includes(a)), { authors, analysts });

    // ---- 2. the copilot ----
    const status = await call("sam", "analyst.status");
    const asked = await call("sam", "analyst.send", { text: "What is the situation on the floor?" });
    const v = await finished("sam");
    const toolsRun = v.transcript.filter((m) => m.role === "tool").map((t) => `${t.name}:${t.ok}`);
    step("it reads the schema, queries, and draws; a write, a table that is not a view, and a tool it has not are each refused, and it carries on",
        status.configured && asked.running !== undefined && toolsRun.join(" ") === "get_schema:true run_query:true run_query:true run_query:false run_query:false save_report:false render_report:true render_report:true" && v.transcript.at(-1).role === "assistant" && !v.error,
        { toolsRun, last: v.transcript.at(-1), error: v.error });
    const schemaHanded = handed.find((h) => h.turn === 1)?.results[0]?.text ?? "";
    const rowsHanded = JSON.parse(handed.find((h) => h.turn === 2)?.results[1]?.text ?? "{}");
    const refusals = handed.find((h) => h.turn === 2)?.results.slice(2).map((r) => r.text) ?? [];
    step("what it is handed: the views and columns Sam may read and no row; of a query's answer, a few rows; why each refusal",
        /"name":"lot"/.test(schemaHanded) && /"name":"machine"/.test(schemaHanded) && !/SC-|LOT-|PP-BLK/.test(schemaHanded) && Array.isArray(rowsHanded.rows) && rowsHanded.rows.length <= 40 && rowsHanded.rowCount >= rowsHanded.rows.length
        && refusals.length === 3 && refusals.every((t) => /message/.test(t)) && /no tool save_report/.test(refusals[2]),
        { schema: schemaHanded.slice(0, 200), rows: rowsHanded.rowCount, refusals });
    const firstDraw = JSON.parse(handed.find((h) => h.turn === 3)?.results[0]?.text ?? "{}");
    step("a report with a block that fails is drawn all the same, and it is told which block and why, to fix it", firstDraw.drawn === true && firstDraw.blocks?.[3]?.ok === false && /colour/.test(firstDraw.blocks[3].error) && firstDraw.blocks.slice(0, 3).every((b) => b.ok), firstDraw);
    const trail = await db.query("SELECT actor, action, after FROM mes.audit_log WHERE object = '$query' AND actor = 'sam' ORDER BY seq DESC LIMIT 6");
    step("each query it ran, and each report it drew, is in the trail as Sam, marked as the copilot's",
        trail.filter((t) => t.action === "ai-query").length === 2 && trail.filter((t) => t.action === "ai-report").length === 2 && trail.every((t) => t.after?.via?.token === "analytics copilot" && t.after.via.agent === "scripted-model") && trail.some((t) => /GROUP BY state/.test(t.after.sql ?? "")),
        trail.map((t) => [t.action, t.after?.via, t.after?.sql?.slice(0, 40)]));
    const [untouched] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'lot' AND state = 'released'");
    step("nothing was written: the lots are as they were", untouched.n === 0 || untouched.n < 3, untouched);

    // ---- 3. the report, run ----
    const run = await call("sam", "reports.run", { report: v.report });
    const views = run.blocks?.map((b) => (b.block === "text" ? null : blockView(b, b.data)));
    step("the report it drew, run for Sam: words, a figure, a chart and a table, each from its own query",
        v.report?.title === `Floor ${tag}` && run.blocks?.length === 4 && run.blocks[0].text && typeof views[1].value === "number" && views[1].value > 0 && views[2].data.rows.length >= 1 && views[2].data.rows.every((r) => Number.isFinite(Number(r[views[2].data.columns.indexOf(run.blocks[2].y[0])])))
        && views[3].columns.join() === "machine_id,state" && views[3].rows.length >= 1 && run.blocks.every((b) => !b.error),
        { blocks: run.blocks?.map((b) => b.error ?? b.block), views });

    // ---- 4. kept, shared, opened by someone else ----
    const kept = await call("sam", "reports.keep", { report: v.report, shared: false, key: key() });
    const [record] = await db.query("SELECT data, created_by FROM mes.records WHERE id = $1", [kept.id]);
    const before = await call("quinn", "reports.run", { id: kept.id });
    const confirmShare = await call("sam", "reports.share", { id: kept.id, shared: true, key: key() });
    const hers = await call("quinn", "reports.run", { id: kept.id });
    const his = await call("sam", "reports.run", { id: kept.id });
    const listed = await call("quinn", "records.list", { object: "report", as: "quinn" });
    const ivans = await call("ivan", "reports.run", { id: kept.id });
    step("kept: a record of Report, Sam's; until he shares it nobody else opens it", kept.id && record?.data.owner === "sam" && record.created_by === "sam" && record.data.shared === false && JSON.parse(record.data.spec).blocks.length === 4 && before.status === 404, { kept, record: record?.data && { owner: record.data.owner, shared: record.data.shared }, before });
    const [hisMachines, herMachines] = [his.blocks?.[3], hers.blocks?.[3]];
    // Ivan (IT) queries and so reads reports, but holds no role on lots or machines.
    const none = (b) => Boolean(b?.error) || b?.data.rows.length === 0 || b?.data.rows[0][0] === 0;
    step("shared: Quinn finds it and opens it. Its queries run as whoever opens it: for Ivan, who has no role on lots or machines, the same report holds no lot and no machine; for Sam it holds them",
        confirmShare.shared === true && listed.rows?.some((r) => r.id === kept.id) && hers.mine === false && hers.owner === "sam" && hers.blocks?.[1].data.rows[0][0] >= 1 && herMachines && hisMachines.data.rows.length >= 1 && his.blocks[1].data.rows[0][0] >= 1
        && ivans.blocks?.length === 4 && none(ivans.blocks[1]) && none(ivans.blocks[2]) && none(ivans.blocks[3]),
        { share: confirmShare, listed: listed.rows?.length ?? listed, hers: hers.blocks?.map((b) => b.error ?? b.data?.rows ?? "text"), ivans: ivans.blocks?.map((b) => b.error ?? b.data?.rows ?? "text") ?? ivans, his: his.blocks?.map((b) => b.error ?? b.data?.rows.length ?? "text") });
    const pageOf = async (who, path) => { const res = await fetch(`${mes}${path}`, { headers: { cookie: `mes_session=${sessions[who]}` } }); return { status: res.status, html: await res.text() }; };
    const [home, page] = [await pageOf("quinn", "/reports"), await pageOf("quinn", `/r/${kept.id}`)];
    step("the AI Report page and a report's own page are served", home.status === 200 && page.status === 200 && home.html.includes("AI Report"), { home: home.status, page: page.status });

    // ---- 5. who may not ----
    const olga = { ask: await call("olga", "analyst.send", { text: "Anything?" }), adhoc: await call("olga", "reports.run", { report: v.report }), keep: await call("olga", "reports.keep", { report: v.report, key: key() }), opens: await call("olga", "reports.run", { id: kept.id }) };
    step("someone who does not query cannot ask the copilot, run a report that is not kept, or keep one; a shared one she reads is drawn for her", olga.ask.status === 403 && olga.adhoc.status === 403 && olga.keep.status === 403 && olga.opens.blocks?.length === 4, { ask: olga.ask.status, adhoc: olga.adhoc.status, keep: olga.keep.status, opens: olga.opens.status ?? "ok" });
    const vera = await call("vera", "reports.run", { id: kept.id });
    const theirs = { change: await call("quinn", "reports.keep", { id: kept.id, report: { ...v.report, title: "Mine now" }, key: key() }), share: await call("quinn", "reports.share", { id: kept.id, shared: false, key: key() }) };
    const row = await call("sam", "records.get", { object: "report", id: kept.id, as: "sam" });
    const given = await call("sam", "records.update", { object: "report", id: kept.id, rowVersion: row.row_version, data: { owner: "quinn" }, key: key() });
    const forged = await call("quinn", "records.create", { object: "report", data: { title: "Forged", owner: "sam", shared: true, spec: JSON.stringify({ blocks: v.report.blocks }) }, key: key() });
    step("another analyst cannot change or stop sharing Sam's report; it cannot be given away, or made in someone else's name",
        theirs.change.status >= 400 && theirs.share.status >= 400 && given.status >= 400 && /stays its author's/.test(JSON.stringify(given)) && forged.status >= 400,
        { theirs, given, forged });
    step("an analyst with no role on reports' readers still opens a shared one as an author; a report not shared is nobody else's", vera.blocks?.length === 4, vera.status ?? "ok");

    // ---- 6. mistakes named; the ceiling ----
    const wrong = reportProblems({ title: " ", blocks: [{ block: "chart", chart: "spline", query: { sql: "SELECT 1" }, x: "a", y: [] }, { block: "chart", chart: "bar", query: { sql: "SELECT 1" }, x: "a", y: [] }, { block: "pie" }, { block: "figure", query: { sql: "SELECT 1", json: { from: "lot" } }, value: "1x" }, { block: "text", text: "" }] }).map((p) => p.message).join("\n");
    step("a report's mistakes are named", /Give the report a title/.test(wrong) && /a chart is one of bar, line, area/.test(wrong) && /y lists columns of its query/.test(wrong) && /a block is one of text, figure, chart, table/.test(wrong) && /SQL or JSON, not both/.test(wrong) && /value names the column/.test(wrong) && /its text is words/.test(wrong), wrong);
    const refusedRun = await call("sam", "reports.run", { report: { title: "x", blocks: [{ block: "pie" }] } });
    const scale = scaleOf([3, 47, 12]);
    step("…and refused before anything is run; a chart's scale is round steps that hold every value", refusedRun.status === 400 && refusedRun.code === "report.invalid" && scale.min === 0 && scale.max >= 47 && scale.ticks.length >= 3 && scale.ticks.length <= 7, { refusedRun, scale });
    await call("sam", "analyst.reset");
    const cleared = await call("sam", "analyst.get");
    step("a new conversation forgets the last one and what it drew; the kept report stays", cleared.transcript.length === 0 && cleared.report === null && (await call("sam", "reports.run", { id: kept.id })).blocks?.length === 4, cleared);

    // ---- 7. report layouts ----
    const LAYOUT = `shift_${tag}`;
    const seeded = await call("sam", "reports.layouts", { as: "sam" });
    const started = await call("dana", "design.start", { layout: LAYOUT, label: "Shift report" });
    const drafted = (await call("dana", "design.change", { id: started.id, as: "dana" })).content?.layouts?.[LAYOUT];
    step("a report layout is a design element: started in a change, from a template the checks pass; the seed's Daily report is offered to those who query",
        started.id && drafted?.name === LAYOUT && drafted.label === "Shift report" && validateReportLayout(drafted, { departments: ["production", "engineering", "quality", "it"] }).length === 0 && seeded.some?.((l) => l.name === "daily_report" && l.blocks.length === 8 && l.blocks[1].width === "quarter"),
        { started, drafted, seeded });
    const layout = { name: LAYOUT, label: "Shift report", description: "The shift, in three blocks.", guidance: "Cover this shift only.", stewards: ["production"], blocks: [
        { block: "figure", title: "Lots in use", width: "third", hint: "How many lots are in use." },
        { block: "chart", chart: "line", width: "full", hint: "Lots by state." },
        { block: "table", width: "half", hint: "The machines and their states." },
    ] };
    const bad = await call("dana", "design.check", { layouts: { [LAYOUT]: { ...layout, stewards: ["nobody"], colour: "red", blocks: [{ block: "figure", query: { sql: "SELECT 1" }, width: "huge" }, { block: "text", chart: "pie" }, { block: "gauge" }] } } });
    const badWords = (bad.problems ?? []).map((p) => p.message).join("\n");
    step("its mistakes are named as it is designed: a query (a layout holds none), a width there is not, a chart on a block that is not one, an unknown block, a department that is not one",
        /holds no query/.test(badWords) && /its width is one of quarter, third, half, full/.test(badWords) && /only a chart block names a chart/.test(badWords) && /a block is one of text, figure, chart, table/.test(badWords) && /"nobody" is not a department/.test(badWords) && /has no "colour"/.test(badWords), bad.problems ?? bad);
    const saved = await call("dana", "design.save", { id: started.id, reason: "The shift's report, laid out once for everyone.", layouts: { [LAYOUT]: layout } });
    const route = saved.error ? [saved.error] : ((await call("dana", "design.check", { layouts: { [LAYOUT]: layout } })).elements ?? []).map((e) => `${e.element}:${(e.stewards ?? []).join()}`);
    const notYet = await call("sam", "analyst.send", { text: "The shift, please.", layout: LAYOUT });
    await call("dana", "design.submit", { id: started.id });
    await call("eli", "design.review", { id: started.id, decision: "pass" });
    const live2 = await call("sam", "design.approve", { id: started.id, department: "production", decision: "approve", meaning: "Approved" });
    const [published] = await db.query("SELECT version, status, body FROM mes.layouts WHERE name = $1", [LAYOUT]);
    const offered = await call("sam", "reports.layouts", { as: "sam" });
    step("it answers to its stewards; until it is published nobody draws on it; reviewed and approved by Production, it is live and offered",
        route.join() === `layout:${LAYOUT}:production` && notYet.status === 409 && /not published/.test(notYet.error ?? "") && live2.state === "executed" && published?.version === 1 && published.status === "published" && published.body.blocks.length === 3 && offered.some?.((l) => l.name === LAYOUT && l.label === "Shift report" && l.blocks.map((b) => b.width).join() === "third,full,half"),
        { route, notYet, state: live2.state ?? live2, published, offered: offered.map?.((l) => l.name) ?? offered });
    const askedOn = await call("sam", "analyst.send", { text: "The shift, please.", layout: LAYOUT });
    const onLayout = await finished("sam");
    const refusal = handed.find((h) => h.layout);
    const told = systems[0] ?? "";
    step("Sam picks it: the copilot is told the layout (its guidance, each block and what belongs there), a report that departs from it is handed back saying how, and the one that follows is drawn",
        askedOn.layout === LAYOUT && /Shift report/.test(told) && /Cover this shift only/.test(told) && /1\. figure, titled "Lots in use", third width: How many lots are in use\./.test(told) && /2\. chart \(line\), full width/.test(told) && /3\. table, half width/.test(told)
        && refusal?.error === true && /does not follow the layout/.test(refusal.text) && /has 3 block\(s\)/.test(refusal.text) && onLayout.report?.blocks.length === 3 && onLayout.transcript.filter((m) => m.role === "tool").map((t) => t.ok).join() === "false,true" && layoutDepartures(onLayout.report, layout).length === 0,
        { told: told.slice(-700), refusal, report: onLayout.report, transcript: onLayout.transcript });
    const laid = onLayout.report ?? { blocks: [] };
    step("it is drawn as the layout says: each block as wide as its place whatever the copilot asked for, under the layout's title where it gives one, and it names its layout",
        laid.layout === LAYOUT && laid.blocks.map((b) => b.width).join() === "third,full,half" && laid.blocks[0].title === "Lots in use" && laid.blocks[1].title === "Lots by state" && laid.blocks[2].title === "Machines", laid);
    const keptLaid = await call("sam", "reports.keep", { report: laid, key: key() });
    const reopened = await call("sam", "reports.run", { id: keptLaid.id });
    const [laidTrail] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$query' AND actor = 'sam' AND action = 'ai-report' ORDER BY seq DESC LIMIT 1");
    const none2 = await call("sam", "analyst.send", { text: "And freely now.", layout: null });
    const free = await finished("sam");
    step("kept, it stays so drawn and says which layout it was drawn on (in the trail too); with no layout picked again, the copilot arranges the report itself",
        reopened.report?.layout === LAYOUT && reopened.blocks?.map((b) => b.width).join() === "third,full,half" && reopened.blocks.every((b) => !b.error) && laidTrail?.after?.layout === `${LAYOUT} v1` && none2.layout === null && free.layout === null && free.transcript.some((m) => m.role === "note" && /No layout from here on/.test(m.text)),
        { reopened: reopened.report ?? reopened, laidTrail, free: free.transcript?.slice(-3) });
    const designerPage = await pageOf("dana", `/design/view/layout/${LAYOUT}`);
    const tools = await call("dana", "design.view", { kind: "layout", name: LAYOUT, as: "dana" });
    step("the designer shows the live layout, read only", designerPage.status === 200 && tools?.content?.layouts?.[LAYOUT]?.label === "Shift report" && tools.view?.version === 1, { page: designerPage.status, view: tools?.view ?? tools });
    await call("sam", "analyst.reset");

    // ---- 8. an AI assisted line ----
    const assist = { block: "assist", title: "Line 1", width: "full", scope: { object: "machine", values: ["M-101", "M-102"] }, goal: "Meet the shift's output on every work order running on the line.", hint: "The lot and its state." };
    const wrongAssist = await call("dana", "design.check", { layouts: { [LAYOUT]: { ...layout, blocks: [{ block: "assist", scope: { object: "furnace", values: [] } }, { block: "assist", goal: "x", scope: { object: "machine", by: "colour", values: ["M-101", "M-101"] } }, { block: "table", scope: assist.scope, goal: "x" }] } } });
    const assistWordsOf = (wrongAssist.problems ?? []).map((p) => p.message).join("\n");
    step("an AI assisted line's mistakes are named: an object that is not one, no record picked, no goal, a field the object has not, a record named twice; only it names records",
        /"furnace" is not an object/.test(assistWordsOf) && /lists what the records are called, one to 50/.test(assistWordsOf) && /say what is to be achieved/.test(assistWordsOf) && /machine has no field "colour"/.test(assistWordsOf) && /a layout's block has no "scope"/.test(assistWordsOf), wrongAssist.problems ?? wrongAssist);
    const second = await call("dana", "design.start", { layout: LAYOUT });
    await call("dana", "design.save", { id: second.id, reason: "Line 1's advice on the shift report.", layouts: { [LAYOUT]: { ...layout, blocks: [...layout.blocks, assist] } } });
    await call("dana", "design.submit", { id: second.id });
    await call("eli", "design.review", { id: second.id, decision: "pass" });
    const live3 = await call("sam", "design.approve", { id: second.id, department: "production", decision: "approve", meaning: "Approved" });
    const offered2 = (await call("sam", "reports.layouts", { as: "sam" })).find?.((l) => l.name === LAYOUT);
    const uses = (await call("dana", "design.view", { kind: "layout", name: LAYOUT, as: "dana" }))?.view?.uses?.map((u) => u.object);
    step("changed through a second change, approved: version 2, offered with the line's records and goal; the designer shows the object it relies on",
        live3.state === "executed" && offered2?.version === 2 && offered2.blocks.length === 4 && offered2.blocks[3].scope?.values.join() === "M-101,M-102" && /shift's output/.test(offered2.blocks[3].goal) && uses?.join() === "machine", { state: live3.state ?? live3, offered2, uses });
    systems.length = 0;
    await call("sam", "analyst.send", { text: "The shift, with the line.", layout: LAYOUT });
    const lined = await finished("sam");
    const toldLine = systems[0] ?? "";
    const lineBlock = lined.report?.blocks?.[3];
    const lineRun = await call("sam", "reports.run", { report: lined.report });
    step("the copilot is told the line: which records, in which view and column, and the goal; the block is drawn with its advice and the rows to act on, about the layout's records whatever the copilot claimed",
        /4\. assist, titled "Line 1", full width: The lot and its state\./.test(toldLine) && /It is about these 2 record\(s\) of Machine \(view machine, where machine_id is one of: "M-101", "M-102"\)/.test(toldLine) && /The goal: Meet the shift's output/.test(toldLine)
        && lineBlock?.block === "assist" && lineBlock.title === "Line 1" && /Start the lot/.test(lineBlock.text) && lineBlock.scope?.object === "machine" && lineBlock.scope.values.join() === "M-101,M-102" && lineRun.blocks?.[3] && !lineRun.blocks[3].error && Array.isArray(lineRun.blocks[3].data.rows) && blockView(lineRun.blocks[3], lineRun.blocks[3].data).columns.join() === "lot_no,state",
        { told: toldLine.slice(-900), lineBlock, run: lineRun.blocks?.[3]?.error ?? lineRun.blocks?.[3]?.data?.rows ?? lineRun });
    // The navigator finds a layout by its label (§10.1): a live query, for those who may ask for a report.
    const navSam = await call("sam", "reports.layouts", { as: "sam" });
    const navOlga = await call("olga", "reports.layouts", { as: "olga" });
    const starred = await call("sam", "prefs.set", { favorites: [`layout:${LAYOUT}`] });
    const opened = await pageOf("sam", `/reports?layout=${LAYOUT}`);
    step("the navigator finds a layout by its label and it can be starred; it opens the AI Report page on it; someone who may not query is offered none",
        navSam.some?.((l) => l.name === LAYOUT && l.label === "Shift report") && Array.isArray(navOlga) && navOlga.length === 0 && !starred.error && opened.status === 200, { navSam: navSam.map?.((l) => l.name) ?? navSam, navOlga, starred, opened: opened.status });
    // A layout that is itself an AI assisted line: its designer picks the line's equipment and writes its
    // goal; a copy is another line, with other equipment.
    const LINE = `line_a_${tag}`;
    const lineLayout = { name: LINE, label: "Line A", stewards: ["production"], scope: { object: "machine", values: ["M-101"] }, goal: "Meet the shift's goal on line A.", blocks: [{ block: "text", width: "full" }, { block: "table", width: "full", title: "To process" }] };
    const lineChange = await call("dana", "design.start", { layout: LINE, label: "Line A" });
    const noGoal = await call("dana", "design.check", { layouts: { [LINE]: { ...lineLayout, goal: "" } } });
    await call("dana", "design.save", { id: lineChange.id, reason: "Line A's assisted report.", layouts: { [LINE]: lineLayout } });
    await call("dana", "design.submit", { id: lineChange.id });
    await call("eli", "design.review", { id: lineChange.id, decision: "pass" });
    const lineLive = await call("sam", "design.approve", { id: lineChange.id, department: "production", decision: "approve", meaning: "Approved" });
    const copyChange = await call("dana", "design.start", { layout: `line_b_${tag}`, label: "Line B", from: LINE });
    const copied = (await call("dana", "design.change", { id: copyChange.id, as: "dana" })).content?.layouts?.[`line_b_${tag}`];
    await call("sam", "analyst.reset");
    systems.length = 0;
    await call("sam", "analyst.send", { text: "What must line A process?", layout: LINE });
    const forLine = await finished("sam");
    const toldWhole = systems[0] ?? "";
    step("a layout may itself be an AI assisted line: its designer picks the line's equipment and writes its goal (a goal is required); a copy starts with the same, to be given another line's; the copilot is told the whole report is about them and the goal, and the report says which records it is about, the layout's whatever the copilot claimed",
        /Say what is to be achieved with the line's records/.test(JSON.stringify(noGoal.problems ?? noGoal)) && lineLive.state === "executed" && copied?.label === "Line B" && copied.scope?.values.join() === "M-101" && copied.goal === lineLayout.goal
        && /The whole report is about one line: these 1 record\(s\) of Machine \(view machine, where machine_id is one of: "M-101"\)/.test(toldWhole) && /The line's goal: Meet the shift's goal on line A\./.test(toldWhole)
        && forLine.report?.scope?.object === "machine" && forLine.report.scope.values.join() === "M-101" && forLine.report.layout === LINE && forLine.report.blocks.length === 2,
        { noGoal: noGoal.problems ?? noGoal, state: lineLive.state ?? lineLive, copied, told: toldWhole.slice(-600), report: forLine.report, transcript: forLine.transcript?.slice(-3) });
    const stillThree = await call("sam", "reports.run", { id: keptLaid.id });
    step("the report kept on the layout's first version is as it was", stillThree.blocks?.length === 3 && stillThree.blocks.map((b) => b.width).join() === "third,full,half", stillThree.blocks?.map((b) => b.block) ?? stillThree);
    await call("sam", "analyst.reset");

    let last = null;
    for (let i = 0; i < 31 && last?.status !== 429; i++) { last = await call("dana", "analyst.send", { text: `Ask ${i}` }); if (last.status !== 429) await finished("dana"); }
    step("past its hourly ceiling a message is refused (429)", last?.status === 429 && last.code === "rate.limited", last);
    await db.query("DELETE FROM mes.analyst_conversations WHERE owner IN ('sam', 'dana')");
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
