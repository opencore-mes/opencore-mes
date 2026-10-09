// The Flow designer (DESIGN.md §32.7): the editor of a flow template, beside the others, on the same
// working copy (`${w}.fl.<name>`). A template is drawn on a canvas: nodes placed and dragged, wired
// from one to another, each opening its settings beside the canvas; problems shown on the node or wire
// they concern. The palette is the template's kind's (a route: start, sequence, auto decision, end; a
// plan: start, wait, auto and manual decision, input screen, sub flow, end) and the kinds the installed
// suites add (§32.9). On a phone the canvas is a list of nodes and their wires. Layout is data: where a
// node sits is part of the design (`layout`), compared and approved with the rest. The boxes and wires
// are drawn as a run's map draws them (flow-picture.js).
import { validateFlow, flowFootprint, flowKindOf, flowStartOf, flowSetsOff, flowContextNames, tidyLayout, subFlowsOf, renameFlowNode, renameFlowParticipant, FLOW_ROLES, FLOW_KINDS_OF, FLOW_NODE_WORDS, WAIT_MODES, INPUT_TYPES } from "./definition.js";
import { noDefault } from "./select.js";
import { changesOf, countByTab } from "./compare.js";
import { elementOps, jsonOf } from "./integration-editor.js";
import { transactionKnown } from "./transaction-editor.js";
import { W, text, labelled } from "./editor-kit.js";
import { tagsInput } from "./pick.js";
import { askDialog, confirmRemove } from "./dialog.js";
import * as history from "./undo.js";
import { exprField, objectEntries, scope, valueEntry } from "./expr-builder.js";
import { IDENTIFIER } from "./definition.js";
import { icon, withIcon } from "./icons.js";
import { NODE, iconOf, positions, wireWords } from "./flow-picture.js";
import { canvasZoom } from "./canvas-zoom.js";
import { ADVANCE, ADVANCE_WORDS } from "./input-flow.js";

export const FLOW_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["canvas", "Flow"], ["general", "General"], ["context", "Context"], ["participants", "Participants"], ["scenarios", "Scenarios"], ["stewards", "Stewards"], ["json", "JSON"]];
const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const toggleIn = (list, value, on) => { const set = new Set(list ?? []); if (on) set.add(value); else set.delete(value); return [...set]; };
const json = (v) => (v === undefined ? "" : JSON.stringify(v));
const parsed = (t) => { try { return { ok: true, value: t.trim() ? JSON.parse(t) : undefined }; } catch { return { ok: false }; } };
// A typed value as the plainest it reads: a number, true or false, else the text.
const valueOf = (t) => (t === "true" ? true : t === "false" ? false : t.trim() !== "" && Number.isFinite(Number(t)) ? Number(t) : t);
const kindWords = (n, kinds) => kinds[n?.kind]?.label ?? FLOW_NODE_WORDS[n?.kind] ?? `needs ${String(n?.kind).split(".")[0]}`;

// What a template may name: objects (with how they take part), transactions, screens, scripts, the
// other templates, the suites' kinds.
export function flowKnown(api, w) {
    const home = api.peek("design.home") ?? {};
    const base = transactionKnown(api, w);
    const objects = {};
    for (const o of home.objects ?? []) objects[o.object] = { ...base.objects[o.object], roles: o.roles ?? [], ...(o.flow ? { flow: o.flow } : {}) };
    for (const [object, body] of Object.entries(api.peek(`${w}.defs`) ?? {})) if (body) objects[object] = { ...base.objects[object], roles: body.roles ?? [], ...(body.flow ? { flow: body.flow } : {}) };
    const draftObject = api.peek(`${w}.object`);
    const open = draftObject ? api.peek(`${w}.b`) : null;
    if (open) objects[draftObject] = { ...base.objects[draftObject], roles: open.roles ?? [], ...(open.flow ? { flow: open.flow } : {}) };
    const transactions = Object.fromEntries((home.transactions ?? []).map((t) => [t.name, { label: t.label, inputs: t.inputs ?? {}, appearsOn: t.appearsOn ?? null, stewards: t.stewards ?? [] }]));
    for (const [n, t] of Object.entries(api.peek(`${w}.tx`) ?? {})) transactions[n] = { label: t.label, inputs: t.inputs ?? {}, appearsOn: t.appearsOn ?? null, stewards: t.stewards ?? [] };
    const screens = [...new Set([...(home.screens ?? []).map((s) => s.name), ...Object.keys(api.peek(`${w}.sc`) ?? {})])];
    // Until the designer's home is in, the scripts and templates there are unknown, not missing: not checked.
    const scripts = Array.isArray(home.scripts) ? [...new Set([...home.scripts.map((s) => s.name), ...Object.keys(api.peek(`${w}.s`) ?? {})])].sort() : undefined;
    const flows = Array.isArray(home.flows) ? [...new Set([...home.flows.map((f) => f.name), ...Object.keys(api.peek(`${w}.fl`) ?? {})])].sort() : undefined;
    // What each template runs as sub flows, the change's drafts over what is live (a circle is refused).
    const subFlows = Array.isArray(home.flows) ? Object.fromEntries([...home.flows.map((f) => [f.name, f.subFlows ?? []]), ...Object.entries(api.peek(`${w}.fl`) ?? {}).map(([n, b]) => [n, subFlowsOf(b)])]) : undefined;
    // What each template is and whose records it takes through: a sub flow runs one of its own kind (§32.14).
    const headOf = (b) => Object.values(b?.participants ?? {}).find((p) => p?.as === (b?.kind === "plan" ? "subject" : "traveler"))?.object ?? null;
    const flowInfo = Array.isArray(home.flows) ? Object.fromEntries([...home.flows.map((f) => [f.name, { kind: f.kind, object: f.object ?? null, label: f.label, asSub: f.asSub === true }]), ...Object.entries(api.peek(`${w}.fl`) ?? {}).map(([n, b]) => [n, { kind: b?.kind ?? null, object: headOf(b), label: b?.label ?? n, asSub: b?.asSub === true }])]) : undefined;
    // The named queries there will be (§23.1): a plan's input screen draws a list from one, binding its parameters.
    const queries = Array.isArray(home.queries) ? Object.fromEntries([...home.queries.map((q) => [q.name, { label: q.label, params: q.params ?? {} }]), ...Object.entries(api.peek(`${w}.qy`) ?? {}).filter(([, b]) => b)]) : undefined;
    return { ...base, objects, transactions, screens, scripts, flows, subFlows, flowInfo, queries, flowNodes: home.flowNodes ?? {} };
}
export function flowProblems(api, id) {
    const w = W(id);
    const known = flowKnown(api, w);
    return Object.entries(api.peek(`${w}.fl`) ?? {}).flatMap(([name, body]) => validateFlow(body, known).map((p) => ({ ...p, message: `${name}: ${p.message}` })));
}
export function flowElements(api, id, change) {
    const w = W(id);
    const known = flowKnown(api, w);
    return Object.entries(api.peek(`${w}.fl`) ?? {}).flatMap(([name, body]) => flowFootprint(name, change.live.flows?.[name] ?? undefined, body, { objects: Object.fromEntries(Object.entries(known.objects).map(([k, o]) => [k, { stewards: o.stewards, transitions: o.transitions, ...(o.approval ? { approval: o.approval } : {}) }])), transactions: known.transactions }));
}

function exprInput(ctx, path, stored, apply, placeholder = "") {
    const draft = `${ctx.w}.exprText.fl.${ctx.name}.${path}`;
    const current = () => ctx.api.getState(draft, null) ?? json(stored);
    return { input: { type: "text", className: () => `expr-input${parsed(current()).ok ? "" : " bad"}`, disabled: ctx.ro, placeholder, spellcheck: false, value: current, oninput: (e) => { ctx.api.setValue(draft, e.target.value); const p = parsed(e.target.value); if (p.ok) apply(p.value); } } };
}
const select = (ctx, value, options, onchange) => ({ select: { disabled: ctx.ro, onchange: (e) => onchange(e.target.value), children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: v === value, textContent: l } }))) } });
const checks = (ctx, items, current, onToggle) => ({ div: { className: "checks", children: items.map(([value, label]) => ({ label: { key: value, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: (current ?? []).includes(value), onchange: (e) => onToggle(value, e.target.checked) } }, { span: ` ${label ?? value}` }] } })) } });
// Who acts on a node: the groups (departments and groups) it goes to.
const who = (ctx, id, n, words) => labelled("Who", checks(ctx, (ctx.known.groups ?? []).map((g) => [g, g]), n.for?.groups, (v, on) => ctx.ops.edit((b) => { b.nodes[id].for = { users: b.nodes[id].for?.users ?? [], groups: toggleIn(b.nodes[id].for?.groups, v, on) }; })), words);

