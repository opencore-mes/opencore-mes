// The expression builder (DESIGN.md §9.2a): conditions built from what a place may read, never typed as JSON.
// An expression (client/expr.js) is shown in words; Edit opens it as rows (a field, an operator, a value) in
// groups (all of, any of, none of), started blank or from a pattern; JSON is one click away for the rest.
// It edits the expression itself, in place: a part nobody touched stays as it was stored, so the builder and
// the JSON always agree, and what is saved is what the server reads.
//
//   exprField({ key, value: () => expr, onChange(expr | undefined), spec, readOnly, empty, emptyHint })   a layout
//     (emptyHint: said below only while there is no condition: what none means here)
//   spec = { scopes: { record: { label, entries: [{ path, label, type, values? }] }, user: { … } }, count?: [objects] }
//
// The pure parts (wordsOf, problemsOf, rowOf, nodeOfRow, PATTERNS) are exported for the tests and the
// change view; the browser floor holds (no lookbehind, structuredClone, findLast).
import { explain, referencesOf } from "./expr.js";
import { noDefault } from "./select.js";
import { icon } from "./icons.js";
import { tagsInput } from "./pick.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SCOPES = ["record", "user", "data", "event", "input", "lookup", "param", "row", "node", "context", "person"];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const refOf = (n) => { if (!isPlain(n)) return null; const k = Object.keys(n); return k.length === 1 && SCOPES.includes(k[0]) && typeof n[k[0]] === "string" ? { scope: k[0], path: n[k[0]] } : null; };
const opOf = (n) => (isPlain(n) && Object.keys(n).length === 1 ? Object.keys(n)[0] : null);

// ---- what a place may read ----
// A field of an object as an entry: its path (with a prefix: "lot."), words and type.
const typeOf = (f) => (f?.multiple ? "list" : f?.type ?? "string");
export function objectEntries(def, { prefix = "", label = "" } = {}) {
    if (!def) return [];
    const head = label ? `${label} · ` : "";
    return [
        { path: `${prefix}state`, label: `${head}state`, type: "enum", values: Array.isArray(def.states) ? def.states : def.states?.list ?? [] },
        { path: `${prefix}id`, label: `${head}the record itself`, type: "ref" },
        ...Object.entries(def.fields ?? {}).map(([name, f]) => ({ path: `${prefix}${name}`, label: `${head}${f?.label ?? name}`, type: typeOf(f), ...(Array.isArray(f?.values) ? { values: f.values } : {}) })),
    ];
}
export const scope = (label, entries) => ({ label, entries: entries.filter(Boolean) });
export const userScope = (roles) => scope("the person", [{ path: "id", label: "the person (sign-in id)", type: "string" }, ...(roles ? [{ path: "roles", label: "their roles", type: "list", values: roles }] : [])]);
// A value kept in a flow's context, by what it holds now (its type is a guess from its first value).
export const valueEntry = (name, value, label) => ({ path: name, label: label ?? name.replace(/_/g, " "), type: typeof value === "number" ? "decimal" : typeof value === "boolean" ? "boolean" : "string" });

const entriesOf = (spec) => Object.entries(spec?.scopes ?? {}).flatMap(([sc, s]) => (s.entries ?? []).map((e) => ({ ...e, scope: sc, scopeLabel: s.label ?? sc })));
const entryOf = (spec, ref) => (ref ? entriesOf(spec).find((e) => e.scope === ref.scope && e.path === ref.path) : null);

