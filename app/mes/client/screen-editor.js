// The designer's editor for a screen (DESIGN.md §26), beside the others, on the same working copy
// (`${w}.sc.<name>`). A screen is a list of blocks from a fixed set; the editor configures them and
// previews the draft with the designer's own rights. Approved by its stewards like anything else.
import { pickMany } from "./pick.js";
import { noDefault } from "./select.js";
import { validateScreen, screenFootprint, BLOCKS, MEASURES } from "./definition.js";
import { changesOf, countByTab } from "./compare.js";
import { elementOps, jsonOf } from "./integration-editor.js";
import { transactionKnown, maximizeSelect, inputFlowSelect } from "./transaction-editor.js";
import { W, clone, text, labelled, check } from "./editor-kit.js";
import { icon, withIcon } from "./icons.js";
import { floorConfig, registerFloorEditor } from "./floor-editor.js";
import { KINDS, CHART_KINDS, CHART_KEYS, TONES } from "./charts.js";

export const SCREEN_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["blocks", "Blocks"], ["preview", "Preview"], ["popup", "Pop-up"], ["callers", "Callers"], ["stewards", "Stewards"], ["json", "JSON"]];
const BLOCK_LABELS = { record: "one record", table: "a table of records", kpi: "a number", breakdown: "a breakdown (bars)", chart: "a chart from a query", transaction: "a transaction's form", text: "text", button: "a button that opens a screen", floor: "a floor layout: records where they stand, with their state" };
const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const toggleIn = (list, value, on) => { const set = new Set(list ?? []); if (on) set.add(value); else set.delete(value); return [...set]; };
const json = (v) => (v === undefined ? "" : JSON.stringify(v));
const parsed = (t) => { try { return { ok: true, value: t.trim() ? JSON.parse(t) : undefined }; } catch { return { ok: false }; } };

// What a screen may name: the objects (fields, states), the transactions (inputs, where they appear).
function screenKnown(api, w) {
    const home = api.peek("design.home") ?? {};
    const base = transactionKnown(api, w);
    const transactions = Object.fromEntries((home.transactions ?? []).map((t) => [t.name, { label: t.label, inputs: t.inputs ?? {}, appearsOn: t.appearsOn ?? null }]));
    for (const [n, t] of Object.entries(api.peek(`${w}.tx`) ?? {})) transactions[n] = { label: t.label, inputs: t.inputs ?? {}, appearsOn: t.appearsOn ?? null };
    // The screens a button may open and a pop-up may open over (§26.6, §26.7).
    const screens = [...new Set([...(home.screens ?? []).map((s) => s.name), ...Object.keys(api.peek(`${w}.sc`) ?? {})])];
    return { ...base, transactions, screens, suiteBlocks: home.suiteBlocks ?? {} };
}
export function screenProblems(api, id) {
    const w = W(id);
    const known = screenKnown(api, w);
    return Object.entries(api.peek(`${w}.sc`) ?? {}).flatMap(([name, body]) => validateScreen(body, known).map((p) => ({ ...p, message: `${name}: ${p.message}` })));
}
export function screenElements(api, id, change) {
    return Object.entries(api.peek(`${W(id)}.sc`) ?? {}).flatMap(([name, body]) => screenFootprint(name, change.live.screens?.[name] ?? undefined, body));
}

const checks = (ctx, items, current, onToggle) => ({
    div: { className: "checks", children: items.map(({ value, label }) => ({ label: { key: value, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: (current ?? []).includes(value), onchange: (e) => onToggle(value, e.target.checked) } }, { span: ` ${label ?? value}` }] } })) },
});
function exprInput(ctx, path, stored, apply, placeholder = "") {
    const draft = `${ctx.w}.exprText.sc.${ctx.name}.${path}`;
    const current = () => ctx.api.getState(draft, null) ?? json(stored);
    return { input: { type: "text", className: () => `expr-input${parsed(current()).ok ? "" : " bad"}`, disabled: ctx.ro, placeholder, spellcheck: false, value: current, oninput: (e) => { ctx.api.setValue(draft, e.target.value); const p = parsed(e.target.value); if (p.ok) apply(p.value); } } };
}
const select = (ctx, value, options, onchange, extra = {}) => ({ select: { disabled: ctx.ro, onchange: (e) => onchange(e.target.value), ...extra, children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: value === v, textContent: l } }))) } });

