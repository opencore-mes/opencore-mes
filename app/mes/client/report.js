// A report (DESIGN.md §34): what a person, or the analytics copilot for them, puts together from the
// plant's queryable data. It is data, like a screen's layout: a title and blocks, each block naming
// the query it draws. Nothing in a report is a result: its queries run when it is opened, as whoever
// opens it, over the same views as the Queries page (§23), so two people opening one report each see
// what their own policies show them.
//
//   { title, description?,
//     blocks: [                                                   (1 to 12)
//       { block: "text",   text },                                the author's words
//       { block: "figure", title, query, value: column, unit? }   one number: the first row's value
//       { block: "chart",  title, query, chart: <kind>, x?, y?, series?, … }  a chart (charts.js: its kinds,
//                                          which columns go where, how it is drawn; §34.9)
//       { block: "table",  title, query, columns?: [columns] }
//       { block: "media",  title?, blob, name?, caption? }      a file kept here, shown as it is (§34.10): a
//                                          picture drawn, a PDF or spreadsheet to open; no query
//       { block: "assist", title, text, query, columns?: [columns], scope?: { object, by?, values } }
//                                          advice on a set of records (§34.6): the copilot's words, and
//                                          the rows to act on, in order
//     ],                                   each with width?: "quarter" | "third" | "half" | "full"
//     layout?: name,                       the report layout it was drawn on (§34.5), if any
//     scope?: { object, by?, values } }    the records the whole report is about (§34.6), its layout's
//   query: { sql: "SELECT …" }  or  { json: { from, select, where, groupBy, orderBy, limit } }
//
// Shared by the server (which checks a report before it is run or kept) and the browser (which draws
// it), so it imports nothing but the charts' contract, shared likewise.
import { CHART_KINDS, chartProblems, chartOf, columnsOf, rowsFor } from "./charts.js";
export const REPORT_BLOCKS = ["text", "figure", "chart", "table", "assist", "media"];
// A set of records a block is about (§34.6): those of `object` whose `by` (its title field when left
// out) is one of `values`. Named by what people call them, not by ids: a design is read by its
// reviewers and carried to other installations.
export const MAX_SCOPE = 50;
export function scopeProblems(scope, known = {}) {
    const out = [];
    if (!isPlain(scope)) return ["it is about a set of records: scope { object, by?, values: [what each is called] }."];
    if (typeof scope.object !== "string" || !LAYOUT_NAME.test(scope.object)) out.push("scope.object names the object its records are of.");
    else if (known.objects && !Object.hasOwn(known.objects, scope.object)) out.push(`"${scope.object}" is not an object.`);
    const fields = known.objects?.[scope.object]?.fields;
    if (scope.by !== undefined && (typeof scope.by !== "string" || !NAME.test(scope.by))) out.push("scope.by names the field the records are picked by.");
    else if (scope.by !== undefined && fields && !Object.hasOwn(fields, scope.by)) out.push(`${scope.object} has no field "${scope.by}".`);
    else if (scope.by === undefined && known.objects?.[scope.object] && !known.objects[scope.object].titleField) out.push(`${scope.object} has no title field: say which field its records are picked by (scope.by).`);
    const values = Array.isArray(scope.values) ? scope.values : [];
    if (!values.length || values.length > MAX_SCOPE || !values.every((v) => typeof v === "string" && v.trim() && v.length <= 120)) out.push(`scope.values lists what the records are called, one to ${MAX_SCOPE}.`);
    else if (new Set(values).size !== values.length) out.push("scope.values names a record twice.");
    for (const k of Object.keys(scope)) if (!["object", "by", "values"].includes(k)) out.push(`a scope has no "${k}".`);
    return out;
}
export const CHARTS = CHART_KINDS;
export const MAX_BLOCKS = 12;
export const MAX_SERIES = 6;
// How many rows of a block's query are drawn (a chart of more points says nothing; a table of more is
// a query to run on the Queries page).
export const BLOCK_ROWS = 200;
// How wide a block is drawn, in twelfths of the page; one that says nothing takes its kind's own.
export const WIDTHS = { quarter: 3, third: 4, half: 6, full: 12 };
export const WIDTH_OF = { text: "full", figure: "quarter", chart: "half", table: "full", assist: "full", media: "half" };
export const widthOf = (block) => (Object.hasOwn(WIDTHS, block?.width ?? "") ? block.width : WIDTH_OF[block?.block] ?? "full");

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LAYOUT_NAME = /^[a-z][a-z0-9_]{0,47}$/;

