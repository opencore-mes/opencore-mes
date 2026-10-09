// Charts (§34.9) without a database or a browser: each kind's checks in words, the numbers a box plot and a
// histogram are drawn from, a sankey that would loop, what is never read as markup, and every kind drawn
// by the drawing library itself (Apache ECharts, server side, to SVG). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as echarts from "echarts";
import { KINDS, CHART_KINDS, chartProblems, chartOption, chartOf, columnsOf, rowsFor, boxStats, histogram, CHART_ROWS, RAW_ROWS } from "../client/charts.js";

const theme = { palette: ["#2f5fd0", "#0f9d74", "#d9822b"], ink: "#1d2230", muted: "#667085", line: "#e3e6ec", panel: "#ffffff", font: "sans-serif", tones: { neutral: "#667085", info: "#2f5fd0", ok: "#067647", warn: "#b54708", danger: "#b42318" }, number: (n) => String(Math.round(n * 100) / 100) };
const data = { columns: ["day", "line", "lots", "rate", "src", "dst", "o", "c", "l", "h"], rows: [
    ["Mon", "L1", 10, "0.5", "Cut", "Mold", 1, 2, 0, 3], ["Tue", "L1", 20, 0.6, "Mold", "Test", 2, 3, 1, 4], ["Mon", "L2", 5, 0.4, "Cut", "Test", 3, 2, 1, 5],
    ["Wed", "L2", 15, 0.9, "Test", "Pack", 2, 4, 1, 6], ["Thu", "L2", 45, 0.2, "Pack", "Ship", 2, 4, 1, 6]] };
const SPECS = {
    bar: { chart: "bar", x: "day", y: ["lots"], marks: [{ value: 12, label: "target", tone: "warn" }], bands: [{ from: 0, to: 8, tone: "danger" }] },
    line: { chart: "line", x: "day", y: ["lots", "rate"], step: true }, area: { chart: "area", x: "day", y: ["lots"], series: "line", stack: true },
    scatter: { chart: "scatter", x: "lots", y: ["rate"], series: "line" }, bubble: { chart: "bubble", x: "lots", y: ["rate"], size: "o" },
    pie: { chart: "pie", x: "day", y: ["lots"] }, donut: { chart: "donut", x: "day", y: ["lots"] }, funnel: { chart: "funnel", x: "day", y: ["lots"] },
    heatmap: { chart: "heatmap", x: "day", series: "line", value: "lots" }, boxplot: { chart: "boxplot", x: "line", y: ["lots"] },
    histogram: { chart: "histogram", y: ["lots"], marks: [{ value: 12 }] }, radar: { chart: "radar", x: "day", y: ["lots", "o"] },
    gauge: { chart: "gauge", y: ["lots"], min: 0, max: 30, bands: [{ from: 0, to: 10, tone: "danger" }, { from: 10, to: 30, tone: "ok" }] },
    treemap: { chart: "treemap", path: ["line", "day"], value: "lots" }, sunburst: { chart: "sunburst", path: ["line", "day"], value: "lots" },
    sankey: { chart: "sankey", source: "src", target: "dst", value: "lots" }, waterfall: { chart: "waterfall", x: "day", y: ["lots"] },
    pareto: { chart: "pareto", x: "day", y: ["lots"] }, candlestick: { chart: "candlestick", x: "day", open: "o", close: "c", low: "l", high: "h" },
    combo: { chart: "combo", x: "day", y: ["lots"], lines: ["rate"] },
};

test("every kind is checked, drawn and accepted by the drawing library, to SVG", () => {
    assert.deepEqual(Object.keys(SPECS).sort(), [...CHART_KINDS].sort());
    for (const [kind, spec] of Object.entries(SPECS)) {
        assert.deepEqual(chartProblems(spec), [], kind);
        const made = chartOption(spec, data, theme);
        assert.equal(made.problem, undefined, kind);
        const c = echarts.init(null, null, { renderer: "svg", ssr: true, width: 600, height: 320 });
        c.setOption(made.option);
        const svg = c.renderToSVGString();
        c.dispose();
        assert.match(svg, /^<svg/, kind);
        assert.ok((svg.match(/<path|<rect/g) ?? []).length > 3, `${kind} draws shapes`);
    }
});

