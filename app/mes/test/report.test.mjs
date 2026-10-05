// A report as data (DESIGN.md §34): what is wrong with one, what a block draws, a chart's scale, and
// the built-in object that keeps it.
import test from "node:test";
import assert from "node:assert/strict";
import { reportProblems, blockView, scaleOf, BLOCK_ROWS, MAX_BLOCKS } from "../client/report.js";
import { REPORT, BUILT_IN_SCRIPTS, CORE_LOCKS as LOCKS } from "../client/builtins.js";
import { validateDefinition as checkDefinition } from "../client/definition.js";

const q = { sql: "SELECT state, count(*) AS lots FROM lot GROUP BY state" };
const good = { title: "Lots", blocks: [
    { block: "text", text: "Where the lots are." },
    { block: "figure", title: "Lots", query: { sql: "SELECT count(*) AS n FROM lot" }, value: "n", unit: "lots" },
    { block: "chart", title: "By state", query: q, chart: "bar", x: "state", y: ["lots"] },
    { block: "table", title: "By state", query: { json: { from: "lot", select: ["state"] } }, columns: ["state"] },
] };

test("a report that can be run has no problems", () => assert.deepEqual(reportProblems(good), []));

test("what is wrong with a report is said per block", () => {
    const bad = (report) => reportProblems(report).map((p) => p.path);
    assert.deepEqual(bad(null), [""]);
    assert.deepEqual(bad({ title: " ", blocks: [] }), ["title", "blocks"]);
    assert.deepEqual(bad({ title: "x", blocks: Array.from({ length: MAX_BLOCKS + 1 }, () => good.blocks[0]) }), ["blocks"]);
    const one = (block) => bad({ title: "x", blocks: [block] });
    assert.deepEqual(one({ block: "script", text: "x" }), ["blocks.0"]);
    assert.deepEqual(one({ block: "text", text: "" }), ["blocks.0"]);
    assert.deepEqual(one({ block: "figure", query: {}, value: "n" }), ["blocks.0"]);
    assert.deepEqual(one({ block: "figure", query: { sql: "SELECT 1", json: {} }, value: "n" }), ["blocks.0"]);
    assert.deepEqual(one({ block: "figure", query: q, value: "n; DROP" }), ["blocks.0"]);
    assert.deepEqual(one({ block: "chart", query: q, chart: "spline", x: "state", y: ["lots"] }), ["blocks.0"]);
    assert.deepEqual(one({ block: "chart", query: q, chart: "radar", x: "state", y: ["lots"] }), []);
    assert.deepEqual(one({ block: "chart", query: q, chart: "sankey", source: "a", target: "b" }), ["blocks.0"]);
    assert.deepEqual(one({ block: "chart", query: q, chart: "pie", x: "state", y: ["a", "b"] }), ["blocks.0"]);
    assert.deepEqual(one({ block: "chart", query: q, chart: "bar", x: "state", y: [] }), ["blocks.0"]);
    assert.deepEqual(one({ block: "table", query: q, columns: [] }), ["blocks.0"]);
    assert.match(reportProblems({ title: "x", blocks: [{ block: "chart", title: "By state", query: q, chart: "bar", x: "state", y: [] }] })[0].message, /Block 1 \(By state\)/);
});

test("a block draws the columns it names, found by name", () => {
    const data = { columns: ["state", "lots", "held"], rows: [["released", "3", 1], ["hold", 2, null], [null, "n/a", 0]] };
    // A chart: its spec and the rows it draws, handed whole to the chart view (charts.js draws them).
    assert.deepEqual(blockView(good.blocks[2], data), { chart: { chart: good.blocks[2].chart, x: "state", y: ["lots"] }, data, more: false });
    assert.deepEqual(blockView({ block: "table", columns: ["held", "state"] }, data).rows[0], [1, "released"]);
    assert.deepEqual(blockView({ block: "table" }, data).columns, data.columns);
    assert.equal(blockView({ block: "figure", value: "lots" }, data).value, 3);
    assert.equal(blockView({ block: "figure", value: "lots" }, { columns: ["lots"], rows: [] }).value, null);
    assert.match(blockView({ block: "figure", value: "n" }, data).problem, /no column "n" \(it has state, lots, held\)/);
    assert.match(blockView({ block: "chart", x: "state", y: ["gone"] }, data).problem, /"gone"/);
    const many = { columns: ["n"], rows: Array.from({ length: BLOCK_ROWS + 5 }, (_, i) => [i]) };
    const table = blockView({ block: "table" }, many);
    assert.equal(table.rows.length, BLOCK_ROWS);
    assert.equal(table.more, true);
});