// ---- in words ----
const LITERAL = (v) => (v === null ? "empty" : typeof v === "string" ? `"${v}"` : Array.isArray(v) ? v.map(LITERAL).join(", ") : String(v));
const OP_WORDS = { eq: "is", ne: "is not", lt: "is less than", le: "is at most", gt: "is more than", ge: "is at least" };
export function wordsOf(node, spec = {}) {
    const ref = refOf(node);
    if (ref) return entryOf(spec, ref)?.label ?? `${ref.scope} ${ref.path}`;
    if (!isPlain(node)) return LITERAL(node);
    const op = opOf(node);
    const a = node[op];
    const w = (x) => { const t = wordsOf(x, spec); return opOf(x) === "all" || opOf(x) === "any" ? `(${t})` : t; };
    if (OP_WORDS[op] && Array.isArray(a)) return `${w(a[0])} ${OP_WORDS[op]} ${w(a[1])}`;
    if (op === "in" && Array.isArray(a)) return `${w(a[0])} is one of ${Array.isArray(a[1]) ? a[1].map(LITERAL).join(", ") : w(a[1])}`;
    if (op === "contains" && Array.isArray(a)) return `${w(a[0])} include ${w(a[1])}`;
    if (op === "is_null") return `${w(a)} is empty`;
    if (op === "not") return opOf(a) === "is_null" ? `${w(a.is_null)} is not empty` : opOf(a) === "any" && Array.isArray(a.any) ? `none of (${a.any.map(w).join("; ")})` : `not (${wordsOf(a, spec)})`;
    if ((op === "all" || op === "any") && Array.isArray(a)) return a.length ? a.map(w).join(op === "all" ? " and " : " or ") : op === "all" ? "always" : "never";
    if (["add", "sub", "mul", "div"].includes(op) && Array.isArray(a)) return a.map(w).join({ add: " + ", sub: " − ", mul: " × ", div: " ÷ " }[op]);
    if (op === "count" && isPlain(a)) {
        const where = Object.entries(isPlain(a.where) ? a.where : {}).map(([f, v]) => `${f} ${Array.isArray(v) ? `is one of ${v.map(LITERAL).join(", ")}` : `is ${wordsOf(v, spec)}`}`);
        return `the number of ${a.object ?? "?"} records${where.length ? ` where ${where.join(" and ")}` : ""}`;
    }
    if ((op === "some" || op === "every") && Array.isArray(a)) return `${op === "some" ? "some" : "every"} row of ${w(a[0])} has ${wordsOf(a[1], spec)}`;
    return JSON.stringify(node);
}

// ---- what is wrong with it, here ----
export function problemsOf(node, spec = {}) {
    if (node === undefined) return [];
    const out = [];
    try { explain(node, {}); } catch (error) { return [`It does not read as an expression: ${error.message}.`]; }
    const scopes = spec.scopes ?? {};
    for (const r of referencesOf(node)) {
        if (!Object.hasOwn(scopes, r.scope)) { out.push(`It reads ${r.scope} (${r.path}), which ${Object.keys(scopes).length ? `this place cannot read: it reads ${Object.keys(scopes).join(", ")}` : "nothing here reads"}.`); continue; }
        const entries = scopes[r.scope].entries ?? [];
        const path = String(r.path);
        if (entries.length && !entries.some((e) => e.path === path || path.startsWith(`${e.path}.`) || e.path.startsWith(`${path}.`))) out.push(`${scopes[r.scope].label ?? r.scope} has no "${path}".`);
    }
    return [...new Set(out)];
}

// ---- a row: one thing, an operator, a value ----
// The operators a row offers, by the type of what it reads.
export const ROW_OPS = { eq: "is", ne: "is not", lt: "<", le: "≤", gt: ">", ge: "≥", in: "is one of", contains: "include", is_null: "is empty", not_null: "is not empty" };
export function opsFor(type) {
    if (type === "list") return ["contains", "is_null", "not_null"];
    if (type === "boolean") return ["eq", "ne", "is_null", "not_null"];
    if (type === "integer" || type === "decimal" || type === "date") return ["eq", "ne", "lt", "le", "gt", "ge", "in", "is_null", "not_null"];
    return ["eq", "ne", "in", "is_null", "not_null"];
}
// A node as a row ({ op, left: ref, right }), or null when it is more than a row (it keeps its JSON).
export function rowOf(node) {
    const op = opOf(node);
    if (!op) return null;
    const a = node[op];
    if (["eq", "ne", "lt", "le", "gt", "ge"].includes(op) && Array.isArray(a) && a.length === 2 && refOf(a[0]) && (refOf(a[1]) || !isPlain(a[1]) && !Array.isArray(a[1]))) return { op, left: a[0], right: a[1] };
    if (op === "in" && Array.isArray(a) && a.length === 2 && refOf(a[0]) && Array.isArray(a[1]) && a[1].every((v) => !isPlain(v) && !Array.isArray(v))) return { op, left: a[0], right: a[1] };
    if (op === "contains" && Array.isArray(a) && a.length === 2 && refOf(a[0]) && !isPlain(a[1]) && !Array.isArray(a[1])) return { op, left: a[0], right: a[1] };
    if (op === "is_null" && refOf(a)) return { op, left: a };
    if (op === "not" && opOf(a) === "is_null" && refOf(a.is_null)) return { op: "not_null", left: a.is_null };
    return null;
}
export function nodeOfRow({ op, left, right }) {
    if (op === "is_null") return { is_null: left };
    if (op === "not_null") return { not: { is_null: left } };
    if (op === "in") return { in: [left, Array.isArray(right) ? right : right === undefined || right === null ? [] : [right]] };
    return { [op]: [left, right === undefined ? null : right] };
}
// A value fit for a type: what a new row, or a changed one, starts with.
export const blankFor = (e) => (e?.type === "enum" || e?.type === "list" ? e.values?.[0] ?? "" : e?.type === "integer" || e?.type === "decimal" ? 0 : e?.type === "boolean" ? true : "");
const refNode = (e) => ({ [e.scope]: e.path });
export function newRow(spec) {
    const e = entriesOf(spec).find((x) => x.type !== "ref") ?? entriesOf(spec)[0];
    if (!e) return { eq: [null, null] };
    return e.type === "list" ? { contains: [refNode(e), blankFor(e)] } : { eq: [refNode(e), blankFor(e)] };
}