// What is wrong with a report: [{ path, message }], empty when it can be run.
export function reportProblems(report) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(report)) return [{ path: "", message: "A report is { title, blocks }." }];
    if (typeof report.title !== "string" || !report.title.trim() || report.title.length > 120) add("title", "Give the report a title, at most 120 characters.");
    if (report.description !== undefined && report.description !== null && (typeof report.description !== "string" || report.description.length > 500)) add("description", "The description is text, at most 500 characters.");
    const blocks = Array.isArray(report.blocks) ? report.blocks : [];
    if (!blocks.length) add("blocks", "A report has at least one block.");
    if (blocks.length > MAX_BLOCKS) add("blocks", `A report has at most ${MAX_BLOCKS} blocks.`);
    if (report.layout !== undefined && report.layout !== null && !(typeof report.layout === "string" && LAYOUT_NAME.test(report.layout))) add("layout", "The layout is a report layout's name.");
    if (report.scope !== undefined && report.scope !== null) for (const m of scopeProblems(report.scope)) add("scope", `The report: ${m}`);
    blocks.forEach((b, i) => {
        const at = `blocks.${i}`;
        const name = `Block ${i + 1}${isPlain(b) && typeof b.title === "string" && b.title ? ` (${b.title})` : ""}`;
        if (!isPlain(b) || !REPORT_BLOCKS.includes(b.block)) { add(at, `${name}: a block is one of ${REPORT_BLOCKS.join(", ")}.`); return; }
        if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > 120)) add(at, `${name}: the title is text, at most 120 characters.`);
        if (b.width !== undefined && !Object.hasOwn(WIDTHS, b.width)) add(at, `${name}: its width is one of ${Object.keys(WIDTHS).join(", ")}.`);
        if (b.block === "text") {
            if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 4000) add(at, `${name}: its text is words, at most 4000 characters.`);
            return;
        }
        // A file shown (§34.10): one kept here, by its name; no query.
        if (b.block === "media") {
            if (typeof b.blob !== "string" || !/^[0-9a-f]{64}$/.test(b.blob)) add(at, `${name}: blob names a file kept here (an attachment's id).`);
            if (b.name !== undefined && (typeof b.name !== "string" || b.name.length > 200)) add(at, `${name}: its name is at most 200 characters.`);
            if (b.caption !== undefined && (typeof b.caption !== "string" || b.caption.length > 500)) add(at, `${name}: its caption is at most 500 characters.`);
            if (b.query !== undefined) add(at, `${name}: a media block has no query.`);
            return;
        }
        const q = b.query;
        const sql = isPlain(q) && typeof q.sql === "string" && q.sql.trim();
        const json = isPlain(q) && isPlain(q.json);
        if (!sql && !json) add(at, `${name}: its query is { sql: "SELECT …" } or { json: { from, select, … } }.`);
        else if (sql && json) add(at, `${name}: its query is SQL or JSON, not both.`);
        else if (sql && q.sql.length > 20_000) add(at, `${name}: a query is at most 20 000 characters.`);
        const column = (v) => typeof v === "string" && NAME.test(v);
        if (b.block === "figure") {
            if (!column(b.value)) add(at, `${name}: value names the column that holds the number.`);
            if (b.unit !== undefined && (typeof b.unit !== "string" || b.unit.length > 20)) add(at, `${name}: the unit is a word or two.`);
        }
        if (b.block === "chart") for (const m of chartProblems(chartOf(b))) add(at, `${name}: ${m}`);
        if (b.block === "assist") {
            if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 4000) add(at, `${name}: its text is the advice, in words, at most 4000 characters.`);
            if (b.scope !== undefined) for (const m of scopeProblems(b.scope)) add(at, `${name}: ${m}`);
        }
        if ((b.block === "table" || b.block === "assist") && b.columns !== undefined && !(Array.isArray(b.columns) && b.columns.length && b.columns.length <= 20 && b.columns.every(column))) add(at, `${name}: columns lists the columns shown, at most 20.`);
    });
    return problems;
}

