// The designer's editor for a screen (DESIGN.md §26), beside the others, on the same working copy
// (`${w}.sc.<name>`). A screen is a list of blocks from a fixed set; the editor configures them and
// previews the draft with the designer's own rights. Approved by its stewards like anything else.
import { pickMany, tagsInput } from "./pick.js";
import { noDefault } from "./select.js";
import { validateScreen, screenFootprint, BLOCKS, MEASURES } from "./definition.js";
import { changesOf, countByTab } from "./compare.js";
import { elementOps, jsonOf } from "./integration-editor.js";
import { transactionKnown, maximizeSelect, inputFlowSelect } from "./transaction-editor.js";
import { W, clone, text, labelled, check } from "./editor-kit.js";
import { exprField, objectEntries, scope } from "./expr-builder.js";
import { icon, withIcon } from "./icons.js";
import { floorConfig, registerFloorEditor } from "./floor-editor.js";
import { KINDS, CHART_KINDS, CHART_KEYS, TONES } from "./charts.js";
import { confirmRemove } from "./dialog.js";
import { querySourceEditor, queryColumns, queriesKnown } from "./query-source.js";
import { uploadFile, acceptWords } from "./media.js";

// A file shown (§35.4): one of the screen's own (uploaded here: the operator's guide for this screen), or a
// record's file or picture, read as the viewer (a lot's step's work instruction, derived from its step).
function mediaConfig(ctx, b, i, known, param) {
    const { api, ops, ro } = ctx;
    const own = b.file !== undefined || b.object === undefined;
    const withFiles = Object.entries(known.objects).filter(([, d]) => Object.values(d.fields ?? {}).some((f) => ["file", "image"].includes(f?.type)));
    const fileFields = Object.entries(known.objects[b.object]?.fields ?? {}).filter(([, f]) => ["file", "image"].includes(f?.type));
    const P = `${ctx.w}.media.${i}`;
    const routes = Object.entries(known.flowInfo ?? {}).filter(([, f]) => f.kind === "route");
    const upload = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        api.batch(() => { api.setValue(`${P}.busy`, true); api.setValue(`${P}.error`, null); });
        try {
            const kept = await uploadFile(file, ["picture", "pdf", "video", "spreadsheet"]);
            ops.edit((bb) => { const x = bb.blocks[i]; for (const k of ["object", "of", "field", "stepsField"]) delete x[k]; x.file = kept.blob; x.name = (kept.name ?? file.name).slice(0, 120); });
        } catch (err) { api.setValue(`${P}.error`, err.message); } finally { api.setValue(`${P}.busy`, false); }
    };
    return [
        labelled("Shows", select(ctx, own ? "own" : "record", [["own", "a file of its own (uploaded here)"], ["record", "a record's file or picture"]], (v) => ops.edit((bb) => {
            const x = bb.blocks[i];
            for (const k of ["file", "name", "object", "of", "field", "steps", "stepsField"]) delete x[k];
            if (v === "record" && withFiles.length) { const [o, d] = withFiles[0]; x.object = o; x.field = Object.entries(d.fields).find(([, f]) => ["file", "image"].includes(f?.type))[0]; if (param && param[1].to === o) x.of = { param: param[0] }; }
        })), own ? "The screen's own guide: a work instruction, a drawing, a video of the job." : "Read as whoever opens the screen: their access decides."),
        own ? { div: { className: "ed-row", children: [
            labelled("File", { div: { className: "file-field", children: [
                b.file ? { MediaView: { key: `me-${i}-${b.file}`, src: `/blob/${b.file}`, compact: true } } : { span: { className: "muted small", textContent: "None yet." } },
                ro() ? { span: {} } : { label: { className: "btn", children: [{ span: () => (api.getState(`${P}.busy`, false) ? "Uploading…" : b.file ? "Replace…" : "Upload…") }, { input: { type: "file", className: "visually-hidden", onchange: upload } }] } },
                { span: { className: "error small", role: "alert", textContent: () => api.getState(`${P}.error`, null) ?? "" } },
            ] } }, `${acceptWords(["picture", "pdf", "video", "spreadsheet"])}: a picture up to 5 MB, a document 10 MB, a video 100 MB.`),
            b.file ? labelled("Its name", text(ctx, `blocks.${i}.name`, { placeholder: "as people read it" })) : { span: {} },
        ] } } : { div: { className: "ed-row", children: [
            labelled("Of", select(ctx, b.object ?? "", [["", "—"], ...withFiles.map(([o, d]) => [o, d.label ?? o])], (v) => ops.edit((bb) => { const x = bb.blocks[i]; x.object = v; x.field = Object.entries(known.objects[v]?.fields ?? {}).find(([, f]) => ["file", "image"].includes(f?.type))?.[0]; if (param && param[1].to === v) x.of = { param: param[0] }; })), withFiles.length ? "" : "No object has a file or picture field yet."),
            labelled("Which record", exprInput(ctx, `blocks.${i}.of`, b.of, (v) => ops.set(`blocks.${i}.of`, v, false), param ? `{"param": "${param[0]}"}` : "a record id"), param ? `The screen's ${param[0]}: {"param": "${param[0]}"}` : "Give the screen a record to be opened with (General)."),
            labelled("Field", select(ctx, b.field ?? "", [["", "—"], ...fileFields.map(([n, f]) => [n, `${f.label ?? n}${f.from !== undefined ? " (derived)" : ""}`])], (v) => ops.set(`blocks.${i}.field`, v, true)), "A file field, or a picture; one derived through a reference shows that record's (a lot's step's instruction)."),
        ] } },
        // Its steps (media-steps.js): the controls under it go a step at a time. Or a route's (§35.4).
        labelled("Follows a route", select(ctx, b.route?.flow ?? "", [["", "no: its own steps"], ...routes.map(([n, f]) => [n, `${f.label ?? n}${f.guided ? ` (${f.guided} steps in a guide)` : " (no step placed in a guide yet)"}`])], (v) => ops.edit((bb) => {
            const x = bb.blocks[i];
            if (!v) { delete x.route; return; }
            for (const k of ["steps", "stepsField", "done"]) delete x[k];
            x.route = { flow: v, of: x.route?.of ?? (param ? { param: param[0] } : undefined) };
        })), "Its steps are the route's sequences placed in this guide (In the guide at, in the Flow designer), each ticked once the traveler has gone on."),
        b.route ? labelled("Whose way", exprInput(ctx, `blocks.${i}.route.of`, b.route.of, (v) => ops.set(`blocks.${i}.route.of`, v, false), param ? `{"param": "${param[0]}"}` : "a record id"), "The traveler: the record the screen is opened with.") : { span: {} },
        b.route ? { span: {} } : own
            ? labelled("Steps", text(ctx, `blocks.${i}.steps`, { multiline: true, placeholder: "1 Remove the cover\n3 Torque crosswise to 12 Nm #value:torque\n4 The seal, seen #photo\n— or for a video —\n0:12 Remove the cover" }), "A line each: the page (a PDF) or the time (a video, 0:45) it starts at, then its words. Empty: page by page. Marked done (below), a step ends with how: #click (the default), #value:<input>, #photo, #file, #device (the equipment), #wait (another transaction, a flow), #screen:<name>.")
            : labelled("Steps from", select(ctx, b.stepsField ?? "", [["", "none: page by page"], ...Object.entries(known.objects[b.object]?.fields ?? {}).filter(([, f]) => ["text", "string"].includes(f?.type) && !f.sensitive).map(([n, f]) => [n, f.label ?? n])], (v) => ops.edit((bb) => { if (v) bb.blocks[i].stepsField = v; else delete bb.blocks[i].stepsField; })), "A text field of the same record, a line each (3 Torque crosswise; 0:45 Clean the seal): each instruction its own steps."),
        ...(b.route ? [] : doneConfig(ctx, b, i, known, param)),
        { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: b.pauseAtSteps !== false, onchange: (e) => ops.edit((bb) => { if (e.target.checked) delete bb.blocks[i].pauseAtSteps; else bb.blocks[i].pauseAtSteps = false; }) } }, { span: " A video stops at each step's end (the operator does it, then presses Next)" }] } },
        labelled("Height", { input: { type: "number", min: 160, max: 1600, step: 20, disabled: ro, value: b.height ?? 480, onchange: (e) => ops.set(`blocks.${i}.height`, Math.max(160, Math.min(1600, Number(e.target.value) || 480)), true) } }, "pixels, for a PDF or a video"),
    ];
}

