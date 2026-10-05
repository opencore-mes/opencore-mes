// Reports and the analytics copilot (DESIGN.md §34): the Reports page (the kept reports, and, for those
// who may query, the copilot that puts one together in words), and a report's own page. A report is
// data (report.js): its blocks are drawn here, each from what its query answered for this viewer.
// Charts are SVG built here, coloured by the series tokens (app.css): no chart library.
import { icon } from "./icons.js";
import { richText } from "./rich-text.js";
import { noDefault } from "./select.js";
import { plant } from "./format.js";
import { titleTab } from "./shell.js";
import { confirmDialog } from "./dialog.js";
import { DAYS } from "./schedule.js";
import { reportTags, reportTagsProblem } from "./builtins.js";
import { blockView, widthOf, layoutOfReport, layoutName } from "./report.js";
import { fileChips, fileHref, kindOf, pasteFiles } from "./attach.js";

const TABLE_ROWS = 50;                // of a block's rows, how many a report draws (the query has the rest)
const newKey = () => `rp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const shownNumber = (v) => (typeof v === "number" ? plant().number(v, { max: 3 }) : v === null || v === undefined ? "—" : String(v));

// ---- a report's blocks, drawn ---------------------------------------------------------------------
const wide = (b) => `rep-w-${widthOf(b)}`;
function blockLayout(b, i) {
    const head = b.title ? { h3: b.title } : { span: {} };
    if (b.block === "text") return { section: { key: `b${i}`, className: `panel rep-block rep-text ${wide(b)}`, children: [head, { div: { className: "rep-words", children: richText(b.text) } }] } };
    if (b.error) return { section: { key: `b${i}`, className: `panel rep-block rep-${b.block} ${wide(b)}`, children: [head, { p: { className: "rep-error icon-text", children: [icon("warning"), { span: b.error }] } }] } };
    // A file shown (§34.10): a picture drawn; a PDF or a spreadsheet to open or save, by its name.
    if (b.block === "media") {
        const f = { blob: b.blob, name: b.name ?? b.title ?? "file", type: b.media?.type };
        const picture = String(f.type ?? "").startsWith("image/");
        return { section: { key: `b${i}`, className: `panel rep-block rep-media ${wide(b)}`, children: [
            head,
            picture ? { a: { href: fileHref(f), target: "_blank", rel: "noopener", className: "rep-media-pic", title: "Open it full size", children: [{ img: { src: `/blob/${b.blob}`, alt: b.caption ?? b.title ?? f.name, loading: "lazy" } }] } }
                : { a: { href: fileHref(f), className: "rep-media-file icon-text", children: [icon("file"), { span: f.name }, { span: { className: "muted small", textContent: ` ${kindOf(f.type)}: open or save` } }] } },
            b.caption ? { p: { className: "muted small rep-caption", textContent: b.caption } } : { span: {} },
        ] } };
    }
    const view = blockView(b, b.data);
    if (view.problem) return { section: { key: `b${i}`, className: `panel rep-block rep-${b.block} ${wide(b)}`, children: [head, { p: { className: "rep-error icon-text", children: [icon("warning"), { span: view.problem }] } }] } };
    if (b.block === "figure") return { section: { key: `b${i}`, className: `panel rep-block rep-figure ${wide(b)}`, children: [head, { p: { className: "rep-number", children: [{ span: { className: "rep-value", textContent: shownNumber(view.value) } }, b.unit ? { span: { className: "rep-unit", textContent: ` ${b.unit}` } } : { span: {} }] } }] } };
    // A chart (§34.9): drawn by the chart view from its spec and its query's rows, nothing else.
    if (b.block === "chart") {
        const empty = !view.data.rows.length;
        const height = widthOf(b) === "quarter" ? 220 : widthOf(b) === "full" ? 340 : 300;
        const drawing = empty ? { p: { className: "muted", textContent: "Nothing to draw: the query answered no rows." } }
            : { ChartView: { key: `ch-${i}-${b.chart}-${view.data.rows.length}-${view.data.columns.join(",")}`, spec: view.chart, data: view.data, title: b.title ?? "Chart", height, more: view.more } };
        return { section: { key: `b${i}`, className: `panel rep-block rep-chart-block ${wide(b)}`, children: [head, drawing] } };
    }
    const rows = view.rows.slice(0, TABLE_ROWS);
    return { section: { key: `b${i}`, className: `panel rep-block rep-table ${b.block === "assist" ? "rep-assist " : ""}${wide(b)}`, children: [
        b.block === "assist" ? { h3: { className: "icon-text", children: [icon("sparkle"), { span: b.title ?? "AI assisted" }] } } : head,
        // Advice on a set of records (§34.6): which, the copilot's words, then the rows to act on.
        b.block === "assist" && b.scope ? { p: { className: "muted small", textContent: `For ${b.scope.values.join(", ")}` } } : { span: {} },
        b.block === "assist" ? { div: { className: "rep-words rep-advice", children: richText(b.text) } } : { span: {} },
        rows.length ? { div: { className: "rep-table-box", children: [{ table: { className: "grid", children: [
            { thead: { children: [{ tr: { children: view.columns.map((c) => ({ th: { key: c, textContent: c.replace(/_/g, " ") } })) } }] } },
            { tbody: { children: rows.map((r, k) => ({ tr: { key: k, children: r.map((v, j) => ({ td: { key: j, className: typeof v === "number" ? "num" : "", textContent: typeof v === "number" ? shownNumber(v) : v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v) } })) } })) } },
        ] } }] } } : { p: { className: "muted", textContent: "No rows." } },
        view.rows.length > rows.length || view.more ? { p: { className: "muted small", textContent: `The first ${rows.length} rows are shown: the query has more (run it on the Queries page for all of them).` } } : { span: {} },
    ] } };
}
// A report layout's places (§34.5), sketched: each as wide as it will be drawn, saying what it is for.
// What the person picking one sees, and the designer drawing one.
const PLACE_WORDS = { text: "Text", figure: "Figure", chart: "Chart", table: "Table", assist: "AI assisted line" };
export const layoutSketch = (blocks) => ({ div: { className: "rep-blocks rep-sketch", children: (blocks ?? []).map((b, i) => ({ div: { key: `p${i}`, className: `rep-place rep-place-${b.block} ${wide(b)}`, children: [
    { span: { className: "rep-place-kind", textContent: `${i + 1} · ${PLACE_WORDS[b.block] ?? b.block}${b.block === "chart" && b.chart ? ` (${b.chart})` : ""}` } },
    b.title ? { strong: b.title } : { span: {} },
    b.scope ? { span: { className: "small", textContent: `For ${(b.scope.values ?? []).join(", ")}` } } : { span: {} },
    b.goal ? { span: { className: "muted small", textContent: `Goal: ${b.goal}` } } : { span: {} },
    b.hint ? { span: { className: "muted small", textContent: b.hint } } : { span: {} },
] } })) } });
// (A report drawn on an AI assisted line says which records it is about, §34.6.)
const reportLayout = (run) => ({ div: { children: [
    run.report?.scope ? { p: { className: "small icon-text rep-line", children: [icon("sparkle"), { span: `AI assisted line · for ${run.report.scope.values.join(", ")}` }] } } : { span: {} },
    { div: { className: "rep-blocks", children: (run.blocks ?? []).map(blockLayout) } },
] } });

// How long a tag just taken off can be put back (its undo button).
const UNDO_MS = 3000;
// How many kept reports the copilot is handed at once (the server's ceiling, reports.js).
const MOST_WITH = 12;
const DAY_WORDS = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export function registerReports(juris) {
    // ---- a kept report's own page -----------------------------------------------------------------
    juris.registerComponent("ReportPage", ({ id }, api) => {
        const P = `rep.page.${id}`;
        const load = () => {
            api.setValue(`${P}.busy`, true);
            api.call("reports.run", { id }).then(
                (run) => api.batch(() => { api.setValue(`${P}.run`, run); api.setValue(`${P}.error`, null); api.setValue(`${P}.busy`, false); titleTab(api, `/r/${id}`, run.title); }),
                (e) => api.batch(() => { api.setValue(`${P}.error`, e.message); api.setValue(`${P}.busy`, false); }),
            );
        };
        if (!api.isServer) api.onMount(load);
        // A report layout made from it (§34.11): a new change in the Designer, its places this report's
        // blocks (kinds, order, widths, titles, chart kinds, what each is for), never its queries.
        const makeLayout = async () => {
            const run = api.peek(`${P}.run`);
            const label = String(run.title).replace(/\s*·.*$/, "").trim() || run.title;
            const { body, dropped } = layoutOfReport({ ...run.report, title: label }, { label });
            if (!body.blocks.length) { api.setValue(`${P}.error`, "This report has no block a layout can hold."); return; }
            const files = dropped.length ? ` The file it shows (block ${dropped.join(", ")}) has no place in a layout.` : "";
            if (!(await confirmDialog(api, { title: "Make a report layout from this report?", message: `A new change opens in the Designer with a report layout of its ${body.blocks.length} block(s): their kinds, order, widths, titles and chart kinds, and what each is for, in words. No query goes with it: on a layout, the copilot writes those each time.${files} It is reviewed and approved like any design before anyone can pick it.`, confirm: "Make the layout" }))) return;
            const base = layoutName(label);
            for (let n = 1; n <= 9; n++) {
                const name = n === 1 ? base : `${base.slice(0, 44)}_${n}`;
                try {
                    const started = await api.call("design.start", { layout: name, label, draft: { ...body, name } });
                    api.navigate(`/design/c/${started.id}`);
                    return;
                } catch (e) {
                    // A name taken (live, or another change's draft): the next one.
                    if (e.code === "design.taken" && n < 9) continue;
                    api.setValue(`${P}.error`, e.message);
                    return;
                }
            }
        };
        const share = async (shared) => {
            const run = api.peek(`${P}.run`);
            if (shared && !(await confirmDialog(api, { title: "Share this report?", message: "Everyone who reads reports will find it. Its figures, charts and tables are drawn for each of them from what they may read; its words are yours, as you wrote them: check they say nothing others should not read.", confirm: "Share" }))) return;
            api.call("reports.share", { id: run.id, shared, key: newKey() }).then(load, (e) => api.setValue(`${P}.error`, e.message));
        };
        return { div: { className: "view report-page", children: [
            () => {
                const run = api.getState(`${P}.run`, null);
                const error = api.getState(`${P}.error`, null);
                if (!run) return { div: { children: [{ h1: "AI report" }, error ? { p: { className: "error", textContent: error } } : { p: { className: "muted", textContent: "Reading…" } }] } };
                return { div: { children: [
                    { div: { className: "view-head", children: [
                        { span: { className: "kind", textContent: "AI report" } }, { h1: run.title },
                        run.shared ? { span: { className: "state-badge", textContent: "Shared" } } : { span: { className: "state-badge", textContent: "Yours only" } },
                        { div: { className: "rep-actions", children: [
                            { button: { type: "button", className: "btn", disabled: () => api.getState(`${P}.busy`, false), onclick: load, children: [icon("refresh"), { span: "Run again" }] } },
                            run.mine ? { button: { type: "button", className: "btn", onclick: () => share(!run.shared), children: [icon(run.shared ? "lock" : "users"), { span: run.shared ? "Stop sharing" : "Share" }] } } : { span: {} },
                            api.getState("me.designer", false) ? { button: { type: "button", className: "btn", title: "A new report layout, in a change, with this report's blocks: kinds, order, widths, titles and chart kinds", onclick: makeLayout, children: [icon("layout"), { span: "Make a layout from it" }] } } : { span: {} },
                            { Link: { to: `/o/report/${run.id}`, className: "btn ghost", textContent: "Its record" } },
                        ] } },
                    ] } },
                    run.description ? { p: { className: "muted", textContent: run.description } } : { span: {} },
                    { p: { className: "muted small", textContent: `By ${run.owner} · drawn ${plant().dateTime(run.at)} from what you may read${run.report?.layout ? ` · on the layout ${run.report.layout}` : ""}.` } },
                    error ? { p: { className: "error", textContent: error } } : { span: {} },
                    reportLayout(run),
                ] } };
            },
        ] } };
    });

    // ---- the Reports page: the kept ones, and the copilot ------------------------------------------
    juris.registerComponent("ReportsPage", (props, api) => {
        const R = "rep.home";
        const analyst = () => api.getState("me.query", false);
        // (A list is read as oneself: `as` names the viewer, as every live query does.)
        const loadList = () => api.call("records.list", { object: "report", as: api.peek("me.id") }).then((l) => api.setValue(`${R}.list`, l.rows ?? []), () => api.setValue(`${R}.list`, []));
        // What the copilot last drew, run for this person (its queries run here, as them).
        const draw = (report) => {
            if (!report) { api.setValue(`${R}.run`, null); return; }
            api.call("reports.run", { report }).then((run) => api.setValue(`${R}.run`, run), (e) => api.setValue(`${R}.error`, e.message));
        };
        let timer = null;
        let drawn = null;
        const apply = (v) => {
            api.setValue(`${R}.view`, v);
            const mark = v.report ? JSON.stringify(v.report) : null;
            if (mark !== drawn && !v.running) { drawn = mark; draw(v.report); }
        };
        const poll = () => {
            clearTimeout(timer);
            api.call("analyst.get").then((v) => { apply(v); if (v.running) timer = setTimeout(poll, 700); }, () => { timer = setTimeout(poll, 2000); });
        };
        if (!api.isServer) {
            api.onMount(() => {
                titleTab(api, "/reports", "AI Report");
                loadList();
                // The tag dropdown closes when the pointer goes down elsewhere, or on Escape.
                const away = (e) => { if (api.peek(`${R}.tagMenu`) && !e.target.closest?.(".rep-tag-menu, .rep-tag-add")) api.setValue(`${R}.tagMenu`, null); };
                const escape = (e) => { if (e.key === "Escape" && api.peek(`${R}.tagMenu`)) api.setValue(`${R}.tagMenu`, null); };
                globalThis.document?.addEventListener("pointerdown", away);
                globalThis.document?.addEventListener("keydown", escape);
                if (analyst()) {
                    api.call("analyst.status").then((st) => api.setValue(`${R}.status`, st), () => {});
                    loadPrompts();
                    // Opened from the navigator on a layout (/reports?layout=<name>): that one is picked.
                    const asked = api.peek("$route.query.layout");
                    api.call("reports.layouts", { as: api.peek("me.id") }).then((l) => api.setValue(`${R}.layouts`, l), () => api.setValue(`${R}.layouts`, []));
                    api.call("analyst.get").then((v) => { api.setValue(`${R}.layout`, typeof asked === "string" && asked ? asked : v.layout ?? ""); apply(v); if (v.running) poll(); }, () => {});
                }
                // What it set going, stopped when it leaves (onMount's own cleanup: onCleanup is for setup only).
                return () => { clearTimeout(timer); clearTimeout(promptTimer); globalThis.document?.removeEventListener("pointerdown", away); globalThis.document?.removeEventListener("keydown", escape); };
            });
        }
        const send = async () => {
            const text = (api.peek(`${R}.draft`) ?? "").trim();
            if (!text) return;
            api.setValue(`${R}.error`, null);
            try {
                api.setValue(`${R}.draft`, "");
                const withReports = api.peek(`${R}.with`) ?? [];
                const files = (api.peek(`${R}.files`) ?? []).map(({ blob, name }) => ({ blob, name }));
                apply(await api.call("analyst.send", { text, layout: api.peek(`${R}.layout`) || null, ...(withReports.length ? { reports: withReports } : {}), ...(files.length ? { attachments: files } : {}) }));
                api.batch(() => { api.setValue(`${R}.with`, []); api.setValue(`${R}.picked`, []); api.setValue(`${R}.files`, []); });
                poll();
            } catch (e) {
                api.batch(() => { api.setValue(`${R}.error`, e.message); api.setValue(`${R}.draft`, text); });
            }
        };
        const reset = async () => {
            if ((api.peek(`${R}.view.transcript`) ?? []).length && !(await confirmDialog(api, { title: "Start a new conversation?", message: "The conversation and the report it drew are forgotten; reports you kept stay.", confirm: "Start anew", danger: true }))) return;
            api.call("analyst.reset").then(() => { drawn = null; api.batch(() => { api.setValue(`${R}.view`, { transcript: [], running: false, report: null }); api.setValue(`${R}.run`, null); api.setValue(`${R}.layout`, ""); }); }, (e) => api.setValue(`${R}.error`, e.message));
        };
        const keep = async () => {
            const run = api.peek(`${R}.run`);
            if (!run) return;
            try {
                const kept = await api.call("reports.keep", { report: run.report, shared: false, key: newKey() });
                await loadList();
                api.navigate(`/r/${kept.id}`);
            } catch (e) {
                api.setValue(`${R}.error`, e.message);
            }
        };
        const list = () => {
            const rows = api.getState(`${R}.list`, null);
            if (rows === null) return { p: { className: "muted", textContent: "Reading…" } };
            if (!rows.length) return { p: { className: "muted", textContent: analyst() ? "No report is kept yet: ask the copilot for one, then keep it." : "No report is shared with you yet." } };
            const me = api.getState("me.id", null);
            // Filed under tags (§34.8): every tag in use is a filter; picked, only its reports are listed
            // (and "Select all" takes those).
            const tagsIn = [...new Set(rows.flatMap((r) => reportTags(r.tags)))].sort();
            const filter = (api.getState(`${R}.tags`, []) ?? []).filter((t) => tagsIn.includes(t));
            // A row never moves under the person's hand: the list is in an order no edit changes (title,
            // then when it was kept), and a report whose tag was just taken off stays while it can be
            // put back, even if the filter would no longer show it.
            const undoing = new Set((api.getState(`${R}.undo`, []) ?? []).map((u) => u.id));
            const stable = [...rows].sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? ""), undefined, { numeric: true, sensitivity: "base" }) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id).localeCompare(String(b.id)));
            const shown = stable.filter((r) => undoing.has(r.id) || filter.every((t) => reportTags(r.tags).includes(t))).slice(0, 50);
            const toggleTag = (t) => api.batch(() => { api.setValue(`${R}.tags`, filter.includes(t) ? filter.filter((x) => x !== t) : [...filter, t]); api.setValue(`${R}.picked`, []); });
            // Its author files a report under tags from a dropdown, opened by "Add tag": the tags in use,
            // ticked where the report has them, and a box to find one or add a new one. Each tick is
            // saved at once (shown at once, then confirmed by the list read again).
            const setTags = (r, next) => {
                const wrong = reportTagsProblem(next);
                if (wrong) { api.setValue(`${R}.tagError`, wrong); return; }
                api.batch(() => {
                    api.setValue(`${R}.tagError`, null);
                    api.setValue(`${R}.list`, rows.map((x) => (x.id === r.id ? { ...x, tags: next.join(", ") || null } : x)));
                });
                api.call("reports.tag", { id: r.id, tags: next, key: newKey() }).then(loadList, (e) => { api.setValue(`${R}.tagError`, e.message); loadList(); });
            };
            const tagMenu = (r) => {
                const has = reportTags(r.tags);
                const typed = String(api.getState(`${R}.tagNew`, "") ?? "").trim().toLowerCase().replace(/\s+/g, " ");
                const all = [...new Set([...tagsIn, ...has])].sort().filter((t) => !typed || t.includes(typed));
                const fresh = typed && !tagsIn.includes(typed) && !has.includes(typed) ? typed : null;
                // Picking a tag (one there is, or a new one) is done with it: the dropdown closes.
                const close = () => api.batch(() => { api.setValue(`${R}.tagMenu`, null); api.setValue(`${R}.tagNew`, ""); });
                const add = (t) => { setTags(r, [...has, t]); close(); };
                const error = api.getState(`${R}.tagError`, null);
                return { div: { className: `rep-tag-menu${api.peek(`${R}.tagMenuUp`) ? " up" : ""}${api.peek(`${R}.tagMenuEnd`) ? " end" : ""}`, role: "dialog", "aria-label": `Tags of ${r.title}`, children: [
                    { input: { type: "text", className: "rep-tag-find", placeholder: "Find or add a tag", "aria-label": "Find or add a tag", value: api.getState(`${R}.tagNew`, "") ?? "", oninput: (e) => api.setValue(`${R}.tagNew`, e.target.value),
                        onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); if (fresh) add(fresh); else if (all.length === 1 && !has.includes(all[0])) add(all[0]); } } } },
                    { div: { className: "rep-tag-options", children: [
                        ...all.map((t) => ({ label: { key: t, className: "rep-tag-option", children: [{ input: { type: "checkbox", checked: has.includes(t), onchange: (e) => { setTags(r, e.target.checked ? [...has, t] : has.filter((x) => x !== t)); close(); } } }, { span: t }] } })),
                        fresh ? { button: { key: "$new", type: "button", className: "rep-tag-option rep-tag-create", onclick: () => add(fresh), children: [icon("plus"), { span: `Add "${fresh}"` }] } } : { span: {} },
                        !all.length && !fresh ? { p: { className: "muted small", textContent: "No tag yet: type one." } } : { span: {} },
                    ] } },
                    error ? { p: { className: "field-error small", textContent: error } } : { span: {} },
                ] } };
            };
            // Its × takes a tag off at once, no question asked; for three seconds the tag stays in its
            // place, struck through, with an undo button that puts it back where it was.
            const removeTag = (r, t) => {
                const has = reportTags(r.tags);
                const at = has.indexOf(t);
                setTags(r, has.filter((x) => x !== t));
                const undo = { key: `${r.id}|${t}|${Date.now()}`, id: r.id, tag: t, at };
                api.setValue(`${R}.undo`, [...(api.peek(`${R}.undo`) ?? []).filter((u) => !(u.id === r.id && u.tag === t)), undo]);
                if (!api.isServer) setTimeout(() => api.setValue(`${R}.undo`, (api.peek(`${R}.undo`) ?? []).filter((u) => u.key !== undo.key)), UNDO_MS);
            };
            const undoRemove = (r, u) => {
                api.setValue(`${R}.undo`, (api.peek(`${R}.undo`) ?? []).filter((x) => x.key !== u.key));
                const has = reportTags(r.tags).filter((x) => x !== u.tag);
                setTags(r, [...has.slice(0, u.at), u.tag, ...has.slice(u.at)]);
            };
            // A report's chips: its tags (its author's with an ×), and in their places those just taken off.
            const chips = (r) => {
                const mine = r.owner === me;
                const out = reportTags(r.tags).map((t) => ({ key: `t:${t}`, node: mine
                    ? { span: { key: `t:${t}`, className: "rep-tag small rep-tag-own", children: [{ span: t }, { button: { type: "button", className: "rep-tag-x", title: `Take off "${t}"`, "aria-label": `Take off the tag ${t}`, onclick: () => removeTag(r, t), children: [icon("x")] } }] } }
                    : { span: { key: `t:${t}`, className: "rep-tag small", textContent: t } } }));
                for (const u of (api.getState(`${R}.undo`, []) ?? []).filter((x) => x.id === r.id && !reportTags(r.tags).includes(x.tag)).sort((a, b) => a.at - b.at)) {
                    out.splice(Math.min(u.at, out.length), 0, { key: u.key, node: { button: { key: u.key, type: "button", className: "rep-tag small rep-tag-own rep-tag-undo", title: `Undo: put "${u.tag}" back`, "aria-label": `Undo taking off the tag ${u.tag}`, onclick: () => undoRemove(r, u), children: [{ span: u.tag }, { span: { className: "rep-tag-x", children: [icon("undo")] } }] } } });
                }
                return out.map((c) => c.node);
            };
            // Opened where it is: under its button, from its left edge (from its right edge when the tab has no
            // room to the right), or above it when the tab has no room below (a report low in a long list); its
            // box takes the cursor without scrolling the tab away from the list.
            const openMenu = (r, e) => {
                const open = api.peek(`${R}.tagMenu`) === r.id;
                const at = e?.currentTarget?.getBoundingClientRect?.();
                const pane = e?.currentTarget?.closest?.(".tabbody")?.getBoundingClientRect?.() ?? { top: 0, bottom: globalThis.innerHeight ?? 800, right: globalThis.innerWidth ?? 1200 };
                const up = Boolean(at && pane.bottom - at.bottom < 280 && at.top - pane.top > pane.bottom - at.bottom);
                const end = Boolean(at && at.left + 248 > pane.right);
                api.batch(() => { api.setValue(`${R}.tagMenu`, open ? null : r.id); api.setValue(`${R}.tagMenuUp`, up); api.setValue(`${R}.tagMenuEnd`, end); api.setValue(`${R}.tagNew`, ""); api.setValue(`${R}.tagError`, null); });
                if (!open && !api.isServer) setTimeout(() => globalThis.document?.querySelector(".rep-tag-menu .rep-tag-find")?.focus({ preventScroll: true }), 0);
            };
            const picked = (api.getState(`${R}.picked`, []) ?? []).filter((id) => shown.some((r) => r.id === id));
            const pick = (id, on) => api.setValue(`${R}.picked`, on ? [...new Set([...picked, id])].slice(0, MOST_WITH) : picked.filter((x) => x !== id));
            return { div: { children: [
                tagsIn.length ? { div: { className: "rep-tags-bar", role: "group", "aria-label": "Filter by tag", children: [
                    { span: { className: "muted small", textContent: "Filter" } },
                    ...tagsIn.map((t) => ({ button: { key: t, type: "button", className: "rep-tag", classList: { on: filter.includes(t) }, "aria-pressed": String(filter.includes(t)), textContent: t, onclick: () => toggleTag(t) } })),
                    filter.length ? { button: { type: "button", className: "linkish", textContent: "show all", onclick: () => api.setValue(`${R}.tags`, []) } } : { span: {} },
                ] } } : { span: {} },
                // Those who ask the copilot pick reports for it to work from: a summary of several.
                analyst() ? { div: { className: "rep-pickbar", children: [
                    { label: { className: "rep-check", children: [{ input: { type: "checkbox", checked: picked.length > 0 && picked.length === Math.min(shown.length, MOST_WITH), "aria-label": "Select all", onchange: (e) => api.setValue(`${R}.picked`, e.target.checked ? shown.slice(0, MOST_WITH).map((r) => r.id) : []) } }, { span: picked.length ? `${picked.length} selected` : "Select all" }] } },
                    { button: { type: "button", className: "btn small", disabled: !picked.length, title: `The copilot is handed the selected reports (at most ${MOST_WITH}) with what you ask next`, textContent: "Ask the copilot about the selected", onclick: () => { api.setValue(`${R}.with`, picked); if (!api.isServer) globalThis.document?.getElementById("analyst-ask")?.focus(); } } },
                ] } } : { span: {} },
                // Each report on two lines: picked, its title (whole, however narrow the card) and whose it
                // is; under the title, its tags.
                { ul: { className: "rep-list", children: shown.map((r) => ({ li: { key: r.id, children: [
                    analyst() ? { input: { type: "checkbox", className: "rep-row-pick", checked: picked.includes(r.id), "aria-label": `Select ${r.title}`, onchange: (e) => pick(r.id, e.target.checked) } } : { span: { className: "rep-row-pick" } },
                    { Link: { to: `/r/${r.id}`, className: "rep-list-link", children: [icon("chart"), { span: r.title }] } },
                    { span: { className: "rep-tags rep-tags-row", children: [
                        ...chips(r),
                        // The dropdown hangs from its button, not from the row: it opens where the pointer already is.
                        r.owner === me ? { span: { key: "$add", className: "rep-tag-anchor", children: [
                            { button: { type: "button", className: "rep-tag-add", "aria-haspopup": "dialog", "aria-expanded": String(api.getState(`${R}.tagMenu`, null) === r.id), onclick: (e) => openMenu(r, e), children: [icon("plus"), { span: "Add tag" }] } },
                            api.getState(`${R}.tagMenu`, null) === r.id ? tagMenu(r) : { span: {} },
                        ] } } : { span: {} },
                    ] } },
                    { span: { className: "rep-who muted small", textContent: r.owner === me ? (r.shared ? "yours, shared" : "yours") : `by ${r.owner}` } },
                ] } })) } },
                !shown.length ? { p: { className: "muted small", textContent: "No kept report has all of these tags." } } : { span: {} },
            ] } };
        };

        // ---- kept prompts (§34.7): asked again, changed, or asked by the clock ----
        let promptTimer = null;
        const loadPrompts = () => api.call("prompts.list").then((l) => {
            const before = api.peek(`${R}.prompts`) ?? [];
            api.setValue(`${R}.prompts`, l);
            // One that has just finished kept a report: the list of reports follows.
            if (before.some((p) => p.running) && !l.some((p) => p.running)) loadList();
            clearTimeout(promptTimer);
            if (l.some((p) => p.running)) promptTimer = setTimeout(loadPrompts, 2000);
        }, () => api.setValue(`${R}.prompts`, []));
        // A schedule as the form holds it, and back (schedule.js: at times of day, or every so often).
        const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
        const formOf = (p) => {
            const sc = p.schedule ?? null;
            const days = sc?.days ?? null;
            const when = !p.id ? "" : !sc ? "none" : sc.every ? "hours" : !days ? "daily" : days.length === 5 && WEEKDAYS.every((d) => days.includes(d)) ? "weekdays" : days.length === 1 ? "weekly" : "daily";
            return { id: p.id ?? null, title: p.title ?? "", prompt: p.prompt ?? "", layout: p.layout ?? "", tags: p.tags ?? "", when, time: sc?.at?.[0] ?? "", day: days?.length === 1 ? days[0] : "", hours: sc?.every?.hours ? String(sc.every.hours) : "" };
        };
        const scheduleOf = (f) => (f.when === "none" ? null : f.when === "hours" ? { every: { hours: Number(f.hours) } } : { at: [f.time], ...(f.when === "weekdays" ? { days: WEEKDAYS } : f.when === "weekly" ? { days: [f.day] } : {}) });
        const edit = (p) => api.batch(() => { api.setValue(`${R}.edit`, formOf(p)); api.setValue(`${R}.editErrors`, null); api.setValue(`${R}.editFiles`, p?.attachments ?? []); });
        const setEdit = (key, value) => api.setValue(`${R}.edit`, { ...(api.peek(`${R}.edit`) ?? {}), [key]: value });
        const savePrompt = async () => {
            const f = api.peek(`${R}.edit`);
            if (!f) return;
            // What only the page can tell: how often, and the time it needs.
            const missing = {};
            if (!f.when) missing.schedule = "Say when it is asked: only when you ask, or by the clock.";
            else if (["daily", "weekdays", "weekly"].includes(f.when) && !f.time) missing.schedule = "Give the time of day.";
            else if (f.when === "weekly" && !f.day) missing.schedule = "Give the day of the week.";
            else if (f.when === "hours" && !(Number.isInteger(Number(f.hours)) && Number(f.hours) >= 1 && Number(f.hours) <= 24)) missing.schedule = "Every how many hours: 1 to 24.";
            // Asked by the clock, its reports are filed under tags (§34.8): at least one.
            if (f.when && f.when !== "none" && !reportTags(f.tags ?? "").length) missing.tags = "A prompt asked by the clock files its reports under tags: give at least one (daily, wirebond).";
            if (Object.keys(missing).length) { api.setValue(`${R}.editErrors`, missing); return; }
            try {
                await api.call("prompts.save", { ...(f.id ? { id: f.id } : {}), title: f.title, prompt: f.prompt, layout: f.layout || null, tags: f.tags || null, schedule: scheduleOf(f), attachments: (api.peek(`${R}.editFiles`) ?? []).map(({ blob, name }) => ({ blob, name })) });
                api.batch(() => { api.setValue(`${R}.edit`, null); api.setValue(`${R}.editErrors`, null); });
                loadPrompts();
            } catch (e) {
                api.setValue(`${R}.editErrors`, e.fields ?? { title: e.message });
            }
        };
        const removePrompt = async (p) => {
            if (!(await confirmDialog(api, { title: "Remove this prompt?", message: `"${p.title}" is no longer kept${p.schedule ? ", and no longer asked by the clock" : ""}. The reports it generated stay.`, confirm: "Remove", danger: true }))) return;
            api.call("prompts.remove", { id: p.id }).then(loadPrompts, (e) => api.setValue(`${R}.error`, e.message));
        };
        const generate = (p) => api.call("prompts.run", { id: p.id }).then(loadPrompts, (e) => api.setValue(`${R}.error`, e.message));
        // Pinned to a report (§34.11): each run repeats it, its queries run again; or unpinned (null).
        const pin = (p, report, words) => api.call("prompts.fix", { id: p.id, ...(report !== undefined ? { report } : {}), ...(words ? { words } : {}) }).then(loadPrompts, (e) => api.setValue(`${R}.error`, e.message));
        // Whether a run asks the AI: unless its pinned report's words are kept as written.
        const asksAi = (p) => !p.fixed || p.words === "fresh";
        const pinned = (p) => ({ div: { className: "rep-pinned small", children: [
            { p: { className: "icon-text", children: [icon("lock"), { span: { children: [
                { span: "Each run repeats " },
                p.fixed.from ? { Link: { to: `/r/${p.fixed.from}`, textContent: p.fixed.title ?? "its pinned report" } } : { strong: p.fixed.title ?? "its pinned report" },
                { span: `: its ${p.fixed.blocks} block(s), titles and charts, its queries run again as you.` },
            ] } }] } },
            { label: { className: "rep-words-pick", children: [
                { span: "Its words" },
                { select: { "aria-label": "Its words", disabled: p.running, onchange: (e) => pin(p, undefined, e.target.value), children: [["kept", "As written (no AI)"], ["fresh", "Written fresh by the copilot, each run"]].map(([v, l]) => ({ option: { key: v, value: v, selected: (p.words ?? "kept") === v, textContent: l } })) } },
            ] } },
            { p: { className: "muted", textContent: p.words === "fresh" ? "The copilot writes only its words, from what each run's queries answer; its blocks and queries stay as they are." : "Its words stay as first written: a sentence that quotes a number keeps that number. Written fresh, the copilot rewrites only the words from each run's answers." } },
        ] } });
        // Into the box, to ask as it is or changed first.
        const useIt = (p) => { api.batch(() => { api.setValue(`${R}.draft`, p.prompt); api.setValue(`${R}.layout`, p.layout ?? ""); }); if (!api.isServer) globalThis.document?.getElementById("analyst-ask")?.focus(); };
        // What was asked last, or what is in the box, kept under a title.
        const keepPrompt = () => {
            const asked = [...(api.peek(`${R}.view.transcript`) ?? [])].reverse().find((m) => m.role === "user")?.text ?? "";
            // What was attached goes with it: the box's files, else those of what was asked last.
            const lastFiles = [...(api.peek(`${R}.view.transcript`) ?? [])].reverse().find((m) => m.role === "user")?.files ?? [];
            const boxFiles = api.peek(`${R}.files`) ?? [];
            edit({ prompt: (api.peek(`${R}.draft`) ?? "").trim() || asked, layout: api.peek(`${R}.layout`) || "", attachments: boxFiles.length ? boxFiles : lastFiles });
        };
        const field = (label, control, error) => ({ label: { className: "ed-field", children: [{ span: label }, control, error ? { span: { className: "field-error", textContent: error } } : { span: {} }] } });
        const promptEditor = () => {
            const f = api.getState(`${R}.edit`, null);
            if (!f) return { span: {} };
            const errors = api.getState(`${R}.editErrors`, null) ?? {};
            const layouts = api.getState(`${R}.layouts`, null) ?? [];
            return { div: { className: "rep-prompt-edit", children: [
                { strong: f.id ? "Change the prompt" : "Keep a prompt" },
                field("Title", { input: { type: "text", value: f.title, "aria-label": "The prompt's title", oninput: (e) => setEdit("title", e.target.value) } }, errors.title),
                field("What to ask", { textarea: { ...pasteFiles(api, `${R}.editFiles`), rows: 4, value: f.prompt, "aria-label": "What to ask", oninput: (e) => setEdit("prompt", e.target.value) } }, errors.prompt),
                field("Given with it each time", { AttachFiles: { key: `prompt-files-${f.id ?? "new"}`, path: `${R}.editFiles`, label: "Attach" } }, errors.attachments),
                layouts.length ? field("Layout", { select: { "aria-label": "The layout it is drawn on", onchange: (e) => setEdit("layout", e.target.value), children: [{ option: { value: "", selected: !f.layout, textContent: "None: the copilot arranges it" } }, ...layouts.map((l) => ({ option: { key: l.name, value: l.name, selected: l.name === f.layout, textContent: l.label } }))] } }, errors.layout) : { span: {} },
                field(f.when && f.when !== "none" ? "Tags of the reports it generates *" : "Tags of the reports it generates", { input: { type: "text", value: f.tags, "aria-label": "Tags of the reports it generates", oninput: (e) => setEdit("tags", e.target.value) } }, errors.tags),
                { div: { className: "ed-row", children: [
                    field("Asked", { select: { "aria-label": "When it is asked", onchange: (e) => setEdit("when", e.target.value), children: noDefault([["none", "Only when I ask"], ["daily", "Every day"], ["weekdays", "Monday to Friday"], ["weekly", "Once a week"], ["hours", "Every few hours"]].map(([v, l]) => ({ option: { key: v, value: v, selected: f.when === v, textContent: l } }))) } }, errors.schedule),
                    f.when === "weekly" ? field("On", { select: { "aria-label": "The day of the week", onchange: (e) => setEdit("day", e.target.value), children: noDefault(DAYS.map((d) => ({ option: { key: d, value: d, selected: f.day === d, textContent: DAY_WORDS[d] } }))) } }) : { span: {} },
                    ["daily", "weekdays", "weekly"].includes(f.when) ? field("At", { input: { type: "time", value: f.time, "aria-label": "The time of day", oninput: (e) => setEdit("time", e.target.value) } }) : { span: {} },
                    f.when === "hours" ? field("Every (hours)", { input: { type: "number", min: 1, max: 24, value: f.hours, "aria-label": "Every how many hours", oninput: (e) => setEdit("hours", e.target.value) } }) : { span: {} },
                ] } },
                f.when && f.when !== "none" ? { p: { className: "muted small", textContent: "By the clock it is asked as you, with your rights as they are then, and each report it draws is kept as yours. Times are the plant's." } } : { span: {} },
                { div: { className: "copilot-buttons", children: [
                    { button: { type: "button", className: "btn primary", textContent: f.id ? "Save" : "Keep", onclick: savePrompt } },
                    { button: { type: "button", className: "btn ghost", textContent: "Cancel", onclick: () => api.setValue(`${R}.edit`, null) } },
                ] } },
            ] } };
        };
        const promptList = () => {
            const rows = api.getState(`${R}.prompts`, null);
            if (rows === null) return { p: { className: "muted", textContent: "Reading…" } };
            if (!rows.length) return { p: { className: "muted", textContent: "No prompt is kept yet. Keep what you ask the copilot, to ask it again, change it, or have it asked by the clock." } };
            return { ul: { className: "rep-prompts", children: rows.map((p) => ({ li: { key: p.id, children: [
                { div: { className: "rep-prompt-head", children: [
                    { strong: p.title },
                    { span: { className: "muted small", textContent: p.running ? "being generated…" : p.scheduleWords ? `${p.scheduleWords}${p.next_at ? `; next ${plant().dateTime(p.next_at)}` : ""}` : "asked only when you ask" } },
                ] } },
                { p: { className: "rep-prompt-text muted small", textContent: p.prompt.length > 220 ? `${p.prompt.slice(0, 220)}…` : p.prompt } },
                p.tags ? { p: { className: "rep-tags", children: reportTags(p.tags).map((t) => ({ span: { key: t, className: "rep-tag small", textContent: t } })) } }
                    : p.schedule ? { p: { className: "field-error small", textContent: "Asked by the clock with no tags: its reports are filed under nothing. Change it to give it tags." } } : { span: {} },
                p.fixed ? pinned(p) : { span: {} },
                p.last_error ? { p: { className: "field-error small", textContent: `Last time (${plant().dateTime(p.last_at)}): ${p.last_error}` } }
                    : p.last_report ? { p: { className: "small", children: [{ span: { className: "muted", textContent: `Last generated ${plant().dateTime(p.last_at)}: ` } }, { Link: { to: `/r/${p.last_report}`, textContent: "open the report" } }] } } : { span: {} },
                { div: { className: "rep-prompt-actions", children: [
                    { button: { type: "button", className: "btn small", textContent: "Put it in the box", title: "To ask as it is, or changed first", onclick: () => useIt(p) } },
                    { button: { type: "button", className: "btn small", textContent: "Generate now", disabled: p.running || (asksAi(p) && !api.getState(`${R}.status.configured`, false)), title: p.fixed ? "Its pinned report's queries run again as you now; the report is kept as yours" : "Asked as you now; the report it draws is kept as yours", onclick: () => generate(p) } },
                    p.fixed ? { button: { type: "button", className: "btn small", textContent: "Ask the copilot each time", disabled: p.running, title: "Unpin it: each run asks the copilot again, and it arranges the report", onclick: () => pin(p, null) } }
                        : p.last_report ? { button: { type: "button", className: "btn small", textContent: "Keep this report's queries", disabled: p.running, title: "Pin it to the last report it drew: each run repeats its blocks, titles and charts, its queries run again, without asking the copilot", onclick: () => pin(p, p.last_report) } } : { span: {} },
                    { button: { type: "button", className: "btn small", textContent: "Change", onclick: () => edit(p) } },
                    { button: { type: "button", className: "btn ghost small", textContent: "Remove", disabled: p.running, onclick: () => removePrompt(p) } },
                ] } },
            ] } })) } };
        };
        return { div: { className: "view reports", children: [
            { div: { className: "view-head", children: [{ h1: "AI Report" }, { span: { className: "muted", textContent: "Words, figures, charts and tables from the plant's data, drawn for whoever opens them from what they may read." } }] } },
            () => { const e = api.getState(`${R}.error`, null); return e ? { p: { className: "error", textContent: e } } : { span: {} }; },
            { div: { className: "rep-layout", classList: { solo: () => !analyst() }, children: [
                () => (analyst() ? { section: { className: "rep-card rep-copilot", children: [
                    { h3: { className: "icon-text", children: [icon("sparkle"), { span: "Analytics copilot" }] } },
                    () => {
                        const st = api.getState(`${R}.status`, null);
                        if (!st) return { p: { className: "muted small", textContent: "…" } };
                        if (!st.configured) return { p: { className: "copilot-off", textContent: st.hint } };
                        return { p: { className: "muted small", textContent: `${st.provider === "anthropic" ? "Claude" : st.provider} · ${st.model}. It reads the views you may query, as you, and draws a report; it changes nothing. Each query it runs is in the audit trail.` } };
                    },
                    { div: { id: "analyst-log", className: "copilot-log", children: () => {
                        const v = api.getState(`${R}.view`, null);
                        const items = v?.transcript ?? [];
                        if (!api.isServer) setTimeout(() => { const el = globalThis.document?.getElementById("analyst-log"); if (el) el.scrollTop = el.scrollHeight; }, 0);
                        const out = items.map((m, i) => (m.role === "tool"
                            ? { div: { key: i, className: `cp-tool icon-text ${m.ok ? "ok" : "bad"}`, children: [icon(m.ok ? "check" : "x"), { span: `${m.name.replace(/_/g, " ")} — ${m.text}` }] } }
                            : m.role === "assistant" ? { div: { key: i, className: "cp-msg assistant", children: richText(m.text) } }
                            : m.files?.length ? { div: { key: i, className: `cp-msg ${m.role}`, children: [{ div: m.text }, fileChips(m.files)] } }
                            : { div: { key: i, className: `cp-msg ${m.role}`, textContent: m.text } }));
                        if (v?.running) out.push({ div: { key: "working", className: "cp-working", textContent: `Working… (step ${v.step || 1})` } });
                        if (!items.length && !v?.running) out.push({ p: { key: "empty", className: "muted small", textContent: "Ask what you want to see: \"How many lots are in each state, and which have waited longest?\", \"Scrap by reason this month, as a chart\", \"What is the situation on line 2?\"" } });
                        return out;
                    } } },
                    // The layout the report is drawn on (§34.5): designed and approved, picked here.
                    () => {
                        const layouts = api.getState(`${R}.layouts`, null) ?? [];
                        const picked = api.getState(`${R}.layout`, "") ?? "";
                        const layout = layouts.find((l) => l.name === picked);
                        if (!layouts.length) return { p: { className: "muted small", textContent: "No report layout is published yet: the copilot arranges the report. A designer draws layouts in the Designer, under Report layouts." } };
                        return { div: { className: "rep-pick", children: [
                            { label: { className: "rep-pick-label", children: [
                                { span: "Layout" },
                                { select: { "aria-label": "The layout the report is drawn on", disabled: () => Boolean(api.getState(`${R}.view.running`, false)), onchange: (e) => api.setValue(`${R}.layout`, e.target.value), children: noDefault([
                                    { option: { value: "", selected: !picked, textContent: "None: the copilot arranges it" } },
                                    ...layouts.map((l) => ({ option: { key: l.name, value: l.name, selected: l.name === picked, textContent: l.label } })),
                                ]) } },
                            ] } },
                            // What it draws, folded away: the conversation keeps the column.
                            layout ? { details: { className: "rep-pick-more", children: [
                                { summary: { className: "muted small", textContent: layout.scope ? "An AI assisted line: what this layout draws" : "What this layout draws" } },
                                layout.description ? { p: { className: "muted small", textContent: layout.description } } : { span: {} },
                                layout.scope ? { p: { className: "small", textContent: `For ${layout.scope.values.join(", ")}. Goal: ${layout.goal}` } } : { span: {} },
                                layoutSketch(layout.blocks),
                            ] } } : { span: {} },
                        ] } };
                    },
                    { div: { className: "copilot-input", children: [
                        // The kept reports handed over with what is asked next (picked in the list).
                        () => {
                            const ids = api.getState(`${R}.with`, []) ?? [];
                            if (!ids.length) return { span: {} };
                            return { p: { className: "rep-with small", children: [{ span: `With ${ids.length} kept report(s): say what you want of them (a summary, what changed, what to do next).` }, { button: { type: "button", className: "linkish", textContent: "without them", onclick: () => api.setValue(`${R}.with`, []) } }] } };
                        },
                        { AttachFiles: { key: "analyst-files", path: `${R}.files`, disabled: () => Boolean(api.getState(`${R}.view.running`, false)) } },
                        { textarea: { ...pasteFiles(api, `${R}.files`), id: "analyst-ask", rows: 3, placeholder: "What do you want to know?", "aria-label": "Ask the analytics copilot", value: () => api.getState(`${R}.draft`, "") ?? "", oninput: (e) => api.setValue(`${R}.draft`, e.target.value), onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); } } },
                        { div: { className: "copilot-buttons", children: [
                            { button: { type: "button", className: "btn primary", disabled: () => Boolean(api.getState(`${R}.view.running`, false)) || !api.getState(`${R}.status.configured`, false), onclick: send, textContent: "Ask" } },
                            { button: { type: "button", className: "btn", onclick: keepPrompt, title: "Keep what is in the box, or what you asked last, to ask again, change, or have asked by the clock", textContent: "Keep prompt" } },
                            { button: { type: "button", className: "btn", onclick: reset, title: "Start a new conversation: this one and the report it drew are forgotten; kept reports stay", textContent: "New chat" } },
                        ] } },
                    ] } },
                ] } } : { span: {} }),
                // The report itself, beside the conversation that drew it; under it, the reports kept.
                { div: { className: "rep-main", children: [
                    // What the copilot drew, for this person, until it is kept.
                    () => {
                        const run = api.getState(`${R}.run`, null);
                        if (!run) return analyst() ? { section: { className: "rep-card rep-empty", children: [{ h3: "The report" }, { p: { className: "muted", textContent: "Nothing is drawn yet. Ask the copilot: the report it draws appears here, and is yours alone until you keep it." } }] } } : { span: {} };
                        return { section: { className: "rep-card rep-drawn", children: [
                            { div: { className: "view-head", children: [
                                { span: { className: "kind", textContent: "Drawn, not kept" } }, { h2: run.title },
                                { div: { className: "rep-actions", children: [{ button: { type: "button", className: "btn primary", onclick: keep, children: [icon("check"), { span: "Keep this report" }] } }] } },
                            ] } },
                            run.description ? { p: { className: "muted", textContent: run.description } } : { span: {} },
                            reportLayout(run),
                        ] } };
                    },
                    { section: { className: "rep-card rep-kept", children: [{ h3: "Kept reports" }, list] } },
                    () => (analyst() ? { section: { className: "rep-card rep-kept-prompts", children: [{ h3: "Kept prompts" }, promptEditor, promptList] } } : { span: {} }),
                ] } },
            ] } },
        ] } };
    });
}