function generalTab(ctx) {
    const { api, body, ops, ro, name } = ctx;
    const known = screenKnown(api, ctx.w);
    const [param, spec] = Object.entries(body.params ?? {})[0] ?? [];
    const published = (api.peek("design.home.screens") ?? []).some((s) => s.name === name);
    const setParam = (fn) => ops.edit((b) => { const cur = Object.entries(b.params ?? {})[0]; const next = fn(cur ? { name: cur[0], ...cur[1] } : null); b.params = next ? { [next.name]: Object.fromEntries(Object.entries(next).filter(([k]) => k !== "name")) } : {}; });
    return {
        div: {
            className: "ed-grid",
            children: [
                labelled("Name", { input: { type: "text", value: body.name, disabled: true } }, `Fixed once created; it opens at /s/${name}.`),
                labelled("Label", text(ctx, "label"), "What the navigator and the tab say."),
                labelled("Description", text(ctx, "description", { multiline: true }), "One line under the title."),
                labelled("Opened with", select(ctx, param ? (spec.type === "ref" ? `ref:${spec.to}` : spec.type) : "", [["", "nothing (the same for everyone)"], ...Object.entries(known.objects).map(([o, d]) => [`ref:${o}`, `a ${(d.label ?? o).toLowerCase()} (a record)`]), ["string", "a word (e.g. a line)"], ["date", "a date"]],
                    (v) => setParam((cur) => (!v ? null : v.startsWith("ref:") ? { name: cur?.name ?? v.slice(4), label: known.objects[v.slice(4)]?.label ?? v.slice(4), type: "ref", to: v.slice(4), required: true, widget: "scan" } : { name: cur?.name ?? "value", label: cur?.label ?? "Value", type: v, required: true }))),
                "Its blocks read it as {\"param\": \"" + (param ?? "machine") + "\"}; the URL carries it (/s/" + name + "/<value>)."),
                param ? labelled("…called", { input: { type: "text", disabled: ro, value: param, onchange: (e) => { const v = e.target.value.trim(); if (/^[a-z][a-z0-9_]{0,47}$/.test(v)) setParam((cur) => ({ ...cur, name: v })); } } }, "The name blocks use for it.") : { span: {} },
                param && spec.type === "ref" ? labelled("…picked by", select(ctx, spec.widget ?? "scan", [["scan", "scanning or typing its label"], ["select", "choosing from a list"]], (v) => setParam((cur) => ({ ...cur, widget: v })))) : { span: {} },
                param && spec.type === "ref" ? labelled("…only those where", exprInput(ctx, `params.${param}.where`, spec.where, (v) => ops.set(`params.${param}.where`, v, false), 'any (e.g. {"process": ["die_saw"]})'), "Fields equal to these values: a die saw's screen opens with die saws only, and lists only them.") : { span: {} },
                labelled("Fill the window", maximizeSelect(ctx), "A Maximize button sets the navigator, the top bar and the tabs aside: a board on a wall, a tablet at a machine. Each device remembers the person's choice."),
                labelled("Input flow", inputFlowSelect(ctx), "How the screen is filled from the keyboard or a scanner: its parameter (param) and its transactions' inputs (<transaction>.<input>), their tabs shown in turn, and back to the start for the next one. Drawn in the Flow designer (a flow template of kind input)."),
                published ? { p: { children: [{ Link: { to: `/s/${name}`, className: "btn", textContent: "Open it (the published version)" } }] } } : { span: {} },
            ],
        },
    };
}

// `where`: field = value rows, each value a JSON expression or a list.
function whereEditor(ctx, i, b, known) {
    const fields = known.objects[b.object]?.fields ?? {};
    const unused = ["state", ...Object.keys(fields)].filter((f) => !Object.hasOwn(b.where ?? {}, f));
    const param = Object.keys(ctx.body.params ?? {})[0];
    return {
        div: {
            className: "tx-sets",
            children: [
                { strong: { className: "small", textContent: "Only records where" } },
                ...Object.entries(b.where ?? {}).map(([f, v]) => ({ div: { key: f, className: "tx-set", children: [
                    { code: f }, { span: " = " },
                    exprInput(ctx, `blocks.${i}.where.${f}`, v, (val) => ctx.ops.set(`blocks.${i}.where.${f}`, val === undefined ? null : val, false), f === "state" ? '["processing"]' : param ? `{"param": "${param}"}` : '"value"'),
                    ctx.ro() ? { span: {} } : { button: { type: "button", className: "mini", title: "Remove the condition", "aria-label": "Remove the condition", children: [icon("x")], onclick: () => ctx.ops.edit((bb) => { delete bb.blocks[i].where[f]; }) } },
                ] } })),
                ctx.ro() || !unused.length ? { span: {} } : select(ctx, "", [["", "+ condition"], ...unused.map((f) => [f, f === "state" ? "state" : fields[f].label ?? f])], (f) => { if (f) ctx.ops.edit((bb) => { bb.blocks[i].where = { ...(bb.blocks[i].where ?? {}), [f]: f === "state" ? [] : fields[f]?.type === "ref" && ctx.body.params?.[param]?.to === fields[f].to ? { param } : null }; }); }, { className: "mini-select" }),
                Object.keys(b.where ?? {}).length ? { span: {} } : { span: { className: "muted small", textContent: " (every record in use)" } },
            ],
        },
    };
}
const measureEditor = (ctx, i, b, known) => {
    const numeric = Object.entries(known.objects[b.object]?.fields ?? {}).filter(([, f]) => ["integer", "decimal"].includes(f.type));
    const value = b.measure && b.measure !== "count" ? `${Object.keys(b.measure)[0]}:${Object.values(b.measure)[0]}` : "count";
    return labelled("Measure", select(ctx, value, [["count", "how many records"], ...numeric.flatMap(([f, d]) => MEASURES.map((m) => [`${m}:${f}`, `${m} of ${(d.label ?? f).toLowerCase()}`]))], (v) => ctx.ops.set(`blocks.${i}.measure`, v === "count" ? "count" : { [v.split(":")[0]]: v.split(":")[1] }, true)));
};
const sinceEditor = (ctx, i, b) => labelled("Changed", select(ctx, b.since ?? "", [["", "at any time"], ["today", "today"], ["7d", "in the last 7 days"], ["30d", "in the last 30 days"]], (v) => ctx.ops.edit((bb) => { if (v) bb.blocks[i].since = v; else delete bb.blocks[i].since; })), "By when a record last changed.");