// A block's data as its drawing wants it, from what its query answered ({ columns, rows }): the columns
// it names, found by name; a value that is not a number is not drawn as one.
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
export function blockView(block, data) {
    const columns = data?.columns ?? [];
    const rows = (data?.rows ?? []).slice(0, BLOCK_ROWS);
    const at = (name) => columns.indexOf(name);
    const missing = (names) => names.filter((n) => at(n) < 0);
    if (block.block === "figure") {
        const lost = missing([block.value]);
        if (lost.length) return { problem: `Its query has no column "${lost[0]}" (it has ${columns.join(", ") || "none"}).` };
        return { value: rows.length ? num(rows[0][at(block.value)]) ?? rows[0][at(block.value)] : null };
    }
    // A chart: its spec, and the rows it draws (charts.js turns them into the drawing).
    if (block.block === "chart") {
        const lost = missing(columnsOf(block));
        if (lost.length) return { problem: `Its query has no column "${lost[0]}" (it has ${columns.join(", ") || "none"}).` };
        const all = data?.rows ?? [];
        const limit = rowsFor(block);
        return { chart: chartOf(block), data: { columns, rows: all.slice(0, limit) }, more: all.length > limit || Boolean(data?.truncated) };
    }
    if (block.block === "table" || block.block === "assist") {
        const shown = block.columns?.length ? block.columns : columns;
        const lost = missing(shown);
        if (lost.length) return { problem: `Its query has no column "${lost[0]}" (it has ${columns.join(", ") || "none"}).` };
        return { columns: shown, rows: rows.map((r) => shown.map((c) => r[at(c)])), more: (data?.rows ?? []).length > rows.length || Boolean(data?.truncated) };
    }
    return {};
}

// A chart's scale: the least and the most drawn (zero always in sight for bars), and round steps between.
export function scaleOf(values, { fromZero = true } = {}) {
    const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
    let lo = nums.length ? Math.min(...nums) : 0;
    let hi = nums.length ? Math.max(...nums) : 1;
    if (fromZero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (hi === lo) hi = lo + 1;
    const rough = (hi - lo) / 4;
    const pow = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough;
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let t = min; t <= max + step / 1e6; t += step) ticks.push(Math.round(t / step) * step);
    return { min, max, ticks };
}

// ---- report layouts (§34.5): how a report is laid out, as a design element ----------------------
//
// A layout is designed, reviewed and approved like a screen. It says which blocks a report has, in
// which order and how wide, and what each is for; it holds no query. Whoever asks for a report picks
// one, and the copilot fills it: a block per place, of the place's kind.
//
//   { name, label, description?,
//     guidance?: words for the copilot about the whole report (its period, its tone, what matters),
//     scope?: { object, by?, values }, goal?: words     an AI assisted line (§34.6): the records the
//                                                       whole report is about (a line's equipment),
//                                                       and what is to be achieved with them
//     blocks: [                                                  (1 to 12)
//       { block: "text" | "figure" | "chart" | "table" | "assist",
//         title?: the block's title, kept as written (without one, the copilot titles it),
//         width?: "quarter" | "third" | "half" | "full",
//         chart?: a chart's kind (charts.js CHART_KINDS; without one, the copilot chooses),
//         hint?: what belongs here ("lots released per day, the last 7 days"),
//         scope: { object, by?, values }, goal: words    (an assist block, §34.6: the records it is
//                                                         about, and what is to be achieved with them) }
//     ],
//     stewards: [departments] }
//
// Every block but an assist one names no object, field or view. An assist block names the records it
// is about (a line's equipment) and nothing else: still no query; the copilot writes it.
export const LAYOUT_KEYS = ["label", "description", "guidance", "scope", "goal", "blocks", "stewards"];
export const LAYOUT_TEMPLATE = (name, label, stewards) => ({
    name, label: (typeof label === "string" && label.trim()) || name.replace(/_/g, " "), description: "", guidance: "",
    blocks: [
        { block: "text", width: "full", hint: "The situation in two or three sentences: what stands out, with the numbers." },
        { block: "figure", width: "quarter", hint: "The one number that matters most." },
        { block: "chart", width: "half", hint: "How it compares or how it moved." },
        { block: "table", width: "full", hint: "The rows behind it." },
    ],
    stewards,
});