// ---- patterns: a condition to start from, filled in with what the place reads ----
export const PATTERNS = [
    { id: "state", label: "is in state…", make: (es) => { const e = es.find((x) => /(^|\.)state$/.test(x.path) && x.values?.length); return e && { in: [refNode(e), [e.values[0]]] }; } },
    { id: "one_of", label: "is one of…", make: (es) => { const e = es.find((x) => x.type === "enum" && x.values?.length); return e && { in: [refNode(e), [e.values[0]]] }; } },
    { id: "empty", label: "is empty", make: (es) => { const e = es.find((x) => x.type !== "ref"); return e && { is_null: refNode(e) }; } },
    { id: "not_empty", label: "is not empty", make: (es) => { const e = es.find((x) => x.type !== "ref"); return e && { not: { is_null: refNode(e) } }; } },
    { id: "between", label: "is between … and …", make: (es) => { const e = es.find((x) => x.type === "integer" || x.type === "decimal" || x.type === "date"); return e && { all: [{ ge: [refNode(e), blankFor(e)] }, { le: [refNode(e), e.type === "date" ? "" : 10] }] }; } },
    // Two of a kind: the same type, and for a choice the same choices (a state is not compared with a severity).
    { id: "same", label: "is the same as another…", make: (es) => { for (const a of es) { const b = es.find((x) => x !== a && x.type === a.type && x.type !== "list" && (x.type !== "enum" || JSON.stringify(x.values ?? []) === JSON.stringify(a.values ?? []))); if (b) return { eq: [refNode(a), refNode(b)] }; } return null; } },
    { id: "role", label: "the person has the role…", make: (es) => { const e = es.find((x) => x.scope === "user" && x.path === "roles"); return e && { contains: [refNode(e), e.values?.[0] ?? ""] }; } },
    { id: "count", label: "how many records … where …", make: (es, spec) => (spec.count?.length ? { gt: [{ count: { object: spec.count[0], where: {} } }, 0] } : null) },
];
export const patternsFor = (spec) => PATTERNS.map((p) => ({ ...p, node: p.make(entriesOf(spec), spec) })).filter((p) => p.node);

// ---- the component ----
const at = (root, path) => path.reduce((n, k) => (n === undefined || n === null ? undefined : n[k]), root);
function setAt(root, path, value) {
    if (!path.length) return value;
    const copy = clone(root);
    const parent = at(copy, path.slice(0, -1));
    if (value === undefined && Array.isArray(parent)) parent.splice(path[path.length - 1], 1);
    else parent[path[path.length - 1]] = value;
    return copy;
}
const parseLoose = (text, type) => {
    const t = String(text ?? "");
    if (type === "integer" || type === "decimal") { const n = Number(t); return t.trim() === "" || !Number.isFinite(n) ? null : n; }
    return t;
};