// ---- the canvas ----
function canvasTab(ctx) {
    const { api, w, ops, body, name, known } = ctx;
    const S = `${w}.flowSel.${name}`;
    const sel = () => api.getState(S, null);
    const pick = (v) => api.setValue(S, v);
    const at = positions(body);
    const kinds = known.flowNodes ?? {};
    const problems = validateFlow(body, known);
    const problemsOf = (path) => problems.filter((p) => p.path === path || p.path.startsWith(`${path}.`)).map((p) => p.message);
    const width = Math.max(720, ...Object.values(at).map((p) => p.x + NODE.w + 60));
    const height = Math.max(320, ...Object.values(at).map((p) => p.y + NODE.h + 60));
    // A drag in progress: the node follows the pointer here, and is placed (saved) on release.
    const D = `${w}.flowDrag.${name}`;
    const posOf = (id) => { const d = api.getState(D, null); return d?.id === id ? d : at[id]; };
    const svgPoint = (e) => { const svg = e.target.ownerSVGElement ?? e.target.closest("svg"); const r = svg.getBoundingClientRect(); const scale = width / r.width; return { x: (e.clientX - r.left) * scale, y: (e.clientY - r.top) * scale }; };
    const connecting = () => api.getState(`${S}c`, null);
    // Fitted to the panel, never below three quarters of its size (then the panel scrolls), or zoomed.
    const zoom = canvasZoom(api, `${w}.flowZoom.${name}`, { width, fitStyle: `min-width: ${Math.round(width * 0.75)}px` });
    const startDrag = (e, id) => {
        // A press on a node starts a drag or a click, never a text selection.
        e.preventDefault();
        if (ctx.ro()) return;
        const p = svgPoint(e);
        const o = at[id];
        api.setValue(D, { id, x: o.x, y: o.y, dx: p.x - o.x, dy: p.y - o.y, moved: false });
        e.target.setPointerCapture?.(e.pointerId);
    };
    const moveDrag = (e) => {
        const d = api.peek(D);
        if (!d) return;
        const p = svgPoint(e);
        api.setValue(D, { ...d, x: Math.max(0, Math.round(p.x - d.dx)), y: Math.max(0, Math.round(p.y - d.dy)), moved: true });
    };
    const endDrag = (id) => {
        const d = api.peek(D);
        api.setValue(D, null);
        if (d?.moved) ops.edit((b) => { b.layout = { ...(b.layout ?? {}), [id]: { x: d.x, y: d.y } }; });
    };
    // A wire drawn: a manual decision's gets a choice to rename; a retry wait's second one is its way back.
    const clickNode = (id) => {
        const from = connecting();
        // The node the wire started from, clicked again: no wire.
        if (from && from === id) { api.setValue(`${S}c`, null); pick({ node: id }); return; }
        if (from && from !== id) {
            api.setValue(`${S}c`, null);
            const source = body.nodes[from];
            const fromKind = flowKindOf(source, kinds);
            const out = (body.edges ?? []).filter((e) => e.from === from);
            const extra = fromKind === "manual_decision" ? { label: `Choice ${out.length + 1}` } : fromKind === "wait" && source.mode === "retry" && out.some((e) => !e.retry) ? { retry: true } : {};
            ops.edit((b) => { b.edges = [...(b.edges ?? []), { from, to: id, ...extra }]; });
            pick({ edge: (body.edges ?? []).length });
            return;
        }
        pick({ node: id });
    };
    const addNode = (kind) => {
        const base = (kinds[kind] ? kind.split(".")[1] : kind).replace(/[^a-z0-9_]/g, "_");
        let n = 1;
        while (body.nodes?.[`${base}_${n}`]) n++;
        const id = `${base}_${n}`;
        const core = flowKindOf({ kind }, kinds);
        const fresh = {
            sequence: { offers: [], leaves: [] },
            manual_decision: { for: { users: [], groups: [] } },
            wait: { message: "", seconds: 300, mode: "auto" },
            input_screen: { for: { users: [], groups: [] }, fields: [] },
            sub_flow: { flow: "" },
            ask: { input: "", advance: "enter" },
            fill: { input: "", value: "" },
            run: { confirm: "ask" },
            end: body.kind === "input" ? { then: "repeat" } : {},
        }[core] ?? {};
        const node = { kind, label: kinds[kind]?.label ?? FLOW_NODE_WORDS[kind] ?? kind, ...fresh, ...(kinds[kind] ? { settings: {} } : {}) };
        const free = { x: 40 + (Object.keys(at).length % 5) * 240, y: height - 40 };
        ops.edit((b) => { b.nodes = { ...(b.nodes ?? {}), [id]: node }; b.layout = { ...(b.layout ?? {}), [id]: free }; });
        pick({ node: id });
    };
    const centre = (id) => { const p = posOf(id); return { x: p.x + NODE.w / 2, y: p.y + NODE.h / 2 }; };
    // Where a wire meets a node's border, so its arrow is seen.
    const border = (from, to) => {
        const [a, b] = [centre(from), centre(to)];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.min(Math.abs(dx) > 0 ? (NODE.w / 2) / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? (NODE.h / 2) / Math.abs(dy) : Infinity);
        return { x1: a.x + dx * t, y1: a.y + dy * t, x2: b.x - dx * t, y2: b.y - dy * t };
    };
    // The palette: the kind's own (one start), and the suites' kinds that extend one of them.
    const own = (FLOW_KINDS_OF[body.kind] ?? FLOW_KINDS_OF.route).filter((k) => k !== "start" || !flowStartOf(body));
    const palette = [...own.map((k) => [k, FLOW_NODE_WORDS[k]]), ...Object.entries(kinds).filter(([, v]) => (FLOW_KINDS_OF[body.kind] ?? []).includes(v.extends)).map(([k, v]) => [k, `${v.label} (${k.split(".")[0]})`])];
    return {
        div: {
            className: "flow-canvas-tab",
            children: [
                ctx.ro() ? { span: {} } : { div: { className: "flow-palette", children: [
                    { span: { className: "muted small", textContent: "Add" } },
                    ...palette.map(([k, l]) => ({ button: { key: k, type: "button", className: `btn small flow-chip kind-${flowKindOf({ kind: k }, kinds)}`, title: `A${/^[aeiou]/i.test(l) ? "n" : ""} ${l.toLowerCase()} node`, onclick: () => addNode(k), children: [withIcon(iconOf(flowKindOf({ kind: k }, kinds)), l)] } })),
                    { span: { className: "spacer" } },
                    { button: { type: "button", className: "btn small", title: "Arrange the nodes: left to right from the start, branches below", onclick: () => ops.edit((b) => { b.layout = tidyLayout(b); }), children: [icon("refresh"), { span: "Tidy" }] } },
                ] } },
                () => (connecting() ? { p: { className: "notice small wire-hint", children: [
                    { span: `Click the node it goes to (from ${body.nodes[connecting()]?.label ?? connecting()}). Esc, the same node or Cancel: none. ` },
                    { button: { type: "button", className: "linkish small", textContent: "Cancel", onclick: () => api.setValue(`${S}c`, null) } },
                ] } } : { p: { className: "muted small", textContent: ctx.ro() ? "Click a node or a wire to read its settings. Zoom with − and +, or Ctrl or ⌘ and the wheel; zoomed in, drag the empty ground to move about." : "Drag a node to place it; click it for its settings; Wire from here draws where it goes next. Zoom with − and +, or Ctrl or ⌘ and the wheel; zoomed in, drag the empty ground to move about." } }),
                { div: { className: "flow-board zoom-box", children: [
                    {
                        div: { className: () => `flow-canvas-wrap zoom-wrap${zoom.zoomed() ? " zoomed" : ""}`, ...zoom.wrap, children: [{
                            svg: {
                                className: "flow-canvas", tabindex: "-1", viewBox: `0 0 ${width} ${height}`, width, height, style: zoom.style, role: "img", "aria-label": `The flow template ${body.label ?? name}`,
                                onpointermove: moveDrag,
                                onkeydown: (e) => { if (e.key === "Escape") api.setValue(`${S}c`, null); },
                                children: [
                                    { defs: { children: [{ marker: { id: `arrow-${name}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", children: [{ path: { d: "M 0 0 L 10 5 L 0 10 z", className: "flow-arrow" } }] } }] } },
                                    ...(body.edges ?? []).map((e, i) => {
                                        if (!body.nodes?.[e.from] || !body.nodes?.[e.to]) return { g: { key: `e${i}` } };
                                        const words = wireWords(body, e, kinds);
                                        return {
                                            g: {
                                                key: `e${i}`, className: () => `flow-edge${e.retry ? " retry" : ""}${sel()?.edge === i ? " selected" : ""}${problemsOf(`edges.${i}`).length ? " bad" : ""}`,
                                                onclick: () => pick({ edge: i }),
                                                children: [
                                                    { line: { x1: () => border(e.from, e.to).x1, y1: () => border(e.from, e.to).y1, x2: () => border(e.from, e.to).x2, y2: () => border(e.from, e.to).y2, className: "flow-edge-hit" } },
                                                    { line: { x1: () => border(e.from, e.to).x1, y1: () => border(e.from, e.to).y1, x2: () => border(e.from, e.to).x2, y2: () => border(e.from, e.to).y2, "marker-end": `url(#arrow-${name})` } },
                                                    words ? { text: { x: () => (centre(e.from).x + centre(e.to).x) / 2, y: () => (centre(e.from).y + centre(e.to).y) / 2 - 6, className: "flow-edge-label", textContent: words } } : { g: {} },
                                                ],
                                            },
                                        };
                                    }),
                                    ...Object.entries(body.nodes ?? {}).map(([id, n]) => {
                                        const kind = flowKindOf(n, kinds) ?? "missing";
                                        const hooks = [n.onEnter, n.onExit].filter(Boolean).length;
                                        return {
                                            g: {
                                                key: `n-${id}`,
                                                className: () => `flow-node kind-${kind}${sel()?.node === id ? " selected" : ""}${problemsOf(`nodes.${id}`).length ? " bad" : ""}${connecting() === id ? " connecting" : ""}`,
                                                transform: () => `translate(${posOf(id).x} ${posOf(id).y})`,
                                                onpointerdown: (e) => startDrag(e, id),
                                                onpointerup: () => { const d = api.peek(D); endDrag(id); if (!d?.moved) clickNode(id); },
                                                children: [
                                                    { rect: { width: NODE.w, height: NODE.h, rx: 8 } },
                                                    { svg: { ...icon(iconOf(kind)).svg, x: 10, y: 9, width: 18, height: 18, className: "flow-node-icon" } },
                                                    { text: { x: 36, y: 23, className: "flow-node-label", textContent: String(n.label ?? id).length > 19 ? `${String(n.label ?? id).slice(0, 18)}…` : String(n.label ?? id) } },
                                                    { text: { x: 36, y: 42, className: "flow-node-kind", textContent: `${kindWords(n, kinds)}${hooks ? " · script" : ""}` } },
                                                ],
                                            },
                                        };
                                    }),
                                ],
                            },
                        }] },
                    },
                    { aside: { className: () => `flow-side panel${sel() ? " open" : ""}`, children: [
                        { button: { type: "button", className: "btn ghost small flow-side-close", title: "Close", "aria-label": "Close the settings", onclick: () => pick(null), children: [icon("x")] } },
                        () => sidePanel(ctx, sel(), pick, problemsOf),
                    ] } },
                    zoom.controls,
                ] } },
                // On a phone: the same, as a list.
                { div: { className: "flow-list", children: Object.entries(body.nodes ?? {}).map(([id, n]) => ({ div: { key: id, className: "flow-list-node", children: [
                    { button: { type: "button", className: `linkish flow-side-head kind-${flowKindOf(n, kinds) ?? "missing"}`, onclick: () => pick({ node: id }), children: [withIcon(iconOf(flowKindOf(n, kinds) ?? "missing"), `${n.label ?? id} · ${kindWords(n, kinds)}`)] } },
                    { div: { className: "muted small", textContent: (body.edges ?? []).filter((e) => e.from === id).map((e) => `→ ${body.nodes[e.to]?.label ?? e.to}${wireWords(body, e, kinds) ? ` (${wireWords(body, e, kinds)})` : ""}`).join(", ") || "—" } },
                ] } })) } },
                // A node's script being written (§32.6): under the canvas, as wide as the tab.
                () => {
                    const script = api.getState(`${w}.hookEdit.${name}`, null);
                    const at = script ? Object.entries(body.nodes ?? {}).find(([, x]) => x?.onEnter === script || x?.onExit === script) : null;
                    if (!at) return { span: {} };
                    const [nid, node] = at;
                    return { div: { className: "flow-hook-editor", children: [
                        { div: { className: "flow-hook-head", children: [
                            { strong: `${node.onEnter === script ? "On entering" : "On leaving"} ${node.label ?? nid}` },
                            { button: { type: "button", className: "btn ghost small", textContent: "Close", onclick: () => api.setValue(`${w}.hookEdit.${name}`, null) } },
                        ] } },
                        { ScriptPanel: { key: `hook-${script}`, id: ctx.id, name: script, readOnly: ctx.ro, example: { event: { kind: node.onEnter === script ? "enter" : "exit", node: nid, label: node.label ?? nid, flow: name }, context: {}, writes: [] } } },
                    ] } };
                },
            ],
        },
    };
}

// What an input screen collects: a row per field, its name, words, type and choices.
function inputFields(ctx, id, n) {
    const fields = Array.isArray(n.fields) ? n.fields : [];
    // Edits the list in place, in its order (the order the screen shows).
    const edit = (fn) => ctx.ops.edit((b) => { b.nodes[id].fields = Array.isArray(b.nodes[id].fields) ? [...b.nodes[id].fields] : []; fn(b.nodes[id].fields); });
    const at = (i, patch) => edit((x) => { x[i] = { ...x[i], ...patch }; });
    const add = () => edit((x) => { let k = x.length + 1; while (x.some((f) => f?.name === `field_${k}`)) k++; x.push({ name: `field_${k}`, label: `Field ${k}`, type: "string" }); });
    return labelled("Collects", { div: { className: "flow-inputs", children: [
        ...fields.map((f, i) => ({ div: { key: `f${i}`, className: "flow-input-row", children: [
            { input: { type: "text", className: "mono", disabled: ctx.ro, value: f.name ?? "", placeholder: "name", title: "Its name in the context", onchange: (e) => at(i, { name: e.target.value.trim() }) } },
            { input: { type: "text", disabled: ctx.ro, value: f.label ?? "", placeholder: "Label", onchange: (e) => at(i, { label: e.target.value }) } },
            select(ctx, f.type ?? "string", INPUT_TYPES.map((t) => [t, t === "query" ? "from a query" : t]), (v) => edit((x) => {
                x[i] = { ...x[i], type: v };
                if (v !== "enum") delete x[i].values;
                if (v !== "query") for (const k of ["query", "value", "display", "separator", "params"]) delete x[i][k];
                else { x[i].value ??= "id"; x[i].params ??= {}; }
            })),
            f.type === "enum" ? tagsInput({ key: `${ctx.w}.fvals.${ctx.name}.${id}.${i}`, readOnly: ctx.ro, placeholder: "Add a choice…", value: f.values ?? [], onChange: (values) => at(i, { values }) }) : { span: {} },
            { label: { className: "small", children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: f.required === true, onchange: (e) => at(i, { required: e.target.checked || undefined }) } }, { span: " required" }] } },
            ctx.ro() || i === 0 ? { span: {} } : { button: { type: "button", className: "linkish small", title: "Earlier on the screen", textContent: "up", onclick: () => edit((x) => { [x[i - 1], x[i]] = [x[i], x[i - 1]]; }) } },
            ctx.ro() ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: "remove", onclick: confirmRemove(ctx.api, "this field", () => edit((x) => { x.splice(i, 1); }) )} },
            f.type === "query" ? queryField(ctx, id, i, f, at) : { span: {} },
        ] } })),
        ctx.ro() ? { span: {} } : { button: { type: "button", className: "btn small", textContent: "+ a field", onclick: add } },
    ] } }, "What the person enters, kept in the context under each name: a list's choice, a text or number, a file, an image or a link.");
}

