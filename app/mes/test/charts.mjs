// Charts (§34.9), end to end against a running server:
//   1. A report's charts of every family run as the person: a histogram drawn from its values (more rows
//      than a table holds), a sankey, a heat map; each block's rows are its query's; a chart that cannot
//      be drawn as asked is refused in words before anything runs.
//   2. A screen's chart block is designed (a chart that needs a column it does not name is refused in
//      words), approved, and read as the viewer: its JSON query takes the screen's parameter (the lots on
//      that machine), its SQL one runs as written; one the viewer may not read says so, the rest is drawn.
//   3. No id is ever shown: a report's cells, a screen chart's labels and a record's history name each record
//      by its title (an id that is no record, "—"); the copilot is handed none either.
//   4. The browser module of the drawing library is served, as one file, with its licence.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/charts.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { chartOption, rowsFor, CHART_ROWS } from "../client/charts.js";
import { blockView, BLOCK_ROWS } from "../client/report.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const people = ["olga", "sam", "vera", "dana", "eli", "quinn", "ivan", "ines"];
const sessions = {};
for (const user of people) {
    sessions[user] = `ch-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const attempt = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, status: error.status, message: error.message }));
const theme = { palette: ["#2f5fd0", "#0f9d74"], ink: "#000", muted: "#666", line: "#ddd", panel: "#fff", font: "x", tones: { neutral: "#888", info: "#2f5fd0", ok: "#0a0", warn: "#a60", danger: "#a00" }, number: String };

try {
    // ---- 1. a report's charts, run as the person ----
    const report = { title: `Charts ${tag}`, blocks: [
        { block: "chart", title: "Spread", query: { sql: "SELECT g::numeric AS v FROM generate_series(1, 1000) g" }, chart: "histogram", y: ["v"], bins: 10, marks: [{ value: 500, label: "half", tone: "warn" }] },
        { block: "chart", title: "Flow", query: { sql: "SELECT 'Mold' AS src, 'Test' AS dst, 30 AS n UNION ALL SELECT 'Test', 'Pack', 25 UNION ALL SELECT 'Test', 'Scrap', 5" }, chart: "sankey", source: "src", target: "dst", value: "n" },
        { block: "chart", title: "Lots by state and item", query: { json: { from: "lot", select: ["state", "item", { count: "*", as: "lots" }], groupBy: ["state", "item"] } }, chart: "heatmap", x: "state", series: "item", value: "lots", labels: true },
        { block: "table", title: "Rows", query: { sql: "SELECT g FROM generate_series(1, 1000) g" } },
    ] };
    const ran = await call("sam", "reports.run", { report });
    const [hist, flow, heat, table] = ran.blocks;
    const histView = blockView(report.blocks[0], hist.data);
    const drawn = [hist, flow, heat].map((b, i) => chartOption(blockView(report.blocks[i], b.data).chart, blockView(report.blocks[i], b.data).data, theme));
    const [{ n: lots }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'lot' AND archived_at IS NULL");
    const heatCells = (heat.data?.rows ?? []).reduce((n, r) => n + Number(r[heat.data.columns.indexOf("lots")]), 0);
    const bad = await attempt(call("sam", "reports.run", { report: { title: "Bad", blocks: [{ block: "chart", query: { sql: "SELECT 1 AS a, 2 AS b, 3 AS c" }, chart: "pie", x: "a", y: ["b", "c"] }] } }));
    step("a report's charts run as the person: a histogram drawn from its 1000 values (a table holds 200), a sankey, a heat map whose cells add up to every lot; a chart that cannot be drawn as asked is refused in words before anything runs",
        hist.data?.rows.length === 1000 && rowsFor(report.blocks[0]) >= 1000 && histView.data.rows.length === 1000 && table.data?.rows.length === BLOCK_ROWS && drawn.every((d) => !d.problem) &&
        drawn[0].option.series[0].data.reduce((n, c) => n + c, 0) === 1000 && flow.data?.rows.length === 3 && heatCells === lots &&
        !bad.ok && /draws one column of values/.test(bad.message),
        { hist: hist.data?.rows.length, table: table.data?.rows.length, drawn: drawn.map((d) => d.problem ?? "ok"), heatCells, lots, bad, errors: ran.blocks.map((b) => b.error).filter(Boolean) });

    // ---- 2. a screen's chart block ----
    const { screens: seeded } = await import("../db/seed.mjs");
    const base = seeded.find((s) => s.name === "work_centre");
    const NAME = `charts_${tag}`;
    const byState = { block: "chart", title: "Lots on it, by state", width: 6, query: { json: { from: "lot", select: ["state", { count: "*", as: "lots" }], where: { eq: [{ field: "machine" }, { param: "machine" }] }, groupBy: ["state"] } }, chart: "donut", x: "state", y: ["lots"] };
    const allMachines = { block: "chart", title: "Lots per machine", width: 6, query: { sql: "SELECT machine AS m, count(*) AS lots FROM lot WHERE machine IS NOT NULL GROUP BY 1 ORDER BY 2 DESC" }, chart: "bar", x: "m", y: ["lots"], horizontal: true, marks: [{ value: 1, label: "capacity", tone: "warn" }] };
    const body = { name: NAME, label: `Charts ${tag}`, description: "A machine's lots, charted.", params: base.params, blocks: [byState, allMachines], callers: base.callers, stewards: base.stewards };
    const { id: change } = await call("dana", "design.start", { screen: NAME, label: body.label });
    const wrong = await call("dana", "design.save", { id: change, reason: "Charts on a machine's screen.", screens: { [NAME]: { ...body, blocks: [{ ...byState, chart: "sankey" }] } } });
    const saved = await call("dana", "design.save", { id: change, reason: "Charts on a machine's screen.", screens: { [NAME]: body } });
    const submitted = await attempt(call("dana", "design.submit", { id: change }));
    await attempt(call("vera", "design.review", { id: change, decision: "pass" }));
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) for (const user of people) {
        const seen = await call(user, "design.change", { id: change, as: user }).catch(() => null);
        for (const department of seen?.can?.approveFor ?? []) state = (await call(user, "design.approve", { id: change, department, decision: "approve", meaning: "Approved" })).state ?? state;
    }
    // A lot moved onto M-101, so the machine's chart has something of its own to draw.
    const [m101] = await db.query("SELECT id FROM mes.records WHERE object = 'machine' AND data->>'machine_id' = 'M-101'");
    const [wo] = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = 'WO-1002'");
    const lot = await call("sam", "records.create", { object: "lot", data: { lot_no: `CH-${tag}`, item: "PP-BLK-10", work_order: wo.id, qty: 10, uom: "kg" }, key: `ch-${tag}-lot` });
    const moved = await attempt(call("olga", "transactions.run", { name: "move_in", input: { lot: lot.id, machine: m101.id }, key: `ch-${tag}-mv` }));
    const shown = await call("olga", "screens.data", { name: NAME, arg: m101.id, as: "olga" });
    const [donut, bars] = shown.blocks ?? [];
    const onIt = await db.query("SELECT state, count(*)::int AS n FROM mes.records WHERE object = 'lot' AND archived_at IS NULL AND data->>'machine' = $1 GROUP BY 1", [m101.id]);
    const donutTotal = (donut?.rows ?? []).reduce((n, r) => n + Number(r[donut.columns.indexOf("lots")]), 0);
    const donutDrawn = chartOption({ chart: "donut", x: "state", y: ["lots"] }, donut ?? {}, theme);
    step("a screen's chart block: one that needs a column it does not name is refused in words; approved, it is read as the viewer: its JSON query takes the screen's machine (the lots on it, as the database counts them), its SQL one runs as written, both drawable",
        /a sankey chart needs/.test((wrong.problems ?? []).map((p) => p.message).join()) && !(saved.problems ?? []).length && submitted.ok && state === "executed" && (moved.ok || /full/.test(moved.message ?? "")) &&
        donutTotal === onIt.reduce((n, r) => n + r.n, 0) && donutTotal >= 1 && !donutDrawn.problem && (bars?.rows ?? []).length >= 1 && !bars.error,
        { wrong: wrong.problems, saved: saved.problems, submitted, state, moved, donut, onIt, bars });

    // One who may run the screen but not query a view the chart reads: that chart says so, the rest is drawn.
    const noView = { ...allMachines, title: "Audit", query: { sql: "SELECT actor AS a, count(*) AS n FROM mes.audit_log GROUP BY 1" } };
    const { id: change2 } = await call("dana", "design.start", { screen: NAME });
    await call("dana", "design.save", { id: change2, reason: "A chart over a table no view gives.", screens: { [NAME]: { ...body, blocks: [byState, noView] } } });
    const preview = await attempt(call("dana", "screens.preview", { screen: { ...body, blocks: [byState, noView] }, arg: m101.id }));
    await attempt(call("dana", "design.withdraw", { id: change2 }));
    const previewBlocks = preview.value?.data?.blocks ?? [];
    step("a chart whose query reads what no view gives (the audit trail) says it could not be read; the screen's other chart is drawn all the same",
        preview.ok && previewBlocks[1]?.error && !previewBlocks[0]?.error && (previewBlocks[0]?.rows ?? []).length >= 1, { preview: preview.ok ? previewBlocks.map((b) => b.error ?? `${(b.rows ?? []).length} rows`) : preview });

    // ---- 3. no id is ever shown ----
    const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = await call("sam", "reports.run", { report: { title: "Ids", blocks: [{ block: "table", query: { sql: "SELECT id, lot_no, machine, '00000000-0000-4000-8000-000000000000'::uuid AS nothing FROM lot WHERE machine IS NOT NULL" } }] } });
    const cells = ids.blocks[0].data?.rows ?? [];
    const col = (n) => ids.blocks[0].data.columns.indexOf(n);
    // A lot on M-101 (this run's, or one an earlier suite put there when the machine was full).
    const [onM101] = await db.query("SELECT id FROM mes.records WHERE object = 'lot' AND archived_at IS NULL AND data->>'machine' = $1 LIMIT 1", [m101.id]);
    const history = await call("olga", "records.history", { object: "lot", id: onM101.id });
    const historyText = JSON.stringify(history);
    step("no id is ever shown: a report's cells name each record by its title (the lot's own id as its number, its machine as M-101; an id that names no record, \"—\"), a screen chart is labelled M-101, a record's history says M-101",
        cells.length >= 1 && !cells.flat().some((v) => typeof v === "string" && UUIDISH.test(v)) && cells.some((r) => r[col("id")] === r[col("lot_no")]) && cells.some((r) => r[col("machine")] === "M-101") && cells.every((r) => r[col("nothing")] === "—") &&
        (bars?.rows ?? []).some((r) => r[0] === "M-101") && !(bars?.rows ?? []).flat().some((v) => typeof v === "string" && UUIDISH.test(v)) &&
        historyText.includes("M-101") && !/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i.test(JSON.stringify(history.map((h) => [h.before, h.after]))),
        { cells: cells.slice(0, 3), bars: bars?.rows, history: history.slice(0, 3).map((h) => [h.action, h.before, h.after]) });

    // ---- 4. the drawing library's browser module ----
    const lib = await fetch(`${mes}/vendor/echarts.js`);
    const text = await lib.text();
    step("the drawing library's browser module is served from the app itself, one module, its licence at the top",
        lib.status === 200 && /javascript/.test(lib.headers.get("content-type") ?? "") && /Apache License, Version 2\.0/.test(text.slice(0, 2000)) && /export\s*\{/.test(text.slice(-4000)) && text.length > 500_000 && CHART_ROWS > 0,
        { status: lib.status, type: lib.headers.get("content-type"), size: text.length });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app.close?.().catch(() => {});
    await pool.end();
}
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