function blockCard(ctx, b, i, count, known) {
    const { ops, ro } = ctx;
    const objects = Object.entries(known.objects);
    const fields = known.objects[b.object]?.fields ?? {};
    const fieldOptions = ["state", ...Object.keys(fields)].map((f) => ({ value: f, label: f === "state" ? "state" : fields[f].label ?? f }));
    const param = Object.entries(ctx.body.params ?? {})[0];
    const move = (d) => ops.edit((bb) => { const [x] = bb.blocks.splice(i, 1); bb.blocks.splice(i + d, 0, x); });
    const objectPicker = ["record", "table", "kpi", "breakdown", "floor"].includes(b.block)
        ? labelled("Of", select(ctx, b.object ?? "", [["", "—"], ...objects.map(([o, d]) => [o, d.label ?? o])], (v) => ops.edit((bb) => { bb.blocks[i] = { block: b.block, title: b.title, width: b.width, object: v, ...(b.block === "table" ? { columns: [known.objects[v]?.titleField ?? "state"].filter(Boolean) } : b.block === "record" ? { show: ["state"], of: param && param[1].to === v ? { param: param[0] } : undefined } : b.block === "breakdown" ? { by: "state", measure: "count" } : b.block === "floor" ? { status: "state", colours: {}, ...(b.image ? { image: b.image } : {}), places: [] } : { measure: "count", label: "records" }) }; })))
        : { span: {} };
    let config = [];
    switch (b.block) {
        // A floor layout (§35): its status, legend and pictures, and the floor arranged by hand.
        case "floor":
            config = floorConfig(ctx, b, i, known);
            break;
        case "record":
            config = [
                labelled("Which record", exprInput(ctx, `blocks.${i}.of`, b.of, (v) => ops.set(`blocks.${i}.of`, v, false), param ? `{"param": "${param[0]}"}` : "a record id"), param ? `The screen's ${param[0]}: {"param": "${param[0]}"}` : "Give the screen a record to be opened with (General)."),
                labelled("Shows", checks(ctx, fieldOptions, b.show, (v, on) => ops.edit((bb) => { bb.blocks[i].show = toggleIn(bb.blocks[i].show, v, on); }))),
            ];
            break;
        case "table": {
            const txs = Object.entries(known.transactions).filter(([, t]) => t.appearsOn?.object === b.object);
            config = [
                whereEditor(ctx, i, b, known),
                labelled("Columns", checks(ctx, fieldOptions, b.columns, (v, on) => ops.edit((bb) => { bb.blocks[i].columns = toggleIn(bb.blocks[i].columns, v, on); })), "The first column links to the record."),
                { div: { className: "ed-row", children: [
                    labelled("Sorted by", select(ctx, b.sort?.field ?? "", [["", "last changed first"], ...fieldOptions.map((o) => [o.value, o.label])], (v) => ops.edit((bb) => { if (v) bb.blocks[i].sort = { field: v, dir: bb.blocks[i].sort?.dir ?? "asc" }; else delete bb.blocks[i].sort; }))),
                    b.sort ? labelled("Direction", select(ctx, b.sort.dir ?? "asc", [["asc", "ascending"], ["desc", "descending"]], (v) => ops.set(`blocks.${i}.sort.dir`, v, true))) : { span: {} },
                    labelled("At most", { input: { type: "number", min: 1, max: 1000, disabled: ro, value: b.limit ?? 200, onchange: (e) => ops.set(`blocks.${i}.limit`, Math.max(1, Math.min(1000, Number(e.target.value) || 200)), true) } }, "rows in all"),
                    labelled("Drawn at a time", { input: { type: "number", min: 5, max: 200, disabled: ro, value: b.pageSize ?? 25, onchange: (e) => ops.set(`blocks.${i}.pageSize`, Math.max(5, Math.min(200, Number(e.target.value) || 25)), true) } }, "more as it is scrolled"),
                ] } },
                labelled("Record buttons", { div: { className: "checks", children: [
                    { label: { children: [{ input: { type: "checkbox", disabled: ro, checked: Boolean(b.create), onchange: (e) => ops.edit((bb) => { if (e.target.checked) bb.blocks[i].create = true; else delete bb.blocks[i].create; }) } }, { span: " New (for whoever may create one)" }] } },
                    { label: { children: [{ input: { type: "checkbox", disabled: ro, checked: Boolean(b.archive), onchange: (e) => ops.edit((bb) => { if (e.target.checked) bb.blocks[i].archive = true; else delete bb.blocks[i].archive; }) } }, { span: " Remove on each row (archives it; for whoever may archive it)" }] } },
                ] } }, "The object's own, through its policies and rules, as on its list and form."),
                labelled("Buttons on each row", txs.length ? checks(ctx, txs.map(([n, t]) => ({ value: n, label: `${t.label ?? n}${t.appearsOn?.states?.length ? ` (${t.appearsOn.states.join(", ")})` : ""}` })), b.rowActions, (v, on) => ops.edit((bb) => { bb.blocks[i].rowActions = toggleIn(bb.blocks[i].rowActions, v, on); })) : { span: { className: "muted small", textContent: `No transaction appears on ${b.object ?? "these"} records.` } }, "A transaction that appears on these records, run right here with the row filled in; shown on rows in its states."),
                // What the row buttons fill in besides the row: the screen's parameter, for an input of its kind.
                ...(param && param[1].type === "ref" ? (() => {
                    const fillable = [...new Set((b.rowActions ?? []).flatMap((t) => Object.entries(known.transactions[t]?.inputs ?? {}).filter(([, s]) => !s.from && s.type === "ref" && s.to === param[1].to).map(([k]) => k)))];
                    return fillable.length ? [labelled("…filling in", { div: { children: fillable.map((k) => ({ div: { key: k, className: "tx-set", children: [
                        { code: k }, { span: " = " },
                        select(ctx, b.fills?.[k] ? json(b.fills[k]) : "", [["", "entered by the person"], [json({ param: param[0] }), `the screen's ${param[0]}`]], (v) => ops.edit((bb) => { bb.blocks[i].fills = { ...(bb.blocks[i].fills ?? {}) }; if (v) bb.blocks[i].fills[k] = JSON.parse(v); else delete bb.blocks[i].fills[k]; if (!Object.keys(bb.blocks[i].fills).length) delete bb.blocks[i].fills; })),
                    ] } })) } }, "Shown locked on the row's form: the screen's equipment on Move in.")] : [];
                })() : []),
            ];
            break;
        }
        case "kpi":
            config = [whereEditor(ctx, i, b, known), { div: { className: "ed-row", children: [measureEditor(ctx, i, b, known), sinceEditor(ctx, i, b), labelled("Says", text(ctx, `blocks.${i}.label`, { placeholder: "lots" }), "After the number.")] } }];
            break;
        case "breakdown":
            config = [
                whereEditor(ctx, i, b, known),
                { div: { className: "ed-row", children: [
                    labelled("By", select(ctx, b.by ?? "state", fieldOptions.filter((o) => o.value === "state" || !["text", "decimal", "integer", "date"].includes(fields[o.value]?.type)).map((o) => [o.value, o.label]), (v) => ops.set(`blocks.${i}.by`, v, true))),
                    measureEditor(ctx, i, b, known), sinceEditor(ctx, i, b),
                ] } },
            ];
            break;
        case "transaction": {
            const t = known.transactions[b.name];
            config = [
                labelled("Transaction", select(ctx, b.name ?? "", [["", "—"], ...Object.entries(known.transactions).map(([n, x]) => [n, x.label ?? n])], (v) => ops.edit((bb) => { bb.blocks[i] = { block: "transaction", title: b.title, width: b.width, name: v, fills: {} }; }))),
                t ? labelled("Filled in by the screen", {
                    div: { children: Object.entries(t.inputs ?? {}).filter(([, s]) => !s.from).map(([k, s]) => ({ div: { key: k, className: "tx-set", children: [
                        { code: k }, { span: " = " },
                        select(ctx, b.fills?.[k] ? json(b.fills[k]) : "", [["", "entered by the person"], ...(param && (s.type !== "ref" || param[1].to === s.to) ? [[json({ param: param[0] }), `the screen's ${param[0]}`]] : [])], (v) => ops.edit((bb) => { bb.blocks[i].fills = { ...(bb.blocks[i].fills ?? {}) }; if (v) bb.blocks[i].fills[k] = JSON.parse(v); else delete bb.blocks[i].fills[k]; })),
                    ] } })) },
                }, "Shown locked; the person enters the rest.") : { span: {} },
                labelled("In a dialog", check(ctx, `blocks.${i}.closeOnDone`, "close the dialog once it is done"), "When this screen is shown as a dialog (a button or a pop-up opened it)."),
            ];
            break;
        }
        // A button that opens another screen as a dialog (§26.6).
        case "button":
            config = [{ div: { className: "ed-row", children: [
                labelled("Opens", select(ctx, b.opens ?? "", [["", "—"], ...(known.screens ?? []).filter((n) => n !== ctx.name).map((n) => [n, n.replace(/_/g, " ")])], (v) => ops.set(`blocks.${i}.opens`, v, true))),
                labelled("Label", text(ctx, `blocks.${i}.label`, { placeholder: "the screen's label" })),
                labelled("Opened with", exprInput(ctx, `blocks.${i}.with`, b.with, (v) => ops.edit((bb) => { if (v === undefined) delete bb.blocks[i].with; else bb.blocks[i].with = v; }), param ? `{"param": "${param[0]}"}` : "nothing"), "Its parameter, if it has one."),
            ] } }];
            break;
        case "text":
            config = [labelled("Text", text(ctx, `blocks.${i}.text`, { multiline: true }))];
            break;
        // A chart (§34.9): a query over the views, run as the viewer, and which of its columns go where.
        case "chart": {
            const kind = KINDS[b.chart];
            const sqlMode = b.query?.sql !== undefined;
            const setQuery = (v) => ops.edit((bb) => { bb.blocks[i].query = v; });
            const roles = kind ? [...kind.needs, ...kind.may].filter((k) => ["x", "series", "size", "value", "source", "target", "open", "high", "low", "close"].includes(k)) : [];
            const lists = kind ? [...kind.needs, ...kind.may].filter((k) => ["y", "path", "lines"].includes(k)) : [];
            const flags = kind ? kind.may.filter((k) => ["stack", "horizontal", "smooth", "step", "labels", "log"].includes(k)) : [];
            const setKey = (k, v) => ops.edit((bb) => { if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete bb.blocks[i][k]; else bb.blocks[i][k] = v; });
            config = [
                { div: { className: "ed-row", children: [
                    labelled("Chart", select(ctx, b.chart ?? "", CHART_KINDS.map((k) => [k, KINDS[k].label]), (v) => ops.edit((bb) => { const keep = Object.fromEntries(Object.entries(bb.blocks[i]).filter(([k]) => ["block", "title", "width", "tab", "showWhen", "enableWhen", "disabledBecause", "query", "unit"].includes(k))); bb.blocks[i] = { ...keep, chart: v }; })), kind ? `For ${kind.for}.` : ""),
                    labelled("Query", select(ctx, sqlMode ? "sql" : "json", [["json", "JSON (may name the screen's parameter)"], ["sql", "SQL"]], (v) => setQuery(v === "sql" ? { sql: "" } : { json: { from: "", select: [] } }))),
                ] } },
                sqlMode
                    ? labelled("SELECT", text(ctx, `blocks.${i}.query.sql`, { multiline: true, placeholder: "SELECT date_trunc('day', created_at)::date AS day, count(*) AS lots FROM lot GROUP BY 1 ORDER BY 1" }), "One SELECT over the views of the Queries page, run as whoever opens the screen. Name its columns (AS lots) and use those names below.")
                    : labelled("JSON query", exprInput(ctx, `blocks.${i}.query.json`, b.query?.json, (v) => setQuery({ json: v }), '{"from": "lot", "select": ["state", {"count": "*", "as": "lots"}], "groupBy": ["state"]}'), param ? `As on the Queries page; in where, {"param": "${param[0]}"} stands for the screen's ${param[0]}: {"eq": [{"field": "${param[0]}"}, {"param": "${param[0]}"}]}.` : "As on the Queries page, run as whoever opens the screen."),
                kind ? { div: { className: "ed-row", children: [
                    ...roles.map((k) => labelled(`${k}${kind.needs.includes(k) ? " *" : ""}`, text(ctx, `blocks.${i}.${k}`, { placeholder: "a column" }), CHART_KEYS[k])),
                    ...lists.map((k) => labelled(`${k}${kind.needs.includes(k) ? " *" : ""}`, { input: { type: "text", disabled: ro, placeholder: "columns, comma separated", value: (b[k] ?? []).join(", "), onchange: (e) => setKey(k, e.target.value.split(",").map((x) => x.trim()).filter(Boolean)) } }, CHART_KEYS[k])),
                    labelled("unit", text(ctx, `blocks.${i}.unit`, { placeholder: "h, %, pcs" }), CHART_KEYS.unit),
                ] } } : { span: {} },
                kind && flags.length ? labelled("Drawn", { div: { className: "checks", children: flags.map((k) => ({ label: { key: k, children: [{ input: { type: "checkbox", disabled: ro, checked: Boolean(b[k]), onchange: (e) => setKey(k, e.target.checked || undefined) } }, { span: ` ${CHART_KEYS[k]}` }] } })) } }) : { span: {} },
                kind && (kind.may.includes("marks") || kind.may.includes("bands")) ? { div: { className: "ed-row", children: [
                    kind.may.includes("marks") ? labelled("Reference lines", exprInput(ctx, `blocks.${i}.marks`, b.marks, (v) => setKey("marks", v), '[{"value": 95, "label": "target", "tone": "ok"}]'), `${CHART_KEYS.marks}; tones: ${TONES.join(", ")}.`) : { span: {} },
                    kind.may.includes("bands") ? labelled("Bands", exprInput(ctx, `blocks.${i}.bands`, b.bands, (v) => setKey("bands", v), '[{"from": 0, "to": 60, "tone": "danger"}]'), CHART_KEYS.bands) : { span: {} },
                ] } } : { span: {} },
            ];
            break;
        }
        default:
            // A suite's block (§30.11): its settings, as its kind names them.
            if (typeof b.block === "string" && b.block.includes(".")) {
                const spec = known.suiteBlocks?.[b.block];
                config = spec
                    ? [{ div: { className: "ed-row", children: Object.keys(spec.config ?? {}).map((k) => labelled(`${k}${(spec.required ?? []).includes(k) ? " (needed)" : ""}`, text(ctx, `blocks.${i}.${k}`, {}))) } }]
                    : [hint(`This block needs the ${b.block.split(".")[0]} suite, which is not installed here: it is drawn as that, and the screen's other blocks work.`)];
            }
    }
    return {
        fieldset: {
            key: `block-${i}-${b.block}`,
            className: `tx-card screen-card ${ctx.changedAt(`block:${i}`)}`,
            children: [
                { legend: { children: [
                    { strong: `${i + 1}. ${BLOCK_LABELS[b.block] ?? known.suiteBlocks?.[b.block]?.label ?? `${b.block} (needs the ${String(b.block).split(".")[0]} suite)`}` },
                    ro() || i === 0 ? { span: {} } : { button: { type: "button", className: "mini", title: "Earlier", "aria-label": "Earlier", children: [icon("arrowUp")], onclick: () => move(-1) } },
                    ro() || i === count - 1 ? { span: {} } : { button: { type: "button", className: "mini", title: "Later", "aria-label": "Later", children: [icon("arrowDown")], onclick: () => move(1) } },
                    ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: () => ops.edit((bb) => { bb.blocks.splice(i, 1); }) } },
                ] } },
                { div: { className: "ed-row", children: [
                    labelled("Title", text(ctx, `blocks.${i}.title`, { placeholder: "shown above it" })),
                    labelled("Tab", text(ctx, `blocks.${i}.tab`, { placeholder: "none: above the tabs" })),
                    labelled("Width", select(ctx, String(b.width ?? 12), Array.from({ length: 10 }, (_, k) => [String(k + 3), `${k + 3} of 12${k + 3 === 12 ? " (whole row)" : k + 3 === 6 ? " (half)" : k + 3 === 4 ? " (a third)" : ""}`]), (v) => ops.set(`blocks.${i}.width`, Number(v), true))),
                    objectPicker,
                ] } },
                ...config,
                // When it is shown and when it may be used (§26.9): conditions on what the screen has.
                { div: { className: "ed-row", children: [
                    labelled("Shown when", exprInput(ctx, `blocks.${i}.showWhen`, b.showWhen, (v) => ops.edit((bb) => { if (v === undefined) delete bb.blocks[i].showWhen; else bb.blocks[i].showWhen = v; }), "always"), "Empty: always. Else a condition; while it does not hold the block is not drawn, and not read."),
                    labelled("Enabled when", exprInput(ctx, `blocks.${i}.enableWhen`, b.enableWhen, (v) => ops.edit((bb) => { if (v === undefined) { delete bb.blocks[i].enableWhen; delete bb.blocks[i].disabledBecause; } else bb.blocks[i].enableWhen = v; }), param ? `always (e.g. {"eq": [{"lookup": "${param[0]}.state"}, "idle"]})` : "always"), "Empty: always. While it does not hold the block is greyed and cannot be used; a tab all of whose blocks are so is greyed too."),
                    b.enableWhen !== undefined ? labelled("…because", text(ctx, `blocks.${i}.disabledBecause`, { placeholder: "what the person reads: This tool already has a lot on it." }), "Said on the greyed block and on its tab.") : { span: {} },
                ] } },
            ],
        },
    };
}

