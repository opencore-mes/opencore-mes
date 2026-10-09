// Forms as the designer lays them out (DESIGN.md §10.4): shared by the record forms (records.js), the
// designer's preview and the definition checks (definition.js), so all three read a layout alike.
//
//   "form": { "sections": [ … ] }                      one page of sections, or
//   "form": { "tabs": [ { "label": "Lot", "sections": [ … ] }, … ] }
//   section  { "label", "collapsible", "collapsed", "fields": [ "qty" | { entry } ] }
//   entry    { "field": "qty", "width": up to 12 (of a 12-column row; at least the widget's minWidth),
//              "widget": see widgetsFor,
//              "help": "…", "placeholder": "…", "rows": 2–20 (long text: its smallest height, in lines),
//              "maxRows": rows–40 (its largest: it grows with what is typed, then scrolls),
//              "minChars": 1–6 (a reference searched as typed: letters before it searches; 2 if not said),
//              "show": <expression>, "enable": <expression> }
//
// `show` and `enable` are presentation, in the policies' expression language, over the form's data
// (`{ "data": "disposition" }`), the record (`{ "record": "state" }`) and the user: a field shown or
// greyed out as the data changes. They never grant anything: what a person may read or write is the
// policies' (§9), and a field a policy locks stays locked whatever `enable` says. A field's
// `requiredWhen` (on the field, since it decides what is valid) is checked by the server too.
import { referencesOf, shapeProblems } from "./expr.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// The widgets a field may be drawn with, by its type; the first is the default.
export function widgetsFor(field) {
    switch (field?.type) {
        case "enum": return field.multiple ? ["checkboxes", "multiselect", "chips"] : ["select", "radio", "buttons"];
        case "boolean": return ["checkbox", "toggle", "yesno"];
        // Searched as typed first (§10.4): a plant's references run to thousands; a dropdown lists the most
        // recent 200 only, for a short list a designer picks it for.
        case "ref": return ["search", "select", "scan"];
        case "integer": case "decimal": return ["number", "stepper"];
        case "text": return ["textarea"];
        case "date": return ["date"];
        case "rows": return ["table"];
        default: return ["input"];
    }
}
export const WIDGET_LABELS = { select: "dropdown", radio: "radio list", buttons: "buttons", checkboxes: "checkbox list", multiselect: "multi-select list", chips: "chips", checkbox: "checkbox", toggle: "toggle", yesno: "yes / no", search: "search as you type", scan: "scan or type the label", number: "number", stepper: "number with − +", textarea: "text box", date: "date", input: "text" };
export const defaultWidth = (field) => (field?.type === "text" ? 12 : 4);
// The narrowest a widget is usable at, in columns of 12: below it neither the input nor the designer's
// card for it (its name and its ◀ ▶ − + buttons) fits.
const MIN_WIDTH = { table: 12, input: 2, number: 2, checkbox: 2, toggle: 2, yesno: 2, select: 3, search: 3, scan: 3, date: 3, stepper: 3, radio: 3, buttons: 4, checkboxes: 4, multiselect: 4, chips: 4, textarea: 4 };
export const minWidth = (widget) => MIN_WIDTH[widget] ?? 2;

// Any stored layout as { tabs: [{ label, sections: [{ label, collapsible, collapsed, fields: [entry] }] }] },
// every entry an object with its defaults filled.
export function normalizeForm(def) {
    const form = isPlain(def?.form) ? def.form : null;
    const fields = def?.fields ?? {};
    const tabs = form && Array.isArray(form.tabs)
        ? form.tabs
        : [{ label: def?.label ?? "Details", sections: list(form?.sections).length ? form.sections : [{ label: "Details", fields: Object.keys(fields) }] }];
    return {
        tabs: tabs.map((t) => ({
            label: String(t?.label ?? ""),
            sections: list(t?.sections).map((s) => ({
                label: String(s?.label ?? ""),
                collapsible: Boolean(s?.collapsible),
                collapsed: Boolean(s?.collapsed),
                fields: list(s?.fields).map((e) => (typeof e === "string" ? { field: e } : isPlain(e) ? { ...e } : { field: "" }))
                    .filter((e) => Object.hasOwn(fields, e.field))
                    .map((e) => {
                        const widget = widgetsFor(fields[e.field]).includes(e.widget) ? e.widget : widgetsFor(fields[e.field])[0];
                        const width = Number.isInteger(e.width) ? e.width : defaultWidth(fields[e.field]);
                        return { ...e, widget, width: Math.min(12, Math.max(minWidth(widget), width)) };
                    }),
            })),
        })),
    };
}