// What a route's or a plan's conditions read (§9.2a): its context, the values it keeps and the fields of
// each record it takes part (its traveler, its subject, the tool).
function flowSpec(ctx) {
    const { body, known } = ctx;
    const entries = [];
    for (const [k, v] of Object.entries(body.context ?? {})) entries.push(valueEntry(k, v));
    for (const n of Object.values(body.nodes ?? {})) for (const f of Array.isArray(n?.fields) ? n.fields : []) if (f?.name && !entries.some((e) => e.path === f.name)) entries.push({ path: f.name, label: f.label ?? f.name, type: f.type === "enum" ? "enum" : f.type === "integer" || f.type === "decimal" || f.type === "boolean" ? f.type : "string", ...(Array.isArray(f.values) ? { values: f.values } : {}) });
    if (body.kind === "plan") entries.push({ path: "route.step", label: "the route step it was set off at", type: "string" });
    for (const [key, p] of Object.entries(body.participants ?? {})) {
        const def = known.objects?.[p?.object];
        entries.push(...objectEntries(def ? { ...def, states: def.states } : null, { prefix: `${key}.`, label: def?.label ?? key }));
    }
    return { scopes: { context: scope("the run", entries) } };
}
// A condition of a route or a plan: built (§9.2a); an input flow's keeps its JSON (it reads a form's inputs).
const condition = (ctx, path, stored, apply, empty, placeholder) => (ctx.body.kind === "input"
    ? exprInput(ctx, path, stored, apply, placeholder)
    : exprField({ key: `${ctx.w}.flowexpr.${ctx.name}.${path}`, readOnly: ctx.ro, empty, value: () => stored, onChange: apply, spec: flowSpec(ctx) }));