// A guide's steps marked done (§35.4): the transaction that records one (the step's number in one of its inputs,
// what the screen fills in, where a photo or a file goes) and the records that say so (its log, read back live).
function doneConfig(ctx, b, i, known, param) {
    const { ops, ro } = ctx;
    const d = b.done;
    const txs = Object.entries(known.transactions ?? {});
    const inputs = Object.entries(known.transactions?.[d?.transaction]?.inputs ?? {});
    const numbers = (entries) => entries.filter(([, f]) => ["integer", "decimal"].includes(f?.type));
    const logFields = Object.entries(known.objects?.[d?.log?.object]?.fields ?? {});
    const setDone = (fn) => ops.edit((bb) => { const x = bb.blocks[i]; x.done = { ...(x.done ?? {}) }; fn(x.done); });
    const pick = (path, v) => setDone((dd) => { const keys = path.split("."); let o = dd; for (const k of keys.slice(0, -1)) o = o[k] = { ...(o[k] ?? {}) }; if (v) o[keys.at(-1)] = v; else delete o[keys.at(-1)]; });
    const start = (t) => ops.edit((bb) => {
        const x = bb.blocks[i];
        if (!t) { delete x.done; return; }
        const ins = Object.entries(known.transactions?.[t]?.inputs ?? {});
        const lot = param ? ins.find(([, f]) => f?.type === "ref" && f.to === param[1].to)?.[0] : null;
        x.done = { transaction: t, step: numbers(ins)[0]?.[0], ...(lot ? { fills: { [lot]: { param: param[0] } } } : {}), ...(ins.find(([, f]) => f?.type === "image") ? { evidence: ins.find(([, f]) => f?.type === "image")[0] } : {}), log: x.done?.log ?? { object: "", step: "" } };
    });
    return [
        labelled("Steps marked done by", select(ctx, d?.transaction ?? "", [["", "nobody: a guide to read"], ...txs.map(([n, t]) => [n, t.label ?? n])], start), "Each step done is a run of this transaction: who may run it, its checks and signature, the audit trail."),
        d ? { div: { className: "ed-row", children: [
            labelled("Its number in", select(ctx, d.step ?? "", [["", "—"], ...numbers(inputs).map(([n, f]) => [n, f.label ?? n])], (v) => pick("step", v)), "The input that takes the step's number (1, 2, …, as the steps are written)."),
            labelled("Photos and files in", select(ctx, d.evidence ?? "", [["", "none"], ...inputs.filter(([, f]) => ["image", "file"].includes(f?.type)).map(([n, f]) => [n, f.label ?? n])], (v) => pick("evidence", v)), "Where a #photo or #file step's goes."),
            labelled("It fills in", exprInput(ctx, `blocks.${i}.done.fills`, d.fills, (v) => ops.set(`blocks.${i}.done.fills`, v, false), param ? `{"lot": {"param": "${param[0]}"}}` : '{"input": value}'), "Its inputs the screen gives: the record it is opened with."),
        ] } } : { span: {} },
        d ? { div: { className: "ed-row", children: [
            labelled("Done when there is a", select(ctx, d.log?.object ?? "", [["", "—"], ...Object.entries(known.objects ?? {}).map(([o, x]) => [o, x.label ?? o])], (v) => setDone((dd) => { dd.log = { ...(dd.log ?? {}), object: v }; })), "The records the transaction makes (and the equipment, another transaction or a flow may make too): one per step done."),
            labelled("…whose step is", select(ctx, d.log?.step ?? "", [["", "—"], ...numbers(logFields).map(([n, f]) => [n, f.label ?? n])], (v) => pick("log.step", v))),
            labelled("…and where", exprInput(ctx, `blocks.${i}.done.log.where`, d.log?.where, (v) => ops.set(`blocks.${i}.done.log.where`, v, false), param ? `{"lot": {"param": "${param[0]}"}}` : '{"field": value}'), "Whose steps: this record's."),
        ] } } : { span: {} },
        d ? { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: d.gate === true, onchange: (e) => pick("gate", e.target.checked ? true : undefined) } }, { span: " Next only once the step in view is done" }] } } : { span: {} },
    ];
}