function blocksTab(ctx) {
    const { api, body, ops, ro } = ctx;
    const known = screenKnown(api, ctx.w);
    const blocks = body.blocks ?? [];
    return {
        div: {
            children: [
                hint("Blocks from a fixed set, in reading order, on a 12-column row (a narrow screen stacks them). Each reads with the viewer's own rights: a table or a number never shows what their forms would not. See it on the Preview tab."),
                ...blocks.map((b, i) => blockCard(ctx, b, i, blocks.length, known)),
                ro() || blocks.length >= 20 ? { span: {} } : select(ctx, "", [["", "+ add a block"], ...BLOCKS.map((k) => [k, BLOCK_LABELS[k]]), ...Object.entries(known.suiteBlocks ?? {}).map(([k, x]) => [k, x.label ?? k])], (k) => {
                    if (!k) return;
                    if (k.includes(".")) { ops.edit((b) => { (b.blocks ??= []).push({ block: k, width: 12 }); }); return; }
                    const first = Object.keys(known.objects)[0];
                    ops.edit((b) => { (b.blocks ??= []).push(k === "floor" ? { block: "floor", object: first, status: "state", colours: {}, places: [], width: 12 } : k === "button" ? { block: "button", opens: (known.screens ?? []).find((n) => n !== ctx.name) ?? "", width: 4 } : k === "text" ? { block: "text", text: "…", width: 12 } : k === "chart" ? { block: "chart", chart: "bar", query: { json: { from: first, select: ["state", { count: "*", as: "records" }], groupBy: ["state"] } }, x: "state", y: ["records"], width: 6 } : k === "transaction" ? { block: "transaction", name: Object.keys(known.transactions)[0] ?? "", fills: {}, width: 6 } : { block: k, object: first, width: k === "table" ? 12 : 4, ...(k === "table" ? { columns: ["state"] } : k === "record" ? { of: null, show: ["state"] } : k === "breakdown" ? { by: "state", measure: "count" } : { measure: "count", label: "records" }) }); });
                }, { className: "add-block" }),
            ],
        },
    };
}

