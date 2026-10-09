// Rows from a named query, as a design names them (DESIGN.md §23.1): a reference's choices (an object's field, a
// transaction's input) or a screen table's rows. Which query, which of its columns are shown, and each of its
// parameters bound to an expression over what that place may read. The query's columns are the server's
// description of it (design.queryColumns: the change's draft of it, or the live one), read once a query and a
// change; the checks say what a design names that the query does not give.
import { labelled } from "./editor-kit.js";
import { noDefault } from "./select.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The named queries there will be: live (the designer's home) and the change's drafts, each with its label and
// parameters (and its text, a draft's).
export function queriesKnown(api, w) {
    const home = api.peek("design.home") ?? {};
    if (!Array.isArray(home.queries)) return undefined;
    return Object.fromEntries([...home.queries.map((q) => [q.name, { label: q.label, params: q.params ?? {} }]), ...Object.entries(api.peek(`${w}.qy`) ?? {}).filter(([, b]) => b)]);
}

// A query's columns as the server describes it: null until read, [] when it gives none, or { problem }.
export function queryColumns(api, w, id, query) {
    if (!query) return null;
    const path = `${w}.qcols.${query}`;
    const have = api.getState(path, undefined);
    if (have === undefined && !api.isServer) {
        api.setValue(path, null);
        api.call("design.queryColumns", { id: id ?? null, query }).then(
            (r) => api.setValue(path, r.columns ? { columns: r.columns, usedBy: r.usedBy ?? [] } : { problem: r.problem ?? "It does not run yet.", usedBy: r.usedBy ?? [] }),
            (e) => api.setValue(path, { problem: e.message }),
        );
    }
    return have ?? null;
}
// Read again (a query's text changed in this change): the next draw asks the server.
export const forgetColumns = (api, w, query) => api.setValue(`${w}.qcols.${query}`, undefined);

// The editor. `kind`: "choices" (a reference's: none means every record of its object) or "table" (a screen's
// rows: its columns, all when none are picked). `scopes`: what its parameters may read, said under them.
export function querySourceEditor(api, { w, id, key, readOnly = false, value = null, onChange, kind = "choices", scopes = "", noun = "record" }) {
    const queries = queriesKnown(api, w) ?? {};
    const src = isPlain(value) ? value : null;
    const q = src?.query ?? "";
    const declared = Object.entries(queries[q]?.params ?? {});
    const cols = queryColumns(api, w, id, q);
    const shownKey = kind === "table" ? "columns" : "display";
    const picked = Array.isArray(src?.[shownKey]) ? src[shownKey] : [];
    const set = (patch) => onChange({ ...(src ?? {}), ...patch });
    const toggle = (c, on) => {
        const order = cols?.columns ?? [];
        const next = on ? [...new Set([...picked, c])].sort((a, b) => order.indexOf(a) - order.indexOf(b)) : picked.filter((x) => x !== c);
        set({ [shownKey]: next.length ? next : undefined });
    };
    const expr = (p, spec) => {
        const errKey = `${key}.err.${p}`;
        const current = src?.params?.[p];
        return labelled(`${spec.label ?? p}${spec.required ? " *" : ""}`, { div: { children: [
            { input: { type: "text", className: "mono", disabled: readOnly, value: () => api.getState(`${key}.text.${p}`, null) ?? (current === undefined ? "" : JSON.stringify(current)),
                placeholder: kind === "table" ? '"created", or {"param": "machine"}' : '"press", or {"data": "area"}',
                oninput: (e) => api.setValue(`${key}.text.${p}`, e.target.value),
                onchange: (e) => {
                    const t = e.target.value.trim();
                    if (!t) { api.batch(() => { api.setValue(errKey, null); api.setValue(`${key}.text.${p}`, null); }); const { [p]: _, ...rest } = src?.params ?? {}; set({ params: Object.keys(rest).length ? rest : undefined }); return; }
                    let v;
                    try { v = JSON.parse(t); } catch { api.setValue(errKey, "Not JSON: a value (\"press\", 3) or an expression ({\"data\": \"area\"})."); return; }
                    api.batch(() => { api.setValue(errKey, null); api.setValue(`${key}.text.${p}`, null); });
                    set({ params: { ...(src?.params ?? {}), [p]: v } });
                } } },
            { div: { className: "small field-error", hidden: () => !api.getState(errKey, null), textContent: () => api.getState(errKey, "") ?? "" } },
        ] } }, spec.type ? `A ${spec.type}.` : undefined);
    };
    return { div: { className: "query-source", children: [
        labelled(kind === "table" ? "Rows from the query" : "Choices from a query", { select: { disabled: readOnly, onchange: (e) => {
            const v = e.target.value;
            if (!v) return onChange(undefined);
            onChange({ query: v, ...(kind === "table" && src?.columns ? {} : {}), params: Object.fromEntries(Object.keys(queries[v]?.params ?? {}).filter((p) => src?.params?.[p] !== undefined).map((p) => [p, src.params[p]])) });
        }, children: noDefault([
            { option: { value: "", selected: !q, textContent: kind === "table" ? "— pick a query —" : `— none: every ${noun} the person may read —` } },
            ...Object.entries(queries).sort(([, a], [, b]) => String(a.label ?? "").localeCompare(String(b.label ?? ""))).map(([n, x]) => ({ option: { value: n, selected: n === q, textContent: `${x.label ?? n} (${n})` } })),
        ]) } }, kind === "choices" ? "The person picks among the query's rows (it gives the records' id), run as them. Saving checks the pick is one of them." : "The query's rows, run as the viewer."),
        ...(q ? [
            labelled(kind === "table" ? "Columns shown" : "Each said by", cols === null ? { span: { className: "muted small", textContent: "Reading its columns…" } }
                : cols.problem ? { span: { className: "small field-error", textContent: `Its columns are not known: ${cols.problem}` } }
                    : { div: { className: "choice-list inline", children: cols.columns.filter((c) => c !== "id").map((c) => ({ label: { key: c, children: [
                        { input: { type: "checkbox", disabled: readOnly, checked: picked.includes(c), onchange: (e) => toggle(c, e.target.checked) } },
                        { span: { className: "mono", textContent: c } },
                    ] } })) } },
            kind === "table" ? "None picked: every column but id." : "None picked: each by its record's title."),
            ...(cols?.columns && !cols.columns.includes("id") && kind === "choices" ? [{ p: { className: "small field-error", textContent: `${queries[q]?.label ?? q} gives no id column: its rows cannot be picked. Add "id" to what it selects.` } }] : []),
            ...declared.map(([p, spec]) => expr(p, spec)),
            ...(declared.length && scopes ? [{ p: { className: "muted small", textContent: `Its parameters read ${scopes}.` } }] : []),
        ] : []),
    ] } };
}
