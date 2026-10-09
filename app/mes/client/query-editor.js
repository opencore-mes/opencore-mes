// The designer's editor for a named query (DESIGN.md §23.1), beside the others, on the same working copy
// (`${w}.qy.<name>`). A query is one SELECT over the query views with parameters by name (:family); it runs
// as whoever it is for and grants nothing. Approved by its stewards like anything else; once live, a plan's
// input screen may draw a dropdown from it (§32.6).
import { validateQuery, queryFootprint, paramsIn, PARAM_TYPES, QUERY_LIMIT } from "./query-def.js";
import { noDefault } from "./select.js";
import { changesOf, countByTab } from "./compare.js";
import { elementOps, jsonOf, deprecation } from "./integration-editor.js";
import { W, text, labelled, check } from "./editor-kit.js";
import { pickMany } from "./pick.js";
import { icon } from "./icons.js";
import { confirmRemove } from "./dialog.js";
import { queryColumns, forgetColumns } from "./query-source.js";

export const QUERY_VIEWS = [["copilot", "Copilot", "sparkle"], ["changes", "Changes"], ["general", "General"], ["sql", "Query"], ["params", "Parameters"], ["tests", "Try and tests"], ["uses", "Used by"], ["web", "Web"], ["stewards", "Stewards"], ["json", "JSON"]];
const TYPE_WORDS = { string: "text", integer: "whole number", decimal: "number", boolean: "yes or no", date: "date" };
const SHOWN = 50; // rows a try shows: enough to judge it, never a table drawn whole
const hint = (words) => ({ p: { className: "muted small", textContent: words } });
const toggleIn = (list, value, on) => { const set = new Set(list ?? []); if (on) set.add(value); else set.delete(value); return [...set]; };
const select = (ctx, value, options, onchange) => ({ select: { disabled: ctx.ro, onchange: (e) => onchange(e.target.value), children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: value === v, textContent: l } }))) } });

const known = (api) => ({ departments: (api.peek("design.home.departments") ?? []).map((d) => d.id) });
export function queryProblemsOf(api, id) {
    return Object.entries(api.peek(`${W(id)}.qy`) ?? {}).flatMap(([name, body]) => validateQuery(body, known(api)).map((p) => ({ ...p, message: `${name}: ${p.message}` })));
}
export function queryElements(api, id, change) {
    return Object.entries(api.peek(`${W(id)}.qy`) ?? {}).flatMap(([name, body]) => queryFootprint(name, change.live.queries?.[name] ?? undefined, body));
}

function generalTab(ctx) {
    const { body, ops } = ctx;
    return { div: { className: "ed-grid", children: [
        labelled("Name", { input: { type: "text", value: body.name, disabled: true } }, "Fixed once created; what a plan's field names it by."),
        labelled("Label", text(ctx, "label"), "What designers pick it by."),
        labelled("Description", text(ctx, "description", { multiline: true }), "What it answers, and for whom: \"The tools of one equipment family that are not down, for the plans that pick a tool.\""),
        labelled("At most (rows)", { input: { type: "number", min: 1, max: QUERY_LIMIT.max, step: 1, disabled: ctx.ro, placeholder: String(QUERY_LIMIT.default), value: body.limit ?? "", onchange: (e) => ops.edit((b) => { const n = Number(e.target.value); if (e.target.value === "") delete b.limit; else b.limit = Number.isInteger(n) ? n : e.target.value; }) } }, `1 to ${QUERY_LIMIT.max}; ${QUERY_LIMIT.default} when empty. A list fed by it shows no more.`),
    ] } };
}

