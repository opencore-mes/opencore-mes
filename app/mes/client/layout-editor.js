// The designer's editor for a report layout (DESIGN.md §34.5), beside the others, on the same working
// copy (`${w}.ly.<name>`). A layout says which blocks an AI report has, in which order and how wide,
// and what each is for; it holds no query. Approved by its stewards like anything else; once live,
// whoever asks the analytics copilot for a report may pick it, and the copilot fills it.
import { validateReportLayout, reportLayoutFootprint, REPORT_BLOCKS, CHARTS, WIDTHS, MAX_BLOCKS, MAX_SCOPE, widthOf } from "./report.js";
import { KINDS } from "./charts.js";
import { noDefault } from "./select.js";
import { transactionKnown } from "./transaction-editor.js";
import { layoutSketch } from "./reports.js";
import { changesOf, countByTab } from "./compare.js";
import { elementOps, jsonOf } from "./integration-editor.js";
import { W, text, labelled } from "./editor-kit.js";
import { icon } from "./icons.js";

export const LAYOUT_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["blocks", "Blocks"], ["preview", "Preview"], ["stewards", "Stewards"], ["json", "JSON"]];
const BLOCK_WORDS = { text: "text: the copilot's words", figure: "a figure: one number", chart: "a chart", table: "a table", assist: "an AI assisted line: advice on a set of records" };
const WIDTH_WORDS = { quarter: "a quarter of the page", third: "a third", half: "half", full: "the whole row" };
const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const toggleIn = (list, value, on) => { const set = new Set(list ?? []); if (on) set.add(value); else set.delete(value); return [...set]; };
const select = (ctx, value, options, onchange, extra = {}) => ({ select: { disabled: ctx.ro, onchange: (e) => onchange(e.target.value), ...extra, children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: value === v, textContent: l } }))) } });

// What a layout may name: the departments, and (an assist block, §34.6) the objects there will be.
const known = (api, w) => ({ departments: (api.peek("design.home.departments") ?? []).map((d) => d.id), objects: transactionKnown(api, w).objects });
export function layoutProblemsOf(api, id) {
    return Object.entries(api.peek(`${W(id)}.ly`) ?? {}).flatMap(([name, body]) => validateReportLayout(body, known(api, W(id))).map((p) => ({ ...p, message: `${name}: ${p.message}` })));
}
export function layoutElements(api, id, change) {
    return Object.entries(api.peek(`${W(id)}.ly`) ?? {}).flatMap(([name, body]) => reportLayoutFootprint(name, change.live.layouts?.[name] ?? undefined, body));
}

function generalTab(ctx) {
    return {
        div: {
            className: "ed-grid",
            children: [
                labelled("Name", { input: { type: "text", value: ctx.body.name, disabled: true } }, "Fixed once created."),
                labelled("Label", text(ctx, "label"), "What the person asking for a report picks it by."),
                labelled("Description", text(ctx, "description", { multiline: true }), "What the layout is for, shown under it when it is picked: \"The shift's report: output, holds and tools down.\""),
                // Its type (§34.6): a report on the plant, or an AI assisted line: a report about the records
                // picked here (a line's equipment) that says what to process to meet the goal.
                labelled("Type", select(ctx, ctx.body.scope ? "line" : "report", [["report", "A report"], ["line", "An AI assisted line: about the equipment picked here"]], (v) => ctx.ops.edit((b) => { if (v === "line") { b.scope ??= { object: "", values: [] }; b.goal ??= ""; } else { delete b.scope; delete b.goal; } })), "An AI assisted line is about one line: you pick its equipment and write its goal, and the copilot says which lots must be processed, and in which order, to meet it. For another line, copy the layout (Copy, on the Report layouts tab) and pick that line's equipment."),
                ...(ctx.body.scope ? scopeEditor(ctx, ctx.body, null) : []),
                labelled("Guidance for the copilot", text(ctx, "guidance", { multiline: true, placeholder: "The period it covers, what matters most, how it should read." }), "Words the copilot is given with the layout, about the whole report: \"Cover the last 24 hours. Lead with what needs action. Name lots and tools by their labels.\""),
            ],
        },
    };
}

