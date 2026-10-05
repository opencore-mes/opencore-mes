// Reports and the analytics copilot (DESIGN.md §34).
//
// A report is data (client/report.js): a title and blocks, each naming the query it draws. It holds no
// results. Opened, each block's query runs **as whoever opened it**, over the views of the Queries page
// (query.js: read-only, the viewer's policies compiled in, one statement, a timeout, a row limit), so a
// report shows nobody what their forms would not. A report is kept as a record of the built-in Report
// object (client/builtins.js), through the record services like any other write: its author's to
// change and to share, audited, archived rather than deleted.
//
// The analytics copilot puts reports together for an analyst, in words. It works **as that person**:
//   get_schema     the views and columns they may read (never a row)
//   run_query      one SELECT, run as them; the model is handed a few rows of the answer
//   render_report  a report, checked and drawn on the person's page; it is not kept until they keep it
// It reads and draws; it writes nothing (the views cannot be written to, and it has no tool that
// writes). Every query it runs is in the audit trail, as the person, marked as the copilot's. What
// reaches the AI provider is the schema and those few rows: who may use it is who may query (§23).
//
// What a person asks may be **kept as a prompt** (§34.7): asked again as it is or changed, and, with a
// schedule, asked by the clock as that person, each generation kept as a report of theirs. And the
// copilot may be handed **kept reports to work from** (a summary of a week's reports): each as the
// person may read it now.
//
// A kept prompt may be **pinned to a report** (§34.11): each run then runs that report's queries again,
// as its owner, and keeps the same blocks, titles and charts, without asking the copilot; its words are
// kept as written, or written fresh by the copilot from that run's answers (and nothing else).
//
// A report may be drawn on a **report layout** (§34.5), a design element approved like a screen: which
// blocks, in which order, how wide, and what each is for. The person picks one; the copilot is told
// it and fills it, and a report that departs from it is handed back to the copilot, not drawn.
import { fail } from "../../../src/errors.js";
import { appendAudit } from "./audit.js";
import { reportProblems, layoutDepartures, laidOut, widthOf, BLOCK_ROWS, WIDTHS } from "../client/report.js";
import { KINDS, CHART_KINDS, CHART_KEYS, TONES, chartOf, rowsFor } from "../client/charts.js";
import { scheduleProblems, nextRunOf, describeSchedule } from "../client/schedule.js";
import { CALL_KIND } from "../../../src/live-protocol.js";
import { reportTagsText, reportTagsProblem } from "../client/builtins.js";