function sqlTab(ctx) {
    const { api, body, ops } = ctx;
    const used = paramsIn(body.sql ?? "").names;
    const undeclared = used.filter((n) => !Object.hasOwn(body.params ?? {}, n));
    return { div: { children: [
        hint("One SELECT over the query views: one view per object (lot, machine…), its columns the fields of the object (the schema explorer on the Query page lists them). Parameters by name, :family; a value is never pasted into the text. It runs as whoever it is for: their policies decide which rows and fields they get."),
        { CodeEditor: { key: `qsql-${ctx.name}`, mode: "sql", rows: 12, label: `${ctx.name} SQL`, readOnly: ctx.ro, value: () => api.getState(`${ops.root}.sql`, "") ?? "", onInput: (t) => ops.set("sql", t) } },
        used.length ? { p: { className: "muted small", textContent: `Parameters it uses: ${used.map((n) => `:${n}`).join(", ")}.` } } : { span: {} },
        undeclared.length && !ctx.ro() ? { p: { children: [
            { span: { className: "field-error", textContent: `Not declared yet: ${undeclared.map((n) => `:${n}`).join(", ")}. ` } },
            { button: { type: "button", className: "linkish", textContent: "Declare them as text", onclick: () => ops.edit((b) => { b.params = { ...(b.params ?? {}) }; for (const n of undeclared) b.params[n] = { type: "string", label: n.replace(/_/g, " ") }; }) } },
        ] } } : { span: {} },
    ] } };
}

function paramsTab(ctx) {
    const { body, ops, ro } = ctx;
    const params = Object.entries(body.params ?? {});
    const put = (name, key, value) => ops.edit((b) => { const p = b.params[name]; if (value === undefined || value === "" || value === false) delete p[key]; else p[key] = value; });
    return { div: { children: [
        hint("Each :name the SELECT uses, with its type: what is given is checked against it and bound as a parameter. A required one missing runs nothing."),
        params.length ? { table: { className: "grid ed-table", children: [
            { thead: { children: [{ tr: { children: ["Name", "Type", "Label", "Required", ""].map((h) => ({ th: h })) } }] } },
            { tbody: { children: params.map(([name, p]) => ({ tr: { key: name, className: ctx.changedAt(`param:${name}`), children: [
                { td: { children: [{ code: `:${name}` }] } },
                { td: { children: [select(ctx, p.type ?? "string", PARAM_TYPES.map((t) => [t, TYPE_WORDS[t]]), (v) => put(name, "type", v))] } },
                { td: { children: [{ input: { type: "text", disabled: ro, value: p.label ?? "", placeholder: name.replace(/_/g, " "), onchange: (e) => put(name, "label", e.target.value.trim()) } }] } },
                { td: { children: [{ input: { type: "checkbox", disabled: ro, "aria-label": `${name} is required`, checked: Boolean(p.required), onchange: (e) => put(name, "required", e.target.checked) } }] } },
                { td: { children: [ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: confirmRemove(ctx.api, `parameter ${name}`, () => ops.edit((b) => { delete b.params[name]; }) )} }] } },
            ] } })) } },
        ] } } : { p: { className: "muted", textContent: "No parameters: it gives the same rows to everyone who may read them." } },
    ] } };
}