export const SCREEN_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["blocks", "Blocks"], ["preview", "Preview"], ["popup", "Pop-up"], ["callers", "Callers"], ["stewards", "Stewards"], ["json", "JSON"]];
const BLOCK_LABELS = { record: "one record", table: "a table of records", kpi: "a number", breakdown: "a breakdown (bars)", chart: "a chart from a query", transaction: "a transaction's form", text: "text", button: "a button that opens a screen", floor: "a floor layout: records where they stand, with their state", media: "a file: a guide, a picture, a video or a PDF", runs: "what was done lately with transactions", plan: "the step a record's plan waits at" };
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
    // The routes a guide may follow (§35.4): their kind and how many of their sequences are placed in a guide.
    const flowInfo = Object.fromEntries((home.flows ?? []).map((f) => [f.name, { kind: f.kind, object: f.object ?? null, guided: f.guided ?? 0, label: f.label }]));
    for (const [n, f] of Object.entries(api.peek(`${w}.fl`) ?? {})) if (f) flowInfo[n] = { kind: f.kind, object: null, guided: Object.values(f.nodes ?? {}).filter((x) => x?.guide !== undefined).length, label: f.label };
    // The named queries there will be (§23.1): a table may show one's rows.
    return { ...base, transactions, screens, flowInfo, suiteBlocks: home.suiteBlocks ?? {}, queries: queriesKnown(api, w) };
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
// What a screen's conditions read (§26.9, §9.2a): its parameter, the record it was opened with, who is looking,
// and counts of records; a pop-up's also the page's inputs (`input`, whatever the page's transaction names).
function screenSpec(ctx, { popup = false } = {}) {
    const known = screenKnown(ctx.api, ctx.w);
    const params = Object.entries(ctx.body.params ?? {});
    const lookup = params.filter(([, p]) => p?.type === "ref").flatMap(([n, p]) => objectEntries(known.objects?.[p.to], { prefix: `${n}.`, label: p.label ?? n }));
    return { scopes: {
        param: scope("what it was opened with", params.map(([n, p]) => ({ path: n, label: p?.label ?? n, type: p?.type === "ref" ? "ref" : p?.type ?? "string", ...(Array.isArray(p?.values) ? { values: p.values } : {}) }))),
        lookup: scope("its record", lookup),
        user: scope("the person", [{ path: "id", label: "the person (sign-in id)", type: "string" }, { path: "departments", label: "their departments", type: "list", values: known.departments ?? [] }]),
        ...(popup ? { input: scope("the page's inputs", []) } : {}),
    }, count: Object.keys(known.objects ?? {}) };
}
const condition = (ctx, path, stored, apply, empty, opts) => exprField({ key: `${ctx.w}.scexpr.${ctx.name}.${path}`, readOnly: ctx.ro, empty, value: () => stored, onChange: apply, spec: screenSpec(ctx, opts) });

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
                // Part of its label typed (§26.1): the records holding it, counted by state, a few of their fields beside each.
                param && spec.type === "ref" && (spec.widget ?? "scan") === "scan" ? labelled("…part of it typed", select(ctx, spec.search ? "search" : "", [["", "not found (the whole label is needed)"], ["search", "lists those that hold it, counted by state"]], (v) => setParam((cur) => { const { search, ...rest } = cur; return v ? { ...rest, search: search ?? true } : rest; })), "A scanner's whole label opens it; a part typed (\"W-2\") lists the records holding it, by state, each one click from opening.") : { span: {} },
                param && spec.type === "ref" && spec.search ? labelled("…showing beside each", { div: { className: "choice-list inline", children: Object.entries(known.objects[spec.to]?.fields ?? {}).filter(([, f]) => !f.sensitive && !["image", "file", "ref"].includes(f.type)).map(([f, def]) => ({ label: { key: f, children: [
                    { input: { type: "checkbox", disabled: ro, checked: (spec.search?.show ?? []).includes(f), onchange: (e) => setParam((cur) => { const now = Array.isArray(cur.search?.show) ? cur.search.show : []; const show = e.target.checked ? [...new Set([...now, f])].slice(0, 6) : now.filter((x) => x !== f); return { ...cur, search: show.length ? { show } : true }; }) } },
                    { span: def.label ?? f },
                ] } })) } }, "Up to 6 fields, to tell them apart (a location, a family).") : { span: {} },
                param && spec.type === "ref" ? labelled("…only those where", exprInput(ctx, `params.${param}.where`, spec.where, (v) => ops.set(`params.${param}.where`, v, false), 'any (e.g. {"process": ["die_saw"]})'), "Fields equal to these values: a die saw's screen opens with die saws only, and lists only them.") : { span: {} },
                // A desk worked all day (§26.1): the records it opens stay in its one tab, and its input flow's end goes
                // back to the scan.
                param ? labelled("One tab", { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: body.oneTab === true, onchange: (e) => ops.edit((bb) => { if (e.target.checked) bb.oneTab = true; else delete bb.oneTab; }) } }, { span: " Each record it is opened on stays in this one tab, named after the screen; at its input flow's end (repeat), back to the scan" }] } }, "For a desk worked all day: nobody closes a tab for each record.") : { span: {} },
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
    // A table's rows: an object's records, or a named query's (§23.1).
    const fromQuery = b.block === "table" && b.query !== undefined;
    const rowsFrom = b.block === "table" ? labelled("Rows from", select(ctx, fromQuery ? "query" : "object", [["object", "an object's records"], ["query", "a named query"]], (v) => ops.edit((bb) => {
        const keep = { block: "table", title: b.title, width: b.width, ...(b.tab !== undefined ? { tab: b.tab } : {}) };
        bb.blocks[i] = v === "query" ? { ...keep, query: "", ...(b.object ? { object: b.object } : {}) } : { ...keep, object: b.object ?? "", columns: [] };
    })), fromQuery ? "Its rows are the query's, run as the viewer: whatever it joins and works out." : undefined) : null;
    const objectPicker = fromQuery
        ? labelled("Each row a record of", select(ctx, b.object ?? "", [["", "— none: no row buttons —"], ...objects.map(([o, d]) => [o, d.label ?? o])], (v) => ops.edit((bb) => { if (v) bb.blocks[i].object = v; else { delete bb.blocks[i].object; delete bb.blocks[i].rowActions; } })), "When the query gives the records' id: a row links to its record and offers that object's transactions.")
        : ["record", "table", "kpi", "breakdown", "floor"].includes(b.block)
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
            if (fromQuery) {
                const { api, w, id } = ctx;
                const cols = queryColumns(api, w, id, b.query)?.columns ?? [];
                config = [
                    querySourceEditor(api, { w, id, key: `${w}.qtbl.${ctx.name}.${i}`, readOnly: ro, value: { query: b.query || undefined, columns: b.columns, params: b.params }, kind: "table",
                        scopes: param ? `the screen's ${param[0]} ({"param": "${param[0]}"}) and the viewer ({"user": "id"})` : 'the viewer ({"user": "id"})',
                        onChange: (src) => ops.edit((bb) => {
                            const t = bb.blocks[i];
                            t.query = src?.query ?? "";
                            if (src?.columns?.length) t.columns = src.columns; else delete t.columns;
                            if (src?.params && Object.keys(src.params).length) t.params = src.params; else delete t.params;
                        }) }),
                    { div: { className: "ed-row", children: [
                        labelled("Sorted by", select(ctx, b.sort?.field ?? "", [["", "as the query orders them"], ...cols.map((c) => [c, c])], (v) => ops.edit((bb) => { if (v) bb.blocks[i].sort = { field: v, dir: bb.blocks[i].sort?.dir ?? "asc" }; else delete bb.blocks[i].sort; }))),
                        b.sort ? labelled("Direction", select(ctx, b.sort.dir ?? "asc", [["asc", "ascending"], ["desc", "descending"]], (v) => ops.set(`blocks.${i}.sort.dir`, v, true))) : { span: {} },
                        labelled("At most", { input: { type: "number", min: 1, max: 1000, disabled: ro, value: b.limit ?? 200, onchange: (e) => ops.set(`blocks.${i}.limit`, Math.max(1, Math.min(1000, Number(e.target.value) || 200)), true) } }, "Rows it reads."),
                        labelled("Drawn at a time", { input: { type: "number", min: 5, max: 200, disabled: ro, value: b.pageSize ?? 25, onchange: (e) => ops.set(`blocks.${i}.pageSize`, Math.max(5, Math.min(200, Number(e.target.value) || 25)), true) } }),
                    ] } },
                    ...(b.object ? [labelled("Buttons on each row", txs.length ? checks(ctx, txs.map(([n, t]) => ({ value: n, label: `${t.label ?? n}${t.appearsOn?.states?.length ? ` (${t.appearsOn.states.join(", ")})` : ""}` })), b.rowActions, (v, on) => ops.edit((bb) => { bb.blocks[i].rowActions = toggleIn(bb.blocks[i].rowActions, v, on); if (!bb.blocks[i].rowActions.length) delete bb.blocks[i].rowActions; })) : { span: { className: "muted small", textContent: `No transaction appears on ${b.object} records.` } }, "Offered on a row when the query gives the record's state and it is one the transaction appears in (or always, when it does not give it)."),
                        ...((b.rowActions ?? []).length ? [labelled("Their form opens", select(ctx, b.rowActionsIn ?? "below", [["below", "under the table"], ["panel", "in a panel over the screen"]], (v) => ops.edit((bb) => { if (v === "panel") bb.blocks[i].rowActionsIn = "panel"; else delete bb.blocks[i].rowActionsIn; })))] : [])] : []),
                ];
                break;
            }
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
                // Where a row button's form opens: under the table, or in a panel over the screen.
                ...((b.rowActions ?? []).length ? [labelled("Their form opens", select(ctx, b.rowActionsIn ?? "below", [["below", "under the table"], ["panel", "in a panel over the screen"]], (v) => ops.edit((bb) => { if (v === "panel") bb.blocks[i].rowActionsIn = "panel"; else delete bb.blocks[i].rowActionsIn; })), "In a panel, the list stays in sight behind it; Esc or Done closes it.")] : []),
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
            config = [labelled("Text", text(ctx, `blocks.${i}.text`, { multiline: true }), "Lines for paragraphs; - for a list; **bold**; # a heading; [words](https://…) or [words](/s/screen) for a link.")];
            break;
        // The step a record's plan waits at (§26.10).
        case "plan":
            config = [
                labelled("Of", exprInput(ctx, `blocks.${i}.of`, b.of, (v) => ops.edit((bb) => { bb.blocks[i].of = v; }), param ? `{"param": "${param[0]}"}` : ""), "The record whose plan it shows, usually the screen's parameter."),
                labelled("Plans", checks(ctx, Object.entries(known.flowInfo ?? {}).filter(([, f]) => f.kind === "plan").map(([n, f]) => ({ value: n, label: f.label ?? n })), b.flows, (f, on) => ops.edit((bb) => { const now = Array.isArray(bb.blocks[i].flows) ? bb.blocks[i].flows : []; const next = on ? [...new Set([...now, f])] : now.filter((x) => x !== f); if (next.length) bb.blocks[i].flows = next; else delete bb.blocks[i].flows; })), "None ticked: any plan the record set off. Its step's form, for whom it is for: the cursor in it."),
            ];
            break;
        // What was done lately with some transactions (§26.10): their runs, from the audit trail.
        case "runs":
            config = [
                labelled("Of", checks(ctx, Object.entries(known.transactions ?? {}).map(([t, x]) => ({ value: t, label: x.label ?? t })), b.transactions, (t, on) => ops.edit((bb) => { const now = Array.isArray(bb.blocks[i].transactions) ? bb.blocks[i].transactions : []; bb.blocks[i].transactions = on ? [...new Set([...now, t])] : now.filter((x) => x !== t); })), "Their runs, newest first: when, by whom, the records each moved and what it set, as the viewer may read them."),
                labelled("How many", { input: { type: "number", min: 5, max: 200, disabled: ro, value: b.limit ?? 50, onchange: (e) => ops.edit((bb) => { const n = Number(e.target.value); if (Number.isInteger(n) && n !== 50) bb.blocks[i].limit = n; else delete bb.blocks[i].limit; }) } }, "5 to 200, the newest."),
                { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: b.mine === true, onchange: (e) => ops.edit((bb) => { if (e.target.checked) bb.blocks[i].mine = true; else delete bb.blocks[i].mine; }) } }, { span: " Only the viewer's own runs" }] } },
            ];
            break;
        case "media":
            config = mediaConfig(ctx, b, i, known, param);
            break;
        // A chart (§34.9): a query over the views, run as the viewer, and which of its columns go where.
        case "chart": {
            const kind = KINDS[b.chart];
            const sqlMode = b.query?.sql !== undefined;
            // A named query (§23.1): the formula approved once, for every chart and table reading it.
            const namedMode = b.query?.named !== undefined;
            const setQuery = (v) => ops.edit((bb) => { bb.blocks[i].query = v; });
            const roles = kind ? [...kind.needs, ...kind.may].filter((k) => ["x", "series", "size", "value", "source", "target", "open", "high", "low", "close"].includes(k)) : [];
            const lists = kind ? [...kind.needs, ...kind.may].filter((k) => ["y", "path", "lines"].includes(k)) : [];
            const flags = kind ? kind.may.filter((k) => ["stack", "horizontal", "smooth", "step", "labels", "log"].includes(k)) : [];
            const setKey = (k, v) => ops.edit((bb) => { if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete bb.blocks[i][k]; else bb.blocks[i][k] = v; });
            config = [
                { div: { className: "ed-row", children: [
                    labelled("Chart", select(ctx, b.chart ?? "", CHART_KINDS.map((k) => [k, KINDS[k].label]), (v) => ops.edit((bb) => { const keep = Object.fromEntries(Object.entries(bb.blocks[i]).filter(([k]) => ["block", "title", "width", "tab", "showWhen", "enableWhen", "disabledBecause", "query", "unit"].includes(k))); bb.blocks[i] = { ...keep, chart: v }; })), kind ? `For ${kind.for}.` : ""),
                    labelled("Query", select(ctx, namedMode ? "named" : sqlMode ? "sql" : "json", [["json", "JSON (may name the screen's parameter)"], ["sql", "SQL"], ["named", "A named query"]], (v) => setQuery(v === "sql" ? { sql: "" } : v === "named" ? { named: Object.keys(known.queries ?? {})[0] ?? "" } : { json: { from: "", select: [] } }))),
                ] } },
                namedMode
                    ? { div: { className: "ed-row", children: [
                        labelled("Named query", select(ctx, b.query.named ?? "", [["", "—"], ...Object.entries(known.queries ?? {}).map(([n, q]) => [n, q.label ?? n])], (v) => setQuery({ named: v, ...(b.query.params ? { params: b.query.params } : {}) }))),
                        labelled("Its parameters", exprInput(ctx, `blocks.${i}.query.params`, b.query?.params, (v) => setQuery({ named: b.query.named, ...(v ? { params: v } : {}) }), param ? `{"${Object.keys(known.queries?.[b.query.named]?.params ?? { from: 1 })[0]}": {"param": "${param[0]}"}}` : '{"weeks": 13}'), "Each a value or an expression over the screen's parameter and the viewer."),
                    ] } }
                    : sqlMode
                    ? labelled("SELECT", text(ctx, `blocks.${i}.query.sql`, { multiline: true, placeholder: "SELECT date_trunc('day', created_at)::date AS day, count(*) AS lots FROM lot GROUP BY 1 ORDER BY 1" }), "One SELECT over the views of the Queries page, run as whoever opens the screen. Name its columns (AS lots) and use those names below.")
                    : labelled("JSON query", exprInput(ctx, `blocks.${i}.query.json`, b.query?.json, (v) => setQuery({ json: v }), '{"from": "lot", "select": ["state", {"count": "*", "as": "lots"}], "groupBy": ["state"]}'), param ? `As on the Queries page; in where, {"param": "${param[0]}"} stands for the screen's ${param[0]}: {"eq": [{"field": "${param[0]}"}, {"param": "${param[0]}"}]}.` : "As on the Queries page, run as whoever opens the screen."),
                kind ? { div: { className: "ed-row", children: [
                    ...roles.map((k) => labelled(`${k}${kind.needs.includes(k) ? " *" : ""}`, text(ctx, `blocks.${i}.${k}`, { placeholder: "a column" }), CHART_KEYS[k])),
                    ...lists.map((k) => labelled(`${k}${kind.needs.includes(k) ? " *" : ""}`, tagsInput({ key: `${ctx.w}.blk.${ctx.name}.${i}.${k}`, readOnly: ro, placeholder: "Add a column…", value: b[k] ?? [], onChange: (next) => setKey(k, next) }), CHART_KEYS[k])),
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
                    ro() ? { span: {} } : { button: { type: "button", className: "linkish", textContent: "remove", onclick: confirmRemove(ctx.api, "this block", () => ops.edit((bb) => { bb.blocks.splice(i, 1); }) )} },
                ] } },
                { div: { className: "ed-row", children: [
                    labelled("Title", text(ctx, `blocks.${i}.title`, { placeholder: "shown above it" })),
                    labelled("Tab", text(ctx, `blocks.${i}.tab`, { placeholder: "none: above the tabs" })),
                    labelled("Width", select(ctx, String(b.width ?? 12), Array.from({ length: 10 }, (_, k) => [String(k + 3), `${k + 3} of 12${k + 3 === 12 ? " (whole row)" : k + 3 === 6 ? " (half)" : k + 3 === 4 ? " (a third)" : ""}`]), (v) => ops.set(`blocks.${i}.width`, Number(v), true))),
                    rowsFrom ?? { span: {} },
                    objectPicker,
                ] } },
                ...config,
                // When it is shown and when it may be used (§26.9): conditions on what the screen has.
                { div: { className: "ed-row", children: [
                    labelled("Shown when", condition(ctx, `blocks.${i}.showWhen`, b.showWhen, (v) => ops.edit((bb) => { if (v === undefined) delete bb.blocks[i].showWhen; else bb.blocks[i].showWhen = v; }), "always"), "Empty: always. Else a condition; while it does not hold the block is not drawn, and not read."),
                    labelled("Enabled when", condition(ctx, `blocks.${i}.enableWhen`, b.enableWhen, (v) => ops.edit((bb) => { if (v === undefined) { delete bb.blocks[i].enableWhen; delete bb.blocks[i].disabledBecause; } else bb.blocks[i].enableWhen = v; }), "always"), "Empty: always. While it does not hold the block is greyed and cannot be used; a tab all of whose blocks are so is greyed too."),
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
                    ops.edit((b) => { (b.blocks ??= []).push(k === "floor" ? { block: "floor", object: first, status: "state", colours: {}, places: [], width: 12 } : k === "button" ? { block: "button", opens: (known.screens ?? []).find((n) => n !== ctx.name) ?? "", width: 4 } : k === "text" ? { block: "text", text: "…", width: 12 } : k === "media" ? { block: "media", width: 12, height: 480 } : k === "runs" ? { block: "runs", transactions: Object.keys(known.transactions ?? {}).slice(0, 1), width: 12 } : k === "plan" ? { block: "plan", of: param ? { param: param[0] } : null, width: 12 } : k === "chart" ? { block: "chart", chart: "bar", query: { json: { from: first, select: ["state", { count: "*", as: "records" }], groupBy: ["state"] } }, x: "state", y: ["records"], width: 6 } : k === "transaction" ? { block: "transaction", name: Object.keys(known.transactions)[0] ?? "", fills: {}, width: 6 } : { block: k, object: first, width: k === "table" ? 12 : 4, ...(k === "table" ? { columns: ["state"] } : k === "record" ? { of: null, show: ["state"] } : k === "breakdown" ? { by: "state", measure: "count" } : { measure: "count", label: "records" }) }); });
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
                    labelled("While", condition(ctx, "popup.while", p.while, (v) => set((x) => { if (v === undefined) delete x.while; else x.while = v; }), "never: it does not open by itself", { popup: true }), 'A condition over the page: a transaction\'s inputs ({"input": …}, {"lookup": "machine.state"}), a screen\'s parameter ({"param": …}), {"user": "id"} and counts.'),
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