// A field drawn from a named query (§32.6): which query, the column kept, the columns shown (joined), and
// each of its parameters bound to an expression over the run's context and the user.
function queryField(ctx, id, i, f, at) {
    const queries = ctx.known.queries ?? {};
    const q = queries[f.query];
    const declared = Object.entries(q?.params ?? {});
    return { div: { className: "flow-query-field", children: [
        labelled("Its list from", select(ctx, f.query ?? "", Object.entries(queries).map(([n, x]) => [n, `${x.label ?? n} (${n})`]), (v) => at(i, { query: v, params: Object.fromEntries(Object.keys(queries[v]?.params ?? {}).map((p) => [p, f.params?.[p] ?? { context: p }])) })), "A named query (Designer, Queries). Each person sees the rows it gives them."),
        { div: { className: "ed-row", children: [
            labelled("Value (column)", { input: { type: "text", className: "mono", disabled: ctx.ro, value: f.value ?? "", placeholder: "id", onchange: (e) => at(i, { value: e.target.value.trim() }) } }, "What goes into the context."),
            labelled("Shown (columns)", tagsInput({ key: `${ctx.w}.fshown.${ctx.name}.${id}.${i}`, readOnly: ctx.ro, placeholder: "Add a column…", value: Array.isArray(f.display) ? f.display : [], onChange: (cols) => at(i, { display: cols.length ? cols : undefined }) }), "Joined, in this order."),
            labelled("Between them", { input: { type: "text", disabled: ctx.ro, value: f.separator ?? "", placeholder: " · ", onchange: (e) => at(i, { separator: e.target.value === "" ? undefined : e.target.value }) } }),
        ] } },
        ...declared.map(([p, spec]) => labelled(`${spec.label ?? p}${spec.required ? " *" : ""}`, exprInput(ctx, `nodes.${id}.fields.${i}.params.${p}`, f.params?.[p] ?? null, (v) => at(i, { params: { ...(f.params ?? {}), [p]: v } }), '{"context": "product.equipment_family"}'), `:${p}, from the run's context ({"context": "lot.product"}), the user ({"user": "id"}) or a value.`)),
    ] } };
}

// A node's script (§32.6), written here: the context in, the context out, a variable set for the decisions after.
const HOOK_TEMPLATE = (name, which, n) => `// ${which === "onEnter" ? "On entering" : "On leaving"} ${n.label ?? "the node"}: sets a context variable the nodes after read.
export default function ${name}(ctx) {
  // ctx = { event: { kind: "enter" | "exit", node, label, flow }, context: { …variables, <record>: { …its fields } }, writes: [] }
  ctx.context.${which === "onEnter" ? "entered" : "left"}_${(n.label ?? "node").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "node"} = true;
  // ctx.writes.push({ record: "lot", action: "hold" });   // made as the template, through the record's own lifecycle
  return ctx;
}`;
async function newHookScript(ctx, id, n, which) {
    const { api, w } = ctx;
    const taken = new Set([...(ctx.known.scripts ?? []), ...Object.keys(api.peek(`${w}.s`) ?? {})]);
    const suggested = `${ctx.name}_${id}_${which === "onEnter" ? "enter" : "exit"}`.slice(0, 48);
    const name = await askDialog(api, {
        title: `New script ${which === "onEnter" ? "on entering" : "on leaving"} ${n.label ?? id}`,
        message: "It runs with the run's context: what it sets there is kept on the run, for the decisions and lists after. It goes in this change, with one test case to start from.",
        label: "Its name", value: taken.has(suggested) ? "" : suggested, required: true,
        check: (v) => (!IDENTIFIER.test(v ?? "") ? "Lower case letters, digits and _, starting with a letter." : taken.has(v) ? `A script "${v}" exists already: pick it in the list.` : null),
        confirm: "Create it",
    });
    if (!name) return;
    const source = HOOK_TEMPLATE(name, which, n);
    const variable = /ctx\.context\.([a-z0-9_]+) = true/.exec(source)?.[1];
    history.before(api, w);
    api.batch(() => {
        ctx.ops.setScript(name, source);
        api.setValue(`${w}.t.${name}`, [{ name: `sets ${variable}`, run: { event: { kind: which === "onEnter" ? "enter" : "exit", node: id, label: n.label ?? id, flow: ctx.name }, context: {}, writes: [] }, expect: { output: { context: { [variable]: true } } } }]);
        ctx.ops.set(`nodes.${id}.${which}`, name, true);
        api.setValue(`${w}.hookEdit.${ctx.name}`, name);
    });
}

// A node's id, or a participant's name, renamed in the designer (no JSON): asked, checked as typed, and
// applied with everything of the template that names it (renameFlowNode, renameFlowParticipant).
async function renameIn(ctx, what, from, rename, onDone) {
    const { api } = ctx;
    const body = api.peek(ctx.root);
    const scripts = what === "node" ? [] : [...new Set(Object.values(body?.nodes ?? {}).flatMap((n) => [n?.onEnter, n?.onExit]).filter((x) => typeof x === "string"))];
    const to = await askDialog(api, {
        title: what === "node" ? `Rename node ${from}` : `Rename record ${from}`,
        message: what === "node"
            ? "Its id is what a traveler's step holds and what lists show: its wires, its place on the canvas and the scenarios that expect it follow. Runs already started keep the version they began on."
            : `Its name in the context: the template's conditions, lists and scenarios follow.${scripts.length ? ` Scripts read it by name too, and are not changed: check ${scripts.join(", ")} (ctx.context.${from}).` : ""}`,
        label: "New name", value: from, required: true,
        check: (v) => (v === from ? "Type a new name." : rename(api.peek(ctx.root), from, v).problem ?? null),
        confirm: "Rename",
    });
    if (!to || to === from) return;
    ctx.ops.edit((b) => { const r = rename(b, from, to); if (r.problem) return; for (const k of Object.keys(b)) delete b[k]; Object.assign(b, r.body); });
    onDone?.(to);
}

