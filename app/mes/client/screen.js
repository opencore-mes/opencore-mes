// A screen (DESIGN.md §26): a page of building blocks drawn from its definition. The blocks are the
// fixed components below; a definition only chooses and configures them, so nothing a designer
// writes ever runs here. Values are drawn as text. What each block shows comes from screens.data,
// read with the viewer's own rights and re-run whenever a record changes.
//   /s/<name>          a screen with no parameter, or one asking for it (scan a machine)
//   /s/<name>/<value>  opened with its parameter
import { titleTab, retab, deskHome, homeFill } from "./shell.js";
import { noDefault } from "./select.js";
import { evaluate } from "./expr.js";
import { confirmDialog } from "./dialog.js";
import { plant } from "./format.js";
import { icon } from "./icons.js";
import { recordFileUrl } from "./media.js";
import { richText } from "./rich-text.js";
import { stateBadgeClass } from "./theme.js";
import { focusFirst, controlFor, controlsOf } from "./keyboard.js";
import { driveInputFlow } from "./input-flow-driver.js";
import { transactionRootId } from "./transaction.js";
import { floorView } from "./floor-view.js";
import { suiteBlocks } from "./suite-registry.js";
import { isHidden } from "./definition.js";
import { editorPanel } from "./editor-kit.js";
import { windowTable } from "./window-rows.js";

// The records holding part of a title (§26.1, a parameter's search), as this person may read them: their count by state
// and a first page, kept for the screen's ParamMatches. `only`: one state's. → what it found, or null.
// A screen opened on a record, or back on its scan (value null). One that keeps one tab (oneTab: a desk worked all
// day) moves the tab it is in to the new path, so no tab opens for each record; the last end's words go once the
// next record is opened.
function keepTab(api, screen, value) {
    if (!api.peek(`scr.${screen}.def.oneTab`)) return;
    const to = value ? `/s/${screen}/${encodeURIComponent(value)}` : `/s/${screen}`;
    const here = api.peek("$route.path");
    if (here && here !== to && here.startsWith(`/s/${screen}`)) retab(api, here, to, api.peek(`scr.${screen}.def.label`));
    if (value) api.setValue(`scr.${screen}.flowDone`, null);
}
function openScreen(api, screen, value) {
    keepTab(api, screen, value);
    api.navigate(value ? `/s/${screen}/${encodeURIComponent(value)}` : `/s/${screen}`);
}

function findMatches(api, screen, spec, q, only) {
    const show = Array.isArray(spec.search?.show) ? spec.search.show : [];
    return api.call("records.matching", { object: spec.to, q, state: only, limit: 30, show, where: spec.where ?? null, as: api.peek("me.id") })
        .then((r) => { const m = { ...r, only, loading: false }; api.setValue(`scr.${screen}.matches`, r.total ? m : null); return m; }, () => null);
}

const words = (v) => String(v ?? "").replace(/_/g, " ");
const number = (v) => (typeof v === "number" ? plant().number(v) : "—");
// One value as text: a reference by its record's title, a state as a badge, a list joined; a sensitive
// one (§6.10) hidden, with Show (records.js SensitiveValue), when the block says whose (`object`).
function cell(field, row, name, tones, object = null) {
    if (name === "state") return { span: { className: stateBadgeClass(row.state, tones), textContent: words(row.state) } };
    const v = row?.[name];
    if (v === undefined) return { span: { className: "muted", title: "Not visible to you", textContent: "·" } };
    if (isHidden(v)) return object && row.id ? { SensitiveValue: { object, id: row.id, field: name, label: field?.label ?? name, type: field?.type ?? "string" } } : { span: { className: "muted", textContent: "Hidden: sensitive" } };
    if (v === null || v === "") return { span: { className: "muted", textContent: "—" } };
    if (field?.type === "ref") return { span: { textContent: row.$titles?.[name] ?? "(not visible)" } };
    // A picture shown small; a file as a link to open it (§35.4), read through its record when the block says whose.
    if (field?.type === "image" && typeof v === "string") return { img: { className: "cell-picture", src: object && row.id ? recordFileUrl(object, row.id, name) : `/blob/${v}`, alt: "", loading: "lazy" } };
    if (field?.type === "file" && typeof v === "string") return { MediaView: { key: `cf-${row.id}-${name}-${v}`, src: object && row.id ? recordFileUrl(object, row.id, name) : `/blob/${v}`, compact: true } };
    if (Array.isArray(v)) return { span: { textContent: v.join(", ") } };
    if (typeof v === "number") return { span: { textContent: number(v) } };
    if (typeof v === "boolean") return { span: { textContent: v ? "yes" : "no" } };
    return { span: { textContent: String(v) } };
}
const labelOf = (fields, name) => (name === "state" ? "State" : fields?.[name]?.label ?? name);