test("a chart's mistakes are said in words: an unknown kind, a column missing, one too many, what its kind does not have", () => {
    assert.match(chartProblems({ chart: "spline" }).join(), /a chart is one of bar, line/);
    assert.match(chartProblems({ chart: "sankey", source: "a", target: "b" }).join(), /a sankey chart needs value/);
    assert.match(chartProblems({ chart: "pie", x: "a", y: ["b", "c"] }).join(), /draws one column of values/);
    assert.match(chartProblems({ chart: "pie", x: "a", y: ["b"], stack: true }).join(), /a pie chart has no stack/);
    assert.match(chartProblems({ chart: "bar", x: "a; DROP", y: ["b"] }).join(), /x names a column/);
    assert.match(chartProblems({ chart: "bar", x: "a", y: ["b", "c"], series: "s" }).join(), /with series, y names one column/);
    assert.match(chartProblems({ chart: "histogram", y: ["v"], bins: 1 }).join(), /bins is a whole number, 2 to 100/);
    assert.match(chartProblems({ chart: "gauge", y: ["v"], min: 5, max: 5 }).join(), /min is less than max/);
    assert.match(chartProblems({ chart: "bar", x: "a", y: ["b"], marks: [{ value: "x" }] }).join(), /mark 1 is \{ value, label\?, tone\? \}/);
    assert.match(chartProblems({ chart: "bar", x: "a", y: ["b"], bands: [{ from: 3, to: 1 }] }).join(), /band 1 is \{ from, to/);
    assert.match(chartProblems({ chart: "bar", x: "a", y: ["b"], marks: [{ value: 1, tone: "red" }] }).join(), /tone of neutral, info, ok, warn, danger/);
    assert.match(chartOption({ chart: "bar", x: "day", y: ["gone"] }, data, theme).problem, /no column "gone"/);
    assert.deepEqual(columnsOf(SPECS.candlestick).sort(), ["c", "day", "h", "l", "o"]);
    assert.deepEqual(chartOf({ block: "chart", title: "t", query: {}, chart: "bar", x: "a", y: ["b"], width: "half" }), { chart: "bar", x: "a", y: ["b"] });
    assert.equal(rowsFor({ chart: "bar" }), CHART_ROWS);
    assert.equal(rowsFor({ chart: "histogram" }), RAW_ROWS);
    for (const k of CHART_KINDS) assert.ok(KINDS[k].for && KINDS[k].label && KINDS[k].needs.length, k);
});

test("the numbers drawn are the query's: quartiles by interpolation and Tukey whiskers; bins over round edges, every value counted once", () => {
    const s = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
    assert.deepEqual([s.q1, s.median, s.q3], [3.25, 5.5, 7.75]);
    assert.deepEqual([s.low, s.high, s.outliers], [1, 9, [100]]);
    const vals = Array.from({ length: 100 }, (_, i) => i + 0.5);
    const h = histogram(vals, 10);
    assert.equal(h.reduce((n, b) => n + b.count, 0), 100);
    assert.deepEqual([h[0].from, h[0].to, h.length], [0, 10, 10]);
    assert.ok(h.every((b) => b.count === 10));
    assert.equal(histogram([5, 5, 5]).reduce((n, b) => n + b.count, 0), 3); // all one value: still drawn
    // A pie draws only parts of zero or more; a pareto sorts largest first and runs to 100%.
    const pareto = chartOption(SPECS.pareto, data, theme).option;
    assert.deepEqual(pareto.series[0].data, [45, 20, 15, 10, 5]);
    assert.equal(pareto.series[1].data.at(-1), 100);
    // A waterfall ends on the total of its changes.
    const fall = chartOption(SPECS.waterfall, data, theme).option;
    assert.equal(fall.xAxis.data.at(-1), "Total");
    assert.equal(fall.series[1].data.at(-1), 95);
    // Long rows: a series per distinct value, each value where its row puts it ("0.5" read as a number).
    const area = chartOption(SPECS.area, data, theme).option;
    assert.deepEqual(area.series.map((x) => x.name), ["L1", "L2"]);
    assert.deepEqual(area.series[1].data, [5, null, 15, 45]);
    assert.equal(chartOption({ chart: "line", x: "day", y: ["rate"] }, data, theme).option.series[0].data[0], 0.4); // the last Mon row
});

test("nothing a query answers is read as markup; a sankey that would loop is said, not drawn", () => {
    const evil = { columns: ["name", "n"], rows: [["<img src=x onerror=alert(1)>", 3], ["{a|b}", 2]] };
    const made = chartOption({ chart: "bar", x: "name", y: ["n"], marks: [{ value: 2, label: "{x} limit" }] }, evil, theme).option;
    assert.equal(made.tooltip.renderMode, "richText");
    assert.equal(made.series[0].markLine.data[0].label.formatter, "x limit");
    const loop = chartOption({ chart: "sankey", source: "a", target: "b", value: "n" }, { columns: ["a", "b", "n"], rows: [["X", "Y", 1], ["Y", "Z", 1], ["Z", "X", 1]] }, theme);
    assert.match(loop.problem, /A sankey cannot loop: X → Y → Z → X/);
    assert.match(chartOption({ chart: "sankey", source: "a", target: "b", value: "n" }, { columns: ["a", "b", "n"], rows: [["X", "X", 1]] }, theme).problem, /flows to itself/);
});

test("a chart of several series with a target line: drawn once, on the first; the others carry no mark that would hide their bars", () => {
    const spec = { chart: "bar", x: "m", y: ["oee", "availability", "quality"], marks: [{ value: 85, label: "world class", tone: "ok" }], bands: [{ from: 0, to: 60, tone: "danger" }] };
    const { option } = chartOption(spec, { columns: ["m", "oee", "availability", "quality"], rows: [["A", 70, 85, 97], ["B", 78, 88, 98]] }, theme);
    assert.equal(option.series.length, 3);
    assert.equal(option.series[0].markLine.data[0].yAxis, 85);
    assert.ok(option.series[0].markArea);
    for (const s of option.series.slice(1)) {
        assert.equal(s.markLine, undefined);
        assert.equal(s.markArea, undefined);
    }
    assert.ok(!JSON.stringify(option).includes('"none":'), "no mark on an axis that is not one");
});