// The settings of what is selected: a node, or a wire.
function sidePanel(ctx, sel, pick, problemsOf) {
    const { api, ops, body, known, S } = ctx;
    const kinds = known.flowNodes ?? {};
    const valuesHint = `the context: ${[...Object.keys(body.participants ?? {}).map((k) => `${k}.<field>`), ...flowContextNames(body)].join(", ") || "add records or values first"}`;
    if (sel?.edge !== undefined) {
        const e = body.edges?.[sel.edge];
        if (!e) return hint("Click a node or a wire.");
        const source = body.nodes?.[e.from];
        const fromKind = flowKindOf(source, kinds);
        const fields = [];
        if (fromKind === "auto_decision") fields.push(labelled("Taken when", condition(ctx, `edges.${sel.edge}.when`, e.when, (v) => ops.set(`edges.${sel.edge}.when`, v, true), "otherwise", 'otherwise (e.g. {"gt": [{"context": "lot.scrap_qty"}, 5]})'), `Its wires are tried in order: the first that holds is taken; leave the last empty for otherwise. Reads ${valuesHint}.`));
        if (fromKind === "manual_decision") fields.push(labelled("The choice", text(ctx, `edges.${sel.edge}.label`, { placeholder: "Scrap the lot" }), "What the person sees and picks."));
        if (fromKind === "wait" && source.mode === "retry") fields.push({ label: { children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: e.retry === true, onchange: (ev) => ops.edit((b) => { if (ev.target.checked) b.edges[sel.edge].retry = true; else delete b.edges[sel.edge].retry; }) } }, { span: " the way back, behind its Retry button" }] } });
        return { div: { children: [
            { h4: `${source?.label ?? e.from} → ${body.nodes?.[e.to]?.label ?? e.to}` },
            ...(fields.length ? fields : [hint("It goes on by this wire.")]),
            ...problemsOf(`edges.${sel.edge}`).map((m, k) => ({ p: { key: `p${k}`, className: "error small", textContent: m } })),
            ctx.ro() ? { span: {} } : { div: { className: "view-actions", children: [
                fromKind === "auto_decision" ? { button: { type: "button", className: "btn small", disabled: !(body.edges ?? []).slice(0, sel.edge).some((x) => x.from === e.from), textContent: "Try earlier", onclick: () => ops.edit((b) => { const before = b.edges.map((x, i) => [x, i]).filter(([x, i]) => x.from === e.from && i < sel.edge).pop()?.[1]; if (before === undefined) return; const [x] = b.edges.splice(sel.edge, 1); b.edges.splice(before, 0, x); pick({ edge: before }); }) } } : { span: {} },
                { button: { type: "button", className: "btn ghost small", textContent: "Remove the wire", onclick: confirmRemove(ctx.api, "this wire", () => { ops.edit((b) => { b.edges.splice(sel.edge, 1); }); pick(null); } )} },
            ] } },
        ] } };
    }
    const id = sel?.node;
    const n = id ? body.nodes?.[id] : null;
    if (!n) return hint("Click a node to see and change its settings, or a wire for its condition or choice.");
    const kind = flowKindOf(n, kinds);
    const set = (path, v, structural = false) => ops.set(`nodes.${id}.${path}`, v, structural);
    const travelerKey = Object.keys(body.participants ?? {}).find((k) => body.participants[k]?.as === "traveler");
    const traveler = body.participants?.[travelerKey];
    const travelerTx = Object.entries(known.transactions ?? {}).filter(([, t]) => !traveler || t.appearsOn?.object === traveler.object);
    const fields = [];
    if (kind === "start" && body.kind === "input") fields.push(hint("Where the person begins: the first ask after it gets the cursor, and an end that repeats comes back here."));
    if (kind === "start" && body.kind !== "input") fields.push(labelled(body.kind === "route" ? "For travelers where" : "For events where", condition(ctx, `nodes.${id}.when`, n.when, (v) => set("when", v, true), "always", `always (e.g. {"eq": [{"context": "product.route_flow"}, "${ctx.name}"]})`), `${body.kind === "route" ? "A traveler made where this holds starts the route (at its step, if it is part-way)." : "Runs start where this holds."} Reads ${valuesHint}.`));
    // A plan's start (§32.5a): on a date of its subject's, and again after each run.
    if (kind === "start" && body.kind === "plan") {
        const subject = Object.values(body.participants ?? {}).find((p) => p?.as === "subject");
        const dates = Object.entries(known.objects?.[subject?.object]?.fields ?? {}).filter(([, f]) => f?.type === "date").map(([k, f]) => [k, f.label ?? k]);
        fields.push(labelled("Due on", select(ctx, n.due ?? "", [["", "no date: on a write only"], ...dates], (v) => set("due", v || undefined, true)), dates.length ? "When this date of the subject arrives (today in the plant, or earlier), the plan sets off by itself, where the condition above also holds." : "Its subject has no date field: a date sets nothing off."));
        fields.push({ label: { children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: n.again === true, onchange: (e) => set("again", e.target.checked ? true : undefined, true) } }, { span: " sets off again for a record once its last run there has ended" }] } });
    }
    if (kind === "sequence") {
        const step = traveler ? known.objects?.[traveler.object]?.flow?.step : null;
        fields.push(hint(step ? `Entering it sets the traveler's ${step} to "${id}".` : "The traveler names no step field yet (Flows, on its object's General tab)."));
        fields.push(labelled("Done here", travelerTx.length ? checks(ctx, travelerTx.map(([t, x]) => [t, x.label ?? t]), n.offers, (v, on) => ops.edit((b) => { b.nodes[id].offers = toggleIn(b.nodes[id].offers, v, on); if (!on) b.nodes[id].leaves = (b.nodes[id].leaves ?? []).filter((l) => l !== v); })) : hint("No transaction appears on the traveler's records yet."), "The transactions offered on a traveler at this step; on others they are refused."));
        fields.push(labelled("…taking it on", checks(ctx, (n.offers ?? []).map((t) => [t, known.transactions?.[t]?.label ?? t]), n.leaves, (v, on) => ops.edit((b) => { b.nodes[id].leaves = toggleIn(b.nodes[id].leaves, v, on); })), "Once one of these has run, the traveler goes on by its wire. A write that moves its step moves it too."));
        fields.push(labelled("Marks its state", select(ctx, n.state ?? "", [["", "leaves it as it is"], ...(known.objects?.[traveler?.object]?.states ?? []).map((s) => [s, s])], (v) => set("state", v || undefined, true)), "On entering, by the action that takes it there, as the template."));
        fields.push(labelled("On resources where", exprInput(ctx, `nodes.${id}.resource`, n.resource, (v) => set("resource", v), 'any (e.g. {"process": ["die_saw"]})'), "Fields of the resource it is worked on: another is refused here."));
        fields.push(labelled("Settings", exprInput(ctx, `nodes.${id}.settings`, n.settings, (v) => set("settings", v), '{"lsl": 28, "usl": 36}'), 'Read by its transactions as {"node": "lsl"}.'));
        fields.push(labelled("Its screen", select(ctx, n.screen ?? "", [["", "none"], ...(known.screens ?? []).map((s) => [s, s])], (v) => set("screen", v || undefined, true))));
        // Where it is in the route's guide (§35.4): a media block following this route shows it as a step there.
        fields.push(labelled("In the guide at", { input: { type: "text", placeholder: "a page (3) or a time (0:45)", disabled: ctx.ro, value: n.guide ?? "", onchange: (e) => set("guide", e.target.value.trim() || undefined, true) } }, "A screen's media block that follows this route shows this step at that page of its PDF, or that moment of its video, ticked once the traveler has gone on."));
    }
    if (kind === "auto_decision") fields.push(hint("It decides at once, on the context: its wires' conditions are tried in order, the last may have none (otherwise). Click a wire for its condition."));
    if (kind === "manual_decision") {
        fields.push(labelled("Asks", text(ctx, `nodes.${id}.message`, { placeholder: "Is the saw blade worn?" })));
        fields.push(who(ctx, id, n, "They choose one of its wires: click a wire to name its choice."));
    }
    if (kind === "wait") {
        fields.push(labelled("Shows", text(ctx, `nodes.${id}.message`, { placeholder: "Let the oven cool down" })));
        fields.push(labelled("For (seconds)", { input: { type: "number", min: 1, step: 1, disabled: ctx.ro, value: n.seconds ?? "", onchange: (e) => set("seconds", e.target.value === "" ? undefined : Math.round(Number(e.target.value)), true) } }, "The time remaining is shown while it waits."));
        fields.push(labelled("When the time is up", select(ctx, n.mode ?? "auto", WAIT_MODES.map((m) => [m, { auto: "it goes on by itself", acknowledge: "it waits for someone to acknowledge", retry: "it waits; Retry goes back" }[m]]), (v) => set("mode", v, true))));
        if (n.mode === "acknowledge" || n.mode === "retry") fields.push(who(ctx, id, n, n.mode === "retry" ? "Wire its way back, then tick it as the retry wire." : ""));
    }
    if (kind === "input_screen") {
        fields.push(labelled("Asks", text(ctx, `nodes.${id}.message`, { placeholder: "Measure the kerf again and attach a photo" })));
        fields.push(who(ctx, id, n, ""));
        fields.push(inputFields(ctx, id, n));
    }
    if (kind === "sub_flow") {
        // Those of its own kind: a plan runs plans; a route, routes for the same traveler (§32.14).
        const route = ctx.body.kind === "route";
        const mine = Object.values(ctx.body.participants ?? {}).find((p) => p?.as === "traveler")?.object;
        const fits = (f) => f !== ctx.name && (!known.flowInfo?.[f] || (known.flowInfo[f].kind === ctx.body.kind && (!route || known.flowInfo[f].object === mine)));
        fields.push(labelled("Runs", select(ctx, n.flow ?? "", [["", "—"], ...(known.flows ?? []).filter(fits).map((f) => [f, `${known.flowInfo?.[f]?.label ?? f}${known.flowInfo?.[f]?.asSub ? " (a sub route)" : ""}`]), ...(n.flow && !(known.flows ?? []).filter(fits).includes(n.flow) ? [[n.flow, n.flow]] : [])], (v) => set("flow", v, true)),
            route ? "Another route for the same traveler. The traveler goes through its steps, then comes back to this route's next step. Reuse one sub route (a rework loop, a test segment) in as many routes as need it." : "Another flow template; this one waits for it to end."));
        fields.push(labelled("Passes", exprInput(ctx, `nodes.${id}.pass`, n.pass, (v) => set("pass", v), '{"lot": {"context": "lot.id"}}'), "Into its context: { name: expression }."));
        fields.push(labelled("Takes back", exprInput(ctx, `nodes.${id}.returns`, n.returns, (v) => set("returns", v), '{"verdict": "decision"}'), "From its context when it ends: { name here: its name there }."));
    }
    // An input flow's steps (§32.13, input-flow.js).
    if (kind === "ask") {
        const names = [...new Set(["param", ...Object.entries(known.transactions ?? {}).flatMap(([t, x]) => Object.keys(x.inputs ?? {}).flatMap((k) => [k, `${t}.${k}`]))])].sort();
        fields.push(labelled("Asks for", { span: { children: [
            { input: { type: "text", list: `asks-${ctx.name}`, disabled: ctx.ro, placeholder: "lot (on a screen: param, or move_in.lot)", spellcheck: false, value: n.input ?? "", onchange: (e) => set("input", e.target.value.trim(), true) } },
            { datalist: { id: `asks-${ctx.name}`, children: names.slice(0, 400).map((k) => ({ option: { key: k, value: k } })) } },
        ] } }, "A transaction's input by name. On a screen: param (what it is opened with) or <transaction>.<input> (the name alone when it has one transaction)."));
        fields.push(labelled("Prompt", text(ctx, `nodes.${id}.prompt`, { placeholder: "Scan the lot" }), "Shown above the form while it asks; its label otherwise."));
        fields.push(labelled("Moves on by", select(ctx, n.advance ?? "enter", ADVANCE.map((a) => [a, ADVANCE_WORDS[a]]), (v) => ops.edit((b) => { const x = b.nodes[id]; x.advance = v; if (v !== "key") delete x.key; if (v !== "auto") { delete x.length; delete x.pattern; } })), "What takes the person on to the next step. A scan always finds its record first."));
        if (n.advance === "key") fields.push(labelled("The key", { input: { type: "text", disabled: ctx.ro, placeholder: "F2, or a scanner's suffix: *", value: n.key ?? "", onkeydown: (e) => { if (e.key.length > 1 && /^F([1-9]|1[0-2])$/.test(e.key)) { e.preventDefault(); e.target.value = e.key; set("key", e.key, true); } }, onchange: (e) => set("key", e.target.value.trim() || undefined, true) } }, "Press it here, or type it: F1 to F12, or one character that is not a letter or a digit."));
        if (n.advance === "auto") {
            fields.push(labelled("Complete at (characters)", { input: { type: "number", min: 1, max: 200, step: 1, disabled: ctx.ro, value: n.length ?? "", onchange: (e) => set("length", e.target.value === "" ? undefined : Math.round(Number(e.target.value)), true) } }, "A label of fixed length moves on as soon as it is read whole."));
            fields.push(labelled("…or when it matches", text(ctx, `nodes.${id}.pattern`, { placeholder: "LOT\\d{4}[A-Z]{2}-[A-Z]" }), "A regular expression the whole entry matches. A scan that found its record, or a choice picked, moves on by itself too."));
        }
        fields.push({ label: { children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: n.skipIfFilled !== false, onchange: (e) => set("skipIfFilled", e.target.checked ? undefined : false, true) } }, { span: " passed over when already filled (by the screen, a row, a fill)" }] } });
        fields.push(labelled("On an error", select(ctx, n.onError ?? "stay", [["stay", "the cursor stays until it is put right"], ["go", "it goes on regardless"]], (v) => set("onError", v === "stay" ? undefined : v, true)), "While its field shows an error, or it is required and empty."));
    }
    if (kind === "fill") {
        fields.push(labelled("Fills", text(ctx, `nodes.${id}.input`, { placeholder: "good_qty" }), "An input, as an ask names one."));
        fields.push(labelled("With", exprInput(ctx, `nodes.${id}.value`, n.value, (v) => set("value", v), '{"lookup": "lot.qty"}'), 'An expression: {"input": "lot"}, {"lookup": "lot.qty"}, {"param": "equipment"}, a value.'));
    }
    if (kind === "run") {
        fields.push(labelled("Runs", select(ctx, n.transaction ?? "", [["", "the form (the transaction, or the screen's only one)"], ...Object.entries(known.transactions ?? {}).map(([t, x]) => [t, x.label ?? t])], (v) => set("transaction", v || undefined, true)), "On a screen with several transactions, which one."));
        fields.push(labelled("Confirming", select(ctx, n.confirm ?? "ask", [["ask", "Check, then Enter on Confirm"], ["auto", "Check, and confirmed at once"]], (v) => set("confirm", v, true)), "A signature is always asked for."));
    }
    if (kind === "end" && body.kind === "input") fields.push(labelled("Then", select(ctx, n.then ?? "repeat", [["repeat", "the start again, for the next one"], ["stop", "stop here"]], (v) => set("then", v, true))));
    if (kind === "end" && body.kind !== "input") fields.push(labelled("Outcome", text(ctx, `nodes.${id}.outcome`, { placeholder: "shipped" })));
    const spec = kinds[n.kind];
    if (spec) for (const [k, type] of Object.entries(spec.config ?? {})) {
        const value = n.settings?.[k];
        fields.push(labelled(`${k}${(spec.required ?? []).includes(k) ? " *" : ""}`, { input: { type: type === "string" ? "text" : type === "boolean" ? "checkbox" : "number", step: type === "decimal" ? "any" : undefined, disabled: ctx.ro, value: type === "boolean" ? undefined : value ?? "", checked: type === "boolean" ? value === true : undefined, onchange: (e) => set(`settings.${k}`, type === "boolean" ? e.target.checked : type === "string" ? e.target.value : e.target.value === "" ? undefined : Number(e.target.value), true) } }, `${spec.label}: from the ${n.kind.split(".")[0]} suite.`));
    }
    // Its lifecycle: a rule script run on entering, and on leaving.
    const scripts = [["", "none"], ...[...new Set([...(known.scripts ?? []), n.onEnter, n.onExit].filter(Boolean))].map((s) => [s, s])];
    const editing = () => api.getState(`${ctx.w}.hookEdit.${ctx.name}`, null);
    const hookRow = (which, words, hintText) => labelled(words, { div: { className: "ed-row", children: [
        select(ctx, n[which] ?? "", scripts, (v) => set(which, v || undefined, true)),
        ctx.ro() ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: "New script…", onclick: () => newHookScript(ctx, id, n, which) } },
        n[which] ? { button: { type: "button", className: "linkish small", textContent: () => (editing() === n[which] ? "Close" : "Edit"), onclick: () => api.setValue(`${ctx.w}.hookEdit.${ctx.name}`, editing() === n[which] ? null : n[which]) } } : { span: {} },
    ] } }, hintText);
    const lifecycle = { div: { className: "flow-lifecycle", children: [
        { strong: { className: "small", textContent: "Scripts" } },
        hookRow("onEnter", "On entering"),
        hookRow("onExit", "On leaving", "Rule scripts: the context in and out; a variable they set is kept on the run, for the decisions and lists after; what they ask to write is written as the template, by the record's own lifecycle."),
    ] } };
    const out = (body.edges ?? []).map((e, i) => [e, i]).filter(([e]) => e.from === id);
    return { div: { children: [
        { h4: { className: `icon-text flow-side-head kind-${kind ?? "missing"}`, children: [icon(iconOf(kind ?? "missing")), { span: n.label ?? id }, { span: { className: "muted small", textContent: ` ${kindWords(n, kinds)} · ${id}` } }] } },
        labelled("Label", text(ctx, `nodes.${id}.label`, { placeholder: "Die saw" })),
        ctx.ro() ? { span: {} } : { div: { className: "small flow-node-id", children: [{ span: { className: "muted", textContent: `Its id: ${id} ` } }, { button: { type: "button", className: "linkish small", textContent: "Rename…", title: "The id a traveler's step holds and lists show", onclick: () => renameIn(ctx, "node", id, renameFlowNode, (to) => pick({ node: to })) } }] } },
        kind ? { span: {} } : { p: { className: "error small", textContent: `A "${n.kind}" node needs the ${String(n.kind).split(".")[0]} suite, which is not installed: it stays, and a run that reaches it stops there.` } },
        ...fields,
        // An input flow runs in the browser, as the person types: no scripts.
        body.kind === "input" ? { span: {} } : lifecycle,
        ...problemsOf(`nodes.${id}`).map((m, k) => ({ p: { key: `p${k}`, className: "error small", textContent: m } })),
        { div: { className: "small", children: [{ strong: "Goes on to" }, { ul: { children: out.length ? out.map(([e, i]) => ({ li: { key: i, children: [{ button: { type: "button", className: "linkish", textContent: `${body.nodes[e.to]?.label ?? e.to}${wireWords(body, e, kinds) ? ` (${wireWords(body, e, kinds)})` : ""}`, onclick: () => pick({ edge: i }) } }] } })) : [{ li: { className: "muted", textContent: kind === "end" ? "nothing: it ends the run" : "nowhere yet" } }] } }] } },
        ctx.ro() ? { span: {} } : { div: { className: "view-actions", children: [
            kind === "end" ? { span: {} } : { button: { type: "button", className: "btn small", textContent: "Wire from here…", title: "Click the node it goes to", onclick: () => { api.setValue(`${S}c`, id); setTimeout(() => globalThis.document?.querySelector(".flow-canvas")?.focus({ preventScroll: true }), 0); } } },
            { button: { type: "button", className: "btn ghost small", textContent: "Remove the node", onclick: confirmRemove(ctx.api, `node ${id}`, () => { ops.edit((b) => { delete b.nodes[id]; if (b.layout) delete b.layout[id]; b.edges = (b.edges ?? []).filter((e) => e.from !== id && e.to !== id); }); pick(null); } )} },
        ] } },
    ] } };
}