export function registerScreens(juris, { args }) {
    // `dialog`: shown over another page (§26.6): no tab, no Maximize, no pop-ups of its own.
    // Its tab named after the screen alone where it keeps one tab (oneTab), else after the record it is opened on too.
    juris.registerComponent("ScreenView", ({ name, arg = null, dialog = false }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const S = `scr.${name}`;
        const defPath = `${S}.def`;
        const dataPath = `${S}.data.${String(arg ?? "-").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        api.live(defPath, "screens.get", args.screen(name, as));
        api.live(dataPath, "screens.data", args.screenData(name, arg, as));
        if (!api.isServer && !dialog) {
            const stop = api.bindState(() => [api.getState(`${defPath}.label`), api.getState(`${dataPath}.param.title`)], ([label, title]) => {
                if (label) titleTab(api, arg ? `/s/${name}/${arg}` : `/s/${name}`, title && !api.peek(`${defPath}.oneTab`) ? `${label}: ${title}` : label);
            });
            api.onCleanup(stop);
        }
        return {
            div: {
                id: dialog ? undefined : `screen-root-${name}`,
                className: dialog ? "view screen in-dialog" : "view screen",
                children: [
                    () => {
                        const d = api.getState(defPath);
                        if (d === null) return { div: { children: [{ h1: "Not available" }, { p: { className: "muted", textContent: "This screen does not exist, or it is not shared with you." } }] } };
                        if (!d) return { p: { className: "muted", textContent: "Loading…" } };
                        const [param, spec] = Object.entries(d.params ?? {})[0] ?? [];
                        return {
                            div: {
                                className: "record-head screen-head",
                                children: [
                                    { div: { className: "title", children: [
                                        dialog ? { span: {} } : { GuideToggle: { key: `guide-s-${name}`, guide: "screen" } },
                                        { span: { className: "kind", textContent: "Screen" } },
                                        { h1: d.label },
                                        () => { const t = api.getState(`${dataPath}.param.title`, null); return t ? { span: { className: "screen-param", textContent: t } } : { span: {} }; },
                                        () => { const st = api.getState(`${dataPath}.param.state`, null); return st ? { span: { className: stateBadgeClass(st, api.getState(`${dataPath}.param.tones`, null)), textContent: words(st) } } : { span: {} }; },
                                        // Its design may let it fill the window (a board, a work centre's tablet).
                                        // So may this desktop's own page (§6.8): opened filled at each sign-in, whatever its design says.
                                        (d.maximize || deskHome(api, arg ? `/s/${name}/${arg}` : `/s/${name}`)) && !dialog ? { MaximizeToggle: { key: `max-${name}`, path: arg ? `/s/${name}/${arg}` : `/s/${name}`, ...homeFill(api, arg ? `/s/${name}/${arg}` : `/s/${name}`, d.maximize, `s.${name}`) } } : { span: {} },
                                    ] } },
                                    // In a dialog, what opened it chose the record; picking another would leave the page.
                                    param && !dialog ? { ParamPicker: { key: `pp-${name}`, screen: name, param, spec, current: arg } } : { span: {} },
                                    d.description ? { p: { className: "muted", textContent: d.description } } : { span: {} },
                                ],
                            },
                        };
                    },
                    // Its input flow (§32.13): over its parameter and its transaction forms, from the keyboard;
                    // what it asks for now, under the heading.
                    () => { const v = api.getState(`${defPath}.inputFlow.version`, null); return v && !dialog ? { ScreenInputFlow: { key: `sif-${name}-${arg ?? ""}-${v}`, name, arg, defPath } } : { span: {} }; },
                    // Part of a title typed where the parameter searches (§26.1): what holds it, counted by state.
                    () => { const p = Object.entries(api.getState(`${defPath}.params`, {}) ?? {})[0]; return p && p[1]?.search && !dialog ? { ParamMatches: { key: `pm-${name}`, screen: name, spec: p[1] } } : { span: {} }; },
                    { ScreenBody: { name, defPath, dataPath, arg, dialog } },
                    // Pop-ups over this screen (§26.7), read with its parameter.
                    dialog ? { span: {} } : { PopupWatch: { key: `pw-s-${name}-${arg ?? ""}`, target: `screen:${name}`, values: () => { const p = Object.keys(api.getState(`${defPath}.params`, {}) ?? {})[0]; return p ? { [p]: arg } : {}; } } },
                ],
            },
        };
    });

    // A screen's input flow walked (input-flow-driver.js): "param" is the scan or pick it is opened with
    // (once chosen, the screen opens on it and the flow goes on past it), "<transaction>.<input>" a
    // transaction block's input (its tab shown first), a run that block's Check and Confirm.
    juris.registerComponent("ScreenInputFlow", ({ name, arg, defPath }, api) => {
        if (!api.isServer) {
            api.onMount(() => {
                const d = api.peek(defPath);
                if (!d?.inputFlow) return undefined;
                const doc = globalThis.document;
                const [param, spec] = Object.entries(d.params ?? {})[0] ?? [];
                const tabPath = `ui.screenTab.${name}`;
                const where = {};
                const forms = {};
                // A form left out for this viewer (one they may not send, §26.10): its asks passed over, its run the end.
                const dataPath = `scr.${name}.data.${String(arg ?? "-").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                (d.blocks ?? []).forEach((b, j) => {
                    if (b.block !== "transaction" || where[b.name]) return;
                    const f = `f.tx.${b.name}.scr_${name}_${j}`;
                    const root = () => doc.getElementById(transactionRootId(b.name, `scr_${name}_${j}`));
                    const hidden = () => api.peek(`${dataPath}.blocks.${j}.$off`) === "hidden";
                    where[b.name] = { f, tab: b.tab ?? null, root, hidden };
                    forms[b.name] = {
                        hidden,
                        primary: () => root()?.querySelector(".form-foot .tx-check, .form-foot .tx-run"),
                        confirm: () => root()?.querySelector(".form-foot .tx-run"),
                        preview: `${f}.preview`, done: `${f}.done`, errors: `${f}.serverErrors`,
                        get signs() { return Boolean(api.peek(`tx.${b.name}.def`)?.signature); },
                    };
                });
                const names = Object.keys(where);
                const drv = driveInputFlow(api, {
                    flow: d.inputFlow, state: `scr.${name}.flow`, rootOf: () => doc.getElementById(`screen-root-${name}`),
                    targets: (input) => {
                        if (input === "param") return param ? { param: true, control: () => doc.getElementById(`param-${name}`), filled: () => Boolean(arg), value: () => arg, set: () => {}, object: spec?.type === "ref" ? spec.to : null } : null;
                        const [t, field] = String(input).includes(".") ? String(input).split(".") : [names.length === 1 ? names[0] : null, input];
                        const w = where[t];
                        if (!w || w.hidden()) return null;
                        const ins = api.peek(`tx.${t}.def`)?.inputs?.[field];
                        return {
                            control: () => controlFor(w.root(), `${w.f}.${field}`),
                            filled: () => { const v = api.peek(`${w.f}.data.${field}`); return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length); },
                            value: () => api.peek(`${w.f}.data.${field}`) ?? null,
                            set: (v) => api.batch(() => { api.setValue(`${w.f}.data.${field}`, v); api.setValue(`${w.f}.preview`, null); api.setValue(`${w.f}.done`, null); }),
                            object: ins?.type === "ref" ? ins.to : null,
                            show: () => { if (w.tab && api.peek(tabPath) !== w.tab) api.setValue(tabPath, w.tab); },
                        };
                    },
                    forms,
                    scope: () => ({ param: param ? { [param]: arg } : {}, user: { id: api.peek("me.id") } }),
                    // A one-tab screen's end that repeats goes back to its scan (no record open, the same tab), its
                    // words kept above the next prompt: what to do with the one just done.
                    // …and at an end that stops (the record only shown), the cursor back on its scan, ready for the next.
                    // (A plan's step shown for the record, its form for this person: the cursor in that instead.)
                    afterStop: () => { if (d.oneTab) setTimeout(() => { const form = doc.getElementById(`screen-root-${name}`)?.querySelector(".task-form"); const first = form && controlsOf(form)[0]; (first ?? doc.getElementById(`param-${name}`))?.focus(); }, 250); },
                    restart: (end) => {
                        if (!d.oneTab || !param || !arg) return false;
                        api.setValue(`scr.${name}.flowDone`, end.label || null);
                        setTimeout(() => openScreen(api, name, null), 0);
                        return true;
                    },
                });
                // Its forms drawn first (they load in the browser).
                // Opened on its parameter, it goes on past the ask for it.
                const begin = setTimeout(() => drv.start(null, { past: Boolean(arg) }), 400);
                return () => { clearTimeout(begin); drv.stop(); };
            });
        }
        return {
            div: {
                className: "screen-flow",
                children: [() => {
                    const done = api.getState(`scr.${name}.flowDone`, null);
                    return done ? { p: { className: "flow-done", role: "status", children: [icon("check"), { span: done }] } } : { span: {} };
                }, () => {
                    const error = api.getState(`scr.${name}.flow.error`, null);
                    const prompt = api.getState(`scr.${name}.flow.prompt`, null);
                    return error || prompt ? { p: { className: `flow-prompt${error ? " bad" : ""}`, role: "status", "aria-live": "polite", children: [icon(error ? "warning" : "scan"), { span: error ?? prompt }] } } : { span: {} };
                }],
            },
        };
    });

    // What the screen is opened with: a scan (a machine's label), or a pick from a list.
    juris.registerComponent("ParamPicker", ({ screen, param, spec, current }, api) => {
        const [error, setError] = api.useState("error", null);
        const [options, setOptions] = api.useState("options", null);
        const as = api.getState("me.id", null, { track: false });
        // What it is called: the parameter's label ("equipment"), not the object's name.
        const noun = String(spec.label ?? words(spec.to)).toLowerCase();
        // Chosen, it lets go of the cursor: the form on the screen's tab in view takes it (keyboard.js).
        const go = (value) => { if (value) globalThis.document?.activeElement?.blur?.(); openScreen(api, screen, value); };
        if (!api.isServer && spec.type === "ref" && spec.widget === "select") {
            // Only the records it opens with (its where: a die saw's screen lists die saws).
            const fits = (r) => Object.entries(spec.where ?? {}).every(([f, v]) => (Array.isArray(v) ? v : [v]).includes(r[f]));
            api.onMount(() => { api.call("records.list", { object: spec.to, as }).then((l) => setOptions(l.rows.filter(fits).map((r) => ({ id: r.id, title: String(r.$title ?? r.id.slice(0, 8)) })).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))), () => setOptions([])); });
        }
        const scan = async (text) => {
            const wanted = String(text ?? "").trim();
            setError(null);
            if (!wanted) return;
            if (spec.type !== "ref") return go(wanted);
            const hit = await api.call("records.lookup", { object: spec.to, key: wanted }).catch(() => null);
            if (hit) { api.setValue(`scr.${screen}.matches`, null); return go(hit.id); }
            // Not a whole title: where the parameter searches, those that hold it (§26.1); else, not found.
            if (spec.search) return findMatches(api, screen, spec, wanted, null).then((m) => { if (m && !m.total) setError(`No ${noun} holds "${wanted}" that you can see.`); });
            setError(`No ${noun} "${wanted}" that you can see.`);
        };
        // Taken from the keyboard (keyboard.js): nothing open yet, the cursor starts here, ready for a scan.
        if (!api.isServer && !current) api.onMount(() => { const el = globalThis.document?.getElementById(`param-${screen}`); const doc = globalThis.document; if (el && (!doc.activeElement || doc.activeElement === doc.body)) el.focus(); });
        const control = spec.type === "ref" && spec.widget === "select"
            ? { select: { id: `param-${screen}`, onchange: (e) => go(e.target.value), children: noDefault(() => [{ option: { value: "", textContent: `Pick the ${noun}…` } }, ...(options() ?? []).map((o) => ({ option: { key: o.id, value: o.id, selected: o.id === current, textContent: o.title } }))]) } }
            : spec.type === "enum"
                ? { select: { id: `param-${screen}`, onchange: (e) => go(e.target.value), children: noDefault([{ option: { value: "", textContent: "—" } }, ...(spec.values ?? []).map((v) => ({ option: { value: v, selected: v === current, textContent: v } }))]) } }
                : { span: { className: "scan-field", children: [
                    icon("scan", { className: "scan-icon" }),
                    { input: { id: `param-${screen}`, type: spec.type === "date" ? "date" : "text", autocomplete: "off", placeholder: current ? `Another ${words(spec.label ?? param).toLowerCase()}: scan or type` : `Scan or type the ${words(spec.label ?? param).toLowerCase()}`, onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); scan(e.target.value); e.target.value = ""; } }, onchange: (e) => { scan(e.target.value); e.target.value = ""; } } },
                ] } };
        return { div: { className: "param-picker", children: [{ span: { className: "muted small", textContent: spec.label ?? param } }, control, () => (error() ? { span: { className: "field-error", textContent: error() } } : { span: {} })] } };
    });

    // What part of a title found (§26.1): how many records hold it, by state (each state a filter: pressed again,
    // all of them), and the rows, a window at a time, more fetched as the list is scrolled to its end; each row a
    // link that opens the screen on that record.
    juris.registerComponent("ParamMatches", ({ screen, spec }, api) => () => {
        const path = `scr.${screen}.matches`;
        const m = api.getState(path, null);
        if (!m || !m.total) return { span: {} };
        const show = Array.isArray(spec.search?.show) ? spec.search.show : [];
        const more = () => {
            if (m.loading || !m.more) return;
            api.setValue(`${path}.loading`, true);
            api.call("records.matching", { object: spec.to, q: m.q, state: m.only, offset: m.rows.length, limit: 30, show, where: spec.where ?? null, as: api.peek("me.id") })
                .then((r) => { if (api.peek(path)?.q === m.q) api.batch(() => { api.setValue(`${path}.rows`, [...m.rows, ...r.rows]); api.setValue(`${path}.more`, r.more); api.setValue(`${path}.loading`, false); }); },
                    () => api.setValue(`${path}.loading`, false));
        };
        const noun = String(spec.label ?? words(spec.to)).toLowerCase();
        return { section: { className: "panel param-matches", "aria-label": `${noun} holding ${m.q}`, children: [
            { div: { className: "pm-head", children: [
                { strong: `${plant().number(m.total)} ${noun}${m.total === 1 ? "" : "s"} hold “${m.q}”` },
                { span: { className: "muted small", textContent: m.only ? ` · ${words(m.only)} only` : " · by state" } },
                { button: { type: "button", className: "btn ghost small pm-close", "aria-label": "Close the search", onclick: () => api.setValue(path, null), children: [icon("x")] } },
            ] } },
            { div: { className: "pm-states", children: m.states.map((x) => ({ button: { key: x.state, type: "button", className: `${stateBadgeClass(x.state, m.tones)} pm-state${m.only === x.state ? " on" : ""}`, "aria-pressed": String(m.only === x.state),
                onclick: () => findMatches(api, screen, spec, m.q, m.only === x.state ? null : x.state), textContent: `${words(x.state)} ${plant().number(x.n)}` } })) } },
            windowTable({ key: `pm-${screen}-${m.q}-${m.only ?? ""}`, head: [m.labels?.title ?? spec.label ?? "", "State", ...show.map((f) => m.labels?.[f] ?? words(f))], count: m.rows.length, className: "pm-rows",
                row: (i) => {
                    if (i >= m.rows.length - 3) more();
                    const r = m.rows[i];
                    return { tr: { key: r.id, children: [
                        { td: { children: [{ Link: { to: `/s/${screen}/${encodeURIComponent(r.id)}`, textContent: r.title, onclick: () => { api.setValue(path, null); keepTab(api, screen, r.id); } } }] } },
                        { td: { children: [{ span: { className: stateBadgeClass(r.state, m.tones), textContent: words(r.state) } }] } },
                        ...show.map((f) => ({ td: { textContent: r[f] === null || r[f] === undefined || r[f] === "" ? "—" : String(r[f]) } })),
                    ] } };
                } }),
        ] } };
    });

    // The blocks, on a 12-column grid (a narrow screen stacks them). `preview`: the designer's draft,
    // drawn with the designer's rights; its buttons do nothing.
    juris.registerComponent("ScreenBody", ({ name, defPath, dataPath, arg = null, preview = false, dialog = false }, api) => () => {
        const d = api.getState(defPath);
        const data = api.getState(dataPath);
        if (!d) return { span: {} };
        if (data === undefined) return { p: { className: "muted", textContent: "Loading…" } };
        if (data === null) return { span: {} };
        if (data.need) return { div: { className: "panel screen-need", children: [{ p: { textContent: data.error ?? `Scan or pick the ${words(d.params?.[data.need]?.label ?? data.need).toLowerCase()} above to open it.` } }] } };
        const scope = { param: Object.fromEntries(Object.keys(d.params ?? {}).map((k) => [k, arg])), user: { id: api.peek("me.id") } };
        const blocks = d.blocks ?? [];
        const tabPath = `ui.screenTab.${dialog ? "dialog." : ""}${name}`;
        // What the server decided of each block (§26.9): not shown (nothing of it came), or shown and not
        // enabled, with why.
        const offs = blocks.map((_, i) => { const o = data.blocks?.[i]?.$off; return o ? { how: o, why: data.blocks[i].$why ?? null } : null; });
        const hidden = (i) => offs[i]?.how === "hidden";
        const disabled = (i) => offs[i]?.how === "disabled";
        const section = (b, i, extra = {}, shown = null) => ({
            section: {
                key: `b${i}`,
                id: `scr-${name}-b${i}`,
                className: `panel screen-block block-${b.block} w-${b.width ?? 12}${disabled(i) ? " block-off" : ""}`,
                ...extra,
                children: [
                    b.title ? { h3: b.title } : { span: {} },
                    disabled(i) ? { p: { className: "block-why icon-text", children: [icon("lock"), { span: offs[i].why ?? "Not available now." }] } } : { span: {} },
                    // Not enabled: everything in it is out of reach of the pointer and the keyboard alike.
                    { fieldset: { className: "block-body", disabled: disabled(i), children: [
                        blockView(api, { name, b, i, data: data.blocks?.[i] ?? {}, live: `${dataPath}.blocks.${i}`, scope, preview, dialog, shown, blocks, offs, tabPath: blocks.some((x) => x.tab) ? tabPath : null }),
                    ] } },
                ],
            },
        });
        const drawn = blocks.map((b, i) => ({ b, i })).filter(({ i }) => !hidden(i));
        // Tabs: blocks that name one share it (Move in, Track in, …); the rest show above the tabs. Every
        // tab's blocks stay drawn, the others hidden, so a form half filled in survives a look elsewhere.
        // A tab none of whose blocks is shown is not there; one none of whose blocks is enabled is greyed,
        // saying why, and is not opened.
        const tabs = [...new Set(drawn.map(({ b }) => (typeof b.tab === "string" && b.tab.trim() ? b.tab : null)).filter(Boolean))];
        if (!tabs.length) return { div: { className: "grid12 screen-grid", children: drawn.map(({ b, i }) => section(b, i)) } };
        const tabOff = (t) => { const mine = drawn.filter(({ b }) => b.tab === t); return mine.every(({ i }) => disabled(i)) ? { why: mine.map(({ i }) => offs[i].why).find(Boolean) ?? "Not available now." } : null; };
        const open = tabs.filter((t) => !tabOff(t));
        const active = () => { const t = api.getState(tabPath, null); return open.includes(t) ? t : open[0] ?? tabs[0]; };
        const whyPath = `${tabPath}Why`;
        const pick = (t) => { const off = tabOff(t); api.batch(() => { api.setValue(whyPath, off ? { tab: t, why: off.why } : null); if (!off) api.setValue(tabPath, t); }); };
        return {
            div: {
                className: "screen-tabbed",
                children: [
                    { div: { className: "grid12 screen-grid", children: drawn.map(({ b, i }) => (b.tab ? null : section(b, i))).filter(Boolean) } },
                    // Alt+1, Alt+2, …: the tabs from the keyboard (its form then takes the cursor, keyboard.js).
                    { nav: { className: "design-tabs screen-tabs", role: "tablist", children: [...tabs.map((t, k) => {
                        const off = tabOff(t);
                        return { button: { key: t, type: "button", role: "tab", className: `design-tab${off ? " tab-disabled" : ""}`, title: off ? off.why : k < 9 ? `Alt+${k + 1}` : undefined, "aria-keyshortcuts": k < 9 ? `Alt+${k + 1}` : undefined, "aria-disabled": off ? "true" : undefined, "aria-selected": () => String(active() === t), classList: { active: () => active() === t }, onclick: () => pick(t), children: off ? [icon("lock"), { span: t }] : [{ span: t }] } };
                    }), { TabKeys: { key: `keys-${open.join("|")}`, tabs: open, tabPath } }] } },
                    // Why a greyed tab is not opened, said where it was asked.
                    () => { const w = api.getState(whyPath, null); return w && tabOff(w.tab) ? { p: { className: "tab-why icon-text", role: "status", children: [icon("lock"), { span: `${w.tab}: ${w.why}` }] } } : { span: {} }; },
                    { div: { className: "grid12 screen-grid", children: drawn.map(({ b, i }) => (b.tab ? section(b, i, { classList: { "tab-off": () => active() !== b.tab } }, () => active() === b.tab) : null)).filter(Boolean) } },
                ],
            },
        };
    });

    // A screen's tabs by Alt and their number (the key's position, so it is the same on every keyboard
    // layout; on a Mac, Option+1 types "¡").
    juris.registerComponent("TabKeys", ({ tabs = [], tabPath }, api) => {
        if (!api.isServer) {
            api.onMount(() => {
                const keys = (e) => {
                    const n = /^Digit([1-9])$/.exec(e.code ?? "")?.[1];
                    if (!e.altKey || e.ctrlKey || e.metaKey || !n || !tabs[Number(n) - 1]) return;
                    e.preventDefault();
                    api.setValue(tabPath, tabs[Number(n) - 1]);
                };
                globalThis.document.addEventListener("keydown", keys);
                return () => globalThis.document.removeEventListener("keydown", keys);
            });
        }
        return { span: { hidden: true } };
    });

    function blockView(api, { name, b, i, data, live = null, scope, preview, dialog, shown = null, blocks = [], tabPath = null, offs = [] }) {
        if (data.error) return { p: { className: "error small", textContent: data.error } };
        // A block of a kind a suite adds (§30.11): its own component, given the block and what the
        // suite read for it. With the suite gone it says what it needs; the other blocks are drawn.
        if (typeof b.block === "string" && b.block.includes(".")) {
            const kind = suiteBlocks[b.block];
            if (data.$needs || !kind) return { p: { className: "muted small icon-text", children: [icon("info"), { span: `This block needs the ${data.$needs ?? b.block.split(".")[0]} suite, which is not installed here.` }] } };
            return { [kind.component]: { key: `suite-block-${name}-${i}`, b, data, preview: Boolean(preview) } };
        }
        switch (b.block) {
            // Words: paragraphs, lists, **bold**, headings and links (rich-text.js), drawn as text.
            case "text":
                return { div: { className: "screen-text rich", children: richText(b.text ?? "") } };
            // The step a record's plan waits at (§26.10): its form for those it is for (the cursor in it), whom it waits
            // for to anyone else. Sent on a one-tab screen, back to the scan, saying so.
            case "plan":
                if (!data.run) return { p: { className: "muted small", textContent: "No plan waits on it now." } };
                return { FlowTask: { key: `plan-${data.run}`, run: data.run, embedded: true, onDone: (step) => {
                    if (preview || !api.peek(`scr.${name}.def.oneTab`)) return;
                    api.setValue(`scr.${name}.flowDone`, `${step ?? b.title ?? "Its step"}: sent`);
                    setTimeout(() => openScreen(api, name, null), 0);
                } } };
            // What was done lately with its transactions (§26.10): newest first, a window at a time; each run when, by
            // whom, which, and for each record it moved its state's way and what it set.
            case "runs": {
                const rows = data.rows ?? [];
                if (!rows.length) return { p: { className: "muted small", textContent: "Nothing done here yet." } };
                const badge = (st, tones) => (st ? { span: { className: stateBadgeClass(st, tones), textContent: words(st) } } : { span: {} });
                return windowTable({ key: `runs-${name}-${i}-${rows[0]?.seq ?? 0}`, head: ["When", "Who", "What", "Record", "Status", "Set"], count: rows.length, className: "runs-rows",
                    row: (k) => {
                        const r = rows[k];
                        return { tr: { key: String(r.seq), children: [
                            { td: { className: "nowrap", textContent: plant().dateTime(r.at) } },
                            { td: { textContent: r.who } },
                            { td: { textContent: r.transaction } },
                            { td: { className: "nowrap", children: r.records.map((x) => ({ div: { key: x.id, children: [preview ? { span: { textContent: x.title ?? "" } } : { Link: { to: `/o/${x.object}/${x.id}`, textContent: x.title ?? x.label } }] } })) } },
                            { td: { children: r.records.map((x) => ({ div: { key: x.id, className: "runs-way", children: x.to ? [badge(x.from, x.tones), x.from ? { span: { className: "muted", textContent: " → " } } : { span: {} }, badge(x.to, x.tones)] : [{ span: { className: "muted", textContent: "—" } }] } })) } },
                            { td: { className: "small", textContent: r.records.flatMap((x) => x.fields.map((f) => `${f.label}: ${f.to ?? "—"}`)).join(" · ") || "—" } },
                        ] } };
                    } });
            }
            // A file shown (§35.4): a record's, read as the viewer, or the screen's own (its guide).
            case "media":
                if (!data.src) return { p: { className: "muted small", textContent: data.none ? "This record has no file here yet." : "Nothing to show." } };
                return { MediaView: { key: `scr-md-${name}-${i}-${data.src}-${(data.steps ?? []).length}`, src: data.src, type: data.type ?? null, name: data.name ?? null, size: data.size ?? null, height: b.height ?? 480, steps: data.steps ?? [], pauseAtSteps: b.pauseAtSteps !== false, live: live ?? null, arg: scope.param ? Object.values(scope.param)[0] ?? null : null } };
            // A chart (§34.9): its query's rows, drawn by the chart view as its spec says.
            case "chart": {
                if (!(data.rows ?? []).length) return { p: { className: "muted small", textContent: "Nothing to draw: its query answered no rows." } };
                const spec = Object.fromEntries(Object.entries(b).filter(([k]) => !["block", "title", "width", "tab", "showWhen", "enableWhen", "disabledBecause", "query"].includes(k)));
                return { ChartView: { key: `scr-ch-${name}-${i}-${b.chart}-${data.rows.length}-${data.columns.join(",")}`, spec, data: { columns: data.columns, rows: data.rows }, title: b.title ?? "Chart", height: (b.width ?? 12) <= 4 ? 220 : 300, more: Boolean(data.truncated) } };
            }
            case "kpi":
                return { div: { className: "kpi", children: [{ span: { className: "kpi-value", textContent: number(data.value) } }, { span: { className: "muted small", textContent: ` ${b.label ?? (data.unit ?? "").toLowerCase()}` } }] } };
            // A floor layout (§35): records where they stand, each with its state as it is now.
            case "floor":
                return floorView(data, { link: !preview });
            case "breakdown": {
                const max = Math.max(1, ...(data.groups ?? []).map((g) => g.value ?? 0));
                if (!data.groups?.length) return { p: { className: "muted small", textContent: "Nothing to show." } };
                return { ul: { className: "bars", children: data.groups.map((g) => ({ li: { key: g.key, children: [
                    { span: { className: "bar-key", textContent: words(g.key) } },
                    { span: { className: "bar", children: [{ span: { className: "bar-fill", style: { width: `${Math.round(((g.value ?? 0) / max) * 100)}%` } } }] } },
                    { span: { className: "bar-value", textContent: number(g.value) } },
                ] } })) } };
            }
            case "record": {
                const r = data.record;
                if (!r) return { p: { className: "muted small", textContent: "Nothing to show." } };
                return { div: { children: [
                    preview ? { strong: r.$title ?? "" } : { Link: { to: `/o/${data.object}/${r.id}`, className: "record-link", textContent: r.$title ?? data.label } },
                    { dl: { className: "record-fields", children: (b.show ?? []).flatMap((f) => [{ dt: { key: `t-${f}`, textContent: labelOf(data.fields, f) } }, { dd: { key: `d-${f}`, children: [cell(data.fields?.[f], r, f, data.tones, preview ? null : data.object)] } }]) } },
                ] } };
            }
            case "table": {
                // A named query's rows (§23.1): its columns as they come, each said in words; a date or a moment in
                // the plant's formats; a row its record (`object`) when the query gives the record's id.
                const fromQuery = b.query !== undefined;
                const asText = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? plant().dateTime(v) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? plant().date(v) : v);
                if (fromQuery) data = {
                    ...data, fields: Object.fromEntries((data.columns ?? []).map((c) => [c, { label: words(c).replace(/^./, (x) => x.toUpperCase()) }])),
                    rows: (data.rows ?? []).map((r, k) => ({ id: r.id ?? `row-${k}`, $real: r.id !== null && r.id !== undefined, ...(r.state ? { state: r.state } : {}), ...Object.fromEntries((data.columns ?? []).map((c, j) => [c, asText(r.cells[j])])), $title: r.cells[0] })),
                };
                const all = data.rows ?? [];
                const columns = fromQuery ? data.columns ?? [] : b.columns ?? [];
                const open = api.getState(`scr.${name}.open.${i}`, null);
                // Drawn as scrolled: `pageSize` rows (25) at first, as many more each time the bottom comes
                // into view, over the rows the block holds (its `limit`).
                const size = b.pageSize ?? 25;
                const shown = Math.min(all.length, api.getState(`scr.${name}.shown.${i}`, size) ?? size);
                const rows = all.slice(0, shown);
                const notice = api.getState(`scr.${name}.notice.${i}`, null);
                // A row's transaction done: its form closes, and a line says what changed.
                const done = (result) => api.batch(() => {
                    api.setValue(`scr.${name}.open.${i}`, null);
                    api.setValue(`scr.${name}.notice.${i}`, `${result.label}: ${result.changes.map((c) => `${c.label} ${c.title}${c.state ? ` → ${words(c.state.to)}` : ""}`).join("; ")}`);
                });
                const txLabel = (tx) => (api.getState("nav.transactions", []) ?? []).find((t) => t.name === tx)?.label ?? tx;
                // The row's actions: the transactions this person may run that appear on it in its state.
                const actionsFor = (row) => (b.rowActions ?? []).map((t) => (api.getState("nav.transactions", []) ?? []).find((x) => x.name === t)).filter((t) => t && (!t.appearsOn?.states?.length || t.appearsOn.states.includes(row.state)) && (t.appearsOn?.when === undefined || evaluate(t.appearsOn.when, { record: row, user: { id: api.peek("me.id") } }) === true));
                // Remove: the record archived as the viewer (its policy and rule pipe decide), after asking.
                const remove = async (row) => {
                    if (!(await confirmDialog(api, { title: `Remove ${row.$title ?? "this record"}?`, message: "It is archived: it leaves the lists and becomes read-only, and it can be restored. Nothing is deleted.", confirm: "Remove", danger: true }))) return;
                    try {
                        await api.call("records.archive", { object: data.object, id: row.id, rowVersion: row.row_version, key: `rm-${row.id}-${row.row_version}` });
                        api.setValue(`scr.${name}.notice.${i}`, `${row.$title ?? "The record"} removed (archived).`);
                    } catch (e) {
                        api.setValue(`scr.${name}.notice.${i}`, { failed: true, text: e.message });
                    }
                };
                const hasActions = (b.rowActions ?? []).length || b.archive;
                // A row's transaction that the screen has a form of its own for (a station's Move in tab): the
                // row fills that form, its tab shown, rather than a second copy of it under the table; the page
                // scrolls to it and keeps four of the list's rows in sight above it. Otherwise, a form here.
                const picked = api.getState(`scr.${name}.picked.${i}`, null);
                const formOff = (t) => { const j = blocks.findIndex((x) => x.block === "transaction" && x.name === t.name); return j >= 0 && t.appearsOn?.fills ? offs[j] ?? null : null; };
                const run = (t, row) => {
                    const j = blocks.findIndex((x) => x.block === "transaction" && x.name === t.name);
                    if (j < 0 || !t.appearsOn?.fills) {
                        const closing = open?.id === row.id && open?.tx === t.name;
                        api.batch(() => { api.setValue(`scr.${name}.notice.${i}`, null); api.setValue(`scr.${name}.open.${i}`, closing ? null : { tx: t.name, id: row.id }); });
                        // The cursor into the form it opened (keyboard.js), once it is drawn.
                        if (!closing && typeof document !== "undefined") setTimeout(() => focusFirst(document.getElementById(transactionRootId(t.name, `scr_${name}_${i}_${row.id}`)), { force: true }), 300);
                        return;
                    }
                    api.batch(() => {
                        api.setValue(`scr.${name}.notice.${i}`, null);
                        api.setValue(`scr.${name}.open.${i}`, null);
                        api.setValue(`scr.${name}.picked.${i}`, row.id);
                        if (blocks[j].tab && tabPath) api.setValue(tabPath, blocks[j].tab);
                        api.setValue(`f.tx.${t.name}.scr_${name}_${j}.data.${t.appearsOn.fills}`, row.id);
                    });
                    if (typeof document === "undefined") return;
                    setTimeout(() => {
                        const form = document.getElementById(`scr-${name}-b${j}`);
                        const target = (blocks[j].tab && form?.closest(".screen-tabbed")?.querySelector(".screen-tabs")) || form;
                        const table = document.getElementById(`scr-${name}-b${i}`);
                        const rowH = table?.querySelector("tbody tr")?.getBoundingClientRect().height || 44;
                        const below = table && target && table.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING;
                        if (!target) return;
                        target.style.scrollMarginTop = below ? `${Math.round(rowH * 4 + 64)}px` : "12px";
                        target.scrollIntoView({ behavior: "smooth", block: "start" });
                        // …and the cursor into its next empty input (keyboard.js): the row filled one of them.
                        setTimeout(() => focusFirst(document.getElementById(transactionRootId(t.name, `scr_${name}_${j}`)), { force: true }), 50);
                    }, 0);
                };
                return { div: { children: [
                    b.create && data.canCreate && !preview ? { div: { className: "screen-block-bar", children: [{ Link: { to: `/o/${data.object}/new`, className: "btn primary", textContent: `New ${String(data.label ?? "").toLowerCase()}` } }] } } : { span: {} },
                    // A notice: done (✓), or refused (✗, a { failed, text }).
                    notice && !open ? { p: { className: `small screen-notice icon-text ${notice.failed ? "error" : "notice"}`, role: "status", children: [icon(notice.failed ? "x" : "check"), { span: notice.failed ? notice.text : notice }] } } : { span: {} },
                    {
                        div: { className: "grid-scroll", children: [{ table: { className: "grid", children: [
                            { thead: { children: [{ tr: { children: [...columns.map((c) => ({ th: labelOf(data.fields, c) })), ...(hasActions ? [{ th: "" }] : [])] } }] } },
                            { tbody: { children: rows.map((row) => ({ tr: { key: row.id, classList: { selected: open?.id === row.id || picked === row.id }, children: [
                                ...columns.map((c, k) => ({ td: { key: c, children: [k === 0 && !preview && !isHidden(row[c]) && data.object && (!fromQuery || row.$real) ? { Link: { to: `/o/${data.object}/${row.id}`, children: [cell(data.fields?.[c], row, c, data.tones)] } } : cell(data.fields?.[c], row, c, data.tones, preview ? null : data.object)] } })),
                                ...(hasActions ? [{ td: { className: "row-actions", children: [
                                    // A row's transaction whose form on this screen is not shown or not enabled now (§26.9) is not offered here either.
                                    ...actionsFor(row).map((t) => { const off = formOff(t); return { button: { key: t.name, type: "button", className: "btn tx-btn", "data-row-tx": `${row.id}:${t.name}`, disabled: preview || Boolean(off), title: off ? off.why ?? "Not available here now." : undefined, textContent: t.label, onclick: () => run(t, row) } }; }),
                                    ...(b.archive && row.$archive ? [{ button: { key: "rm", type: "button", className: "btn ghost", disabled: preview, textContent: "Remove", onclick: () => remove(row) } }] : []),
                                ] } }] : []),
                            ] } })) } },
                            // Empty: say why: none there, or none this person may see.
                            ...(rows.length ? [] : [{ tbody: { children: [{ tr: { children: [{ td: { colSpan: columns.length + (hasActions ? 1 : 0), className: "muted", textContent: data.noRole ? `You hold no role on ${data.label ?? data.object}, so none of its records are shown to you. Roles are given in People & departments (Roles), approved by its stewards.` : Object.keys(b.where ?? {}).length ? "None match." : `No ${String(data.label ?? "records").toLowerCase()} yet.` } }] } }] } }]),
                        ] } }] },
                    },
                    all.length > size || all.length >= (b.limit ?? 200) ? { div: { className: "pager", children: [
                        { span: { className: "muted small", textContent: `${shown} of ${all.length}${all.length >= (b.limit ?? 200) ? "+ (it holds the first " + (b.limit ?? 200) + ")" : ""}` } },
                        shown < all.length && !preview ? { AutoMore: { key: `more-${i}-${shown}`, id: `more-${name}-${i}`, label: "Show more", onMore: () => api.setValue(`scr.${name}.shown.${i}`, shown + size) } } : { span: {} },
                    ] } } : { span: {} },
                    // A row's transaction, right here: the record filled in; the row moves on when it is done. Under the
                    // table, or (rowActionsIn: "panel") in a panel over the screen, the list kept in sight behind it.
                    open && !preview && b.rowActionsIn !== "panel" ? { div: { key: `open-${open.tx}-${open.id}`, className: "screen-inline", children: [
                        { div: { className: "screen-inline-head", children: [{ strong: txLabel(open.tx) }, { button: { type: "button", className: "btn ghost", textContent: "Close", onclick: () => api.setValue(`scr.${name}.open.${i}`, null) } }] } },
                        { TransactionScreen: { key: `inl-${open.tx}-${open.id}`, name: open.tx, from: open.id, embedded: true, slot: `scr_${name}_${i}_${open.id}`, onDone: done, prefill: Object.fromEntries(Object.entries(b.fills ?? {}).map(([k, e]) => [k, evaluate(e, scope) ?? null]).filter(([, v]) => v !== null)) } },
                    ] } } : { span: {} },
                    open && !preview && b.rowActionsIn === "panel" ? editorPanel(api, {
                        id: `scr-${name}-panel-${i}`, title: txLabel(open.tx),
                        subtitle: [{ span: (all.find((r) => r.id === open.id)?.$title) ?? "" }],
                        close: () => api.setValue(`scr.${name}.open.${i}`, null),
                        returnTo: `[data-row-tx="${open.id}:${open.tx}"]`,
                        children: [{ div: { key: `open-${open.tx}-${open.id}`, className: "screen-panel-form", children: [{ TransactionScreen: { key: `inl-${open.tx}-${open.id}`, name: open.tx, from: open.id, embedded: true, slot: `scr_${name}_${i}_${open.id}`, onDone: done, prefill: Object.fromEntries(Object.entries(b.fills ?? {}).map(([k, e]) => [k, evaluate(e, scope) ?? null]).filter(([, v]) => v !== null)) } }] } }],
                    }) : { span: {} },
                ] } };
            }
            case "transaction": {
                if (preview) return { p: { className: "muted small", textContent: `The ${words(b.name)} transaction's form, here${Object.keys(b.fills ?? {}).length ? `, with ${Object.keys(b.fills).join(", ")} filled in by the screen` : ""}.` } };
                const prefill = Object.fromEntries(Object.entries(b.fills ?? {}).map(([k, e]) => [k, evaluate(e, scope) ?? null]).filter(([, v]) => v !== null));
                // In a dialog, a transaction that finishes may close it (closeOnDone).
                const onDone = dialog && b.closeOnDone ? () => api.setValue("ui.screenDialog", null) : null;
                // The screen's input flow, if it has one, walks this form (`driven`).
                return { TransactionScreen: { key: `blk-${b.name}-${JSON.stringify(prefill)}`, name: b.name, embedded: true, prefill, slot: `scr_${name}_${i}`, onDone, active: shown, driven: Boolean(api.peek(`scr.${name}.def.inputFlow`)) && !dialog } };
            }
            // A button that opens a screen as a dialog (§26.6), with its parameter worked out here.
            case "button": {
                if (preview) return { p: { className: "muted small", textContent: `A button that opens the ${words(b.opens)} screen as a dialog.` } };
                if (!data.canOpen) return { p: { className: "muted small", textContent: `${data.label ?? words(b.opens)}: not shared with you.` } };
                const open = () => api.setValue("ui.screenDialog", { name: b.opens, label: data.label, arg: b.with === undefined ? null : evaluate(b.with, scope) ?? null, key: Date.now() });
                return { button: { type: "button", className: "btn primary", textContent: b.label ?? data.label, onclick: open } };
            }
            default:
                return { span: {} };
        }
    }
}