test("a chart's scale is round, and keeps zero in sight for bars", () => {
    assert.deepEqual(scaleOf([3, 7, 18]), { min: 0, max: 20, ticks: [0, 5, 10, 15, 20] });
    assert.deepEqual(scaleOf([]), { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    const below = scaleOf([-4, 6]);
    assert.ok(below.min <= -4 && below.max >= 6 && below.ticks.includes(0));
    const line = scaleOf([101, 104], { fromZero: false });
    assert.ok(line.min >= 100 && line.min <= 101 && line.max >= 104 && line.max <= 105, JSON.stringify(line));
    assert.equal(scaleOf([5, 5]).max > scaleOf([5, 5]).min, true);
});

test("the built-in Report is a design the checks pass, each rule with its script", () => {
    assert.deepEqual(checkDefinition(REPORT, { objects: ["report"], scripts: ["report_kept"], departments: ["$governance"], locks: LOCKS }), []);
    assert.deepEqual(REPORT.rules.map((r) => r.script).filter((name) => !BUILT_IN_SCRIPTS[name]), []);
    assert.ok(REPORT.policies.every((p) => p.when), "nobody reads a report that is neither theirs nor shared");
});

// ---- report layouts (§34.5) ----
import { validateReportLayout, reportLayoutFootprint, layoutDepartures, laidOut, widthOf, LAYOUT_TEMPLATE } from "../client/report.js";
import { layouts as seedLayouts } from "../db/seed.mjs";

const layout = { name: "shift", label: "Shift", stewards: ["production"], blocks: [{ block: "figure", title: "Lots", width: "third" }, { block: "chart", chart: "line" }, { block: "table", width: "half", hint: "The rows." }] };
const known = { departments: ["production", "quality"] };

test("a layout that can be published has no problems; the template and the seed's are such", () => {
    assert.deepEqual(validateReportLayout(layout, known), []);
    assert.deepEqual(validateReportLayout(LAYOUT_TEMPLATE("daily", "Daily", ["production"]), known), []);
    for (const l of seedLayouts) assert.deepEqual(validateReportLayout(l, known), [], l.name);
});

test("what is wrong with a layout is said: it holds no query", () => {
    const words = (body) => validateReportLayout(body, known).map((p) => p.message).join("\n");
    assert.match(words({ ...layout, blocks: [{ block: "figure", query: { sql: "SELECT 1" } }] }), /holds no query/);
    assert.match(words({ ...layout, blocks: [{ block: "table", width: "wide" }] }), /its width is one of/);
    assert.match(words({ ...layout, blocks: [{ block: "text", chart: "bar" }] }), /only a chart block names a chart/);
    assert.match(words({ ...layout, blocks: [] }), /at least one block/);
    assert.match(words({ ...layout, stewards: [] }), /at least one department/);
    assert.match(words({ ...layout, stewards: ["nobody"] }), /"nobody" is not a department/);
    assert.match(words({ ...layout, name: "Shift" }), /lower case/);
    assert.match(words({ ...layout, callers: {} }), /has no "callers"/);
});

test("a layout's footprint is its stewards: the old and the new for a change", () => {
    assert.deepEqual(reportLayoutFootprint("shift", undefined, layout), [{ element: "layout:shift", change: "added", stewards: ["production"] }]);
    assert.deepEqual(reportLayoutFootprint("shift", layout, layout), []);
    assert.deepEqual(reportLayoutFootprint("shift", layout, { ...layout, label: "Shifts", stewards: ["quality"] }), [
        { element: "layout:shift.label", change: "changed", stewards: ["production", "quality"] },
        { element: "layout:shift.stewards", change: "changed", stewards: ["production", "quality"] },
    ]);
});

test("a report follows its layout block for block, and is drawn as wide as the layout says", () => {
    const blocks = [{ block: "figure", title: "Mine", query: q, value: "lots", width: "full" }, { block: "chart", title: "By state", chart: "line", query: q, x: "state", y: ["lots"] }, { block: "table", query: q }];
    assert.deepEqual(layoutDepartures({ title: "x", blocks }, layout), []);
    assert.match(layoutDepartures({ title: "x", blocks: blocks.slice(0, 2) }, layout)[0], /has 3 block\(s\).*The report has 2/);
    assert.match(layoutDepartures({ title: "x", blocks: [blocks[2], blocks[1], blocks[0]] }, layout).join(" "), /Block 1 is a figure in the layout \(Lots\), not a table/);
    assert.match(layoutDepartures({ title: "x", blocks: [blocks[0], { ...blocks[1], chart: "bar" }, blocks[2]] }, layout)[0], /a line chart in the layout, not a bar chart/);
    const drawn = laidOut({ title: "x", blocks }, layout);
    assert.equal(drawn.layout, "shift");
    assert.deepEqual(drawn.blocks.map((b) => b.width), ["third", "half", "half"]);
    assert.deepEqual(drawn.blocks.map((b) => b.title), ["Lots", "By state", undefined]);
    assert.deepEqual(reportProblems(drawn), []);
});

test("a block is as wide as it says, or as its kind is", () => {
    assert.deepEqual(["text", "figure", "chart", "table"].map((block) => widthOf({ block })), ["full", "quarter", "half", "full"]);
    assert.equal(widthOf({ block: "figure", width: "half" }), "half");
    assert.equal(widthOf({ block: "figure", width: "toString" }), "quarter");
    assert.match(reportProblems({ title: "x", blocks: [{ block: "text", text: "x", width: "wide" }] })[0].message, /its width is one of/);
    assert.match(reportProblems({ ...good, layout: "Not A Name" })[0].message, /a report layout's name/);
});

// ---- an AI assisted line (§34.6) ----
import { scopeProblems } from "../client/report.js";

test("an assist block is about records the designer picked, and a goal; only it names records", () => {
    const objects = { machine: { titleField: "machine_id", fields: { machine_id: {}, name: {} } }, note: { titleField: null, fields: { text: {} } } };
    const line = { block: "assist", title: "Line 1", scope: { object: "machine", values: ["M-101", "M-102"] }, goal: "Meet the shift's output." };
    const of = (block) => validateReportLayout({ ...layout, blocks: [block] }, { ...known, objects }).map((p) => p.message).join("\n");
    assert.equal(of(line), "");
    assert.equal(of({ ...line, scope: { ...line.scope, by: "name" } }), "");
    assert.match(of({ ...line, scope: { object: "furnace", values: ["F-1"] } }), /"furnace" is not an object/);
    assert.match(of({ ...line, scope: { object: "note", values: ["x"] } }), /has no title field/);
    assert.match(of({ ...line, scope: { ...line.scope, values: [] } }), /one to 50/);
    assert.match(of({ ...line, scope: { ...line.scope, values: ["M-101", "M-101"] } }), /names a record twice/);
    assert.match(of({ ...line, scope: { ...line.scope, where: "1=1" } }), /a scope has no "where"/);
    assert.match(of({ ...line, goal: " " }), /what is to be achieved/);
    assert.match(of({ ...line, query: { sql: "SELECT 1" } }), /holds no query/);
    assert.match(of({ block: "table", scope: line.scope }), /a layout's block has no "scope"/);
    assert.deepEqual(scopeProblems(line.scope), [], "without the objects known (a pack read elsewhere), its shape alone is checked");
});

test("a report's assist block is advice and the rows to act on, about the layout's records", () => {
    const place = { block: "assist", title: "Line 1", scope: { object: "machine", values: ["M-101"] }, goal: "x" };
    const block = { block: "assist", title: "Mine", text: "Start LOT-1 first.", query: q, columns: ["state"], scope: { object: "lot", values: ["forged"] } };
    assert.deepEqual(reportProblems({ title: "x", blocks: [block] }), []);
    assert.match(reportProblems({ title: "x", blocks: [{ ...block, text: "" }] })[0].message, /its text is the advice/);
    const drawn = laidOut({ title: "x", blocks: [block] }, { name: "shift", blocks: [place] });
    assert.deepEqual(drawn.blocks[0].scope, place.scope);
    assert.equal(drawn.blocks[0].title, "Line 1");
    assert.equal(drawn.blocks[0].width, "full");
    assert.deepEqual(layoutDepartures({ title: "x", blocks: [{ block: "table", query: q }] }, { name: "shift", blocks: [place] }).length, 1);
    assert.deepEqual(blockView(block, { columns: ["state", "lots"], rows: [["released", 3]] }).rows, [["released"]]);
});

test("a layout may be an AI assisted line: the whole report is about the records picked, toward a goal", () => {
    const objects = { machine: { titleField: "machine_id", fields: { machine_id: {} } } };
    const line = { ...layout, scope: { object: "machine", values: ["M-101", "M-102"] }, goal: "Meet the shift's output." };
    const words = (body) => validateReportLayout(body, { ...known, objects }).map((p) => p.message).join("\n");
    assert.equal(words(line), "");
    assert.match(words({ ...line, goal: "" }), /Say what is to be achieved with the line's records/);
    assert.match(words({ ...line, scope: { object: "furnace", values: ["F-1"] } }), /The line: "furnace" is not an object/);
    assert.match(words({ ...layout, goal: "x" }), /A goal is for the records the layout is about/);
    assert.deepEqual(reportLayoutFootprint("shift", layout, line).map((e) => e.element), ["layout:shift.scope", "layout:shift.goal"]);
    const blocks = [{ block: "figure", query: q, value: "lots" }, { block: "chart", chart: "line", query: q, x: "state", y: ["lots"] }, { block: "table", query: q }];
    const drawn = laidOut({ title: "x", scope: { object: "lot", values: ["forged"] }, blocks }, line);
    assert.deepEqual(drawn.scope, line.scope, "the report is about the layout's records, whatever it claimed");
    assert.equal(laidOut({ title: "x", scope: line.scope, blocks }, layout).scope, undefined, "and about none when its layout names none");
    assert.deepEqual(reportProblems(drawn), []);
    assert.match(reportProblems({ ...drawn, scope: { object: "machine", values: [] } })[0].message, /The report: scope.values/);
});

// A layout made from a report (§34.11): its places are the report's blocks, never its queries.
import { layoutOfReport, layoutName } from "../client/report.js";
test("a layout made from a report: its blocks' kinds, order, widths, titles and chart kinds, in words, no query", () => {
    const report = { ...good, title: "Lots · 2026-10-05 06:00", description: "Every morning.", blocks: [...good.blocks, { block: "media", blob: "a".repeat(64), caption: "The line" }] };
    const { body, dropped } = layoutOfReport(report, { name: layoutName(report.title), label: "Lots" });
    assert.equal(body.name, "lots");
    assert.deepEqual(body.blocks.map((b) => [b.block, b.width, b.title ?? null, b.chart ?? null]), [["text", "full", null, null], ["figure", "quarter", "Lots", null], ["chart", "half", "By state", "bar"], ["table", "full", "By state", null]]);
    assert.match(body.blocks[0].hint, /Words like these: "Where the lots are\."/);
    assert.equal(body.blocks[1].hint, "One number: n (lots)");
    assert.equal(body.blocks[2].hint, "lots by state");
    assert.equal(body.blocks[3].hint, "Columns: state");
    assert.deepEqual(dropped, [5]);
    assert.ok(!JSON.stringify(body).includes("SELECT") && !JSON.stringify(body).includes('"query"'));
    assert.equal(body.guidance, "Every morning.");
    // With stewards, it is a layout the platform's own check passes.
    assert.deepEqual(validateReportLayout({ ...body, stewards: ["production"] }, known), []);
    assert.equal(layoutName("Équipe 2 · 2026-10-05"), "equipe_2");
    assert.equal(layoutName("2026 summary"), "report_2026_summary");
    assert.match(layoutName("x".repeat(80)), /^x{1,40}$/);
});