function generalTab(ctx) {
    const { body, ops } = ctx;
    return { div: { className: "ed-grid", children: [
        labelled("Label", text(ctx, "label", { placeholder: "Back-end route" })),
        labelled("Kind", select(ctx, body.kind ?? "route", [["route", "a route: a traveler goes through it, step by step"], ["plan", "a plan (OCAP): an event sets it off"], ["input", "an input flow: how a transaction or a screen is filled from the keyboard"]], (v) => ops.edit((b) => {
            // Made an input flow from a template no one drew on yet: its first steps, ready to change.
            const untouched = Object.keys(b.nodes ?? {}).sort().join() === "done,first,start" && !(b.nodes.first.offers ?? []).length;
            b.kind = v;
            if (v === "input") {
                b.participants = {}; b.context = {}; delete b.ends;
                if (untouched) {
                    b.nodes = { start: { kind: "start", label: "Start" }, first: { kind: "ask", label: "Scan the lot", input: "lot", advance: "enter" }, run: { kind: "run", label: "Check and confirm", confirm: "ask" }, done: { kind: "end", label: "Next", then: "repeat" } };
                    b.edges = [{ from: "start", to: "first" }, { from: "first", to: "run" }, { from: "run", to: "done" }];
                    b.layout = { start: { x: 40, y: 60 }, first: { x: 240, y: 60 }, run: { x: 440, y: 60 }, done: { x: 640, y: 60 } };
                }
            }
        })), "A route draws starts, sequences, auto decisions, sub flows (other routes) and ends; a plan, waits, decisions, input screens and sub flows; an input flow, asks, fills, decisions and runs, named by transactions and screens."),
        labelled("Description", text(ctx, "description", { placeholder: "What it is for", multiline: true })),
        // A sub route (§32.14): it takes up no traveler by itself; other routes run it, at a sub flow.
        body.kind === "route" ? labelled("Runs", select(ctx, body.asSub === true ? "sub" : "own", [["own", "on its own: it takes up the travelers its start names"], ["sub", "only inside another route, as its sub flow"]], (v) => ops.edit((b) => { if (v === "sub") b.asSub = true; else delete b.asSub; })), "A sub route is drawn once and run by every route that needs it (a rework loop, a test segment): the traveler goes through its steps and comes back. It needs no scenario of its own: it is tried through the routes that run it.") : { span: {} },
        // What the route does at every step (§32.15): a transaction it runs on its traveler, as itself.
        body.kind === "route" ? (() => {
            const known = flowKnown(ctx.api, ctx.w);
            const traveler = Object.values(body.participants ?? {}).find((p) => p?.as === "traveler")?.object;
            const fits = Object.entries(known.transactions ?? {}).filter(([, t]) => traveler && t.appearsOn?.object === traveler && t.appearsOn?.fills).map(([n, t]) => [n, t.label ?? n]);
            const pick = (which, words) => labelled(words, select(ctx, body.everySequence?.[which]?.run ?? "", [["", "nothing"], ...fits], (v) => ops.edit((b) => {
                const every = { ...(b.everySequence ?? {}) };
                if (v) every[which] = { run: v }; else delete every[which];
                if (Object.keys(every).length) b.everySequence = every; else delete b.everySequence;
            })));
            return { div: { className: "ed-row", children: [
                pick("onEnter", "As it enters any step, run"),
                pick("onExit", "As it leaves any step, run"),
                hint("A transaction on its traveler, run by the route as itself (with the roles below), every time: a future hold, a check at every step. It appears on the traveler's records, names this route among its callers (Callers: routes), and is signed by nobody."),
            ] } };
        })() : { span: {} },
        body.kind === "input" ? { span: {} } : labelled("Ends early when", condition(ctx, "ends.when", body.ends?.when, (v) => ops.set("ends", v === undefined ? undefined : { when: v }, true), "never", 'never (e.g. {"in": [{"context": "lot.state"}, ["merged", "scrapped"]]})'), "Checked after each write to the traveler: a run whose traveler is merged or scrapped ends there."),
    ] } };
}

