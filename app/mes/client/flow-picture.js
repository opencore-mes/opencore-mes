// A flow template drawn (DESIGN.md §32.7): the boxes and wires the Flow designer's canvas and a run's
// map share. Every node is the same box, told apart by its border's colour (app.css) and its icon.
// A run's map is the template as that run's version draws it, read only, its way on it: the nodes it
// went through filled in, the wires it took marked (×2: twice), where it is now outlined, the rest
// faded. It is shown on a plan's page and on a record's route banner, when the person asks for it.
import { flowKindOf, flowWalk } from "./definition.js";
import { icon } from "./icons.js";
import { plant } from "./format.js";
import { canvasZoom } from "./canvas-zoom.js";

export const NODE = { w: 184, h: 56 };
const KIND_ICONS = { start: "play", sequence: "steps", auto_decision: "branch", manual_decision: "personChoice", wait: "hourglass", input_screen: "form", sub_flow: "subflow", ask: "scan", fill: "pencil", run: "check", end: "flag", missing: "warning" };
export const iconOf = (kind) => KIND_ICONS[kind] ?? "info";

// Where each node sits: its own place, or (a node with none) a free spot below.
export function positions(body) {
    const at = {};
    let n = 0;
    for (const id of Object.keys(body.nodes ?? {})) {
        const p = body.layout?.[id];
        at[id] = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : { x: 40 + (n % 5) * 240, y: 300 + Math.floor(n / 5) * 90 };
        if (!p) n++;
    }
    return at;
}
// The size the nodes need, never below a panel's.
export const extent = (at) => ({ width: Math.max(720, ...Object.values(at).map((p) => p.x + NODE.w + 60)), height: Math.max(320, ...Object.values(at).map((p) => p.y + NODE.h + 60)) });
// Where a wire meets the two nodes' borders, so its arrow is seen.
export function borderOf(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.min(Math.abs(dx) > 0 ? (NODE.w / 2) / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? (NODE.h / 2) / Math.abs(dy) : Infinity);
    return { x1: a.x + dx * t, y1: a.y + dy * t, x2: b.x - dx * t, y2: b.y - dy * t };
}
const centreOf = (p) => ({ x: p.x + NODE.w / 2, y: p.y + NODE.h / 2 });
// What a wire says on the canvas: its choice, its way back, its condition, or otherwise. (A run's map
// knows a condition only as being there: `cond`.)
export function wireWords(body, e, kinds) {
    if (e.retry) return "retry";
    if (e.label) return e.label;
    if (e.when !== undefined || e.cond) return "if …";
    return flowKindOf(body.nodes?.[e.from], kinds) === "auto_decision" ? "otherwise" : "";
}
export const arrowMarker = (id, className = "flow-arrow") => ({ marker: { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", children: [{ path: { d: "M 0 0 L 10 5 L 0 10 z", className } }] } });
const short = (s) => (String(s).length > 19 ? `${String(s).slice(0, 18)}…` : String(s));

// A run's map: `map` as flows.task and flows.runOf give it (flowMapOf), `steps` its way, `node` and
// `state` where it is now. `key` tells its arrows apart from another map's on the same page, and keeps
// its zoom (canvas-zoom.js), given `api`; a finger scrolls it, so only a mouse drags its ground.
// `opens(id)`: what a node opens when clicked (a sub flow's own map, §32.14), as { words, open }, or null.
export function flowRunMap({ map, steps = [], node = null, state = "running", key = "run", api = null, opens = () => null }) {
    if (!map) return { span: {} };
    const walk = flowWalk(map, steps);
    const at = positions(map);
    const { width, height } = extent(at);
    const ends = state === "ended" ? "ended" : state === "stopped" ? "stopped" : "current";
    const nowWords = { current: "now", ended: "ended here", stopped: "stopped here" }[ends];
    // Who moved it there: a person, or the template itself (an automatic step), as its way says.
    const by = (who) => String(who).replace(/^flow:/, map.kind === "plan" ? "the plan " : "the route ");
    const when = (id) => steps.filter((s) => s.node === id).map((s) => `${plant().dateTime(s.at)}${s.by ? `, by ${by(s.by)}` : ""}`);
    const wire = (e, words, marker) => {
        const b = borderOf(centreOf(at[e.from]), centreOf(at[e.to]));
        const [a, z] = [centreOf(at[e.from]), centreOf(at[e.to])];
        return [
            { line: { ...b, "marker-end": `url(#${marker})` } },
            words ? { text: { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 - 6, className: "flow-edge-label", textContent: words } } : { g: {} },
        ];
    };
    const way = steps.map((s) => s.label ?? s.node).join(" → ");
    const fitStyle = `min-width: ${Math.round(width * 0.6)}px`;
    const zoom = api ? canvasZoom(api, `ui.runZoom.${key}`, { width, fitStyle, pan: "mouse" }) : null;
    return {
        div: {
            className: "flow-run-map",
            children: [
                { div: { className: "zoom-box", children: [{ div: { className: () => `flow-run-wrap zoom-wrap${zoom?.zoomed() ? " zoomed" : ""}`, ...(zoom?.wrap ?? {}), children: [{
                    svg: {
                        className: "flow-canvas flow-run", viewBox: `0 0 ${width} ${height}`, width, height, style: zoom ? zoom.style : fitStyle,
                        role: "img", "aria-label": `${map.label}: its way, ${way || "not started"}`,
                        children: [
                            { defs: { children: [arrowMarker(`arrow-${key}`), arrowMarker(`arrow-${key}-on`, "flow-arrow on")] } },
                            ...map.edges.map((e, i) => {
                                const n = walk.taken[i] ?? 0;
                                const words = [wireWords(map, e), n > 1 ? `×${n}` : ""].filter(Boolean).join(" ");
                                return { g: { key: `e${i}`, className: `flow-edge${e.retry ? " retry" : ""}${n ? " taken" : ""}`, children: wire(e, words, n ? `arrow-${key}-on` : `arrow-${key}`) } };
                            }),
                            // Moves no wire leads by: a step set by hand, followed off route (§32.5).
                            ...walk.off.filter((m) => at[m.from] && at[m.to]).map((m, i) => ({ g: { key: `off${i}`, className: "flow-edge off taken", children: wire(m, "off route", `arrow-${key}-on`) } })),
                            ...Object.entries(map.nodes).map(([id, n]) => {
                                const visits = walk.visits[id] ?? 0;
                                const here = id === node;
                                const times = when(id);
                                const opener = opens(id);
                                const act = opener ? { tabindex: "0", role: "button", "aria-label": `${n.label}: ${opener.words}`, onclick: opener.open, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opener.open(); } } } : {};
                                return {
                                    g: {
                                        key: `n-${id}`,
                                        className: `flow-node kind-${n.kind}${visits ? " walked" : " unreached"}${here ? ` ${ends}` : ""}${opener ? " opens" : ""}`,
                                        transform: `translate(${at[id].x} ${at[id].y})`,
                                        ...act,
                                        children: [
                                            { title: { textContent: `${n.label} (${n.words})${here ? `: ${nowWords}` : ""}. ${visits ? `Entered ${visits === 1 ? "once" : `${visits} times`}: ${times.join("; ")}.` : "Not reached."}${opener ? ` Click to ${opener.words}.` : ""}` } },
                                            { rect: { width: NODE.w, height: NODE.h, rx: 8 } },
                                            { svg: { ...icon(iconOf(n.kind)).svg, x: 10, y: 9, width: 18, height: 18, className: "flow-node-icon" } },
                                            { text: { x: 36, y: 23, className: "flow-node-label", textContent: short(n.label) } },
                                            { text: { x: 36, y: 42, className: "flow-node-kind", textContent: here ? nowWords : `${n.words}${n.hooks ? " · script" : ""}` } },
                                            opener ? { svg: { ...icon("chevronRight").svg, x: NODE.w - 24, y: NODE.h / 2 - 8, width: 16, height: 16, className: "flow-node-open" } } : { g: {} },
                                            visits > 1 ? { g: { className: "flow-visits", children: [{ circle: { cx: NODE.w - 4, cy: 4, r: 11 } }, { text: { x: NODE.w - 4, y: 8, textContent: String(visits) } }] } } : { g: {} },
                                        ],
                                    },
                                };
                            }),
                        ],
                    },
                }] } }, zoom ? zoom.controls : { span: {} }] } },
                { div: { className: "flow-run-legend small muted", children: [
                    { span: { className: "swatch walked", textContent: "went through" } },
                    // (A sub route not reached yet, drawn as published: nothing is there now.)
                    state === "unreached" ? { span: {} } : { span: { className: `swatch ${ends}`, textContent: nowWords } },
                    { span: { className: "swatch taken", textContent: "wire taken (×2: twice)" } },
                    { span: { className: "swatch unreached", textContent: "not reached" } },
                    { span: { textContent: `Point at a step for when it was there, and who moved it on.${Object.keys(map.nodes).some((id) => opens(id)) ? " Click a sub flow to open its own map." : ""}` } },
                ] } },
            ],
        },
    };
}

// A traveler's route as flows.runOf gives it (`r`), drawn: the route's map, and the sub routes' (§32.14).
// A sub flow clicked opens its run's own map (the last, where it was entered more than once: the others
// a click away), or, not reached yet, the sub route as published now. The trail above leads back up.
// What is open is kept at `view` (this page's alone); `key` tells its maps apart. A record's route
// banner and the sandbox's Follow a route draw it.
export function routeMaps(api, r, { view, key }) {
    const V = view;
    const routes = r.routes ?? [];
    const byId = (runId) => routes.find((x) => x.id === runId) ?? null;
    const own = byId(r.id) ?? { id: r.id, parent: null, at: null, label: r.label, map: r.map, steps: r.steps, node: r.node, state: r.state, outcome: r.outcome };
    const v = api.getState(V, null);
    const run = (v?.run && byId(v.run)?.map) ? byId(v.run) : own;
    const path = (run === own && v?.run !== own.id ? [] : v?.path ?? []).filter((p) => r.subMaps?.[p.flow]);
    const show = (to) => api.setValue(V, to);
    // The runs of one sub flow node, in the order they ran: "2 of 2" where there is more than one.
    const siblings = (x) => routes.filter((y) => y.parent && y.parent === x.parent && y.at === x.at);
    const up = [];
    for (let x = run; x && up.length <= 8; x = x.parent ? byId(x.parent) : null) up.unshift(x);
    const tail = path.map((p, i) => ({ path: path.slice(0, i + 1), label: r.subMaps[p.flow]?.label ?? p.flow }));
    const shownMap = path.length ? r.subMaps[path.at(-1).flow] : run.map;
    const opens = (node) => {
        const n = shownMap?.nodes?.[node];
        if (n?.kind !== "sub_flow" || !n.flow) return null;
        const ran = path.length ? [] : routes.filter((c) => c.parent === run.id && c.at === node);
        if (ran.length) return { words: `open its run${ran.length > 1 ? ` (the last of ${ran.length})` : ""}`, open: () => show({ run: ran[ran.length - 1].id, path: [] }) };
        return r.subMaps?.[n.flow] ? { words: "open it (not reached yet)", open: () => show({ run: run.id, path: [...path, { node, flow: n.flow }] }) } : null;
    };
    const state = (x) => (x.state === "ended" ? `ended: ${x.outcome ?? ""}` : x.state === "stopped" ? `stopped at ${x.nodeLabel ?? x.node}` : `at ${x.nodeLabel ?? x.node}`);
    const crumbs = [
        ...up.map((x, i) => {
            const sib = siblings(x);
            const nth = sib.length > 1 ? ` (${sib.indexOf(x) + 1} of ${sib.length})` : "";
            const last = i === up.length - 1 && !tail.length;
            return last ? { strong: { key: `c-${x.id}`, textContent: `${x.label}${nth}` } } : { button: { key: `c-${x.id}`, type: "button", textContent: `${x.label}${nth}`, onclick: () => show({ run: x.id, path: [] }) } };
        }),
        ...tail.map((t, i) => (i === tail.length - 1 ? { strong: { key: `t-${i}`, textContent: t.label } } : { button: { key: `t-${i}`, type: "button", textContent: t.label, onclick: () => show({ run: run.id, path: t.path }) } })),
    ].flatMap((c, i) => (i ? [{ span: { key: `s-${i}`, className: "muted", textContent: " › " } }, c] : [c]));
    const sib = run.parent ? siblings(run) : [];
    return {
        div: {
            className: "flow-route-maps",
            children: [
                { div: { className: "flow-trail small", children: [
                    { span: { className: "flow-trail-path", children: crumbs } },
                    { span: { className: "muted", textContent: ` · ${tail.length ? "not reached yet: as published now" : state(run)}` } },
                    // Entered more than once: each time's run, a click away.
                    !tail.length && sib.length > 1 ? { span: { className: "flow-trail-runs", children: [{ span: { className: "muted", textContent: " · runs: " } }, ...sib.map((x, i) => (x.id === run.id ? { strong: { key: x.id, textContent: String(i + 1) } } : { button: { key: x.id, type: "button", textContent: String(i + 1), onclick: () => show({ run: x.id, path: [] }) } }))] } } : { span: {} },
                ] } },
                tail.length
                    ? flowRunMap({ map: shownMap, steps: [], node: null, state: "unreached", key: `${key}-${path.map((p) => p.node).join("-")}`, api, opens })
                    : flowRunMap({ map: run.map, steps: run.steps ?? [], node: run.node, state: run.state, key: `${key}-${run.id}`, api, opens }),
            ],
        },
    };
}

// Whether a person keeps a run's map open, per kind (a plan's, a route's): this browser remembers it.
export function useRunMap(api, kind) {
    const S = `ui.runMap.${kind}`;
    const key = `mes.runMap.${kind}`;
    if (!api.isServer) api.onMount(() => { try { if (localStorage.getItem(key) === "1") api.setValue(S, true); } catch { /* storage off: closed */ } });
    const open = () => api.getState(S, false) === true;
    const toggle = () => { const on = !open(); api.setValue(S, on); try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* this visit only */ } };
    return { open, toggle };
}