// The records an assist block is about (§34.6): an object, and those of its records the designer
// picks, by what they are called (the object's title field). Found by typing, as the designer may read
// them; one typed in full is taken as written (a record to come, or one the designer may not read).
function scopeEditor(ctx, b, i) {
    const { api, ops, ro, w } = ctx;
    const objects = known(api, w).objects;
    const scope = b.scope ?? { object: "", values: [] };
    const S = `${w}.scopePick.${ctx.name}.${i ?? "all"}`;   // i: the block's place, or null for the layout's own
    const by = scope.by ?? objects[scope.object]?.titleField;
    const put = (next) => ops.edit((bb) => { (i === null ? bb : bb.blocks[i]).scope = next; });
    // One clicked among those found leaves what was typed and the rest of the list as they are, so
    // the next is one click away (a line's tools share a name: EQPWBD-01 to -08); one typed in full
    // and entered clears the box for the next name.
    const add = (value, typed = false) => {
        const v = String(value ?? "").trim();
        if (!v || (scope.values ?? []).includes(v) || (scope.values ?? []).length >= MAX_SCOPE) return;
        if (typed) { api.setValue(`${S}.q`, ""); api.setValue(`${S}.found`, []); }
        put({ ...scope, values: [...(scope.values ?? []), v] });
    };
    let timer = null;
    const search = (q) => {
        api.setValue(`${S}.q`, q);
        clearTimeout(timer);
        if (!q.trim() || !scope.object) { api.setValue(`${S}.found`, []); return; }
        timer = setTimeout(() => api.call("records.list", { object: scope.object, as: api.peek("me.id"), q: q.trim() }).then(
            (l) => {
                // Those called what was typed first; the list's search also finds a record by its other fields.
                const names = (l.rows ?? []).map((r) => String((by && r[by]) ?? r.$title ?? "")).filter(Boolean);
                const called = names.filter((n) => n.toLowerCase().includes(q.trim().toLowerCase()));
                api.setValue(`${S}.found`, (called.length ? called : names).slice(0, 24));
            },
            () => api.setValue(`${S}.found`, [])), 200);
    };
    return [
        { div: { className: "ed-row", children: [
            labelled("Records of", select(ctx, scope.object ?? "", [["", "—"], ...Object.entries(objects).map(([o, d]) => [o, d.label ?? o])], (v) => put({ object: v, values: [] })), "The object whose records make up the line: its equipment."),
        ] } },
        labelled(`Which (${(scope.values ?? []).length} of at most ${MAX_SCOPE})`, { div: { className: "scope-pick", children: [
            { div: { className: "scope-chips", children: (scope.values ?? []).map((v) => ({ span: { key: v, className: "scope-chip", children: [{ span: v }, ro() ? { span: {} } : { button: { type: "button", className: "mini", title: `Remove ${v}`, "aria-label": `Remove ${v}`, children: [icon("x")], onclick: () => put({ ...scope, values: scope.values.filter((x) => x !== v) }) } }] } })) } },
            ro() || !scope.object ? { span: {} } : { input: { type: "search", placeholder: `Type to find ${(objects[scope.object]?.label ?? scope.object).toLowerCase()} records; Enter adds what is typed`, value: () => api.getState(`${S}.q`, "") ?? "", oninput: (e) => search(e.target.value), onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); add(e.target.value, true); } } } },
            () => { const found = (api.getState(`${S}.found`, []) ?? []).filter((v) => !(scope.values ?? []).includes(v)); return found.length ? { div: { className: "scope-found", children: found.map((v) => ({ button: { key: v, type: "button", className: "btn ghost", textContent: `+ ${v}`, onclick: () => add(v) } })) } } : { span: {} }; },
        ] } }, by ? `Each by its ${(objects[scope.object]?.fields?.[by]?.label ?? by).toLowerCase()}, as people call it. The copilot keeps ${i === null ? "the whole report" : "this block"} to them, as far as whoever asks may read them.` : "Pick the object first."),
        labelled("The goal", text(ctx, i === null ? "goal" : `blocks.${i}.goal`, { multiline: true, placeholder: "Meet this shift's output target on every work order running on the line; what is due first goes first." }), "What is to be achieved with them, and where the targets are found if they are data. The copilot looks at what waits and what is done, and says what to process first and why."),
    ];
}