// Try it with values typed in, as you; keep those values as a test the fitness test runs.
function testsTab(ctx) {
    const { api, body, ops, ro, w } = ctx;
    const T = `${w}.qtry.${ctx.name}`;
    const params = Object.entries(body.params ?? {});
    const values = () => api.getState(`${T}.values`, {}) ?? {};
    const run = async () => {
        api.setValue(`${T}.busy`, true);
        api.setValue(`${T}.error`, null);
        try {
            const ran = await api.call("query.named", { sql: body.sql, params: body.params ?? {}, values: values(), limit: body.limit });
            api.setValue(`${T}.result`, { columns: ran.columns, rows: ran.rows.slice(0, SHOWN), total: ran.rows.length, truncated: ran.truncated, ms: ran.ms });
        } catch (error) {
            api.setValue(`${T}.result`, null);
            api.setValue(`${T}.error`, error?.message ?? "It could not run.");
        } finally {
            api.setValue(`${T}.busy`, false);
        }
    };
    const tests = Array.isArray(body.tests) ? body.tests : [];
    return { div: { children: [
        hint("Try it as you: type values for its parameters and run it. What you may read is what you see; a plan's dropdown shows each person what they may read."),
        params.length ? { div: { className: "ed-row", children: params.map(([name, p]) => labelled(p.label ?? name, { input: { type: p.type === "date" ? "date" : p.type === "integer" || p.type === "decimal" ? "number" : "text", value: () => values()[name] ?? "", oninput: (e) => api.setValue(`${T}.values`, { ...values(), [name]: e.target.value }) } }, `${TYPE_WORDS[p.type] ?? p.type}${p.required ? ", required" : ""}`)) } } : { span: {} },
        { div: { className: "ed-row", children: [
            { button: { type: "button", className: "btn", disabled: () => api.getState(`${T}.busy`, false), children: [icon("play"), { span: " Run it" }], onclick: run } },
            ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Keep these values as a test", onclick: () => {
                const name = params.length ? params.map(([n]) => `${n} ${values()[n] ?? ""}`.trim()).join(", ") : "with no values";
                ops.edit((b) => { b.tests = [...(Array.isArray(b.tests) ? b.tests : []), { name, params: { ...values() } }]; });
            } } },
        ] } },
        () => { const e = api.getState(`${T}.error`, null); return e ? { p: { className: "field-error", textContent: e } } : { span: {} }; },
        () => {
            const r = api.getState(`${T}.result`, null);
            if (!r) return { span: {} };
            return { div: { children: [
                { p: { className: "muted small", textContent: `${r.total}${r.truncated ? "+" : ""} row(s) in ${r.ms} ms${r.total > SHOWN ? `; the first ${SHOWN} shown` : ""}. Columns: ${r.columns.join(", ")}.` } },
                { div: { className: "table-scroll", children: [{ table: { className: "grid", children: [
                    { thead: { children: [{ tr: { children: r.columns.map((c) => ({ th: c })) } }] } },
                    { tbody: { children: r.rows.map((row, i) => ({ tr: { key: `r${i}`, children: row.map((v, j) => ({ td: { key: `c${j}`, textContent: v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v) } })) } })) } },
                ] } }] } },
            ] } };
        },
        { h4: "Tests" },
        hint("The fitness test runs each as whoever submits the change: it must run, and give the columns the lists drawn from it name."),
        tests.length ? { table: { className: "grid ed-table", children: [
            { thead: { children: [{ tr: { children: ["Test", "Values", ""].map((h) => ({ th: h })) } }] } },
            { tbody: { children: tests.map((t, i) => ({ tr: { key: `t${i}`, children: [
                { td: t.name },
                { td: { children: [{ code: JSON.stringify(t.params ?? {}) }] } },
                { td: { children: [ro() ? { span: {} } : { button: { type: "button", className: "btn ghost", textContent: "Remove", onclick: confirmRemove(ctx.api, "this test", () => ops.edit((b) => { b.tests.splice(i, 1); if (!b.tests.length) delete b.tests; }) )} }] } },
            ] } })) } },
        ] } } : { p: { className: "muted", textContent: "No tests yet: run it with values that matter and keep them." } },
    ] } };
}