// When the screen opens by itself (§26.7): over which pages, for whom, while what holds, opened with
// what. It only shows: what must not happen is refused by the transaction's own checks.
function popupTab(ctx) {
    const { api, body, ops, ro } = ctx;
    const home = api.peek("design.home") ?? {};
    const known = screenKnown(api, ctx.w);
    const p = body.popup;
    const set = (fn) => ops.edit((b) => { b.popup = { ...(b.popup ?? {}) }; fn(b.popup); });
    const pages = [
        { value: "*", label: "every page" },
        ...Object.entries(known.transactions).map(([n, t]) => ({ value: `transaction:${n}`, label: `the ${t.label ?? n} transaction` })),
        ...(known.screens ?? []).filter((n) => n !== ctx.name).map((n) => ({ value: `screen:${n}`, label: `the ${n.replace(/_/g, " ")} screen` })),
    ];
    return {
        div: {
            children: [
                hint("A pop-up opens this screen by itself, as a dialog, over the pages you choose, while its condition holds, and closes by itself when it no longer does. It only shows: what must not happen is refused by the transaction's own checks. Example: while the machine's area is in maintenance, over Track in."),
                labelled("Opens by itself", { label: { className: "inline", children: [{ input: { type: "checkbox", disabled: ro, checked: Boolean(p), onchange: (e) => ops.edit((b) => { if (e.target.checked) b.popup = { on: [], for: { groups: [] } }; else delete b.popup; }) } }, { span: " as a pop-up" }] } }),
                p ? { div: { children: [
                    { h4: "Over" },
                    checks(ctx, pages, p.on, (v, on) => set((x) => { x.on = toggleIn(x.on, v, on); })),
                    { h4: "For" },
                    checks(ctx, (home.groups ?? []).map((g) => ({ value: g.id, label: g.name })), p.for?.groups, (v, on) => set((x) => { x.for = { ...(x.for ?? {}), groups: toggleIn(x.for?.groups, v, on) }; })),
                    pickMany({ key: `popup-users-${ctx.name}`, options: (home.users ?? []).map((u) => ({ value: u.id, label: u.name, hint: u.id })), value: p.for?.users ?? [], readOnly: ctx.ro, placeholder: "Add a person…", onChange: (next) => set((x) => { x.for = { ...(x.for ?? {}), users: next }; }) }),
                    labelled("While", exprInput(ctx, "popup.while", p.while, (v) => set((x) => { if (v === undefined) delete x.while; else x.while = v; }), '{"eq": [{"lookup": "area.state"}, "maintenance"]}'), 'A condition over the page: a transaction\'s inputs ({"input": …}, {"lookup": "machine.state"}), a screen\'s parameter ({"param": …}), {"user": "id"} and counts.'),
                    labelled("Opened with", exprInput(ctx, "popup.with", p.with, (v) => set((x) => { if (v === undefined) delete x.with; else x.with = v; }), '{"input": "machine"}'), "Its parameter, if it has one, from the page."),
                ] } } : { span: {} },
            ],
        },
    };
}