const MAX_STEPS = 16;
const STALE_MS = 10 * 60_000;
// Rows of a query's answer handed to the model, and how long a value in them may be: enough to read a
// situation, not a copy of the plant.
const MODEL_ROWS = 40;
const MODEL_CELL = 200;
const MODEL_CHARS = 16_000;
// Messages a person, and this instance in all, may send it in an hour (copilot.js has the same).
const SENDS = { perPerson: 30, perInstance: 300, everyMs: 60 * 60_000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Kept prompts (§34.7): how many a person keeps, how many of them run by the clock, how often one may
// run at most (each run asks the AI as a message does), how many the scheduler starts at a time, and
// how many kept reports the copilot is handed at once, with how much of each.
const PROMPTS = { perPerson: 50, scheduled: 10, minMinutes: 60, perTick: 2, staleMs: 15 * 60_000 };
const WITH_REPORTS = { most: 12, words: 1500, rows: 8 };
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const SYSTEM = `You are the analytics copilot of OpenCore MES, a manufacturing execution system whose objects (lots, equipment, work orders, whatever this plant designed) are queried through read-only SQL views. You help one person understand the plant's situation and put a report together: words, figures, charts and tables.

How you work:
- Call get_schema first. It lists the views this person may read: one per object (its columns are the object's fields, plus id, state, created_at, updated_at), and <object>_stays for the time records spent in each state. Use only the views and columns it lists; never guess a name.
- A reference column (a lot's machine) holds the record's id: to show what people call it, join that object's view on id and select its title field (SELECT m.machine_id AS machine, count(*) AS lots FROM lot l JOIN machine m ON m.id = l.machine GROUP BY 1). Never show ids on a chart.
- Call run_query to look at the data before you say anything about it. One SELECT per call (PostgreSQL). Aggregate in SQL (count, sum, avg, GROUP BY, date_trunc) rather than reading rows. You are shown at most ${MODEL_ROWS} rows, so ask for summaries.
- When you know what to show, call render_report once with the whole report. Each figure, chart and table carries its own query, which is run again whenever the report is opened, as whoever opens it. Name result columns plainly (AS lots, AS day) and use those names in value, x, y and columns.
- A chart names its kind (chart) and which result columns go where; you never write a number into it: it draws only what its query answers. Choose the kind that answers the question:
${CHART_KINDS.map((k) => `  - ${k}: ${KINDS[k].for} (needs ${KINDS[k].needs.join(", ")}${KINDS[k].may.length ? `; may say ${KINDS[k].may.join(", ")}` : ""})`).join("\n")}
  Order time along x in the query (ORDER BY the bucket). For several series either list several y columns (wide rows) or give one y and a series column (long rows). A distribution (histogram, boxplot, scatter, bubble) is drawn from the values themselves: select the values, not a summary. marks are reference lines (a target, control limits) and bands shaded ranges, each with a tone of ${TONES.join(", ")} (good: ok, bad: danger); unit is a short word after each value. A figure is one number: its query answers one row.
- An "assist" block is advice on a set of records (a line's equipment, a team's orders): text is your advice in plain words (what to do first and why, with the numbers; what will be missed if nothing changes), and query lists the rows to act on, in the order to act on them. Advise only from what you queried: the goal as it is written, the data as it is.
- Text blocks are your words: what the situation is, what stands out, what to look at next. Say only what the data you queried shows, with the numbers. If a query answers nothing, say so; never invent a value.
- You read as this person: rows and fields their policies hide are not there, and you cannot tell that they are missing. If the data looks incomplete, say that their access may not show everything.
- The person may attach files to a message: a picture (a defect, a label, a whiteboard), a PDF (a spec, a certificate, a work instruction) or a spreadsheet (given to you as its rows). Read them as they are: say what they show, compare them with the plant's data when asked, and say when a file and the data disagree. Never invent what a file does not show. To show an attached file in the report, add a "media" block naming it (blob: its attachment id, as given; caption: what it shows); never quote an attachment id in your words.
- A block may say how wide it is drawn: width "quarter", "third", "half" or "full" of the page (left out: a figure a quarter, a chart half, text and tables full).
- When the person has picked a report layout, it is given below and it decides the report's shape: exactly its blocks, in its order, each of its kind. You choose the queries and the words.
- You cannot change anything, and you do not keep reports: the person keeps and shares what you draw. Answer briefly in plain words once the report is drawn.`;

// A pinned prompt's run with its words written fresh (§34.11): the copilot is handed what each block
// answers now and writes only the words. It draws nothing and runs no query.
const WORDS_SYSTEM = `You are the analytics copilot of OpenCore MES. A report is generated again from fixed queries: its figures, charts and tables are drawn from what they answer now, and you do not change them. You write only its words: each text block, and the advice of each AI assisted block, from what the report's blocks answer now.
- Say only what the answers show, with their numbers. If a block failed or answered nothing, say so; never invent a value.
- What a block said when the report was first drawn is given as an example of its purpose and tone, not as facts: its numbers are old.
- Keep each block about what it was about, about as long. Plain words, no headings of your own.
- Call write_words once, with a text for every block you are asked for.`;

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const QUERY = { type: "object", description: 'A query: { "sql": "SELECT …" } (PostgreSQL, one statement, over the views of get_schema), or { "json": { from, select, where, groupBy, orderBy, limit } }.', properties: { sql: { type: "string" }, json: { type: "object" } } };
const TOOLS = [
    { name: "get_schema", description: "The views this person may query and their columns (name, type, label, whether they may read it). No rows.", input_schema: obj({}) },
    { name: "run_query", description: `Run one read-only query as this person and see its columns and up to ${MODEL_ROWS} rows. Aggregate in SQL; this is for looking, the report's blocks carry their own queries.`, input_schema: obj({ query: QUERY }, ["query"]) },
    {
        name: "render_report",
        description: "Draw the report on the person's page. Give the whole report each time. It is checked and each block's query is run once as the person: you are told which blocks failed and why, so you can fix them and call it again.",
        input_schema: obj({
            title: { type: "string", description: "The report's title." },
            description: { type: "string", description: "One line under the title, optional." },
            blocks: {
                type: "array", description: "1 to 12 blocks, in reading order.",
                items: {
                    type: "object",
                    properties: {
                        block: { type: "string", enum: ["text", "figure", "chart", "table", "assist", "media"] },
                        blob: { type: "string", description: "media: the attachment id of a file the person attached (as given)." },
                        caption: { type: "string", description: "media: what it shows, in a line." },
                        title: { type: "string" },
                        text: { type: "string", description: "text: your words. assist: your advice." },
                        query: QUERY,
                        value: { type: "string", description: "figure: the column holding the number." },
                        unit: { type: "string", description: "figure, chart: a word after the number (lots, %, h)." },
                        chart: { type: "string", enum: CHART_KINDS, description: "chart: its kind (see the system prompt for what each is for and needs)." },
                        ...Object.fromEntries(["x", "series", "size", "value", "source", "target", "open", "high", "low", "close"].map((k) => [k, { type: "string", description: `chart: ${CHART_KEYS[k]}.` }])),
                        ...Object.fromEntries(["y", "path", "lines"].map((k) => [k, { type: "array", items: { type: "string" }, description: `chart: ${CHART_KEYS[k]}.` }])),
                        ...Object.fromEntries(["stack", "horizontal", "smooth", "step", "labels", "log"].map((k) => [k, { type: "boolean", description: `chart: ${CHART_KEYS[k]}.` }])),
                        bins: { type: "integer", description: `chart: ${CHART_KEYS.bins}.` },
                        min: { type: "number", description: `chart: ${CHART_KEYS.min}.` },
                        max: { type: "number", description: `chart: ${CHART_KEYS.max}.` },
                        marks: { type: "array", description: `chart: ${CHART_KEYS.marks}.`, items: { type: "object", properties: { value: { type: "number" }, label: { type: "string" }, tone: { type: "string", enum: TONES } }, required: ["value"] } },
                        bands: { type: "array", description: `chart: ${CHART_KEYS.bands}.`, items: { type: "object", properties: { from: { type: "number" }, to: { type: "number" }, label: { type: "string" }, tone: { type: "string", enum: TONES } }, required: ["from", "to"] } },
                        columns: { type: "array", items: { type: "string" }, description: "table, assist: the columns shown, in order (all of them when left out)." },
                        width: { type: "string", enum: Object.keys(WIDTHS), description: "How wide it is drawn (a layout's own widths win)." },
                    },
                    required: ["block"],
                },
            },
        }, ["title", "blocks"]),
    },
];

const WORDS_TOOLS = [{
    name: "write_words",
    description: "The report's words: one text for each block you are asked for, by its number.",
    input_schema: obj({ words: { type: "array", items: obj({ block: { type: "integer", description: "The block's number, as given." }, text: { type: "string", description: "Its words." } }, ["block", "text"]) } }, ["words"]),
}];

export function createReports({ store, records, requireViewer, query, titles = null, blobs = null, attachments = null, provider, log = console, sendLimits = SENDS, plantTz = "UTC", now = () => Date.now() }) {
    const { db } = store;
    const sessions = new Map(); // user id → the conversation, while this process runs it
    const shownAs = (user, answer) => (titles ? titles.titled(user, answer) : answer);

    async function person(self) {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        return { id: user.id, name: user.name };
    }
    // Who may query (§23) may put a report together, and ask the copilot.
    async function analyst(self) {
        const user = await person(self);
        if (!(await store.rolesFor(user.id, "query")).length) fail("Reports are made by those who may query: that needs the analyst role.", { status: 403 });
        return user;
    }

    // ---- running a report -----------------------------------------------------------------------
    // Each block's query, run as `user`: its answer, or why not, beside the block. One block that
    // fails does not take the others with it.
    async function runBlocks(user, report) {
        const out = [];
        for (const b of report.blocks) {
            if (b.block === "text") { out.push({ ...b }); continue; }
            // A file shown (§34.10): what is kept under its name, without the bytes (the page fetches it).
            if (b.block === "media") {
                const kept = blobs ? (await blobs.about([b.blob])).get(b.blob) : null;
                out.push(kept ? { ...b, media: kept } : { ...b, error: "This file is not kept here (any more)." });
                continue;
            }
            try {
                // A chart of a distribution is drawn from its values: more rows than a table shows.
                // Ids never shown (§34.9): each is its record's title, as this person may read it.
                const r = await shownAs(user, await query.runAs(user, b.query, b.block === "chart" ? rowsFor(b) : BLOCK_ROWS));
                out.push({ ...b, data: { columns: r.columns, rows: r.rows, truncated: r.truncated, ms: r.ms } });
            } catch (error) {
                if (error?.expose !== true) log.error?.("report block", error);
                out.push({ ...b, error: error?.expose === true ? error.message : "This block could not be read." });
            }
        }
        return out;
    }
    const checked = (report) => {
        const problems = reportProblems(report);
        if (problems.length) fail(`The report has ${problems.length} problem(s): ${problems[0].message}`, { fields: Object.fromEntries(problems.map((p) => [p.path || "report", p.message])), code: "report.invalid" });
        // Only what a report is made of is kept: nothing else rides along.
        return {
            title: report.title.trim(), ...(report.description ? { description: report.description } : {}), ...(report.layout ? { layout: report.layout } : {}),
            ...(report.scope ? { scope: { object: report.scope.object, ...(report.scope.by ? { by: report.scope.by } : {}), values: report.scope.values } } : {}),
            blocks: report.blocks.map((b) => (b.block === "text" ? { block: "text", ...(b.title ? { title: b.title } : {}), ...(b.width ? { width: b.width } : {}), text: b.text }
                : b.block === "media" ? { block: "media", ...(b.title ? { title: b.title } : {}), ...(b.width ? { width: b.width } : {}), blob: b.blob, ...(b.name ? { name: b.name } : {}), ...(b.caption ? { caption: b.caption } : {}) }
                : { block: b.block, ...(b.title ? { title: b.title } : {}), ...(b.width ? { width: b.width } : {}), query: b.query.sql !== undefined ? { sql: b.query.sql } : { json: b.query.json },
                    ...(b.block === "figure" ? { value: b.value, ...(b.unit ? { unit: b.unit } : {}) } : {}),
                    ...(b.block === "chart" ? chartOf(b) : {}),
                    ...(b.block === "assist" ? { text: b.text, ...(b.scope ? { scope: { object: b.scope.object, ...(b.scope.by ? { by: b.scope.by } : {}), values: b.scope.values } } : {}) } : {}),
                    ...((b.block === "table" || b.block === "assist") && b.columns ? { columns: b.columns } : {}) })),
        };
    };
    // A kept report, as the person may read it (the record services decide), with what it holds.
    async function kept(self, id) {
        if (typeof id !== "string" || !UUID.test(id)) fail("No such report.", { status: 404 });
        const row = await records["records.get"].call(self, { object: "report", id });
        if (!row) fail("No such report, or it is not shared with you.", { status: 404 });
        let report = null;
        try { report = JSON.parse(row.spec); } catch { report = null; }
        if (!report || reportProblems({ ...report, title: row.title }).length) fail("This report's blocks cannot be read: its author can draw it again on the AI Report page.", { status: 409 });
        return { row, report: { ...report, title: row.title, ...(row.description ? { description: row.description } : {}) } };
    }

    // ---- report layouts (§34.5) -----------------------------------------------------------------
    const layoutOf = async (name) => (typeof name === "string" && name ? (await store.layouts()).get(name) ?? null : null);
    // What the copilot is told about the layout the person picked.
    // An assist block's records and goal (§34.6), as the copilot is told them: which view, which
    // column, which values. It reads them as the person does: one they may not read is not there.
    const lineWords = (scope, defs) => `these ${scope.values.length} record(s) of ${defs[scope.object]?.label ?? scope.object} (view ${scope.object}, where ${scope.by ?? defs[scope.object]?.titleField ?? "id"} is one of: ${scope.values.map((v) => JSON.stringify(v)).join(", ")}).`;
    const assistWords = (b, defs) => {
        const by = b.scope.by ?? defs[b.scope.object]?.titleField ?? "id";
        return `\n   It is about these ${b.scope.values.length} record(s) of ${defs[b.scope.object]?.label ?? b.scope.object} (view ${b.scope.object}, where ${by} is one of: ${b.scope.values.map((v) => JSON.stringify(v)).join(", ")}). Find what refers to them in the schema (columns that refer to ${b.scope.object}) and keep every query of this block to them.\n   The goal: ${b.goal}\n   Look first at what the goal needs (targets, due dates, what is done already, what waits), then fill the block: text is your advice, query the rows to act on, most urgent first.`;
    };
    const layoutWords = (l, defs) => [
        `\n\nThe person picked the report layout "${l.body.label}" (${l.body.name}, version ${l.version}). Draw the report on it: exactly these ${l.body.blocks.length} block(s), in this order, each of the kind given. A title given here is kept as written; where there is none, title the block yourself. Widths are the layout's.`,
        ...(l.body.description ? [`What it is for: ${l.body.description}`] : []),
        ...(l.body.guidance ? [`Its guidance: ${l.body.guidance}`] : []),
        // An AI assisted line (§34.6): the whole report is about the records its designer picked.
        ...(l.body.scope ? [`The whole report is about one line: ${lineWords(l.body.scope, defs)} Keep every block's query to them: find what refers to them in the schema (columns that refer to ${l.body.scope.object}). Records outside the line are not part of this report.\nThe line's goal: ${l.body.goal}\nLook first at what the goal needs (targets, due dates, what is done already, what waits on the line). The report must say what has to be processed, and in which order, to meet the goal: lead with that, in words and as rows.`] : []),
        ...l.body.blocks.map((b, i) => `${i + 1}. ${b.block === "chart" ? `chart (${b.chart ?? "the kind is yours to choose"})` : b.block}${b.title ? `, titled "${b.title}"` : ""}, ${widthOf(b)} width${b.hint ? `: ${b.hint}` : ""}${b.block === "assist" ? assistWords(b, defs) : ""}`),
        "If the data cannot fill a block, keep the block and say so in it (a text block's words, or a query that answers what there is). Never add, drop or reorder blocks.",
    ].join("\n");

    // ---- the copilot's conversation -------------------------------------------------------------
    const sent = [];
    const withinSends = (userId) => {
        const since = Date.now() - sendLimits.everyMs;
        while (sent.length && sent[0].at < since) sent.shift();
        if (sent.length >= sendLimits.perInstance || sent.filter((x) => x.user === userId).length >= sendLimits.perPerson) return false;
        sent.push({ user: userId, at: Date.now() });
        return true;
    };
    const sessionOf = async (user) => {
        if (sessions.get(user.id)?.running) return sessions.get(user.id);
        const [row] = await db.query("SELECT messages, transcript, report, layout, running, started_at, updated_at FROM mes.analyst_conversations WHERE owner = $1", [user.id]);
        const s = { user: user.id, messages: row?.messages ?? [], transcript: row?.transcript ?? [], report: row?.report ?? null, layout: row?.layout ?? null, running: false, step: 0, error: null, started_at: row?.started_at ?? null, updated_at: row?.updated_at ?? null };
        if (row?.running) {
            if (Date.now() - new Date(row.updated_at).getTime() < STALE_MS) return { ...s, running: true, elsewhere: true };
            s.transcript.push({ role: "note", text: "The copilot was stopped before it finished (the server restarted): ask it again.", at: new Date().toISOString() });
            await keep(s);
        }
        sessions.set(user.id, s);
        return s;
    };
    async function keep(s) {
        // (A kept prompt's generation runs beside the person's conversation, never over it.)
        if (s.detached) return;
        const [row] = await db.query(
            `INSERT INTO mes.analyst_conversations (owner, messages, transcript, report, running, layout) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (owner) DO UPDATE SET messages = $2, transcript = $3, report = $4, running = $5, layout = $6, updated_at = now()
             RETURNING started_at, updated_at`,
            [s.user, JSON.stringify(s.messages), JSON.stringify(s.transcript), s.report ? JSON.stringify(s.report) : null, s.running, s.layout ?? null]);
        s.started_at = row.started_at;
        s.updated_at = row.updated_at;
    }
    const keepQuietly = (s) => keep(s).catch((error) => log.error?.("analytics copilot: keeping the conversation", error));
    const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);
    const view = (s) => ({ transcript: s.transcript, running: s.running, step: s.step, error: s.error, report: s.report, layout: s.layout ?? null, started_at: iso(s.started_at), updated_at: iso(s.updated_at) });
    const clip = (value) => { const text = JSON.stringify(value); return text.length > MODEL_CHARS ? `${text.slice(0, MODEL_CHARS)}… (cut: ask for fewer rows or columns)` : text; };
    const cell = (v) => (typeof v === "string" && v.length > MODEL_CELL ? `${v.slice(0, MODEL_CELL)}…` : v);
    const via = () => ({ token: "analytics copilot", agent: provider.model ?? provider.name });
    // A query the copilot ran, in the trail: as the person, marked as its own.
    const audited = (user, what, after) => db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$query", action: what, after: { ...after, via: via() } })).catch((error) => log.error?.("analytics copilot: audit", error));

    // Kept reports the person hands the copilot to work from (a summary of several): each as they may
    // read it now, its words, and what its blocks answer for them at this moment, cut to a digest.
    async function digestOf(self, user, ids) {
        const out = [];
        for (const id of ids) {
            const k = await kept(self, id);
            const blocks = await runBlocks(user, k.report);
            out.push({
                title: k.report.title, kept: iso(k.row.created_at), ...(k.report.description ? { description: k.report.description } : {}),
                blocks: blocks.map((b) => (b.block === "text" ? { text: String(b.text).slice(0, WITH_REPORTS.words) }
                    : b.error ? { block: b.block, title: b.title ?? null, error: b.error }
                    : { block: b.block, title: b.title ?? null, ...(b.block === "assist" ? { advice: String(b.text).slice(0, WITH_REPORTS.words) } : {}), columns: b.data.columns.map((c) => c.name ?? c), rows: b.data.rows.slice(0, WITH_REPORTS.rows).map((row) => row.map(cell)), ...(b.data.rows.length > WITH_REPORTS.rows ? { more: b.data.rows.length - WITH_REPORTS.rows } : {}) })),
            });
        }
        return out;
    }

    const tools = {
        async get_schema(user) {
            const views = await query.schemaAs(user);
            return { views: views.map((v) => ({ name: v.name, label: v.label, kind: v.kind, states: v.states, columns: v.columns.map((c) => ({ name: c.name, type: c.type, ...(c.label && c.label !== c.name ? { label: c.label } : {}), ...(c.values ? { values: c.values } : {}), ...(c.to ? { refersTo: c.to } : {}), ...(c.access && c.access !== "always" ? { readable: c.access } : {}) })) })) };
        },
        async run_query(user, { query: q } = {}) {
            if (!isPlain(q) || (typeof q.sql !== "string" && !isPlain(q.json))) throw Object.assign(new Error('A query is { "sql": "SELECT …" } or { "json": { from, … } }.'), { expose: true });
            // What the copilot is handed holds no id either: its words cannot quote one.
            const r = await shownAs(user, await query.runAs(user, q.sql !== undefined ? { sql: q.sql } : { json: q.json }, 500));
            await audited(user, "ai-query", { sql: String(r.sql).slice(0, 2000), rows: r.rows.length });
            return { columns: r.columns, rows: r.rows.slice(0, MODEL_ROWS).map((row) => row.map(cell)), rowCount: r.rows.length, ...(r.rows.length > MODEL_ROWS ? { note: `Only the first ${MODEL_ROWS} of ${r.rows.length}${r.truncated ? "+" : ""} rows are shown to you: aggregate in SQL.` } : {}) };
        },
        async render_report(user, input, session) {
            const problems = reportProblems(input);
            if (problems.length) throw Object.assign(new Error(problems.map((p) => p.message).join(" ")), { expose: true });
            // On the layout the person picked (§34.5): one that departs from it goes back, not onto the page.
            const layout = await layoutOf(session.layout);
            if (layout) {
                const departures = layoutDepartures(input, layout.body);
                if (departures.length) throw Object.assign(new Error(`The report does not follow the layout. ${departures.join(" ")} Draw it again on the layout.`), { expose: true });
            }
            const { layout: _claimed, scope: _scope, ...own } = input;
            const report = checked(layout ? laidOut(own, layout.body) : own);
            const blocks = await runBlocks(user, report);
            await audited(user, "ai-report", { title: report.title, blocks: report.blocks.length, queries: report.blocks.filter((b) => b.query).length, ...(layout ? { layout: `${layout.body.name} v${layout.version}` } : {}) });
            session.report = report;
            return {
                drawn: true,
                blocks: blocks.map((b, i) => (b.block === "text" ? { block: i + 1, ok: true } : b.error ? { block: i + 1, ok: false, error: b.error } : b.block === "media" ? { block: i + 1, ok: true, shown: b.media?.type } : { block: i + 1, ok: true, columns: b.data.columns, rows: b.data.rows.length })),
                ...(blocks.some((b) => b.error) ? { note: "Fix the blocks that failed and call render_report again with the whole report." } : {}),
            };
        },
    };
    const summarize = (name, ok, result) => {
        if (!ok) return result?.message ?? "failed";
        if (name === "get_schema") return `${result.views.length} view(s)`;
        if (name === "run_query") return `${result.rowCount} row(s)`;
        if (name === "render_report") { const bad = result.blocks.filter((b) => !b.ok).length; return bad ? `drawn; ${bad} block(s) need fixing` : `drawn: ${result.blocks.length} block(s)`; }
        return "done";
    };

    async function run(session, user) {
        try {
            for (session.step = 1; session.step <= MAX_STEPS; session.step++) {
                const layout = await layoutOf(session.layout);
                const defs = layout?.body.scope || layout?.body.blocks.some((b) => b.block === "assist") ? Object.fromEntries((await store.allDefinitions()).filter(Boolean).map((d) => [d.body.object, d.body])) : {};
                // What the person attached (§34.10), given as the model reads it: kept in the conversation by name only.
                const answer = await provider.complete({ system: layout ? SYSTEM + layoutWords(layout, defs) : SYSTEM, messages: attachments ? await attachments.expand(session.messages) : session.messages, tools: TOOLS });
                session.messages.push({ role: "assistant", content: answer.content });
                for (const block of answer.content) if (block.type === "text" && block.text.trim()) session.transcript.push({ role: "assistant", text: block.text });
                if (answer.stop === "pause") continue;
                if (answer.stop !== "tools") {
                    if (answer.note) session.transcript.push({ role: "note", text: answer.note });
                    if (answer.stop === "max_tokens") session.transcript.push({ role: "note", text: "The answer was cut short; ask to continue." });
                    return;
                }
                const results = [];
                for (const call of answer.content.filter((b) => b.type === "tool_use")) {
                    let ok = true;
                    let result;
                    try {
                        if (!Object.hasOwn(tools, call.name)) throw Object.assign(new Error(`There is no tool ${call.name}: it reads the schema, runs queries and draws reports.`), { expose: true });
                        result = await tools[call.name](user, call.input ?? {}, session);
                    } catch (error) {
                        ok = false;
                        if (error?.expose !== true) log.error?.("analytics copilot tool", call.name, error);
                        result = { message: error?.expose === true ? error.message : "The tool failed." };
                    }
                    session.transcript.push({ role: "tool", name: call.name, ok, text: summarize(call.name, ok, result) });
                    results.push({ type: "tool_result", tool_use_id: call.id, content: clip(result), ...(ok ? {} : { is_error: true }) });
                }
                session.messages.push({ role: "user", content: results });
                await keepQuietly(session);
            }
            session.transcript.push({ role: "note", text: `Stopped after ${MAX_STEPS} steps; ask to continue.` });
        } catch (error) {
            log.error?.("analytics copilot", error);
            session.error = error?.reason ? `The AI failed: ${error.reason}` : "The AI could not be reached or failed; try again.";
            session.transcript.push({ role: "note", text: session.error });
        } finally {
            session.running = false;
            await keepQuietly(session);
        }
    }

    // ---- kept prompts (§34.7) ---------------------------------------------------------------------
    const promptAudit = (q, actor, action, after) => appendAudit(q, { actor, object: "$report-prompt", action, after });
    const triggerOf = (schedule) => (schedule ? { schedule } : null);
    const promptOut = (p) => ({
        id: p.id, title: p.title, prompt: p.prompt, layout: p.layout ?? null, tags: p.tags ?? null, schedule: p.schedule ?? null, attachments: p.attachments ?? [],
        scheduleWords: p.schedule ? describeSchedule(triggerOf(p.schedule), plantTz) : null,
        next_at: iso(p.next_at), running: Boolean(p.running), last_at: iso(p.last_at), last_report: p.last_report ?? null, last_error: p.last_error ?? null,
        // Pinned to a report (§34.11): which, how many blocks, and whether its words are written fresh.
        fixed: p.fixed ? { from: p.fixed_from ?? null, title: p.fixed.title ?? null, blocks: (p.fixed.blocks ?? []).length, layout: p.fixed.layout ?? null } : null, words: p.words ?? "kept",
    });
    // Whether a run asks the AI: unless it is pinned to a report whose words are kept as written.
    const asksAi = (p) => !p.fixed || p.words === "fresh";
    // What is wrong with a prompt as given, by field. A schedule is a service's (schedule.js): at times
    // of day or every so often, on some days; at most once an hour, since each run asks the AI.
    function promptProblems({ title, prompt, schedule, tags }) {
        const fields = {};
        if (tags !== undefined && tags !== null && reportTagsProblem(tags)) fields.tags = reportTagsProblem(tags);
        if (typeof title !== "string" || !title.trim() || title.length > 120) fields.title = "Give it a title, at most 120 characters.";
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8000) fields.prompt = "Say what to ask, in at most 8000 characters.";
        if (schedule !== undefined && schedule !== null) {
            const wrong = scheduleProblems(triggerOf(schedule));
            // (A kind of schedule a suite adds is a service's, §30.11: a kept prompt runs on the clock.)
            if (schedule?.from !== undefined) fields.schedule = "A kept prompt runs on the clock: every so many minutes or hours, or at times of day.";
            else if (wrong.length) fields.schedule = wrong[0];
            else if (schedule.every && (schedule.every.minutes ?? schedule.every.hours * 60) < PROMPTS.minMinutes) fields.schedule = `A kept prompt runs at most once every ${PROMPTS.minMinutes} minutes: each run asks the AI.`;
            else if (schedule.at && new Set(schedule.at).size !== schedule.at.length) fields.schedule = "A time of day is listed once.";
            // What the clock generates is filed under tags (§34.8): nobody asked for it, so it is found by them.
            if (!fields.tags && !reportTagsText(tags)) fields.tags = "A prompt asked by the clock files its reports under tags: give at least one (daily, wirebond).";
        }
        return fields;
    }
    const nextOf = (schedule, after = now()) => { const at = schedule ? nextRunOf([triggerOf(schedule)], after, plantTz) : null; return at ? new Date(at) : null; };
    const stamp = (at) => new Intl.DateTimeFormat("sv-SE", { timeZone: plantTz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);
    async function ownPrompt(user, id) {
        if (typeof id !== "string" || !UUID.test(id)) fail("No such prompt.", { status: 404 });
        const [p] = await db.query("SELECT * FROM mes.report_prompts WHERE id = $1 AND owner = $2", [id, user.id]);
        if (!p) fail("No such prompt of yours.", { status: 404 });
        return p;
    }
    // One generation: the prompt asked as its owner, beside their own conversation, and what the
    // copilot drew kept as a report of theirs, through the record services. `by`: "clock" or "now".
    async function generate(p, by) {
        const done = async (report, error) => {
            await db.transaction(async (tx) => {
                await tx.query("UPDATE mes.report_prompts SET running = false, last_at = now(), last_report = coalesce($2, last_report), last_error = $3, updated_at = now() WHERE id = $1", [p.id, report, error]);
                await promptAudit(tx, p.owner, error ? "prompt:failed" : "prompt:generated", { prompt: p.id, title: p.title, by, ...(report ? { report } : {}), ...(error ? { error } : {}) });
            }).catch((e) => log.error?.("report prompt: recording a generation", e));
        };
        try {
            // Asked as its owner, with their rights as they are now: someone who left, or may no longer
            // query, is asked nothing for.
            const owner = await store.user(p.owner);
            if (!owner || owner.active === false) return await done(null, "Its owner is no longer active here.");
            if (!(await store.rolesFor(owner.id, "query")).length) return await done(null, "Its owner may no longer query (the analyst role).");
            if (asksAi(p) && !provider.available) return await done(null, provider.hint ?? "No AI is configured on this server.");
            if (asksAi(p) && !withinSends(owner.id)) return await done(null, "The copilot has been asked a great deal in the past hour: this run was skipped.");
            const user = { id: owner.id, name: owner.name };
            if (p.fixed) return await again(p, by, user, done);
            const layout = await layoutOf(p.layout);
            if (p.layout && !layout) return await done(null, `Its report layout "${p.layout}" is not published any more: pick another.`);
            // Its attachments (§34.10), given with it each time: those still kept.
            const kept = attachments && (p.attachments ?? []).length ? await attachments.checked(p.attachments) : { list: [] };
            const session = { user: user.id, detached: true, messages: [{ role: "user", content: [{ type: "text", text: p.prompt }, ...(attachments?.blocks(kept.list ?? []) ?? [])] }], transcript: [], report: null, layout: layout?.body.name ?? null, running: true, step: 0, error: null };
            await run(session, user);
            if (!session.report) return await done(null, session.error ?? "The copilot answered without drawing a report.");
            const at = new Date(now());
            const title = `${p.title} · ${stamp(at)}`.slice(0, 200);
            const self = { [CALL_KIND]: "internal", reason: `report prompt ${p.id}`, user, asPerson: true };
            const row = await records["records.create"].call(self, {
                object: "report", key: `prompt-${p.id}-${at.getTime()}`,
                data: { title, description: session.report.description ?? `Asked ${by === "clock" ? "by the clock" : "on request"}: ${p.title}.`, spec: JSON.stringify({ blocks: session.report.blocks, ...(session.report.layout ? { layout: session.report.layout } : {}) }), owner: user.id, shared: false, ...(p.tags ? { tags: p.tags } : {}) },
            });
            if (!row?.id) return await done(null, "The report it drew waits for approval, or could not be kept.");
            await done(row.id, null);
        } catch (error) {
            if (error?.expose !== true) log.error?.("report prompt", error);
            await done(null, error?.expose === true ? error.message : "The generation failed.");
        }
    }
    // A run of a prompt pinned to a report (§34.11): the report's queries run again as its owner, its
    // blocks, titles, charts and widths as they were kept; its words as written, or written fresh by the
    // copilot from what the blocks answer now. Kept as a new report of the owner's. A block whose query
    // fails now (a field gone) is kept in its place, saying why, and the run says which.
    async function again(p, by, user, done) {
        let report = { ...(p.fixed.description ? { description: p.fixed.description } : {}), ...(p.fixed.layout ? { layout: p.fixed.layout } : {}), blocks: p.fixed.blocks };
        const blocks = await runBlocks(user, report);
        if (p.words === "fresh") report = await freshWords(user, p, report, blocks);
        const at = new Date(now());
        const self = { [CALL_KIND]: "internal", reason: `report prompt ${p.id}`, user, asPerson: true };
        const row = await records["records.create"].call(self, {
            object: "report", key: `prompt-${p.id}-${at.getTime()}`,
            data: { title: `${p.title} · ${stamp(at)}`.slice(0, 200), description: report.description ?? `Its queries run again ${by === "clock" ? "by the clock" : "on request"}: ${p.title}.`, spec: JSON.stringify({ blocks: report.blocks, ...(report.layout ? { layout: report.layout } : {}) }), owner: user.id, shared: false, ...(p.tags ? { tags: p.tags } : {}) },
        });
        if (!row?.id) return done(null, "The report waits for approval, or could not be kept.");
        const failed = blocks.map((b, i) => (b.error ? `block ${i + 1}${b.title ? ` (${b.title})` : ""}: ${b.error}` : null)).filter(Boolean);
        return done(row.id, failed.length ? `Kept, but ${failed.length} of ${blocks.length} block(s) could not be read: ${failed.join("; ")}. Ask the copilot for a new report, then pin that one.` : null);
    }
    // Its words written fresh: the copilot is handed each block's answer now (a few rows, as the person
    // reads them) and the words as first written, and writes each text block and each advice again. Its
    // blocks, queries and charts are not its to change.
    async function freshWords(user, p, report, blocks) {
        const wanted = report.blocks.map((b, i) => (b.block === "text" || b.block === "assist" ? i + 1 : null)).filter(Boolean);
        if (!wanted.length) return report;
        const digest = blocks.map((b, i) => ({
            block: i + 1, kind: b.block, ...(b.title ? { title: b.title } : {}),
            ...(b.block === "text" ? { firstWritten: String(b.text).slice(0, WITH_REPORTS.words) }
                : b.block === "media" ? { file: b.caption ?? b.name ?? "a file" }
                : b.error ? { error: b.error }
                : { ...(b.block === "assist" ? { firstWritten: String(b.text).slice(0, WITH_REPORTS.words) } : {}), columns: b.data.columns.map((c) => c.name ?? c), rows: b.data.rows.slice(0, MODEL_ROWS).map((row) => row.map(cell)), ...(b.data.rows.length > MODEL_ROWS ? { more: b.data.rows.length - MODEL_ROWS } : {}) }),
        }));
        const messages = [{ role: "user", content: [{ type: "text", text: `What the report is for, as its owner asked for it: ${p.prompt}

Write the words of block(s) ${wanted.join(", ")}. The report, as its queries answer now:
${clip(digest)}` }] }];
        for (let attempt = 0; attempt < 2; attempt++) {
            const answer = await provider.complete({ system: WORDS_SYSTEM, messages, tools: WORDS_TOOLS });
            const call = (answer.content ?? []).find((b) => b.type === "tool_use" && b.name === "write_words");
            const words = new Map((Array.isArray(call?.input?.words) ? call.input.words : []).filter((w) => wanted.includes(w?.block) && typeof w.text === "string" && w.text.trim()).map((w) => [w.block, w.text.trim().slice(0, 8000)]));
            if (wanted.every((n) => words.has(n))) {
                await audited(user, "ai-report-words", { prompt: p.id, title: p.title, blocks: wanted.length });
                return { ...report, blocks: report.blocks.map((b, i) => (words.has(i + 1) ? { ...b, text: words.get(i + 1) } : b)) };
            }
            messages.push({ role: "assistant", content: answer.content ?? [] });
            if (call) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `Every block asked for needs its words: ${wanted.filter((n) => !words.has(n)).join(", ")}.`, is_error: true }] });
            else messages.push({ role: "user", content: [{ type: "text", text: "Call write_words with the words of every block asked for." }] });
        }
        throw Object.assign(new Error("The copilot did not write the report's words: try again, or keep its words as written."), { expose: true });
    }

    // The clock: prompts whose time has come, a few at a time, each claimed by one instance (its next
    // run is set as it is claimed, so a run that fails is not tried again until then). One left
    // running by a process that stopped is freed after a while.
    async function tick() {
        await db.query("UPDATE mes.report_prompts SET running = false, last_error = 'The server stopped while it was being generated.' WHERE running AND started_at < now() - make_interval(secs => $1)", [PROMPTS.staleMs / 1000]);
        for (let i = 0; i < PROMPTS.perTick; i++) {
            const [due] = await db.query("SELECT id, schedule FROM mes.report_prompts WHERE next_at <= to_timestamp($1 / 1000.0) AND NOT running ORDER BY next_at LIMIT 1", [now()]);
            if (!due) return;
            const [p] = await db.query("UPDATE mes.report_prompts SET running = true, started_at = now(), next_at = $2 WHERE id = $1 AND NOT running AND next_at <= to_timestamp($3 / 1000.0) RETURNING *", [due.id, nextOf(due.schedule), now()]);
            if (p) await generate(p, "clock");
        }
    }

    const services = {
        // ---- kept prompts (§34.7): the person's own ----
        async "prompts.list"() {
            const user = await analyst(this);
            return (await db.query("SELECT * FROM mes.report_prompts WHERE owner = $1 ORDER BY lower(title), created_at", [user.id])).map(promptOut);
        },
        // Kept (no `id`) or changed (theirs). A schedule, or none (null); its next run follows from it.
        async "prompts.save"({ id, title, prompt, layout, schedule, tags, attachments: attached } = {}) {
            const user = await analyst(this);
            const fields = promptProblems({ title, prompt, schedule, tags });
            // What it is given each time it is asked (§34.10): files kept here.
            const files = attachments && attached?.length ? await attachments.checked(attached) : { list: [] };
            if (files.problem) fields.attachments = files.problem;
            const picked = layout === undefined || layout === null || layout === "" ? null : await layoutOf(layout);
            if (layout && !picked) fields.layout = "That report layout is not published.";
            if (Object.keys(fields).length) fail("Some of it needs attention.", { fields, code: "prompt.invalid" });
            const mine = await db.query("SELECT id, schedule IS NOT NULL AS scheduled FROM mes.report_prompts WHERE owner = $1", [user.id]);
            const others = mine.filter((x) => x.id !== id);
            if (!id && mine.length >= PROMPTS.perPerson) fail(`You keep ${PROMPTS.perPerson} prompts already: remove one first.`, { status: 409 });
            if (schedule && others.filter((x) => x.scheduled).length >= PROMPTS.scheduled) fail(`At most ${PROMPTS.scheduled} of your prompts run by the clock: take the schedule off another first.`, { status: 409, fields: { schedule: "Too many scheduled." } });
            const values = [title.trim(), prompt.trim(), picked?.body.name ?? null, schedule ? JSON.stringify(schedule) : null, nextOf(schedule ?? null), reportTagsText(tags), JSON.stringify(files.list.map(({ blob, name, type }) => ({ blob, name, type })))];
            return db.transaction(async (tx) => {
                let row;
                if (id === undefined || id === null) {
                    [row] = await tx.query("INSERT INTO mes.report_prompts (owner, title, prompt, layout, schedule, next_at, tags, attachments) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *", [user.id, ...values]);
                } else {
                    await ownPrompt(user, id);
                    [row] = await tx.query("UPDATE mes.report_prompts SET title = $3, prompt = $4, layout = $5, schedule = $6, next_at = $7, tags = $8, attachments = $9, updated_at = now() WHERE id = $1 AND owner = $2 RETURNING *", [id, user.id, ...values]);
                }
                await promptAudit(tx, user.id, id ? "prompt:changed" : "prompt:kept", { prompt: row.id, title: row.title, layout: row.layout, schedule: row.schedule });
                return promptOut(row);
            });
        },
        async "prompts.remove"({ id } = {}) {
            const user = await analyst(this);
            const p = await ownPrompt(user, id);
            if (p.running) fail("It is being generated: remove it once that has finished.", { status: 409 });
            await db.transaction(async (tx) => {
                await tx.query("DELETE FROM mes.report_prompts WHERE id = $1 AND owner = $2", [id, user.id]);
                await promptAudit(tx, user.id, "prompt:removed", { prompt: id, title: p.title });
            });
            return { ok: true };
        },
        // Pinned to a report (§34.11): `report`, a kept report the person may read (one of its runs), whose
        // blocks each run repeats; null, the copilot is asked again each time. `words`: "kept" (as written)
        // or "fresh" (the copilot writes only the words, from each run's answers).
        async "prompts.fix"({ id, report, words } = {}) {
            const user = await analyst(this);
            const p = await ownPrompt(user, id);
            if (p.running) fail("It is being generated: pin it once that has finished.", { status: 409 });
            if (words !== undefined && !["kept", "fresh"].includes(words)) fail('Its words are "kept" (as written) or "fresh" (written by the copilot each run).', { fields: { words: "kept or fresh." } });
            let fixed = p.fixed;
            let from = p.fixed_from;
            if (report === null) { fixed = null; from = null; }
            else if (report !== undefined) {
                // As the person reads it now: what they may not read is not theirs to pin.
                const k = await kept(this, report);
                const ok = checked(k.report);
                fixed = { title: ok.title, ...(ok.description ? { description: ok.description } : {}), ...(ok.layout ? { layout: ok.layout } : {}), blocks: ok.blocks };
                from = k.row.id;
            }
            if (!fixed && words === "fresh") fail("Only a prompt pinned to a report has its words written fresh: pin it to a report first.", { fields: { words: "Not pinned." } });
            return db.transaction(async (tx) => {
                const [row] = await tx.query("UPDATE mes.report_prompts SET fixed = $3, fixed_from = $4, words = $5, updated_at = now() WHERE id = $1 AND owner = $2 RETURNING *", [p.id, user.id, fixed ? JSON.stringify(fixed) : null, from, fixed ? words ?? p.words ?? "kept" : "kept"]);
                await promptAudit(tx, user.id, fixed ? "prompt:pinned" : "prompt:unpinned", { prompt: p.id, title: p.title, ...(fixed ? { report: from, blocks: fixed.blocks.length, words: row.words } : {}) });
                return promptOut(row);
            });
        },
        // Generated now: asked as the person, beside their conversation; the report it draws is kept as
        // theirs. Not waited for: the list says when it is done, and what came of it.
        async "prompts.run"({ id } = {}) {
            const user = await analyst(this);
            if (asksAi(await ownPrompt(user, id)) && !provider.available) fail(provider.hint ?? "No AI is configured.", { status: 503, code: "ai.unconfigured" });
            const [p] = await db.query("UPDATE mes.report_prompts SET running = true, started_at = now() WHERE id = $1 AND owner = $2 AND NOT running RETURNING *", [id, user.id]);
            if (!p) fail("It is being generated already.", { status: 409 });
            generate(p, "now"); // not awaited
            return promptOut(p);
        },

        // ---- reports ----
        // A report run for whoever asks: a kept one (`id`), as they may read it; or one not kept yet
        // (`report`: the copilot's, or one being put together), for those who may query.
        async "reports.run"({ id, report } = {}) {
            if (id !== undefined && id !== null) {
                const user = await person(this);
                const k = await kept(this, id);
                return { id: k.row.id, title: k.report.title, description: k.report.description ?? null, owner: k.row.owner, shared: Boolean(k.row.shared), mine: k.row.owner === user.id, rowVersion: k.row.row_version, report: k.report, blocks: await runBlocks(user, k.report), at: new Date().toISOString() };
            }
            const user = await analyst(this);
            const ok = checked(report);
            return { id: null, title: ok.title, description: ok.description ?? null, owner: user.id, shared: false, mine: true, report: ok, blocks: await runBlocks(user, ok), at: new Date().toISOString() };
        },
        // Kept, as its author's (a new one), or kept again (their own, changed): through the record
        // services, so the Report object's policies, its rule and the audit trail apply.
        async "reports.keep"({ id, report, shared, tags, key } = {}) {
            const user = await analyst(this);
            const ok = checked(report);
            if (tags !== undefined && reportTagsProblem(tags)) fail(reportTagsProblem(tags), { fields: { tags: reportTagsProblem(tags) } });
            const data = { title: ok.title, description: ok.description ?? null, spec: JSON.stringify({ blocks: ok.blocks, ...(ok.layout ? { layout: ok.layout } : {}) }), ...(tags === undefined ? {} : { tags: reportTagsText(tags) }), ...(shared === undefined ? {} : { shared: Boolean(shared) }) };
            if (typeof key !== "string" || key.length < 8) fail("A bad request key.");
            if (id === undefined || id === null) {
                const row = await records["records.create"].call(this, { object: "report", data: { ...data, owner: user.id, shared: Boolean(shared) }, key });
                return { id: row.id, title: row.title, shared: Boolean(row.shared) };
            }
            const k = await kept(this, id);
            const row = await records["records.update"].call(this, { object: "report", id, rowVersion: k.row.row_version, data, key });
            return { id: row.id, title: row.title, shared: Boolean(row.shared) };
        },
        // Filed under tags (§34.8): words its author gives it, to find it again. Through the record
        // services: its author's to change, in the record's history.
        async "reports.tag"({ id, tags, key } = {}) {
            await person(this);
            const k = await kept(this, id);
            const wrong = reportTagsProblem(tags);
            if (wrong) fail(wrong, { fields: { tags: wrong } });
            if (typeof key !== "string" || key.length < 8) fail("A bad request key.");
            const row = await records["records.update"].call(this, { object: "report", id, rowVersion: k.row.row_version, data: { tags: reportTagsText(tags) }, key });
            return { id: row.id, tags: row.tags ?? null };
        },
        // Shared with everyone who holds a role on reports, or kept to its author again.
        async "reports.share"({ id, shared, key } = {}) {
            await person(this);
            const k = await kept(this, id);
            if (typeof key !== "string" || key.length < 8) fail("A bad request key.");
            const row = await records["records.update"].call(this, { object: "report", id, rowVersion: k.row.row_version, data: { shared: Boolean(shared) }, key });
            return { id: row.id, shared: Boolean(row.shared) };
        },

        // ---- the analytics copilot ----
        async "analyst.status"() {
            await analyst(this);
            return { configured: provider.available, provider: provider.name, model: provider.model, hint: provider.hint ?? null };
        },
        async "analyst.get"() {
            return view(await sessionOf(await analyst(this)));
        },
        // The published report layouts (§34.5), for whoever may ask for a report: what each is for and
        // the blocks it gives.
        // Live (the navigator finds each by its label, §10.1): `as` names the viewer, as every live query
        // does; someone who may not query is offered none.
        async "reports.layouts"({ as } = {}) {
            const user = await requireViewer(this, as);
            if (!(await store.rolesFor(user.id, "query")).length) return [];
            return [...(await store.layouts()).values()].map((l) => ({ name: l.body.name, label: l.body.label, description: l.body.description ?? "", version: l.version, ...(l.body.scope ? { scope: l.body.scope, goal: l.body.goal } : {}), blocks: l.body.blocks.map((b) => ({ block: b.block, ...(b.title ? { title: b.title } : {}), ...(b.chart ? { chart: b.chart } : {}), width: widthOf(b), ...(b.hint ? { hint: b.hint } : {}), ...(b.block === "assist" ? { scope: b.scope, goal: b.goal } : {}) })) })).sort((a, b) => a.label.localeCompare(b.label));
        },
        // `layout`: the report layout to draw on from now on (a name; null or "" for none; left out,
        // the conversation's own stays).
        // `reports`: kept reports to work from (their ids, at most a dozen): the copilot is handed each
        // as the person may read it now, with the message.
        async "analyst.send"({ text, layout, reports: withReports, attachments: attached } = {}) {
            const user = await analyst(this);
            const ids = withReports === undefined || withReports === null ? [] : withReports;
            if (!Array.isArray(ids) || ids.length > WITH_REPORTS.most || !ids.every((id) => typeof id === "string" && UUID.test(id)) || new Set(ids).size !== ids.length) fail(`Pick at most ${WITH_REPORTS.most} kept reports to work from.`, { fields: { reports: "Too many, or not reports." } });
            if (!provider.available) fail(provider.hint ?? "No AI is configured.", { status: 503, code: "ai.unconfigured" });
            if (typeof text !== "string" || !text.trim() || text.length > 8000) fail("Say what you want to know, in at most 8000 characters.", { fields: { text: "Required." } });
            if (!withinSends(user.id)) fail("The copilot has been asked a great deal in the past hour: try again later.", { status: 429, code: "rate.limited" });
            const session = await sessionOf(user);
            if (session.running) fail("The copilot is still working on your last message.", { status: 409 });
            if (layout !== undefined) {
                const picked = layout === null || layout === "" ? null : await layoutOf(layout);
                if (layout && !picked) fail("That report layout is not published (any more): pick another, or none.", { fields: { layout: "Not published." }, status: 409 });
                if ((picked?.body.name ?? null) !== (session.layout ?? null)) {
                    session.layout = picked?.body.name ?? null;
                    session.transcript.push({ role: "note", text: picked ? `Drawn on the layout ${picked.body.label} from here on.` : "No layout from here on: the copilot arranges the report.", at: new Date().toISOString() });
                }
            }
            // Files the person attached (§34.10): read by the copilot, shown in the report if it says so.
            const files = attachments && attached?.length ? await attachments.checked(attached) : { list: [] };
            if (files.problem) fail(files.problem, { fields: { attachments: files.problem } });
            const digest = ids.length ? await digestOf(this, user, ids) : [];
            session.messages.push({ role: "user", content: [{ type: "text", text: text.trim() }, ...(attachments?.blocks(files.list) ?? []), ...(digest.length ? [{ type: "text", text: `The person picked these ${digest.length} kept report(s) to work from. Each is given as they may read it now: its words as they were written when it was drawn, and what its blocks answer at this moment.\n${clip(digest)}` }] : [])] });
            session.transcript.push({ role: "user", text: text.trim(), at: new Date().toISOString(), ...(files.list.length ? { files: files.list.map(({ blob, name, type }) => ({ blob, name, type })) } : {}) });
            if (digest.length) session.transcript.push({ role: "note", text: `With ${digest.length} kept report(s): ${digest.map((d) => d.title).join("; ")}.`, at: new Date().toISOString() });
            session.running = true;
            session.error = null;
            session.step = 0;
            await keep(session);
            run(session, user); // not awaited: the page reads the transcript as it grows
            return view(session);
        },
        async "analyst.reset"() {
            const user = await analyst(this);
            const session = await sessionOf(user);
            if (session.running) fail("Wait until the copilot has answered.", { status: 409 });
            sessions.delete(user.id);
            await db.query("DELETE FROM mes.analyst_conversations WHERE owner = $1", [user.id]);
            return { ok: true };
        },
    };
    const touches = {
        "reports.run": [], "reports.layouts": [], "analyst.status": [], "analyst.get": [], "analyst.send": [], "analyst.reset": [],
        "prompts.list": [], "prompts.save": [], "prompts.remove": [], "prompts.run": [], "prompts.fix": [],
        "reports.keep": (_args, result) => [{ name: "records.list", where: { object: "report" } }, { name: "records.get", where: { object: "report", id: result?.id } }],
        "reports.tag": ({ id } = {}) => [{ name: "records.list", where: { object: "report" } }, { name: "records.get", where: { object: "report", id } }],
        "reports.share": ({ id } = {}) => [{ name: "records.list", where: { object: "report" } }, { name: "records.get", where: { object: "report", id } }],
    };
    return { services, touches, queries: ["reports.layouts"], tick };
}
