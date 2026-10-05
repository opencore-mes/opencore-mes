// The test sandbox (DESIGN.md §5.13), in the designer: a change put under test (and taken out), what
// it was tested with, the order the changes under test are applied in (the execution flow), and the
// way in. The test sandbox is the installation's one shared pre-production copy: what is live, plus
// every change under test, so that changes nobody has approved yet see each other. Nothing in it
// reaches the live database; approval is still asked for, change by change, afterwards.
import { icon } from "./icons.js";
import { plant } from "./format.js";

const openAt = (r) => r.url ?? `${globalThis.location.protocol}//${globalThis.location.hostname}:${r.port}/`;

export function registerTestSandbox(juris) {
    // Into the test sandbox, in a tab of its own: it is built first if what is under test changed.
    const enter = async (api, path) => {
        api.batch(() => { api.setValue(`${path}.busy`, true); api.setValue(`${path}.error`, null); });
        try {
            const r = await api.call("test.enter", {});
            globalThis.open?.(openAt(r), "opencore-test-sandbox");
            return r;
        } catch (e) {
            api.setValue(`${path}.error`, e.message);
            return null;
        } finally {
            api.setValue(`${path}.busy`, false);
        }
    };

    // On a change's page: under test or not, and what it was tested with.
    juris.registerComponent("TestPanel", ({ id }, api) => {
        const P = `testpanel.${id}`;
        const change = () => api.getState(`dc.${id}`, null);
        const act = (name) => { api.batch(() => { api.setValue(`${P}.busy`, true); api.setValue(`${P}.error`, null); }); return api.call(name, { id }).then(() => {}, (e) => api.setValue(`${P}.error`, e.message)).finally(() => api.setValue(`${P}.busy`, false)); };
        return { div: { className: "test-panel", children: () => {
            const c = change();
            if (!c || String(id).startsWith("view-")) return [];
            const me = api.getState("me.id", null);
            const mine = [c.author, ...(c.co_designers ?? [])].includes(me);
            const busy = api.getState(`${P}.busy`, false);
            const last = (c.tested ?? []).slice(-3).reverse();
            return [
                { h4: { className: "icon-text", children: [icon("play"), { span: "Test sandbox" }] } },
                c.test
                    ? { p: { className: "small", textContent: `Under test since ${plant().dateTime(c.test.at)} (place ${c.test.order} in the order). It is applied there with every other change under test; nothing reaches the plant.` } }
                    : { p: { className: "muted small", textContent: "Not under test. In the test sandbox this change runs together with the other changes under test, before anyone is asked to approve." } },
                { div: { className: "test-buttons", children: [
                    !c.test && mine && c.state === "design" ? { button: { type: "button", className: "btn", disabled: busy, textContent: "Add to test sandbox", onclick: () => act("test.add") } } : { span: {} },
                    c.test ? { button: { type: "button", className: "btn primary", disabled: busy, textContent: busy ? "Opening…" : "Open the test sandbox", onclick: () => enter(api, P) } } : { span: {} },
                    c.test && mine ? { button: { type: "button", className: "btn ghost", disabled: busy, textContent: "Take it out", onclick: () => act("test.remove") } } : { span: {} },
                ] } },
                () => { const e = api.getState(`${P}.error`, null); return e ? { p: { className: "error small", role: "alert", textContent: e } } : { span: {} }; },
                // What it was tested with, each time the test sandbox was built with it in: its evidence.
                last.length ? { div: { className: "test-evidence", children: [
                    { strong: { className: "small", textContent: "Tested with" } },
                    ...last.map((t, k) => ({ p: { key: k, className: `small ${t.ok ? "" : "error"}`, children: [
                        { span: `${plant().dateTime(t.at)} · ` },
                        t.ok ? { span: (t.with ?? []).length ? (t.with ?? []).map((w) => w.title).join("; ") : "alone (no other change under test)" } : { span: `could not be applied there: ${t.error ?? ""}` },
                    ] } })),
                    (c.tested ?? []).length > 3 ? { p: { className: "muted small", textContent: `…and ${(c.tested ?? []).length - 3} build(s) before.` } } : { span: {} },
                ] } } : { span: {} },
            ];
        } } };
    });

    // The designer's Test sandbox tab: the changes under test, in the order they are applied.
    juris.registerComponent("TestBench", (props, api) => {
        const P = "testbench";
        const load = () => api.call("test.state", {}).then((s) => api.setValue(`${P}.state`, s), (e) => api.setValue(`${P}.error`, e.message));
        const act = (name, args = {}) => { api.batch(() => { api.setValue(`${P}.busy`, true); api.setValue(`${P}.error`, null); }); return api.call(name, args).then((s) => api.setValue(`${P}.state`, s), (e) => api.setValue(`${P}.error`, e.message)).finally(() => api.setValue(`${P}.busy`, false)); };
        if (!api.isServer) api.onMount(load);
        const move = (ids, i, d) => { const next = [...ids]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); return act("test.order", { ids: next }); };
        return { div: { children: [
            { p: { className: "muted small", textContent: "The test sandbox is this installation's shared pre-production copy: what is live, plus every change under test, applied in the order below. Changes nobody has approved yet see each other there; people sign in as themselves, with their own roles. Nothing in it reaches the plant: each change still goes to review and approval. A change is put here from its own page (Add to test sandbox)." } },
            () => {
                const s = api.getState(`${P}.state`, null);
                const busy = api.getState(`${P}.busy`, false);
                const error = api.getState(`${P}.error`, null);
                if (!s) return { p: { className: "muted small", textContent: error ?? "Reading…" } };
                const ids = s.changes.map((c) => c.id);
                const isDesigner = (api.getState("design.home.me.roles", []) ?? []).includes("designer");
                return { div: { children: [
                    { div: { className: "test-buttons", children: [
                        { button: { type: "button", className: "btn primary", disabled: busy || !s.changes.length, textContent: busy ? "Working…" : "Open the test sandbox", onclick: () => enter(api, P).then(load) } },
                        { button: { type: "button", className: "btn", disabled: busy || !s.changes.length, textContent: "Build it again now", onclick: () => act("test.build") } },
                        { span: { className: "muted small", textContent: !s.changes.length ? "Nothing is under test." : s.built ? `Built ${plant().dateTime(s.built)} by ${s.by}${s.stale ? " · changed since: it is built again when it is next opened" : ""}.` : "Not built yet: it is built when it is first opened." } },
                    ] } },
                    error ? { p: { className: "error small", role: "alert", textContent: error } } : { span: {} },
                    s.changes.length ? { table: { className: "grid", children: [
                        { thead: { children: [{ tr: { children: ["Order", "Change", "By", "State", "In the test sandbox", ""].map((h) => ({ th: h })) } }] } },
                        { tbody: { children: s.changes.map((c, i) => ({ tr: { key: c.id, children: [
                            { td: String(i + 1) },
                            { td: { children: [{ Link: { to: `/design/c/${c.id}`, textContent: c.title } }] } },
                            { td: c.author },
                            { td: c.state },
                            { td: { className: c.applied && !c.applied.ok ? "error" : "", textContent: !c.applied ? "not built with this version yet" : c.applied.ok ? "applied" : `could not be applied: ${c.applied.error}` } },
                            { td: { className: "row-buttons", children: isDesigner ? [
                                { button: { type: "button", className: "mini", disabled: busy || i === 0, title: "Apply it earlier", "aria-label": `Apply ${c.title} earlier`, children: [icon("arrowUp")], onclick: () => move(ids, i, -1) } },
                                { button: { type: "button", className: "mini", disabled: busy || i === ids.length - 1, title: "Apply it later", "aria-label": `Apply ${c.title} later`, children: [icon("arrowDown")], onclick: () => move(ids, i, 1) } },
                            ] : [] } },
                        ] } })) } },
                    ] } } : { span: {} },
                    s.changes.length > 1 ? { p: { className: "muted small", textContent: "The order is the execution flow: each change is applied on top of those before it. One that needs what another brings goes after it." } } : { span: {} },
                ] } };
            },
        ] } };
    });

    // In the test sandbox itself: said on every page.
    juris.registerComponent("TestSandboxBar", (props, api) => (api.getState("me.test", false)
        ? { div: { className: "test-bar", role: "status", children: [icon("play"), { strong: "Test sandbox" }, { span: " · a copy for testing changes that are not approved yet. Nothing done here reaches the plant." }] } }
        : { span: {} }));
}