// What is wrong with a layout: [{ path, message }].
export function layoutProblems(def) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    const form = def?.form;
    if (form === undefined) return problems;
    if (!isPlain(form)) return [{ path: "form", message: "The form is { sections } or { tabs }." }];
    if (form.tabs !== undefined && form.sections !== undefined) add("form", "A form has sections or tabs, not both.");
    const fields = def.fields ?? {};
    const tabs = Array.isArray(form.tabs) ? form.tabs : [{ label: "", sections: form.sections }];
    if (Array.isArray(form.tabs) && !form.tabs.length) add("form.tabs", "A form with tabs has at least one.");
    const placed = new Set();
    tabs.forEach((tab, t) => {
        const at = Array.isArray(form.tabs) ? `form.tabs.${t}` : "form";
        if (Array.isArray(form.tabs) && !String(tab?.label ?? "").trim()) add(at, `Tab ${t + 1} needs a label.`);
        list(tab?.sections).forEach((section, s) => {
            const where = `${at}.sections.${s}`;
            const name = section?.label || `section ${s + 1}`;
            list(section?.fields).forEach((e) => {
                const entry = typeof e === "string" ? { field: e } : e;
                if (!isPlain(entry) || !Object.hasOwn(fields, entry.field)) { add(where, `Form section "${name}": "${entry?.field ?? e}" is not a field.`); return; }
                if (placed.has(entry.field)) add(where, `"${entry.field}" is placed twice on the form.`);
                placed.add(entry.field);
                const widget = widgetsFor(fields[entry.field]).includes(entry.widget) ? entry.widget : widgetsFor(fields[entry.field])[0];
                if (entry.width !== undefined && !(Number.isInteger(entry.width) && entry.width >= minWidth(widget) && entry.width <= 12)) add(where, `"${entry.field}": width is ${minWidth(widget)} to 12 (of a 12-column row) drawn as ${WIDGET_LABELS[widget]}.`);
                if (entry.widget !== undefined && !widgetsFor(fields[entry.field]).includes(entry.widget)) add(where, `"${entry.field}": a ${fields[entry.field].type}${fields[entry.field].multiple ? " with several values" : ""} is drawn as ${widgetsFor(fields[entry.field]).join(", ")}, not "${entry.widget}".`);
                if (entry.rows !== undefined && !(Number.isInteger(entry.rows) && entry.rows >= 2 && entry.rows <= 20)) add(where, `"${entry.field}": rows is 2 to 20.`);
                if (entry.maxRows !== undefined && !(Number.isInteger(entry.maxRows) && entry.maxRows >= (entry.rows ?? 3) && entry.maxRows <= 40)) add(where, `"${entry.field}": its largest height is ${entry.rows ?? 3} to 40 lines (at least its smallest).`);
                if ((entry.rows !== undefined || entry.maxRows !== undefined) && fields[entry.field].type !== "text") add(where, `"${entry.field}": only a long text has a height in lines.`);
                if (entry.minChars !== undefined && !(Number.isInteger(entry.minChars) && entry.minChars >= 1 && entry.minChars <= 6 && widget === "search")) add(where, `"${entry.field}": letters before searching is 1 to 6, for a reference searched as typed.`);
                for (const k of ["help", "placeholder"]) if (entry[k] !== undefined && (typeof entry[k] !== "string" || entry[k].length > 300)) add(where, `"${entry.field}": ${k} is text, at most 300 characters.`);
                for (const k of ["show", "enable"]) if (entry[k] !== undefined) for (const m of expressionProblems(entry[k], fields)) add(where, `"${entry.field}" ${k} when: ${m}`);
            });
        });
    });
    return problems;
}

// What is wrong with a condition over the form: it reads the form's data, the record and the user.
export function expressionProblems(expr, fields) {
    try {
        const out = shapeProblems(expr);
        for (const ref of referencesOf(expr)) {
            if (!["data", "record", "user"].includes(ref.scope)) out.push(`it reads ${ref.scope}, but a form's condition reads data, record or user.`);
            else if (ref.scope !== "user" && !["state", "type", "id"].includes(ref.path) && !Object.hasOwn(fields, String(ref.path).split(".")[0])) out.push(`it reads ${ref.scope}.${ref.path}, which is not a field.`);
        }
        return out;
    } catch (error) {
        return [error.message];
    }
}

// The layout back in its shortest stored form: one tab as { sections }, a bare field as its name.
export function storeForm(normalized, def) {
    const fields = def?.fields ?? {};
    const entry = (e) => {
        const out = { field: e.field };
        if (e.width !== undefined && e.width !== defaultWidth(fields[e.field])) out.width = e.width;
        if (e.widget && e.widget !== widgetsFor(fields[e.field])[0]) out.widget = e.widget;
        for (const k of ["help", "placeholder", "rows", "maxRows", "minChars", "show", "enable"]) if (e[k] !== undefined && e[k] !== "") out[k] = e[k];
        return Object.keys(out).length === 1 ? e.field : out;
    };
    const section = (s) => ({ label: s.label, ...(s.collapsible ? { collapsible: true } : {}), ...(s.collapsible && s.collapsed ? { collapsed: true } : {}), fields: s.fields.map(entry) });
    const tabs = normalized.tabs.map((t) => ({ label: t.label, sections: t.sections.map(section) }));
    return tabs.length === 1 ? { sections: tabs[0].sections } : { tabs };
}
