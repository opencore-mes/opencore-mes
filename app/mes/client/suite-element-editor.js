// The designer's editor for a design element of a kind a suite adds (DESIGN.md §30.11), beside the
// others, on the same working copy (`${w}.el.<name>`). What every element has is edited here (label,
// description, stewards); what its kind adds is edited by the suite's own component (its browser
// module's `elements: { "<suite>.<kind>": { label, component } }`, given { id, name, body, ops, ro,
// known: { objects, elements } }),
// or, where the suite brings none, or is not installed, as JSON.
import { validateSuiteElement, suiteElementFootprint } from "./definition.js";
import { changesOf, countByTab } from "./compare.js";
import { elementOps, jsonOf } from "./integration-editor.js";
import { suiteElements } from "./suite-registry.js";
import { W, text, labelled } from "./editor-kit.js";
import { icon } from "./icons.js";

export const ELEMENT_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["design", "Design"], ["stewards", "Stewards"], ["json", "JSON"]];
const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const toggleIn = (list, value, on) => { const set = new Set(list ?? []); if (on) set.add(value); else set.delete(value); return [...set]; };
const known = (api) => { const home = api.peek("design.home") ?? {}; return { departments: (home.departments ?? []).map((d) => d.id), suiteElements: home.suiteElements ?? {} }; };

// What every element has, and what its suite checks of its kind (the browser module's `validate`, the
// same the server runs), against the objects there are and the elements: this change's drafts over
// the live ones its suite shares.
// What an element may name, for its suite's check and its editor: the objects there are, the
// elements (this change's drafts over the live ones its suite shares), and those live ones alone (what
// the change does to them). The services its schedules run are the server's to check.
export function elementsKnown(api, id) {
    const home = api.peek("design.home") ?? {};
    const live = Object.fromEntries((home.elements ?? []).filter((x) => x.body).map((x) => [x.name, x.body]));
    return {
        objects: Object.fromEntries((home.objects ?? []).map((o) => [o.object, { label: o.label, fields: o.fields ?? {}, actions: o.actions ?? [] }])),
        elements: { ...live, ...(api.peek(`${W(id)}.el`) ?? {}) },
        live,
    };
}
export function elementProblemsOf(api, id) {
    const about = elementsKnown(api, id);
    return Object.entries(api.peek(`${W(id)}.el`) ?? {}).flatMap(([name, body]) => [
        ...validateSuiteElement(body, known(api)).map((p) => ({ ...p, message: `${name}: ${p.message}` })),
        ...(suiteElements[body?.kind]?.validate?.(body, about) ?? []).map((m) => ({ path: "", message: `${name}: ${m}` })),
    ]);
}
export function suiteElementsOf(api, id, change) {
    return Object.entries(api.peek(`${W(id)}.el`) ?? {}).flatMap(([name, body]) => suiteElementFootprint(name, change.live.elements?.[name] ?? undefined, body));
}

function generalTab(ctx) {
    const kind = known(ctx.api).suiteElements[ctx.body.kind];
    return {
        div: {
            className: "ed-grid",
            children: [
                labelled("Name", { input: { type: "text", value: ctx.body.name, disabled: true } }, "Fixed once created."),
                labelled("Kind", { input: { type: "text", value: kind?.label ?? ctx.body.kind, disabled: true } }, kind ? `A design element of the ${ctx.body.kind.split(".")[0]} suite.` : `Needs the ${String(ctx.body.kind).split(".")[0]} suite, which is not installed here.`),
                labelled("Label", text(ctx, "label"), "What people know it by."),
                labelled("Description", text(ctx, "description", { multiline: true })),
            ],
        },
    };
}
function designTab(ctx) {
    const own = suiteElements[ctx.body.kind];
    if (own?.component) return { [own.component]: { key: `suite-el-${ctx.name}`, id: ctx.id, name: ctx.name, body: ctx.body, ops: ctx.ops, ro: ctx.ro(), known: elementsKnown(ctx.api, ctx.id) } };
    return { div: { children: [hint(known(ctx.api).suiteElements[ctx.body.kind] ? "Its suite brings no editor of its own for this kind: edit it as JSON." : `It needs the ${String(ctx.body.kind).split(".")[0]} suite, which is not installed here: it stays as it is until the suite is back.`), jsonOf(ctx)] } };
}
function stewardsTab(ctx) {
    const depts = ctx.api.peek("design.home.departments") ?? [];
    return { div: { children: [
        hint("Its stewards approve every change to it."),
        { div: { className: "checks", children: depts.map((d) => ({ label: { key: d.id, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: (ctx.body.stewards ?? []).includes(d.id), onchange: (e) => ctx.ops.edit((b) => { b.stewards = toggleIn(b.stewards, d.id, e.target.checked); }) } }, { span: ` ${d.label ?? d.id}` }] } })) } },
    ] } };
}

export function registerSuiteElementEditor(juris) {
    juris.registerComponent("SuiteElementEditor", ({ id, editable, pane = 0, name, head }, api) => {
        const w = W(id);
        const ops = elementOps(api, id, "element", name);
        const view = () => { const v = api.getState(`${w}.panes.${pane}.view`, "general"); return ELEMENT_VIEWS.some(([k]) => k === v) ? v : "general"; };
        const ro = () => !api.prop(editable);
        return {
            div: {
                className: "editor",
                children: [
                    { div: { className: "editor-head", children: [
                        head ?? { span: {} },
                        { nav: { className: "subtabs", children: ELEMENT_VIEWS.map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                            api.getState(`${w}.vrev`);
                            api.getState(`dc.${id}.updated_at`);
                            const all = changesOf(api, id, "element", name);
                            const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                            return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                        }] } })) } },
                    ] } },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(ops.root);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const ctx = { api, w, ops, ro, body, id, kind: "element", name, root: ops.root };
                        switch (view()) {
                            case "copilot": return { CopilotPanel: { key: `copilot-${id}`, id } };
                            case "changes": return { ChangesView: { key: `changes-el-${name}`, id, kind: "element", name, onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "design": return designTab(ctx);
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
