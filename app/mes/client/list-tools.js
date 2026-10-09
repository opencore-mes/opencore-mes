// Search, filters and sorting over a list of designs (the designer's tabs): what the person typed, the
// filters they set and the order they chose, kept per list while they move around (ui.lt.<key>, the page's
// own state). The lists are a plant's designs (tens to a few hundred), so they are filtered here, in the page.
//
//   const t = listTools(api, "flows", { placeholder, text: (x) => [x.name, x.label], filters, sorts })
//   t.bar(list)   the toolbar (search, a select per filter, the order), with "n of m" and Clear once narrowed
//   t.apply(list) the list as asked
// filters: [{ id, label, options: [[value, words]] | () => …, test: (x, value) => boolean }]
// sorts:   [[id, words, (x) => key]] (the first is the default; numbers and text both sort)
//
// applyListTools is the pure part, for the tests.
import { noDefault } from "./select.js";
import { icon } from "./icons.js";

const textOf = (v) => String(v ?? "").toLowerCase();
export function applyListTools(list, { q = "", text = () => [], filters = [], values = {}, sorts = [], sort, desc = false } = {}) {
    const words = textOf(q).trim().split(/\s+/).filter(Boolean);
    const out = (Array.isArray(list) ? list : []).filter((x) => {
        // Every word typed is somewhere in what it is called, in any order ("move in" finds "Move in").
        const hay = text(x).map(textOf).join(" ");
        if (!words.every((w) => hay.includes(w))) return false;
        return filters.every((f) => values[f.id] === undefined || values[f.id] === "" || f.test(x, values[f.id]));
    });
    const by = sorts.find(([id]) => id === sort) ?? sorts[0];
    if (!by) return out;
    const key = by[2];
    const cmp = (a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (typeof ka === "number" && typeof kb === "number") return ka - kb;
        return String(ka ?? "").localeCompare(String(kb ?? ""), undefined, { numeric: true, sensitivity: "base" });
    };
    return out.map((x, i) => [x, i]).sort(([a, i], [b, j]) => (desc ? cmp(b, a) : cmp(a, b)) || i - j).map(([x]) => x);
}

// The two filters every design list has: who stewards it, and whether a change to it is open.
export const stewardFilter = (departments) => ({ id: "steward", label: "Stewarded by", options: () => departments().map((d) => [d.id, d.name ?? d.id]), test: (x, v) => (x.stewards ?? []).includes(v) });
export const openFilter = { id: "open", label: "Open change", options: [["yes", "with an open change"], ["no", "without one"]], test: (x, v) => (v === "yes" ? (x.open ?? []).length > 0 : !(x.open ?? []).length) };
export const designSorts = (extra = []) => [
    ["label", "Name", (x) => x.label ?? x.object ?? x.name],
    ["name", "Id", (x) => x.name ?? x.object],
    ...extra,
    ["version", "Version", (x) => Number(x.version ?? 0)],
    ["open", "Open change first", (x) => ((x.open ?? []).length ? 0 : 1)],
];
// The values a list's items have, as filter options (an object's areas, a flow's records).
export const optionsOf = (list, key, words = (v) => v) => [...new Set((list ?? []).map(key).filter((v) => v !== null && v !== undefined && v !== ""))].sort((a, b) => String(a).localeCompare(String(b))).map((v) => [String(v), words(v)]);

export function listTools(api, key, { placeholder = "Find…", text, filters = [], sorts = [], desc: newestFirst = false } = {}) {
    const S = `ui.lt.${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const state = () => ({
        q: api.getState(`${S}.q`, "") ?? "",
        values: api.getState(`${S}.f`, {}) ?? {},
        sort: api.getState(`${S}.sort`, null) ?? sorts[0]?.[0],
        desc: (api.getState(`${S}.desc`, null) ?? newestFirst) === true,
    });
    const apply = (list) => applyListTools(list, { ...state(), text, filters, sorts });
    const narrowed = () => { const s = state(); return Boolean(s.q.trim()) || Object.values(s.values).some((v) => v !== "" && v !== undefined); };
    const bar = (list) => {
        const s = state();
        const total = (list ?? []).length;
        const shown = narrowed() ? apply(list).length : total;
        return { div: { className: "list-tools", children: [
            { input: { type: "search", className: "design-search", placeholder, "aria-label": placeholder, value: () => api.getState(`${S}.q`, "") ?? "", oninput: (e) => api.setValue(`${S}.q`, e.target.value) } },
            ...filters.map((f) => {
                const opts = typeof f.options === "function" ? f.options() : f.options;
                const v = s.values[f.id] ?? "";
                return { select: { key: f.id, className: v ? "on" : "", title: f.label, "aria-label": f.label, onchange: (e) => api.setValue(`${S}.f`, { ...state().values, [f.id]: e.target.value }), children: noDefault([[ "", `${f.label}: any`], ...opts].map(([val, words]) => ({ option: { value: val, selected: val === v, textContent: val ? `${f.label}: ${words}` : words } }))) } };
            }),
            sorts.length > 1 ? { select: { className: "list-sort", title: "Order", "aria-label": "Order", onchange: (e) => api.setValue(`${S}.sort`, e.target.value), children: noDefault(sorts.map(([id, words]) => ({ option: { value: id, selected: id === s.sort, textContent: `Sort: ${words}` } }))) } } : { span: {} },
            sorts.length ? { button: { type: "button", className: "btn ghost small", title: s.desc ? "Last first" : "First first", "aria-label": s.desc ? "Descending: click for ascending" : "Ascending: click for descending", children: [icon(s.desc ? "arrowDown" : "arrowUp")], onclick: () => api.setValue(`${S}.desc`, !s.desc) } } : { span: {} },
            narrowed() ? { span: { className: "muted small", textContent: `${shown} of ${total}` } } : { span: {} },
            narrowed() ? { button: { type: "button", className: "linkish small", textContent: "Clear", onclick: () => api.batch(() => { api.setValue(`${S}.q`, ""); api.setValue(`${S}.f`, {}); }) } } : { span: {} },
        ] } };
    };
    return { apply, bar, state };
}
