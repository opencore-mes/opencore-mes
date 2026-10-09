// Charts (DESIGN.md §34.9): one contract for every chart OpenCore MES draws, a report's chart block
// (made by a person or the analytics copilot), a screen's chart block, the analytics page. A chart is
// data: its kind and which columns of its query go where. Its numbers are only ever its query's, run as
// whoever looks: neither the AI nor the designer writes a number into a chart, and no option of the
// drawing library is written by either. This module checks a chart and turns it, with its query's rows,
// into the drawing library's option (Apache ECharts, drawn in the browser: chart-view.js). Shared by the
// server (the checks) and the browser (the drawing), so it imports nothing.
//
//   { chart: <kind>, x?, y?: [columns], series?, size?, value?, source?, target?, path?: [columns],
//     open?, high?, low?, close?, lines?: [columns],              which column goes where (KINDS says)
//     stack?, horizontal?, smooth?, step?, labels?, log?: true,   how it is drawn
//     unit?: words after each value, bins?: 2-100 (a histogram), min?, max? (a gauge's, or an axis's),
//     marks?: [{ value, label?, tone? }]  reference lines (a target, limits) across the values,
//     bands?: [{ from, to, label?, tone? }]  shaded ranges (a gauge's coloured arcs) }
//
// Tones are the theme's (neutral, info, ok, warn, danger, §10.8), never a colour.

export const TONES = ["neutral", "info", "ok", "warn", "danger"];
export const MAX_SERIES = 8;
// Rows a chart draws: points and categories say nothing past a few hundred; a distribution (a histogram,
// a box plot, a scatter) is drawn from the values themselves, so more.
export const CHART_ROWS = 300;
export const RAW_ROWS = 5000;