// Where it is used (§23.1): the references whose choices it gives, the screens' tables of its rows, the plans'
// lists; each said, and what of its columns each names that it no longer gives. Align brings those into this
// change, put right where that is plain.
const KIND_WORDS = { object: "Object", transaction: "Transaction", screen: "Screen", flow: "Plan" };
function usesTab(ctx) {
    const { api, w, id, name, ro } = ctx;
    const d = queryColumns(api, w, id, name);
    const cols = d?.columns ?? null;
    const notice = api.getState(`${w}.qalign.${name}`, null);
    const refresh = () => forgetColumns(api, w, name);
    const align = async () => {
        if (api.peek(`${w}.dirty`)) { api.setValue(`${w}.qalign.${name}`, "Save the change first: Align works on what is saved."); return; }
        try {
            const r = await api.call("design.align", { id });
            api.setValue(`${w}.qalign.${name}`, r.brought?.length ? `Brought into this change: ${r.brought.map((b) => `${KIND_WORDS[b.kind] ?? b.kind} ${b.label}`).join(", ")}. Each is in the change's designs now, to finish and approve with it.` : "Nothing to bring: what uses it is in line.");
            refresh();
        } catch (e) { api.setValue(`${w}.qalign.${name}`, e.message); }
    };
    if (d === null) return { p: { className: "muted", textContent: "Reading its columns and where it is used…" } };
    const uses = d.usedBy ?? [];
    const broken = (u) => (cols ? u.columns.filter((c) => c && !cols.includes(c)) : []);
    const anyBroken = uses.some((u) => !u.inChange && broken(u).length);
    return { div: { children: [
        hint("What it gives (its columns, as the database describes it without running it), and every design that names them. Change a column, and each design that shows it is named here and in the change's problems."),
        { div: { className: "ed-row", children: [
            labelled("Its columns", cols ? { div: { className: "chips", children: cols.map((c) => ({ code: { key: c, className: "chip", textContent: c } })) } } : { span: { className: "small field-error", textContent: d.problem ?? "Not known." } }),
            { button: { type: "button", className: "btn ghost", textContent: "Read again", onclick: refresh, title: "After saving a change to its text" } },
        ] } },
        uses.length ? { table: { className: "grid", children: [
            { thead: { children: [{ tr: { children: ["Used by", "Where", "Names", ""].map((h) => ({ th: h })) } }] } },
            { tbody: { children: uses.map((u, k) => ({ tr: { key: `${u.kind}-${u.name}-${k}`, children: [
                { td: { children: [{ span: `${KIND_WORDS[u.kind] ?? u.kind} ` }, { strong: u.label }, { span: { className: "muted small", textContent: ` (${u.name})` } }] } },
                { td: { textContent: u.at } },
                { td: { className: "mono small", textContent: u.columns.filter(Boolean).join(", ") || "—" } },
                { td: { children: [broken(u).length
                    ? { span: { className: "small field-error", textContent: `No longer given: ${broken(u).join(", ")}${u.inChange ? " (in this change: put it right there)" : ""}` } }
                    : { span: { className: "muted small", textContent: u.inChange ? "in this change" : "in line" } }] } },
            ] } })) } },
        ] } } : { p: { className: "muted", textContent: "Nothing uses it yet: a reference's choices, a screen's table and a plan's list may." } },
        anyBroken && !ro() ? { div: { className: "ed-row", children: [
            { button: { type: "button", className: "btn primary", textContent: "Align", onclick: align, title: "Bring every design it would break into this change, without what it no longer gives" } },
            { span: { className: "muted small", textContent: "Brings the designs it would break into this change, each without the columns it no longer gives; the rest the checks say." } },
        ] } } : { span: {} },
        notice ? { p: { className: "small notice", role: "status", textContent: notice } } : { span: {} },
    ] } };
}

// Published over HTTP (§23.3, docs/contracts/http-apis): an outside system (a BI tool, an ERP) reads a page of its rows
// with GET /svc/v1/<name>, its parameters in the address, as its token's person, who must be named here. Inside the
// platform it is a question, not a permission; over the web, the plant names who may ask.
function webTab(ctx) {
    const { api, body, ops, ro, name } = ctx;
    const home = api.peek("design.home") ?? {};
    const callers = body.http?.callers ?? {};
    const setCallers = (kind, next) => ops.edit((b) => { b.http = { ...(b.http ?? {}), callers: { ...(b.http?.callers ?? {}), [kind]: next } }; if (!next.length) delete b.http.callers[kind]; });
    const example = Object.keys(body.params ?? {}).map((p) => `${p}=…`).join("&");
    return { div: { children: [
        hint(`An outside system reads a page of its rows over HTTP with a token (scope query:run), as the token's person: what their policies let them read, at most ${body.limit ?? QUERY_LIMIT.default} rows a page, the next page from the answer's next. It changes nothing.`),
        { div: { className: "ed-web", children: [
            labelled("Published over HTTP", check(ctx, "http.enabled", `outside systems read it: GET /svc/v1/${name}${example ? `?${example}` : ""}`), "Its name is its address: no web service or transaction published over HTTP may have it too."),
        ] } },
        ...(body.http?.enabled ? [
            { h4: "Who may read it over HTTP" },
            hint("Nobody until named: the person a token stands for (an integration user), or a group they are in."),
            { h4: "Groups" },
            { div: { className: "checks", children: (home.groups ?? []).map((g) => ({ label: { key: g.id, children: [{ input: { type: "checkbox", disabled: ro, checked: (callers.groups ?? []).includes(g.id), onchange: (e) => setCallers("groups", toggleIn(callers.groups, g.id, e.target.checked)) } }, { span: ` ${g.name}` }] } })) } },
            { h4: "Users" },
            pickMany({ key: `qy-callers-${name}`, options: (home.users ?? []).map((u) => ({ value: u.id, label: u.name, hint: u.id })), value: callers.users ?? [], readOnly: ro, placeholder: "Add a person…", onChange: (next) => setCallers("users", next) }),
        ] : []),
        ...(body.http?.enabled || body.deprecated ? [{ div: { className: "ed-web", children: [deprecation(ctx)] } }] : []),
    ] } };
}