function blockCard(ctx, b, i, count) {
    const { ops, ro } = ctx;
    const move = (d) => ops.edit((bb) => { const [x] = bb.blocks.splice(i, 1); bb.blocks.splice(i + d, 0, x); });
    const put = (key, value) => ops.edit((bb) => { if (value === "" || value === undefined) delete bb.blocks[i][key]; else bb.blocks[i][key] = value; });
    return {
        fieldset: {
            key: `b${i}`,
            className: `tx-card screen-card ${ctx.changedAt(`block:${i}`)}`,
            children: [
                { legend: { children: [
                    { strong: `${i + 1}. ${BLOCK_WORDS[b.block] ?? b.block}` },
                    ro() || i === 0 ? { span: {} } : { button: { type: "button", className: "mini", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], onclick: () => move(-1) } },
                    ro() || i === count - 1 ? { span: {} } : { button: { type: "button", className: "mini", title: "Later", "aria-label": "Later", children: [icon("arrowDown")], onclick: () => move(1) } },
                    // A copy just below it: the same block for another set of records (the next line).
                    ro() || count >= MAX_BLOCKS ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "copy", title: b.block === "assist" ? "A copy below it, for another set of records" : "A copy below it", onclick: () => ops.edit((bb) => { bb.blocks.splice(i + 1, 0, JSON.parse(JSON.stringify(bb.blocks[i]))); }) } },
                    ro() || count === 1 ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: () => ops.edit((bb) => { bb.blocks.splice(i, 1); }) } },
                ] } },
                { div: { className: "ed-row", children: [
                    labelled("Kind", select(ctx, b.block, REPORT_BLOCKS.map((k) => [k, BLOCK_WORDS[k]]), (v) => ops.edit((bb) => { bb.blocks[i].block = v; if (v !== "chart") delete bb.blocks[i].chart; if (v === "assist") { bb.blocks[i].scope ??= { object: "", values: [] }; bb.blocks[i].goal ??= ""; } else { delete bb.blocks[i].scope; delete bb.blocks[i].goal; } }))),
                    labelled("Width", select(ctx, widthOf(b), Object.keys(WIDTHS).map((k) => [k, WIDTH_WORDS[k]]), (v) => put("width", v)), "Of a 12-column row; a narrow screen gives it more."),
                    b.block === "chart" ? labelled("Chart", select(ctx, b.chart ?? "", [["", "the copilot chooses"], ...CHARTS.map((c) => [c, KINDS[c].label])], (v) => put("chart", v)), b.chart && KINDS[b.chart] ? `For ${KINDS[b.chart].for}.` : "The copilot picks the kind that answers the question; pick one to fix it.") : { span: {} },
                ] } },
                labelled("Title", text(ctx, `blocks.${i}.title`, { placeholder: b.block === "assist" ? "the line's name: Line 1" : "none: the copilot titles it" }), "Kept as written on every report drawn on this layout."),
                ...(b.block === "assist" ? scopeEditor(ctx, b, i) : []),
                labelled("What belongs here", text(ctx, `blocks.${i}.hint`, { multiline: true, placeholder: b.block === "text" ? "The situation in two or three sentences, with the numbers." : b.block === "figure" ? "Lots released in the last 24 hours." : b.block === "chart" ? "Lots released per day, the last 7 days." : b.block === "assist" ? "Anything more: which columns the list shows, how many rows." : "Lots on hold: lot, hold reason, since when; longest first." }), "Said to the copilot, and shown to the person picking the layout. Say what, over which period, in which order: the copilot writes the query."),
            ],
        },
    };
}
function blocksTab(ctx) {
    const { body, ops, ro } = ctx;
    const blocks = body.blocks ?? [];
    return {
        div: {
            children: [
                hint("The report's blocks, in reading order. A layout holds no query: it says what each block is for, and the copilot fills it from what the person asking may read. A report drawn on it has exactly these blocks."),
                ...blocks.map((b, i) => blockCard(ctx, b, i, blocks.length)),
                ro() || blocks.length >= MAX_BLOCKS ? { span: {} } : select(ctx, "", [["", "+ add a block"], ...REPORT_BLOCKS.map((k) => [k, BLOCK_WORDS[k]])], (k) => { if (k) ops.edit((b) => { (b.blocks ??= []).push({ block: k, width: widthOf({ block: k }), ...(k === "assist" ? { scope: { object: "", values: [] }, goal: "" } : {}) }); }); }, { className: "add-block" }),
            ],
        },
    };
}
function previewTab(ctx) {
    return { div: { children: [
        hint("How a report drawn on it is laid out: each block where and as wide as it will be. Its content is the copilot's, from what whoever asks may read."),
        ctx.body.description ? { p: { className: "muted", textContent: ctx.body.description } } : { span: {} },
        layoutSketch(ctx.body.blocks ?? []),
    ] } };
}
function stewardsTab(ctx) {
    const depts = ctx.api.peek("design.home.departments") ?? [];
    return { div: { children: [
        hint("Its stewards approve every change to it. A layout reads and writes nothing: a report drawn on it is read by each person with their own rights."),
        { div: { className: "checks", children: depts.map((d) => ({ label: { key: d.id, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: (ctx.body.stewards ?? []).includes(d.id), onchange: (e) => ctx.ops.edit((b) => { b.stewards = toggleIn(b.stewards, d.id, e.target.checked); }) } }, { span: ` ${d.name}` }] } })) } },
    ] } };
}