export function registerExprBuilder(juris) {
    juris.registerComponent("ExprField", ({ key: k, value, onChange, spec = {}, readOnly, empty = "always", emptyHint = null }, api) => {
        const S = `exprb.${String(k).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const ro = () => Boolean(typeof readOnly === "function" ? readOnly() : readOnly);
        const get = () => (typeof value === "function" ? value() : value);
        const entries = entriesOf(spec);
        const put = (next) => { onChange(next); api.setValue(`${S}.rev`, (api.peek(`${S}.rev`) ?? 0) + 1); };
        // A group left with one condition at the top is that condition again ("all of: x" reads as x).
        const edit = (path, next) => { let root = setAt(get(), path, next); const op = opOf(root); if (next === undefined && (op === "all" || op === "any") && Array.isArray(root[op]) && root[op].length === 1) root = root[op][0]; put(root); };
        const mode = () => api.getState(`${S}.mode`, null);
        const thingOptions = (ref) => {
            const opts = entries.map((e) => [`${e.scope}|${e.path}`, `${e.scopeLabel}: ${e.label}`]);
            if (ref && !entries.some((e) => e.scope === ref.scope && e.path === ref.path)) opts.unshift([`${ref.scope}|${ref.path}`, `${ref.scope} ${ref.path} (not in this place's list)`]);
            return opts;
        };
        const sel = (current, options, onchange, extra = {}) => ({ select: { disabled: ro, onchange: (e) => onchange(e.target.value), ...extra, children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: v === current, textContent: l } }))) } });

        // The value side of a row: a value of its type, or another field.
        function valueControl(row, path, e) {
            const asField = refOf(row.right);
            const toggle = row.op === "in" || row.op === "contains" ? { span: {} } : sel(asField ? "field" : "value", [["value", "a value"], ["field", "a field"]], (v) => edit(path, nodeOfRow({ ...row, right: v === "field" ? refNode(entries.find((x) => x !== e && x.type === e?.type) ?? entries[0]) : blankFor(e) })), { className: "expr-kind", title: "Compare with a value, or with another field" });
            if (asField) return [toggle, sel(`${asField.scope}|${asField.path}`, thingOptions(asField), (v) => { const [sc, p] = v.split("|"); edit(path, nodeOfRow({ ...row, right: { [sc]: p } })); })];
            if (row.op === "in") {
                const list = Array.isArray(row.right) ? row.right : [];
                if (e?.values?.length) return [{ div: { className: "expr-chips", children: e.values.map((v) => ({ label: { key: String(v), className: "small", children: [{ input: { type: "checkbox", disabled: ro, checked: list.includes(v), onchange: (ev) => edit(path, nodeOfRow({ ...row, right: ev.target.checked ? [...list, v] : list.filter((x) => x !== v) })) } }, { span: ` ${v}` }] } })) } }];
                return [tagsInput({ key: `${S}.in.${path.join(".")}`, readOnly: ro, placeholder: "Add a value…", value: list, create: (x) => parseLoose(x, e?.type), onChange: (next) => edit(path, nodeOfRow({ ...row, right: next })) })];
            }
            const v = row.right;
            if ((e?.type === "enum" || e?.type === "list") && e.values?.length) return [toggle, sel(String(v ?? ""), e.values.map((x) => [String(x), String(x)]), (x) => edit(path, nodeOfRow({ ...row, right: x })))];
            if (e?.type === "boolean") return [toggle, sel(String(v), [["true", "yes"], ["false", "no"]], (x) => edit(path, nodeOfRow({ ...row, right: x === "true" })))];
            return [toggle, { input: { type: e?.type === "integer" || e?.type === "decimal" ? "number" : e?.type === "date" ? "date" : "text", step: e?.type === "decimal" ? "any" : undefined, disabled: ro, value: v === null || v === undefined ? "" : String(v), onchange: (ev) => edit(path, nodeOfRow({ ...row, right: parseLoose(ev.target.value, e?.type) })) } }];
        }
        function rowView(node, path, removable) {
            const row = rowOf(node);
            const remove = ro() || !removable ? { span: {} } : { button: { type: "button", className: "mini", title: "Remove", "aria-label": "Remove this condition", children: [icon("x")], onclick: () => edit(path, undefined) } };
            if (!row) return { div: { className: "expr-row expr-raw", children: [rawInput(node, path), remove] } };
            const left = refOf(row.left);
            const e = entryOf(spec, left);
            const ops = [...new Set([...opsFor(e?.type), row.op])];
            return { div: { className: "expr-row", children: [
                sel(`${left.scope}|${left.path}`, thingOptions(left), (v) => { const [sc, p] = v.split("|"); const ne = entries.find((x) => x.scope === sc && x.path === p); const op = opsFor(ne?.type).includes(row.op) ? row.op : opsFor(ne?.type)[0]; edit(path, nodeOfRow({ op, left: { [sc]: p }, right: op === "in" ? [] : blankFor(ne) })); }, { className: "expr-thing" }),
                sel(row.op, ops.map((o) => [o, ROW_OPS[o]]), (op) => edit(path, nodeOfRow({ ...row, op, right: op === "in" ? (row.right === undefined || row.right === null || refOf(row.right) ? [] : [row.right]) : Array.isArray(row.right) ? row.right[0] ?? blankFor(e) : row.right ?? blankFor(e) })), { className: "expr-op" }),
                ...(row.op === "is_null" || row.op === "not_null" ? [] : valueControl(row, path, e)),
                remove,
            ] } };
        }
        // More than a row (a count, every row of a table, arithmetic): its JSON, kept as typed until it reads.
        function rawInput(node, path) {
            const draft = `${S}.raw.${path.join(".")}`;
            const text = () => api.getState(draft, null) ?? JSON.stringify(node);
            return { div: { className: "expr-raw-box", children: [
                { span: { className: "muted small", textContent: wordsOf(node, spec) } },
                { input: { type: "text", className: "mono", disabled: ro, value: text, spellcheck: false, oninput: (ev) => { api.setValue(draft, ev.target.value); try { const v = JSON.parse(ev.target.value); explain(v, {}); edit(path, v); } catch { /* kept as typed until it reads */ } } } },
            ] } };
        }
        function groupView(node, path, depth) {
            const none = opOf(node) === "not";
            const op = none ? "none" : opOf(node);
            const list = none ? node.not.any : node[op];
            const listPath = none ? [...path, "not", "any"] : [...path, op];
            const regroup = (to) => { const items = clone(list); edit(path, to === "none" ? { not: { any: items } } : { [to]: items }); };
            const add = (n) => edit([...listPath, list.length], n);
            return { div: { className: `expr-group depth-${Math.min(depth, 3)}`, children: [
                { div: { className: "expr-group-head", children: [
                    sel(op, [["all", "all of these"], ["any", "any of these"], ["none", "none of these"]], regroup, { className: "expr-op" }),
                    ro() || !path.length ? { span: {} } : { button: { type: "button", className: "mini", title: "Remove the group", "aria-label": "Remove the group", children: [icon("x")], onclick: () => edit(path, undefined) } },
                ] } },
                ...list.map((child, i) => ({ div: { key: `c${i}`, children: [nodeView(child, [...listPath, i], depth + 1, true)] } })),
                ro() ? { span: {} } : addBar(add),
            ] } };
        }
        function nodeView(node, path, depth, removable) {
            const op = opOf(node);
            if (op === "all" || op === "any" || (op === "not" && opOf(node.not) === "any" && Array.isArray(node.not.any))) return Array.isArray(op === "not" ? node.not.any : node[op]) ? groupView(node, path, depth) : rowView(node, path, removable);
            return rowView(node, path, removable);
        }
        function addBar(add) {
            const patterns = patternsFor(spec);
            return { div: { className: "expr-add", children: [
                { button: { type: "button", className: "linkish small", textContent: "+ condition", onclick: () => add(newRow(spec)) } },
                { button: { type: "button", className: "linkish small", textContent: "+ group", onclick: () => add({ any: [newRow(spec)] }) } },
                patterns.length ? sel("", [["", "+ from a pattern…"], ...patterns.map((p) => [p.id, p.label])], (id) => { const p = patterns.find((x) => x.id === id); if (p) add(clone(p.node)); }, { className: "expr-pattern", title: "Start from a common condition, filled in with what this place reads" }) : { span: {} },
            ] } };
        }
        // Tried on values typed in: true or false, and why (expr.js explain).
        function tryView() {
            const node = get();
            const refs = [...new Map(referencesOf(node).map((r) => [`${r.scope}.${r.path}`, r])).values()];
            const T = `${S}.try`;
            const scopes = {};
            for (const r of refs) {
                const typed = api.getState(`${T}.${r.scope}__${String(r.path).replace(/\./g, "__")}`, "");
                let v = typed;
                try { v = typed === "" ? null : JSON.parse(typed); } catch { v = typed; }
                let o = (scopes[r.scope] ??= {});
                const parts = String(r.path).split(".");
                parts.forEach((p, i) => { if (i === parts.length - 1) o[p] = v; else o = (o[p] = isPlain(o[p]) ? o[p] : {}); });
            }
            let result;
            try { result = explain(node, scopes); } catch (error) { result = { value: null, text: error.message }; }
            return { div: { className: "expr-try", children: [
                { p: { className: "muted small", textContent: "Try it: type what each reads (a number, true, \"text\" or plain text), and see what it gives." } },
                { div: { className: "expr-try-grid", children: refs.map((r) => ({ label: { key: `${r.scope}.${r.path}`, className: "ed-field", children: [{ span: entryOf(spec, r)?.label ?? `${r.scope} ${r.path}` }, { input: { type: "text", value: () => api.getState(`${T}.${r.scope}__${String(r.path).replace(/\./g, "__")}`, ""), oninput: (ev) => api.setValue(`${T}.${r.scope}__${String(r.path).replace(/\./g, "__")}`, ev.target.value) } }] } })) } },
                { p: { className: result.value === true ? "notice small" : "muted small", textContent: `${result.value === true ? "Holds" : result.value === false ? "Does not hold" : `Gives ${JSON.stringify(result.value ?? null)}`}: ${result.text}` } },
            ] } };
        }
        return {
            div: {
                className: "expr-field",
                children: [
                    () => {
                        api.getState(`${S}.rev`);
                        const node = get();
                        const problems = problemsOf(node, spec);
                        return { div: { className: "expr-head", children: [
                            // The condition drawn as a rule, not as words beside the field: a box with its words,
                            // opened for editing by a click. None: what none means, in a dashed box.
                            node === undefined
                                ? { span: { className: "expr-rule empty", textContent: empty } }
                                : ro()
                                    ? { div: { className: "expr-rule", children: [icon("branch"), { span: { className: "expr-words", textContent: wordsOf(node, spec) } }] } }
                                    : { button: { type: "button", className: `expr-rule${mode() === "build" ? " open" : ""}`, title: "Edit the condition", "aria-expanded": mode() === "build" ? "true" : "false", onclick: () => api.setValue(`${S}.mode`, mode() === "build" ? null : "build"), children: [icon("branch"), { span: { className: "expr-words", textContent: wordsOf(node, spec) } }] } },
                            { span: { className: "spacer" } },
                            { button: { type: "button", className: "linkish small", textContent: () => (mode() === "build" ? "Done" : ro() ? "Show" : node === undefined ? "Add a condition" : "Edit"), onclick: () => api.setValue(`${S}.mode`, mode() === "build" ? null : "build") } },
                            { button: { type: "button", className: "linkish small", textContent: () => (mode() === "json" ? "Done" : "JSON"), title: "The same, as JSON", onclick: () => { api.setValue(`${S}.jsonText`, null); api.setValue(`${S}.mode`, mode() === "json" ? null : "json"); } } },
                            node === undefined ? { span: {} } : { button: { type: "button", className: "linkish small", textContent: () => (mode() === "try" ? "Done" : "Try"), onclick: () => api.setValue(`${S}.mode`, mode() === "try" ? null : "try") } },
                            ...problems.map((m, i) => ({ p: { key: `p${i}`, className: "field-error expr-problem", textContent: m } })),
                            node === undefined && emptyHint ? { p: { className: "muted small expr-problem", textContent: emptyHint } } : { span: {} },
                        ] } };
                    },
                    () => {
                        api.getState(`${S}.rev`);
                        const m = mode();
                        const node = get();
                        if (m === "json") {
                            const text = () => api.getState(`${S}.jsonText`, null) ?? (node === undefined ? "" : JSON.stringify(node, null, 2));
                            return { div: { className: "expr-json", children: [
                                { textarea: { className: "mono", rows: 4, disabled: ro, spellcheck: false, value: text, oninput: (ev) => {
                                    api.setValue(`${S}.jsonText`, ev.target.value);
                                    if (!ev.target.value.trim()) { onChange(undefined); return; }
                                    try { const v = JSON.parse(ev.target.value); explain(v, {}); onChange(v); } catch { /* kept as typed until it reads */ }
                                } } },
                                { p: { className: "muted small", textContent: "Applied as soon as it reads; empty means none." } },
                            ] } };
                        }
                        if (m === "try") return tryView();
                        if (m !== "build") return { span: {} };
                        if (node === undefined) return ro() ? { p: { className: "muted small", textContent: empty } } : { div: { className: "expr-builder", children: [addBar((n) => put(n))] } };
                        const op = opOf(node);
                        const grouped = (op === "all" || op === "any") && Array.isArray(node[op]) || (op === "not" && opOf(node.not) === "any");
                        return { div: { className: "expr-builder", children: [
                            nodeView(node, [], 0, true),
                            // A single condition: one more makes them a group, all of them.
                            grouped || ro() ? { span: {} } : addBar((n) => put({ all: [node, n] })),
                        ] } };
                    },
                ],
            },
        };
    });
}

// The layout that draws one (a component per field; `key` keeps its state apart from others').
export const exprField = (props) => ({ ExprField: { ...props, key: props.key } });