function callersTab(ctx) {
    const { api, body, ops } = ctx;
    const home = api.peek("design.home") ?? {};
    return {
        div: {
            children: [
                hint("Deny by default: nobody may open it until named here. What each sees in it is still their own rights on each object."),
                { h4: "Groups" },
                checks(ctx, (home.groups ?? []).map((g) => ({ value: g.id, label: g.name })), body.callers?.groups, (v, on) => ops.edit((b) => { b.callers = { ...(b.callers ?? {}), groups: toggleIn(b.callers?.groups, v, on) }; })),
                { h4: "Users" },
                pickMany({ key: `callers-${ctx.name}`, options: (home.users ?? []).map((u) => ({ value: u.id, label: u.name, hint: u.id })), value: body.callers?.users ?? [], readOnly: ctx.ro, placeholder: "Add a person…", onChange: (next) => ops.edit((b) => { b.callers = { ...(b.callers ?? {}), users: next }; }) }),
            ],
        },
    };
}
function stewardsTab(ctx) {
    const depts = ctx.api.peek("design.home.departments") ?? [];
    return { div: { children: [hint("Its stewards approve every change to it. It writes nothing itself: a transaction it shows is approved as a transaction."), checks(ctx, depts.map((d) => ({ value: d.id, label: d.name })), ctx.body.stewards, (v, on) => ctx.ops.edit((b) => { b.stewards = toggleIn(b.stewards, v, on); }))] } };
}