function stewardsTab(ctx) {
    const depts = ctx.api.peek("design.home.departments") ?? [];
    return { div: { children: [
        hint("Its stewards approve every change to it. A query writes nothing and grants nothing: it reads as whoever it runs for."),
        { div: { className: "checks", children: depts.map((d) => ({ label: { key: d.id, children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: (ctx.body.stewards ?? []).includes(d.id), onchange: (e) => ctx.ops.edit((b) => { b.stewards = toggleIn(b.stewards, d.id, e.target.checked); }) } }, { span: ` ${d.name}` }] } })) } },
    ] } };
}

export function registerQueryEditor(juris) {
    juris.registerComponent("QueryEditor", ({ id, editable, pane = 0, name, head }, api) => {
        const w = W(id);
        const ops = elementOps(api, id, "query", name);
        const view = () => { const v = api.getState(`${w}.panes.${pane}.view`, "general"); return QUERY_VIEWS.some(([k]) => k === v) ? v : "general"; };
        const ro = () => !api.prop(editable);
        return {
            div: {
                className: "editor",
                children: [
                    { div: { className: "editor-head", children: [
                        head ?? { span: {} },
                        { nav: { className: "subtabs", children: QUERY_VIEWS.map(([key, label, glyph]) => ({ button: { key, type: "button", className: "subtab", classList: { active: () => view() === key }, onclick: () => api.setValue(`${w}.panes.${pane}.view`, key), children: [glyph ? icon(glyph) : { span: {} }, { span: label }, () => {
                            api.getState(`${w}.vrev`);
                            api.getState(`dc.${id}.updated_at`);
                            const all = changesOf(api, id, "query", name);
                            const n = key === "changes" ? all.length : countByTab(all)[key] ?? 0;
                            return n ? { span: { className: "tab-diff", title: `${n} change(s) from the published version`, textContent: String(n) } } : { span: {} };
                        }] } })) } },
                    ] } },
                    () => {
                        api.getState(`${w}.rev`);
                        const body = api.peek(ops.root);
                        if (!body) return { p: { className: "muted", textContent: "Loading…" } };
                        const changed = new Set(changesOf(api, id, "query", name).map((c) => `${c.element}:${c.change}`));
                        const changedAt = (el) => (changed.has(`${el}:added`) ? "diff-added" : changed.has(`${el}:changed`) ? "diff-changed" : "");
                        const ctx = { api, w, ops, ro, body, id, kind: "query", name, root: ops.root, changedAt };
                        switch (view()) {
                            case "copilot": return { CopilotPanel: { key: `copilot-${id}`, id } };
                            case "changes": return { ChangesView: { key: `changes-qy-${name}`, id, kind: "query", name, onOpen: (tab) => api.setValue(`${w}.panes.${pane}.view`, tab) } };
                            case "sql": return sqlTab(ctx);
                            case "params": return paramsTab(ctx);
                            case "tests": return testsTab(ctx);
                            case "uses": return usesTab(ctx);
                            case "web": return webTab(ctx);
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