// Each kind: what it is for (for people and for the AI), the columns it needs (`roles`: one column each;
// `y`, `path`, `lines`: lists), and what may be said of its drawing.
export const KINDS = {
    bar: { label: "Bar", for: "comparing amounts across categories, or over time; stack to show parts of a whole, horizontal for long names", needs: ["x", "y"], may: ["series", "stack", "horizontal", "labels", "log", "marks", "bands", "min", "max"] },
    line: { label: "Line", for: "a trend over time or along an ordered axis; several series compare trends; step for values that hold until they change", needs: ["x", "y"], may: ["series", "smooth", "step", "labels", "log", "marks", "bands", "min", "max"] },
    area: { label: "Area", for: "a trend with its volume; stack to show how parts add up over time", needs: ["x", "y"], may: ["series", "stack", "smooth", "step", "labels", "marks", "bands", "min", "max"] },
    scatter: { label: "Scatter", for: "how two measures relate, one point per row; series colours groups", needs: ["x", "y"], may: ["series", "log", "marks", "bands"], raw: true },
    bubble: { label: "Bubble", for: "three measures at once: position by two, size by a third", needs: ["x", "y", "size"], may: ["series", "log", "marks"], raw: true },
    pie: { label: "Pie", for: "shares of one whole, a few parts (six or fewer)", needs: ["x", "y"], may: ["labels"] },
    donut: { label: "Donut", for: "shares of one whole, with room for the total in the middle", needs: ["x", "y"], may: ["labels"] },
    funnel: { label: "Funnel", for: "amounts through successive stages (each stage a row)", needs: ["x", "y"], may: ["labels"] },
    heatmap: { label: "Heat map", for: "a value across two categories (a machine by hour, a defect by line)", needs: ["x", "series", "value"], may: ["labels", "min", "max"] },
    boxplot: { label: "Box plot", for: "how values spread, per group: median, quartiles, whiskers and outliers, from the values themselves", needs: ["y"], may: ["x", "horizontal", "marks", "bands"], raw: true },
    histogram: { label: "Histogram", for: "how one measure is distributed, counted in bins", needs: ["y"], may: ["bins", "marks", "bands", "labels"], raw: true },
    radar: { label: "Radar", for: "several measures of a few things side by side (each row a measure, each y a thing)", needs: ["x", "y"], may: ["labels"] },
    gauge: { label: "Gauge", for: "one value against its range (the first row), coloured bands for good and bad", needs: ["y"], may: ["min", "max", "bands", "labels"] },
    treemap: { label: "Tree map", for: "parts of a whole in levels (path: the columns from the top level down), sized by value", needs: ["path", "value"], may: ["labels"] },
    sunburst: { label: "Sunburst", for: "parts of a whole in levels, as rings (path: the columns from the top level down)", needs: ["path", "value"], may: ["labels"] },
    sankey: { label: "Sankey", for: "flows from one stage to the next (each row a flow: source, target, value); no loops", needs: ["source", "target", "value"], may: ["labels"] },
    waterfall: { label: "Waterfall", for: "how a total is built up and taken down, step by step (each row a change)", needs: ["x", "y"], may: ["labels", "marks"] },
    pareto: { label: "Pareto", for: "the few causes that matter most: bars largest first, with the running share", needs: ["x", "y"], may: ["labels", "marks"] },
    candlestick: { label: "Candlestick", for: "a range per period: where it opened, closed, and its low and high", needs: ["x", "open", "close", "low", "high"], may: ["marks", "bands"] },
    combo: { label: "Bars and lines", for: "amounts as bars with a rate or a trend as lines on a second axis (y: the bars, lines: the lines)", needs: ["x", "y", "lines"], may: ["stack", "labels", "marks", "bands"] },
};
export const CHART_KINDS = Object.keys(KINDS);
const ROLE_ONE = ["x", "series", "size", "value", "source", "target", "open", "high", "low", "close"];
const ROLE_LIST = ["y", "path", "lines"];
const FLAGS = ["stack", "horizontal", "smooth", "step", "labels", "log"];
// What every key of a chart says, for the checks and for the AI's tools.
export const CHART_KEYS = {
    chart: `the kind: ${CHART_KINDS.join(", ")}`,
    x: "the column along the bottom: categories, dates, or each slice's or stage's name",
    y: "the columns of values drawn (a list; one for pie, donut, funnel, gauge, waterfall, pareto, histogram, box plot)",
    series: "a column whose values each become a series (long rows: one value column in y, one series per distinct value); in a heat map, its rows",
    size: "a bubble's size", value: "the amount (a heat map's cell, a tree map's or sunburst's part, a sankey's flow)",
    source: "a sankey flow's start", target: "a sankey flow's end", path: "a tree map's or sunburst's levels, top first (a list)",
    open: "a candle's opening value", close: "its closing value", low: "its lowest", high: "its highest", lines: "a combo's columns drawn as lines on the second axis (a list)",
    stack: "stack the series", horizontal: "bars across", smooth: "smooth lines", step: "lines in steps", labels: "write each value", log: "a logarithmic value axis",
    unit: "a word after each value (h, %, pcs)", bins: "a histogram's number of bins (2 to 100; chosen when left out)",
    min: "the value axis's (or a gauge's) least", max: "its most",
    marks: "reference lines [{ value, label?, tone? }]: a target, control limits", bands: "shaded ranges [{ from, to, label?, tone? }]; a gauge's coloured arcs",
};

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const num = (v) => (isNum(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const words = (v, n) => typeof v === "string" && v.trim() && v.length <= n;

// The columns a chart reads, in the order its kind names them.
export function columnsOf(c) {
    const out = [];
    for (const k of ROLE_ONE) if (typeof c?.[k] === "string") out.push(c[k]);
    for (const k of ROLE_LIST) if (Array.isArray(c?.[k])) out.push(...c[k]);
    return [...new Set(out)];
}
export const rowsFor = (c) => (KINDS[c?.chart]?.raw ? RAW_ROWS : CHART_ROWS);

// What is wrong with a chart, in words a person reads: [messages], empty when it can be drawn.
export function chartProblems(c) {
    const out = [];
    if (!isPlain(c)) return ["a chart is { chart, x, y, … }."];
    const kind = KINDS[c.chart];
    if (!kind) return [`a chart is one of ${CHART_KINDS.join(", ")}.`];
    for (const k of ROLE_ONE) if (c[k] !== undefined && !(typeof c[k] === "string" && COLUMN.test(c[k]))) out.push(`${k} names a column of its query.`);
    for (const k of ROLE_LIST) if (c[k] !== undefined && !(Array.isArray(c[k]) && c[k].length && c[k].length <= MAX_SERIES && c[k].every((v) => typeof v === "string" && COLUMN.test(v)))) out.push(`${k} lists columns of its query, one to ${MAX_SERIES}.`);
    for (const need of kind.needs) if (c[need] === undefined) out.push(`a ${kind.label.toLowerCase()} chart needs ${need}: ${CHART_KEYS[need]}.`);
    const allowed = new Set(["chart", "unit", ...kind.needs, ...kind.may]);
    for (const k of [...ROLE_ONE, ...ROLE_LIST, ...FLAGS, "bins", "min", "max", "marks", "bands"]) if (c[k] !== undefined && !allowed.has(k)) out.push(`a ${kind.label.toLowerCase()} chart has no ${k}.`);
    const one = ["pie", "donut", "funnel", "gauge", "waterfall", "pareto", "histogram", "boxplot", "heatmap", "treemap", "sunburst", "sankey"];
    if (one.includes(c.chart) && Array.isArray(c.y) && c.y.length > 1) out.push(`a ${kind.label.toLowerCase()} chart draws one column of values (y).`);
    if (c.series !== undefined && c.chart !== "heatmap" && Array.isArray(c.y) && c.y.length > 1) out.push("with series, y names one column: its values are split by series.");
    if (c.path !== undefined && Array.isArray(c.path) && c.path.length > 4) out.push("path has at most 4 levels.");
    for (const k of FLAGS) if (c[k] !== undefined && typeof c[k] !== "boolean") out.push(`${k} is true or false.`);
    if (c.unit !== undefined && !words(c.unit, 12)) out.push("unit is a short word (h, %, pcs).");
    if (c.bins !== undefined && !(Number.isInteger(c.bins) && c.bins >= 2 && c.bins <= 100)) out.push("bins is a whole number, 2 to 100.");
    for (const k of ["min", "max"]) if (c[k] !== undefined && !isNum(c[k])) out.push(`${k} is a number.`);
    if (isNum(c.min) && isNum(c.max) && c.min >= c.max) out.push("min is less than max.");
    if (c.marks !== undefined) {
        if (!Array.isArray(c.marks) || c.marks.length > 8) out.push("marks lists up to 8 reference lines.");
        else c.marks.forEach((m, i) => { if (!isPlain(m) || !isNum(m.value) || (m.label !== undefined && !words(m.label, 40)) || (m.tone !== undefined && !TONES.includes(m.tone)) || Object.keys(m).some((k) => !["value", "label", "tone"].includes(k))) out.push(`mark ${i + 1} is { value, label?, tone? } (a tone of ${TONES.join(", ")}).`); });
    }
    if (c.bands !== undefined) {
        if (!Array.isArray(c.bands) || c.bands.length > 8) out.push("bands lists up to 8 ranges.");
        else c.bands.forEach((b, i) => { if (!isPlain(b) || !isNum(b.from) || !isNum(b.to) || b.from >= b.to || (b.label !== undefined && !words(b.label, 40)) || (b.tone !== undefined && !TONES.includes(b.tone)) || Object.keys(b).some((k) => !["from", "to", "label", "tone"].includes(k))) out.push(`band ${i + 1} is { from, to, label?, tone? }, from less than to.`); });
    }
    return out;
}
// The keys of a chart, from a block that carries one (a report's or a screen's), and nothing else.
export function chartOf(block) {
    const out = {};
    for (const k of Object.keys(CHART_KEYS)) if (block?.[k] !== undefined) out[k] = block[k];
    return out;
}

// ---- drawing ---------------------------------------------------------------------------------------
// theme: { palette: [colours], ink, muted, line, panel, font, tones: { neutral, info, ok, warn, danger },
// number(n) → words (the plant's format) }. → { option } or { problem }.
const label = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
const textOnly = (s) => String(s).replace(/[{}|]/g, ""); // the library reads braces as its own templates
const nice = (x) => { if (!(x > 0)) return 1; const p = 10 ** Math.floor(Math.log10(x)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= x) ?? x; };

export function chartOption(spec, data, theme) {
    const kind = KINDS[spec?.chart];
    if (!kind) return { problem: "It is not a chart this version draws." };
    const columns = data?.columns ?? [];
    const lost = columnsOf(spec).filter((c) => !columns.includes(c));
    if (lost.length) return { problem: `Its query has no column "${lost[0]}" (it has ${columns.join(", ") || "none"}).` };
    const rows = (data?.rows ?? []).slice(0, rowsFor(spec));
    const at = (c) => columns.indexOf(c);
    const col = (c) => rows.map((r) => r[at(c)]);
    const fmt = (v) => (isNum(v) ? `${theme.number(v)}${spec.unit ? ` ${spec.unit}` : ""}` : "—");
    const tone = (t) => theme.tones[t ?? "info"] ?? theme.tones.info;
    const base = {
        animationDuration: 300, color: theme.palette, textStyle: { color: theme.ink, fontFamily: theme.font },
        aria: { enabled: true }, grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
        // Text, never HTML: nothing a query answers is read as markup.
        tooltip: { renderMode: "richText", confine: true, backgroundColor: theme.panel, borderColor: theme.line, textStyle: { color: theme.ink }, valueFormatter: fmt },
    };
    const legendFor = (n) => (n > 1 ? { legend: { type: "scroll", top: 0, textStyle: { color: theme.muted }, icon: "roundRect" } } : {});
    // Counts are whole: when every value drawn is, so are the axis's steps.
    const whole = (values) => values.length > 0 && values.every((v) => v === null || v === "-" || Number.isInteger(v));
    const valueAxis = (extra = {}) => ({ type: spec.log ? "log" : "value", min: spec.min, max: spec.max, axisLabel: { color: theme.muted, formatter: (v) => theme.number(v) }, splitLine: { lineStyle: { color: theme.line } }, ...extra });
    const catAxis = (data, extra = {}) => ({ type: "category", data, axisLabel: { color: theme.muted, hideOverlap: true }, axisLine: { lineStyle: { color: theme.line } }, axisTick: { alignWithLabel: true }, ...extra });
    // Reference lines and bands, drawn once: on the first series (`along` its value axis); the others pass "none"
    // and carry none (a mark line on an axis that is not one is no line: ECharts then draws none of that series).
    const marked = (s, along = "yAxis") => (along === "none" ? s : {
        ...s,
        ...(spec.marks?.length ? { markLine: { symbol: "none", silent: true, data: spec.marks.map((m) => ({ [along]: m.value, lineStyle: { color: tone(m.tone), type: "dashed", width: 1.5 }, label: { formatter: textOnly(m.label ?? theme.number(m.value)), color: tone(m.tone), position: "insideEndTop" } })) } } : {}),
        ...(spec.bands?.length ? { markArea: { silent: true, data: spec.bands.map((b) => [{ [along]: b.from, name: textOnly(b.label ?? ""), itemStyle: { color: tone(b.tone), opacity: 0.12 }, label: { color: tone(b.tone) } }, { [along]: b.to }]) } } : {}),
    });
    const labels = spec.labels ? { label: { show: true, color: theme.ink, formatter: (p) => fmt(Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value) } } : {};

    // Categories and series for bar, line, area, combo, radar: wide (one series per y column) or long
    // (one y column, a series per distinct value of `series`).
    const categorical = () => {
        const cats = [...new Set(col(spec.x).map(label))];
        if (spec.series) {
            const names = [...new Set(col(spec.series).map(label))].slice(0, MAX_SERIES);
            const cell = new Map(rows.map((r) => [`${label(r[at(spec.x)])}\u0000${label(r[at(spec.series)])}`, num(r[at(spec.y[0])])]));
            return { cats, series: names.map((n) => ({ name: n, values: cats.map((c) => cell.get(`${c}\u0000${n}`) ?? null) })) };
        }
        const byCat = new Map();
        for (const r of rows) byCat.set(label(r[at(spec.x)]), r);
        return { cats, series: spec.y.map((y) => ({ name: y, values: cats.map((c) => num(byCat.get(c)?.[at(y)])) })) };
    };

    switch (spec.chart) {
        case "bar": case "line": case "area": {
            const { cats, series } = categorical();
            const flip = spec.chart === "bar" && spec.horizontal;
            const kindOf = spec.chart === "bar" ? "bar" : "line";
            return { option: { ...base, ...legendFor(series.length), tooltip: { ...base.tooltip, trigger: "axis" },
                xAxis: flip ? valueAxis(whole(series.flatMap((x) => x.values)) ? { minInterval: 1 } : {}) : catAxis(cats, spec.chart === "bar" ? {} : { boundaryGap: false }), yAxis: flip ? catAxis(cats, { inverse: true }) : valueAxis(whole(series.flatMap((x) => x.values)) ? { minInterval: 1 } : {}),
                series: series.map((s, i) => marked({ name: s.name, type: kindOf, data: s.values, ...(spec.stack ? { stack: "all" } : {}), ...(kindOf === "line" ? { smooth: Boolean(spec.smooth), ...(spec.step ? { step: "end" } : {}), showSymbol: cats.length <= 60, connectNulls: false } : { barMaxWidth: 48 }), ...(spec.chart === "area" ? { areaStyle: { opacity: spec.stack ? 0.6 : 0.25 } } : {}), ...labels }, i === 0 ? (flip ? "xAxis" : "yAxis") : "none")) } };
        }
        case "combo": {
            const bars = categorical();
            const lines = { ...spec, y: spec.lines, series: undefined };
            const byCat = new Map(rows.map((r) => [label(r[at(spec.x)]), r]));
            const lineSeries = lines.y.map((y) => ({ name: y, values: bars.cats.map((c) => num(byCat.get(c)?.[at(y)])) }));
            return { option: { ...base, ...legendFor(bars.series.length + lineSeries.length), tooltip: { ...base.tooltip, trigger: "axis" }, xAxis: catAxis(bars.cats), yAxis: [valueAxis(whole(bars.series.flatMap((x) => x.values)) ? { minInterval: 1 } : {}), valueAxis({ splitLine: { show: false } })],
                series: [...bars.series.map((s, i) => marked({ name: s.name, type: "bar", data: s.values, barMaxWidth: 48, ...(spec.stack ? { stack: "all" } : {}), ...labels }, i === 0 ? "yAxis" : "none")),
                    ...lineSeries.map((s) => ({ name: s.name, type: "line", yAxisIndex: 1, data: s.values, showSymbol: bars.cats.length <= 60 }))] } };
        }
        case "scatter": case "bubble": {
            const groups = new Map();
            const sizes = spec.size ? col(spec.size).map(num).filter(isNum) : [];
            const most = Math.max(1, ...sizes.map(Math.abs));
            for (const r of rows) {
                const x = num(r[at(spec.x)]), y = num(r[at(spec.y[0])]);
                if (x === null || y === null) continue;
                const g = spec.series ? label(r[at(spec.series)]) : spec.y[0];
                if (!groups.has(g)) { if (groups.size >= MAX_SERIES) continue; groups.set(g, []); }
                const s = spec.size ? num(r[at(spec.size)]) : null;
                groups.get(g).push(spec.size ? { value: [x, y, s], symbolSize: 6 + 34 * Math.sqrt(Math.abs(s ?? 0) / most) } : [x, y]);
            }
            return { option: { ...base, ...legendFor(groups.size), tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => `${p.seriesName}\n${spec.x}: ${theme.number(p.value[0])}\n${spec.y[0]}: ${fmt(p.value[1])}${spec.size ? `\n${spec.size}: ${theme.number(p.value[2])}` : ""}` },
                xAxis: valueAxis({ name: spec.x, nameLocation: "middle", nameGap: 26, nameTextStyle: { color: theme.muted }, min: undefined, max: undefined, scale: true }), yAxis: valueAxis({ name: spec.y[0], nameTextStyle: { color: theme.muted }, scale: true }),
                series: [...groups].map(([name, pts], i) => marked({ name, type: "scatter", data: pts, symbolSize: spec.size ? undefined : 8 }, i === 0 ? "yAxis" : "none")) } };
        }
        case "pie": case "donut": case "funnel": {
            let parts = rows.map((r) => ({ name: label(r[at(spec.x)]), value: num(r[at(spec.y[0])]) })).filter((p) => p.value !== null && p.value >= 0);
            if (spec.chart === "funnel") parts = parts.sort((a, b) => b.value - a.value);
            if (!parts.length) return { problem: "Nothing to draw: no row has a value of zero or more." };
            const showLabels = spec.labels !== false;
            return { option: { ...base, ...legendFor(parts.length > 1 && parts.length <= 12 ? 2 : 0), tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => `${p.name}: ${fmt(p.value)}${spec.chart !== "funnel" ? ` (${Math.round(p.percent * 10) / 10}%)` : ""}` },
                series: [spec.chart === "funnel"
                    ? { type: "funnel", top: 32, bottom: 8, left: "10%", width: "80%", sort: "descending", gap: 2, data: parts, label: { show: showLabels, color: theme.ink, formatter: (p) => `${p.name}: ${fmt(p.value)}` } }
                    : { type: "pie", radius: spec.chart === "donut" ? ["45%", "72%"] : ["0%", "72%"], center: ["50%", "56%"], data: parts, itemStyle: { borderColor: theme.panel, borderWidth: 2 }, label: { show: showLabels, color: theme.ink, formatter: (p) => `${p.name}\n${Math.round(p.percent * 10) / 10}%` } }] } };
        }
        case "heatmap": {
            const xs = [...new Set(col(spec.x).map(label))], ys = [...new Set(col(spec.series).map(label))];
            const cells = rows.map((r) => [xs.indexOf(label(r[at(spec.x)])), ys.indexOf(label(r[at(spec.series)])), num(r[at(spec.value)])]).filter((c) => c[2] !== null);
            const vals = cells.map((c) => c[2]);
            return { option: { ...base, tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => `${xs[p.value[0]]} · ${ys[p.value[1]]}: ${fmt(p.value[2])}` }, grid: { ...base.grid, bottom: 64 },
                xAxis: catAxis(xs, { splitArea: { show: true } }), yAxis: catAxis(ys, { splitArea: { show: true } }),
                visualMap: { min: spec.min ?? Math.min(0, ...vals), max: spec.max ?? Math.max(1, ...vals), calculable: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 120, textStyle: { color: theme.muted }, inRange: { color: [theme.panel, theme.palette[0]] }, formatter: (v) => theme.number(v) },
                series: [{ type: "heatmap", data: cells, label: { show: Boolean(spec.labels), color: theme.ink, formatter: (p) => theme.number(p.value[2]) }, itemStyle: { borderColor: theme.panel, borderWidth: 1 } }] } };
        }
        case "boxplot": {
            const groups = new Map();
            for (const r of rows) {
                const v = num(r[at(spec.y[0])]);
                if (v === null) continue;
                const g = spec.x ? label(r[at(spec.x)]) : spec.y[0];
                if (!groups.has(g)) groups.set(g, []);
                groups.get(g).push(v);
            }
            const names = [...groups.keys()];
            const boxes = [], outliers = [];
            names.forEach((g, i) => {
                const s = boxStats(groups.get(g));
                boxes.push([s.low, s.q1, s.median, s.q3, s.high]);
                for (const o of s.outliers) outliers.push(spec.horizontal ? [o, i] : [i, o]);
            });
            const flip = Boolean(spec.horizontal);
            return { option: { ...base, tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => (p.seriesType === "boxplot" ? `${p.name}\nmost ${fmt(p.value[5])}\nQ3 ${fmt(p.value[4])}\nmedian ${fmt(p.value[3])}\nQ1 ${fmt(p.value[2])}\nleast ${fmt(p.value[1])}` : `outlier: ${fmt(flip ? p.value[0] : p.value[1])}`) },
                xAxis: flip ? valueAxis({ scale: true }) : catAxis(names), yAxis: flip ? catAxis(names, { inverse: true }) : valueAxis({ scale: true }),
                series: [marked({ name: spec.y[0], type: "boxplot", data: boxes, itemStyle: { color: theme.panel, borderColor: theme.palette[0], borderWidth: 1.5 } }, flip ? "xAxis" : "yAxis"), { name: "outliers", type: "scatter", data: outliers, symbolSize: 6, itemStyle: { color: theme.tones.warn } }] } };
        }
        case "histogram": {
            const vals = col(spec.y[0]).map(num).filter(isNum);
            if (!vals.length) return { problem: "Nothing to draw: no row has a number." };
            const h = histogram(vals, spec.bins);
            return { option: { ...base, tooltip: { ...base.tooltip, trigger: "axis", formatter: (ps) => `${ps[0].name}\n${ps[0].value} of ${vals.length}` }, xAxis: catAxis(h.map((b) => `${theme.number(b.from)}–${theme.number(b.to)}`), { name: spec.y[0], nameLocation: "middle", nameGap: 26, nameTextStyle: { color: theme.muted } }),
                yAxis: { type: "value", minInterval: 1, axisLabel: { color: theme.muted }, splitLine: { lineStyle: { color: theme.line } } },
                series: [{ name: "count", type: "bar", barCategoryGap: "4%", data: h.map((b) => b.count), ...(spec.labels ? { label: { show: true, color: theme.ink } } : {}),
                    ...(spec.marks?.length || spec.bands?.length ? histogramMarks(spec, h, tone) : {}) }] } };
        }
        case "radar": {
            const { cats, series } = categorical();
            const most = Math.max(1, ...series.flatMap((s) => s.values.filter(isNum)));
            return { option: { ...base, ...legendFor(series.length), tooltip: { ...base.tooltip, trigger: "item" },
                radar: { indicator: cats.map((c) => ({ name: c, max: nice(most) })), axisName: { color: theme.muted }, splitLine: { lineStyle: { color: theme.line } }, splitArea: { show: false }, axisLine: { lineStyle: { color: theme.line } } },
                series: [{ type: "radar", data: series.map((s) => ({ name: s.name, value: s.values.map((v) => v ?? 0), areaStyle: { opacity: 0.15 } })), ...labels }] } };
        }
        case "gauge": {
            const v = rows.length ? num(rows[0][at(spec.y[0])]) : null;
            const min = spec.min ?? 0, max = spec.max ?? nice(Math.max(1, v ?? 1));
            const stops = (spec.bands ?? []).slice().sort((a, b) => a.to - b.to).map((b) => [Math.min(1, Math.max(0, (b.to - min) / (max - min))), tone(b.tone)]);
            return { option: { ...base, series: [{ type: "gauge", min, max, center: ["50%", "60%"], radius: "90%", progress: { show: !stops.length, width: 12 },
                axisLine: { lineStyle: { width: 12, color: stops.length ? [...stops, ...(stops[stops.length - 1][0] < 1 ? [[1, theme.line]] : [])] : [[1, theme.line]] } },
                axisTick: { show: false }, splitLine: { length: 8, lineStyle: { color: theme.muted } }, axisLabel: { color: theme.muted, distance: 18, formatter: (x) => theme.number(x) }, pointer: { itemStyle: { color: theme.ink } },
                detail: { valueAnimation: true, color: theme.ink, fontSize: 22, offsetCenter: [0, "40%"], formatter: (x) => fmt(x) }, data: [{ value: v ?? 0, name: textOnly(spec.y[0]) }], title: { color: theme.muted, offsetCenter: [0, "68%"] } }] } };
        }
        case "treemap": case "sunburst": {
            const root = [];
            for (const r of rows) {
                const v = num(r[at(spec.value)]);
                if (v === null || v < 0) continue;
                let level = root;
                spec.path.forEach((p, i) => {
                    const name = label(r[at(p)]);
                    let node = level.find((n) => n.name === name);
                    if (!node) { node = { name, ...(i < spec.path.length - 1 ? { children: [] } : { value: 0 }) }; level.push(node); }
                    if (i === spec.path.length - 1) node.value += v; else level = node.children;
                });
            }
            if (!root.length) return { problem: "Nothing to draw: no row has a value of zero or more." };
            return { option: { ...base, tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => `${(p.treePathInfo ?? []).slice(1).map((n) => n.name).join(" › ") || p.name}: ${fmt(p.value)}` },
                series: [spec.chart === "treemap"
                    ? { type: "treemap", data: root, roam: false, nodeClick: "zoomToNode", breadcrumb: { show: spec.path.length > 1, itemStyle: { color: theme.panel, borderColor: theme.line, textStyle: { color: theme.ink } } }, label: { show: true, formatter: (p) => `${p.name}${spec.labels ? `\n${fmt(p.value)}` : ""}` }, upperLabel: { show: spec.path.length > 1, color: theme.ink, height: 20 }, levels: [{ itemStyle: { borderColor: theme.panel, borderWidth: 2, gapWidth: 2 } }, { colorSaturation: [0.35, 0.6], itemStyle: { gapWidth: 1, borderColorSaturation: 0.6 } }] }
                    : { type: "sunburst", data: root, radius: ["12%", "92%"], center: ["50%", "54%"], itemStyle: { borderColor: theme.panel, borderWidth: 2 }, label: { rotate: "radial", color: theme.ink, minAngle: 8 } }] } };
        }
        case "sankey": {
            const links = new Map();
            for (const r of rows) {
                const s = label(r[at(spec.source)]), t = label(r[at(spec.target)]), v = num(r[at(spec.value)]);
                if (v === null || v <= 0) continue;
                if (s === t) return { problem: `A sankey flows from one thing to another: "${s}" flows to itself.` };
                const k = `${s}\u0000${t}`;
                links.set(k, (links.get(k) ?? 0) + v);
            }
            const list = [...links].map(([k, value]) => { const [source, target] = k.split("\u0000"); return { source, target, value }; });
            const loop = cycleOf(list);
            if (loop) return { problem: `A sankey cannot loop: ${loop.join(" → ")}.` };
            const nodes = [...new Set(list.flatMap((l) => [l.source, l.target]))].map((name, i) => ({ name, itemStyle: { color: theme.palette[i % theme.palette.length] } }));
            return { option: { ...base, tooltip: { ...base.tooltip, trigger: "item", formatter: (p) => (p.dataType === "edge" ? `${p.data.source} → ${p.data.target}: ${fmt(p.value)}` : `${p.name}: ${fmt(p.value)}`) },
                series: [{ type: "sankey", data: nodes, links: list, emphasis: { focus: "adjacency" }, nodeAlign: "justify", left: 8, right: 96, label: { color: theme.ink }, lineStyle: { color: "gradient", opacity: 0.35 } }] } };
        }
        case "waterfall": {
            const steps = rows.map((r) => ({ name: label(r[at(spec.x)]), value: num(r[at(spec.y[0])]) ?? 0 }));
            let run = 0;
            const base_ = [], up = [], down = [];
            for (const s of steps) {
                const from = run, to = run + s.value;
                base_.push(Math.min(from, to)); up.push(s.value >= 0 ? s.value : "-"); down.push(s.value < 0 ? -s.value : "-");
                run = to;
            }
            const cats = [...steps.map((s) => s.name), "Total"];
            base_.push(Math.min(0, run)); up.push(run >= 0 ? run : "-"); down.push(run < 0 ? -run : "-");
            return { option: { ...base, tooltip: { ...base.tooltip, trigger: "axis", formatter: (ps) => { const i = ps[0].dataIndex; return `${cats[i]}: ${fmt(i < steps.length ? steps[i].value : run)}`; } },
                xAxis: catAxis(cats), yAxis: valueAxis(whole([...up, ...down]) ? { minInterval: 1 } : {}),
                series: [{ type: "bar", stack: "w", silent: true, itemStyle: { color: "transparent" }, data: base_, tooltip: { show: false } },
                    marked({ name: "up", type: "bar", stack: "w", data: up, itemStyle: { color: theme.tones.ok }, ...labels }), { name: "down", type: "bar", stack: "w", data: down, itemStyle: { color: theme.tones.danger }, ...labels }] } };
        }
        case "pareto": {
            const parts = rows.map((r) => ({ name: label(r[at(spec.x)]), value: num(r[at(spec.y[0])]) })).filter((p) => p.value !== null && p.value >= 0).sort((a, b) => b.value - a.value);
            const total = parts.reduce((n, p) => n + p.value, 0) || 1;
            let run = 0;
            const share = parts.map((p) => Math.round(((run += p.value) / total) * 1000) / 10);
            return { option: { ...base, ...legendFor(2), tooltip: { ...base.tooltip, trigger: "axis", formatter: (ps) => `${ps[0].name}\n${spec.y[0]}: ${fmt(ps[0].value)}\nrunning share: ${ps[1]?.value ?? ""}%` },
                xAxis: catAxis(parts.map((p) => p.name)), yAxis: [valueAxis(whole(parts.map((p) => p.value)) ? { minInterval: 1 } : {}), { type: "value", min: 0, max: 100, axisLabel: { color: theme.muted, formatter: "{value}%" }, splitLine: { show: false } }],
                series: [marked({ name: spec.y[0], type: "bar", data: parts.map((p) => p.value), barMaxWidth: 48, ...labels }), { name: "running share", type: "line", yAxisIndex: 1, data: share, symbolSize: 5, itemStyle: { color: theme.tones.warn }, markLine: { symbol: "none", silent: true, data: [{ yAxis: 80, lineStyle: { color: theme.muted, type: "dotted" }, label: { show: false } }] } }] } };
        }
        case "candlestick": {
            const cats = col(spec.x).map(label);
            const data = rows.map((r) => [num(r[at(spec.open)]), num(r[at(spec.close)]), num(r[at(spec.low)]), num(r[at(spec.high)])]);
            return { option: { ...base, tooltip: { ...base.tooltip, trigger: "axis", formatter: (ps) => { const v = data[ps[0].dataIndex]; return `${ps[0].name}\nopen ${fmt(v[0])}\nclose ${fmt(v[1])}\nlow ${fmt(v[2])}\nhigh ${fmt(v[3])}`; } },
                xAxis: catAxis(cats), yAxis: valueAxis({ scale: true }),
                series: [marked({ type: "candlestick", data, itemStyle: { color: theme.tones.ok, color0: theme.tones.danger, borderColor: theme.tones.ok, borderColor0: theme.tones.danger } })] } };
        }
        default: return { problem: "It is not a chart this version draws." };
    }
}