// The run's context: the values every run starts with, beside its records and what it collects.
function contextTab(ctx) {
    const { body, ops } = ctx;
    const values = Object.entries(body.context ?? {});
    const collected = flowContextNames(body).filter((k) => !Object.hasOwn(body.context ?? {}, k));
    const add = () => ops.edit((b) => { b.context = { ...(b.context ?? {}) }; let n = values.length + 1; while (Object.hasOwn(b.context, `value_${n}`)) n++; b.context[`value_${n}`] = 0; });
    const rename = (from, to) => ops.edit((b) => { if (!to || to === from || Object.hasOwn(b.context, to)) return; b.context = Object.fromEntries(Object.entries(b.context).map(([k, v]) => [k === from ? to : k, v])); });
    return { div: { children: [
        hint("What every run carries, and its decisions read as {\"context\": \"name\"}: its records (Participants), these values it starts with, and what its input screens collect and its sub flows return. Its scripts may change the values."),
        { table: { className: "grid", children: [{ tbody: { children: [
            ...Object.keys(body.participants ?? {}).map((k) => ({ tr: { key: `p-${k}`, children: [{ td: { children: [{ code: k }] } }, { td: { className: "muted", textContent: `its ${body.participants[k].object} record, as it is now` } }, { td: {} }] } })),
            ...values.map(([k, v]) => ({ tr: { key: `v-${k}`, children: [
                { td: { children: [{ input: { type: "text", disabled: ctx.ro, value: k, onchange: (e) => rename(k, e.target.value.trim()) } }] } },
                { td: { children: [{ input: { type: "text", disabled: ctx.ro, value: json(v), onchange: (e) => ops.edit((b) => { b.context[k] = valueOf(e.target.value.replace(/^"(.*)"$/, "$1")); }) } }] } },
                { td: { children: [ctx.ro() ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: "remove", onclick: confirmRemove(ctx.api, `context value ${k}`, () => ops.edit((b) => { delete b.context[k]; }) )} }] } },
            ] } })),
            ...collected.map((k) => ({ tr: { key: `c-${k}`, children: [{ td: { children: [{ code: k }] } }, { td: { className: "muted", textContent: "collected on the way" } }, { td: {} }] } })),
        ] } }] } },
        ctx.ro() ? { span: {} } : { button: { type: "button", className: "btn small", textContent: "+ a value", onclick: add } },
    ] } };
}