export function registerLayoutEditor(juris) {
    juris.registerComponent("LayoutEditor", ({ id, editable, pane = 0, name, head }, api) => {
        const w = W(id);
        const ops = elementOps(api, id, "layout", name);
        const view = () => { const v = api.getState(`${w}.panes.${pane}.view`, "general"); return LAYOUT_VIEWS.some(([k]) => k === v) ? v : "general"; };
        const ro = () => !api.prop(editable);
        return {
            div: {
                className: "editor",
                children: [
                    { div: { className: "editor-head", children: [
                        head ?? { span: {} },
                        { nav: { className: "subtabs", children: LAYOUT_VIEWS.map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                            api.getState(`${w}.vrev`);
                            api.getState(`dc.${id}.updated_at`);
                            const all = changesOf(api, id, "layout", name);
                            const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                            return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                        }] } })) } },
                    ] } },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(ops.root);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const changed = new Set(changesOf(api, id, "layout", name).map((c) => `${c.element}:${c.change}`));
                        const changedAt = (el) => (changed.has(`${el}:added`) ? "diff-added" : changed.has(`${el}:changed`) ? "diff-changed" : "");
                        const ctx = { api, w, ops, ro, body, id, kind: "layout", name, root: ops.root, changedAt };
                        switch (view()) {
                            case "copilot": return { CopilotPanel: { key: `copilot-${id}`, id } };
                            case "changes": return { ChangesView: { key: `changes-ly-${name}`, id, kind: "layout", name, onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "blocks": return blocksTab(ctx);
                            case "preview": return previewTab(ctx);
                            case "stewards": return stewardsTab(ctx);
                            case "json": return jsonOf(ctx);
                            default: return generalTab(ctx);
                        }
                    },
                ],
            },
        };
    });
}