// A box's numbers (Tukey): quartiles by linear interpolation, whiskers at the furthest values within 1.5
// times the box's height, the rest outliers.
export function boxStats(values) {
    const v = values.filter(isNum).slice().sort((a, b) => a - b);
    if (!v.length) return { low: null, q1: null, median: null, q3: null, high: null, outliers: [] };
    const q = (p) => { const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
    const q1 = q(0.25), median = q(0.5), q3 = q(0.75), iqr = q3 - q1;
    const inside = v.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
    return { low: inside[0], q1, median, q3, high: inside[inside.length - 1], outliers: v.filter((x) => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr) };
}
// Equal bins over round edges: as many as asked, else Sturges' rule (at least 5, at most 30). Each value
// in one bin; the last bin keeps its upper edge.
export function histogram(values, bins) {
    const v = values.filter(isNum);
    let lo = Math.min(...v), hi = Math.max(...v);
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    const n = bins ?? Math.min(30, Math.max(5, Math.ceil(Math.log2(v.length) + 1)));
    const width = nice((hi - lo) / n);
    const start = Math.floor(lo / width) * width;
    const count = Math.max(1, Math.ceil((hi - start) / width + 1e-9));
    const out = Array.from({ length: count }, (_, i) => ({ from: round(start + i * width), to: round(start + (i + 1) * width), count: 0 }));
    for (const x of v) out[Math.min(count - 1, Math.floor((x - start) / width + 1e-9))].count++;
    return out;
}
const round = (x) => Math.round(x * 1e9) / 1e9;
// A histogram's reference lines and bands, at the bin each value falls in (its axis is the bins').
function histogramMarks(spec, h, tone) {
    const binOf = (x) => Math.max(0, Math.min(h.length - 1, h.findIndex((b) => x < b.to) === -1 ? h.length - 1 : h.findIndex((b) => x < b.to)));
    const frac = (x) => { const i = binOf(x); const b = h[i]; return i + (x - b.from) / (b.to - b.from) - 0.5; };
    return {
        ...(spec.marks?.length ? { markLine: { symbol: "none", silent: true, data: spec.marks.map((m) => ({ xAxis: frac(m.value), lineStyle: { color: tone(m.tone), type: "dashed", width: 1.5 }, label: { formatter: textOnly(m.label ?? String(m.value)), color: tone(m.tone) } })) } } : {}),
        ...(spec.bands?.length ? { markArea: { silent: true, data: spec.bands.map((b) => [{ xAxis: frac(b.from), name: textOnly(b.label ?? ""), itemStyle: { color: tone(b.tone), opacity: 0.12 } }, { xAxis: frac(b.to) }]) } } : {}),
    };
}
// A loop among flows, if any: the names along it.
function cycleOf(links) {
    const next = new Map();
    for (const l of links) (next.get(l.source) ?? next.set(l.source, []).get(l.source)).push(l.target);
    const state = new Map(), stack = [];
    const visit = (n) => {
        state.set(n, 1); stack.push(n);
        for (const m of next.get(n) ?? []) {
            if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
            if (!state.has(m)) { const found = visit(m); if (found) return found; }
        }
        state.set(n, 2); stack.pop();
        return null;
    };
    for (const n of next.keys()) if (!state.has(n)) { const found = visit(n); if (found) return found; }
    return null;
}