function participantsTab(ctx) {
    const { body, ops, known } = ctx;
    const objects = Object.entries(known.objects ?? {});
    const opted = objects.filter(([, o]) => (o.flow?.as ?? []).length);
    const parts = Object.entries(body.participants ?? {});
    const add = () => ops.edit((b) => { let n = parts.length + 1; while (b.participants?.[`record_${n}`]) n++; b.participants = { ...(b.participants ?? {}), [`record_${n}`]: { object: opted[0]?.[0] ?? "", as: opted[0]?.[1].flow.as[0] ?? "traveler" } }; });
    return { div: { children: [
        hint("The records a template works with, in its context by these names: the traveler going through it, the resources it is worked on, what it reads. Only objects whose design says they take part (on their General tab) are offered, as what they take part as."),
        opted.length ? { span: {} } : { p: { className: "error small", textContent: "No object takes part in flows yet: open one (a lot) in this change and say how it takes part, on its General tab." } },
        { table: { className: "grid", children: [{ tbody: { children: parts.map(([k, p]) => ({ tr: { key: k, children: [
            { td: { children: [{ code: k }, ctx.ro() ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: " rename…", onclick: () => renameIn(ctx, "participant", k, renameFlowParticipant) } }] } },
            { td: { children: [select(ctx, p.object, [["", "—"], ...opted.map(([o, x]) => [o, x.label ?? o])], (v) => ops.edit((b) => { b.participants[k] = { object: v, as: known.objects[v]?.flow?.as?.[0] ?? "traveler" }; }))] } },
            { td: { children: [select(ctx, p.as, (known.objects[p.object]?.flow?.as ?? FLOW_ROLES).map((r) => [r, r]), (v) => ops.edit((b) => { b.participants[k].as = v; }))] } },
            { td: { children: [select(ctx, p.from ?? "", [["", "its own"], ...parts.filter(([o]) => o !== k).flatMap(([o, q]) => Object.entries(known.objects[q.object]?.fields ?? {}).filter(([, f]) => f.type === "ref" && f.to === p.object).map(([f]) => [`${o}.${f}`, `${o}'s ${f}`]))], (v) => ops.edit((b) => { if (v) b.participants[k].from = v; else delete b.participants[k].from; }))] } },
            { td: { children: [ctx.ro() ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: "remove", onclick: confirmRemove(ctx.api, `participant ${k}`, () => ops.edit((b) => { delete b.participants[k]; }) )} }] } },
        ] } })) } }] } },
        ctx.ro() || !opted.length ? { span: {} } : { button: { type: "button", className: "btn small", textContent: "+ a record", onclick: add } },
        { h4: "What the template itself may do" },
        hint("Marking a traveler's step and state, and its scripts' writes, are done as the template, with only these roles: give it the least it needs."),
        // Its participants' objects, and those its scripts write that take no part (a route's samples, a plan's
        // report): each added here by the designer, kept while it holds a role.
        () => {
            const ui = `ui.flowRoleObjects.${ctx.id}.${ctx.name}`;
            const own = [...new Set(parts.map(([, p]) => p.object).filter(Boolean))];
            const extra = [...new Set([...Object.keys(body.roles && typeof body.roles === "object" && !Array.isArray(body.roles) ? body.roles : {}), ...(ctx.api.getState(ui, []) ?? [])])].filter((o) => !own.includes(o));
            const shown = [...own, ...extra];
            const others = Object.entries(known.objects ?? {}).filter(([o, x]) => !shown.includes(o) && (x.roles ?? []).length);
            return { div: { children: [
                ...shown.map((o) => ({ div: { key: o, children: [{ strong: known.objects[o]?.label ?? o }, own.includes(o) ? { span: {} } : { span: { className: "muted small", textContent: " (written by its scripts)" } }, checks(ctx, (known.objects[o]?.roles ?? []).map((r) => [r, r]), body.roles?.[o], (v, on) => ops.edit((b) => { b.roles = { ...(b.roles ?? {}), [o]: toggleIn(b.roles?.[o], v, on) }; if (!b.roles[o].length) delete b.roles[o]; }))] } })),
                ctx.ro() || !others.length ? { span: {} } : select(ctx, "", [["", "+ roles on another object (one its scripts write)…"], ...others.map(([o, x]) => [o, x.label ?? o])], (v) => { if (v) ctx.api.setValue(ui, [...(ctx.api.peek(ui) ?? []), v]); }),
            ] } };
        },
    ] } };
}

// Its evidence (§32.8): scenarios walking a record through it, each expecting the nodes it reaches, run
// by the fitness test in a sandbox and kept with each version. Made in the sandbox; read and removed here.
function scenariosTab(ctx) {
    const { api, body, ops, ro, id, name } = ctx;
    const list = Array.isArray(body.scenarios) ? body.scenarios : [];
    const runs = (api.peek(`dc.${id}.fitness.checks`) ?? []).find((c) => c.id === "scenarios")?.runs ?? [];
    const view = String(id).startsWith("view-");
    const sandbox = (sc) => `/design/c/${id}/sandbox?flow=${encodeURIComponent(name)}${sc ? `&scenario=${encodeURIComponent(sc.name)}` : ""}`;
    const nodeLabel = (n) => body.nodes?.[n]?.label ?? n;
    const txLabel = (n) => ctx.known.transactions?.[n]?.label ?? n;
    const describe = (st) => { const d = st?.do ?? {}; return (d.transaction && txLabel(d.transaction)) || (d.act ? `answer ${d.act.plan ?? "the plan"} (${d.act.values ? "fill in" : d.act.choice ? `“${d.act.choice}”` : String(d.act.action ?? "").replace(/_/g, " ")})` : d.action ? `${d.action} ${d.record ?? ""}` : d.update !== undefined ? `edit ${d.update}` : d.create ? `make ${d.create}` : d.service ? `call ${d.service}` : d.screen ? `open ${d.screen}` : "?"); };
    const sets = flowSetsOff(body);
    return { div: { children: [
        hint(sets
            ? "Its evidence: each scenario starts from records picked from live (or given), walks one through this template as someone (a transaction, a plan's answer, a wait's time passing) and expects the node it reaches. The fitness test runs them in a sandbox; a new or changed template without one, or with one that fails, is not submitted."
            : "It sets off only as another plan's sub flow: it is tried through the plans that run it, and needs no scenario of its own."),
        view ? { span: {} } : { Link: { to: sandbox(null), className: "btn primary icon-text", children: [icon("play"), { span: "Make one in the sandbox" }] } },
        list.length ? { ul: { className: "scenario-list", children: list.map((sc, i) => {
            const last = runs.find((r) => r.flow === name && r.name === sc?.name);
            return { li: { key: `${i}-${sc?.name}`, className: "panel", children: [
                { div: { className: "sbx-step-head", children: [
                    { strong: sc?.name ?? "(unnamed)" },
                    last ? { span: { className: `badge ${last.passed ? "tone-ok" : "tone-danger"}`, textContent: last.passed ? "passed" : "failed" } } : { span: { className: "muted small", textContent: " not run yet" } },
                    { span: { className: "spacer" } },
                    view ? { span: {} } : { Link: { to: sandbox(sc), className: "small", textContent: "open in the sandbox" } },
                    ro() ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: "remove", onclick: confirmRemove(ctx.api, "this scenario", () => ops.edit((b) => { b.scenarios = (b.scenarios ?? []).filter((_, k) => k !== i); if (!b.scenarios.length) delete b.scenarios; }) )} },
                ] } },
                { div: { className: "small muted", textContent: `Records: ${Object.entries(sc?.records ?? {}).map(([k, r]) => `@${k} (${r.object}${r.data !== undefined ? ", given" : ""})`).join(", ") || "none: its steps make them"}` } },
                { ol: { className: "small", children: (sc?.steps ?? []).map((st, j) => ({ li: { key: j, textContent: `${describe(st)}${st.as ? `, as ${st.as}` : ""} → ${st.expect?.ok === false ? "refused" : "runs"}${st.expect?.node ? `; ${Object.entries(st.expect.node).map(([k, n]) => `@${k} at ${nodeLabel(n)}`).join(", ")}` : ""}` } })) } },
                last && !last.passed ? { p: { className: "error small", textContent: last.detail } } : { span: {} },
            ] } };
        }) } } : { p: { className: "muted", textContent: "None yet." } },
    ] } };
}

function stewardsTab(ctx) {
    const { body, ops, known } = ctx;
    return { div: { children: [
        hint("The departments that approve a change to this template. The stewards of the transactions it offers and of the objects it may write approve it too."),
        checks(ctx, (known.departments ?? []).map((d) => [d, d]), body.stewards, (v, on) => ops.edit((b) => { b.stewards = toggleIn(b.stewards, v, on); })),
    ] } };
}

export function registerFlowEditor(juris) {
    juris.registerComponent("FlowEditor", ({ id, editable, pane = 0, name, head }, api) => {
        const w = W(id);
        const ops = elementOps(api, id, "flow", name);
        const view = () => { const v = api.getState(`${w}.panes.${pane}.view`, "canvas"); return FLOW_VIEWS.some(([k]) => k === v) ? v : "canvas"; };
        const ro = () => !api.prop(editable);
        return {
            div: {
                className: "editor flow-editor",
                // The panel its guide outlines in (§33): this window's, not another's beside it.
                "data-guide-scope": `${id}-${pane}`,
                children: [
                    { div: { className: "editor-head", children: [
                        { GuideToggle: { key: `guide-flow-${pane}`, guide: "flow-designer", scope: `[data-guide-scope="${id}-${pane}"]` } },
                        head ?? { span: {} },
                        // An input flow (§32.13) has no records, context or scenarios: those tabs are not drawn.
                        { nav: { className: "subtabs", children: FLOW_VIEWS.map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", hidden: () => api.getState(`${ops.root}.kind`, null) === "input" && ["context", "participants", "scenarios"].includes(key), classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                            api.getState(`${w}.vrev`);
                            api.getState(`dc.${id}.updated_at`);
                            const all = changesOf(api, id, "flow", name);
                            const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                            return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                        }] } })) } },
                    ] } },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(ops.root);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const ctx = { api, w, ops, ro, body, id, kind: "flow", name, root: ops.root, known: flowKnown(api, w), S: `${w}.flowSel.${name}` };
                        switch (view()) {
                            case "copilot": return { CopilotPanel: { key: `copilot-${id}`, id } };
                            case "changes": return { ChangesView: { key: `changes-fl-${name}`, id, kind: "flow", name, onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "general": return generalTab(ctx);
                            case "context": return contextTab(ctx);
                            case "participants": return participantsTab(ctx);
                            case "scenarios": return scenariosTab(ctx);
                            case "stewards": return stewardsTab(ctx);
                            case "json": return jsonOf(ctx);
                            default: return canvasTab(ctx);
                        }
                    },
                ],
            },
        };
    });
}