export function registerScreenEditor(juris) {
    registerFloorEditor(juris);
    // The draft, drawn with the designer's own rights (screens.preview), opened with a value they pick.
    juris.registerComponent("ScreenPreview", ({ id, name }, api) => {
        const w = W(id);
        const P = `${w}.preview.${name}`;
        const [options, setOptions] = api.useState("options", null);
        const as = api.getState("me.id", null, { track: false });
        const body = () => api.peek(`${w}.sc.${name}`);
        const [param, spec] = Object.entries(body()?.params ?? {})[0] ?? [];
        const run = async () => {
            api.setValue(`${P}.busy`, true);
            try {
                const r = await api.call("screens.preview", { screen: clone(body()), arg: api.peek(`${P}.arg`) ?? null });
                api.batch(() => { api.setValue(`${P}.problems`, r.problems ?? null); api.setValue(`${P}.def`, r.def ?? null); api.setValue(`${P}.data`, r.data ?? null); });
            } catch (e) {
                api.setValue(`${P}.problems`, [{ message: e.message }]);
            } finally {
                api.setValue(`${P}.busy`, false);
            }
        };
        if (!api.isServer) api.onMount(() => {
            if (spec?.type === "ref") api.call("records.list", { object: spec.to, as }).then((l) => setOptions(l.rows.map((r) => ({ id: r.id, title: String(r.$title ?? r.id.slice(0, 8)) }))), () => setOptions([]));
            run();
        });
        return {
            div: {
                children: [
                    hint("The draft as it will look, with your own rights on each object; its buttons do nothing here."),
                    { div: { className: "query-bar", children: [
                        param ? { label: { className: "inline small", children: [{ span: `${spec.label ?? param}: ` }, spec.type === "ref"
                            ? { select: { onchange: (e) => { api.setValue(`${P}.arg`, e.target.value || null); run(); }, children: noDefault(() => [{ option: { value: "", textContent: "—" } }, ...(options() ?? []).map((o) => ({ option: { key: o.id, value: o.id, selected: api.peek(`${P}.arg`) === o.id, textContent: o.title } }))]) } }
                            : { input: { type: spec.type === "date" ? "date" : "text", onchange: (e) => { api.setValue(`${P}.arg`, e.target.value || null); run(); } } }] } } : { span: {} },
                        { button: { type: "button", className: "btn", disabled: () => api.getState(`${P}.busy`, false), textContent: () => (api.getState(`${P}.busy`, false) ? "Drawing…" : "Redraw with the draft"), onclick: run } },
                    ] } },
                    () => {
                        const problems = api.getState(`${P}.problems`, null);
                        return problems?.length ? { ul: { className: "error small", children: problems.map((p, k) => ({ li: { key: k, textContent: p.message } })) } } : { span: {} };
                    },
                    { div: { className: "screen-preview", children: [{ ScreenBody: { name: `preview_${name}`, defPath: `${P}.def`, dataPath: `${P}.data`, arg: null, preview: true } }] } },
                ],
            },
        };
    });

    juris.registerComponent("ScreenEditor", ({ id, editable, pane = 0, name, head }, api) => {
        const w = W(id);
        const ops = elementOps(api, id, "screen", name);
        const view = () => { const v = api.getState(`${w}.panes.${pane}.view`, "general"); return SCREEN_VIEWS.some(([k]) => k === v) ? v : "general"; };
        const ro = () => !api.prop(editable);
        return {
            div: {
                className: "editor",
                children: [
                    { div: { className: "editor-head", children: [
                        head ?? { span: {} },
                        { nav: { className: "subtabs", children: SCREEN_VIEWS.map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                            api.getState(`${w}.vrev`);
                            api.getState(`dc.${id}.updated_at`);
                            const all = changesOf(api, id, "screen", name);
                            const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                            return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                        }] } })) } },
                    ] } },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(ops.root);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const changed = new Set(changesOf(api, id, "screen", name).map((c) => `${c.element}:${c.change}`));
                        const changedAt = (el) => (changed.has(`${el}:added`) ? "diff-added" : changed.has(`${el}:changed`) ? "diff-changed" : "");
                        const ctx = { api, w, ops, ro, body, id, kind: "screen", name, root: ops.root, changedAt };
                        switch (view()) {
                            case "copilot": return { CopilotPanel: { key: `copilot-${id}`, id } };
                            case "changes": return { ChangesView: { key: `changes-sc-${name}`, id, kind: "screen", name, onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "blocks": return blocksTab(ctx);
                            case "preview": return { ScreenPreview: { key: `pv-${name}-${api.peek(`${w}.vrev`) ?? 0}`, id, name } };
                            case "popup": return popupTab(ctx);
                            case "callers": return callersTab(ctx);
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

export const SCREEN_TEMPLATE = (name, stewards) => ({ name, label: name.replace(/_/g, " "), description: "", params: {}, blocks: [{ block: "text", text: "Add blocks: tables, numbers, records, transactions.", width: 12 }], callers: { users: [], groups: [] }, stewards });