export function validateReportLayout(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A report layout is an object." }];
    if (!LAYOUT_NAME.test(body.name ?? "")) add("name", "A report layout's name is lower case letters, digits and _.");
    if (!(typeof body.label === "string" && body.label.trim()) || body.label.length > 120) add("label", "Give the layout a label, at most 120 characters.");
    if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 500)) add("description", "The description is text, at most 500 characters.");
    if (body.guidance !== undefined && (typeof body.guidance !== "string" || body.guidance.length > 2000)) add("guidance", "The guidance is words for the copilot, at most 2000 characters.");
    for (const k of Object.keys(body)) if (k !== "name" && !LAYOUT_KEYS.includes(k)) add(k, `A report layout has no "${k}".`);
    // An AI assisted line (§34.6): the records the whole report is about, and the goal.
    if (body.scope !== undefined) {
        for (const m of scopeProblems(body.scope, known)) add("scope", `The line: ${m}`);
        if (typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > 1000) add("goal", "Say what is to be achieved with the line's records (the goal), in at most 1000 characters.");
    } else if (body.goal !== undefined && body.goal !== "") add("goal", "A goal is for the records the layout is about: pick them (the line's equipment), or leave the goal out.");
    const blocks = Array.isArray(body.blocks) ? body.blocks : [];
    if (!blocks.length) add("blocks", "A layout has at least one block.");
    if (blocks.length > MAX_BLOCKS) add("blocks", `A layout has at most ${MAX_BLOCKS} blocks.`);
    blocks.forEach((b, i) => {
        const at = `blocks.${i}`;
        const name = `Block ${i + 1}`;
        if (!isPlain(b) || !REPORT_BLOCKS.includes(b.block)) { add(at, `${name}: a block is one of ${REPORT_BLOCKS.join(", ")}.`); return; }
        for (const k of Object.keys(b)) if (!["block", "title", "width", "chart", "hint", ...(b.block === "assist" ? ["scope", "goal"] : [])].includes(k)) add(at, `${name}: a layout's block has no "${k}" (a layout holds no query: the report's blocks do).`);
        if (b.title !== undefined && (typeof b.title !== "string" || b.title.length > 120)) add(at, `${name}: the title is text, at most 120 characters.`);
        if (b.width !== undefined && !Object.hasOwn(WIDTHS, b.width)) add(at, `${name}: its width is one of ${Object.keys(WIDTHS).join(", ")}.`);
        if (b.chart !== undefined && (b.block !== "chart" || !CHARTS.includes(b.chart))) add(at, b.block === "chart" ? `${name}: a chart is one of ${CHARTS.join(", ")}.` : `${name}: only a chart block names a chart.`);
        if (b.hint !== undefined && (typeof b.hint !== "string" || b.hint.length > 500)) add(at, `${name}: the hint is words, at most 500 characters.`);
        if (b.block === "assist") {
            for (const m of scopeProblems(b.scope, known)) add(at, `${name}: ${m}`);
            if (typeof b.goal !== "string" || !b.goal.trim() || b.goal.length > 1000) add(at, `${name}: say what is to be achieved with them (goal), in at most 1000 characters.`);
        }
    });
    const stewards = Array.isArray(body.stewards) ? body.stewards : [];
    if (!stewards.length) add("stewards", "Name at least one department that stewards it.");
    for (const d of stewards) if ((known.departments ?? []).length && !known.departments.includes(d)) add("stewards", `"${d}" is not a department.`);
    return problems;
}

// A layout made from a report (§34.11): its places in its order, each of its kind, as wide as it was drawn,
// under its title, a chart of its kind; what each place is for said in words from what the block showed
// (its columns, its first words), never its query. A file the report showed has no place: a layout's
// reports are not given one. An assist block's records stay; its goal is the designer's to write.
// → { body, dropped: [block numbers left out] }
export const layoutName = (title) => {
    const base = String(title ?? "").replace(/·.*$/, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
    return /^[a-z]/.test(base) ? base : `report_${base || "layout"}`.slice(0, 40);
};
export function layoutOfReport(report, { name, label } = {}) {
    const dropped = [];
    const blocks = [];
    (Array.isArray(report?.blocks) ? report.blocks : []).forEach((b, i) => {
        if (!isPlain(b) || b.block === "media" || !REPORT_BLOCKS.includes(b.block)) { dropped.push(i + 1); return; }
        const place = { block: b.block, width: widthOf(b) };
        if (typeof b.title === "string" && b.title.trim()) place.title = b.title.trim().slice(0, 120);
        if (b.block === "chart" && CHART_KINDS.includes(b.chart)) place.chart = b.chart;
        const said = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
        const first = (text) => { const t = said(text); return t.length > 160 ? `${t.slice(0, 157)}…` : t; };
        const c = chartOf(b);
        const hint = b.block === "text" ? (first(b.text) ? `Words like these: "${first(b.text)}"` : "")
            : b.block === "figure" ? `One number: ${said(b.value)}${b.unit ? ` (${said(b.unit)})` : ""}`
            : b.block === "chart" ? [c.y?.length ? said(c.y.join(", ")) : c.value ? said(c.value) : "", c.x ? `by ${said(c.x)}` : "", c.series ? `per ${said(c.series)}` : ""].filter(Boolean).join(" ")
            : b.block === "table" ? (Array.isArray(b.columns) && b.columns.length ? `Columns: ${b.columns.map(said).join(", ")}` : "")
            : "Advice in plain words, then the rows to act on, most urgent first.";
        if (hint) place.hint = hint.slice(0, 500);
        if (b.block === "assist") { place.scope = b.scope ?? report.scope ?? { object: "", values: [] }; place.goal = ""; }
        blocks.push(place);
    });
    return {
        body: {
            name, label: (typeof label === "string" && label.trim()) || String(report?.title ?? name).slice(0, 120),
            description: `Made from the report "${String(report?.title ?? "").slice(0, 200)}".`.slice(0, 500),
            guidance: report?.description ? String(report.description).slice(0, 2000) : "",
            blocks: blocks.slice(0, MAX_BLOCKS),
        },
        dropped,
    };
}

// A layout's footprint: its stewards. It reads and writes nothing.
const sameAs = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function reportLayoutFootprint(name, before, after) {
    if (sameAs(before, after)) return [];
    const of = (b) => (Array.isArray(b?.stewards) ? b.stewards : []);
    const answer = [...new Set([...of(before), ...of(after)])].filter(Boolean).sort();
    const element = `layout:${name}`;
    if (!before) return [{ element, change: "added", stewards: of(after).slice().sort() }];
    if (!after) return [{ element, change: "removed", stewards: of(before).slice().sort() }];
    return LAYOUT_KEYS.filter((k) => !sameAs(before[k], after[k])).map((k) => ({ element: `${element}.${k}`, change: "changed", stewards: answer }));
}

// Where a report departs from the layout it is drawn on: [messages], none when it follows it.
export function layoutDepartures(report, layout) {
    const out = [];
    const places = Array.isArray(layout?.blocks) ? layout.blocks : [];
    const blocks = Array.isArray(report?.blocks) ? report.blocks : [];
    if (blocks.length !== places.length) out.push(`The layout "${layout?.label ?? layout?.name}" has ${places.length} block(s), in this order: ${places.map((p, i) => `${i + 1} ${p.block}`).join(", ")}. The report has ${blocks.length}.`);
    places.forEach((p, i) => {
        const b = blocks[i];
        if (!isPlain(b)) return;
        if (b.block !== p.block) out.push(`Block ${i + 1} is a ${p.block} in the layout${p.title ? ` (${p.title})` : ""}, not a ${b.block}.`);
        else if (p.chart && b.chart !== p.chart) out.push(`Block ${i + 1} is a ${p.chart} chart in the layout, not a ${b.chart} chart.`);
    });
    return out;
}
// The report as its layout draws it: each block as wide as its place, under the place's title where
// the layout gives one. What the report keeps, so it is drawn the same once the layout has changed
// or is gone.
export function laidOut(report, layout) {
    const places = Array.isArray(layout?.blocks) ? layout.blocks : [];
    const { scope: _claimed, ...own } = report;
    return {
        ...own, layout: layout.name, ...(layout.scope ? { scope: layout.scope } : {}),
        blocks: (report.blocks ?? []).map((b, i) => {
            const p = places[i] ?? {};
            const out = { ...b, width: widthOf({ block: b.block, width: p.width }) };
            if (p.title) out.title = p.title;
            // The records it is about are the layout's, whatever the copilot wrote.
            if (b.block === "assist") { if (p.scope) out.scope = p.scope; else delete out.scope; }
            return out;
        }),
    };
}
