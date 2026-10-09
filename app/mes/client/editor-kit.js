// What the designer's editors share: the working copy's path, and inputs bound to one leaf of it.
// A tab's `ctx` is { api, w, ops, ro, root }: `root` is the part of the working copy it edits (the
// object's definition `${w}.b` unless given, or a service's or a connection's), and `ops.set(path,
// value, structural)` writes under it.
import { scriptBody } from "./pipe.js";
import { tagsInput } from "./pick.js";

export const W = (id) => `dz.${id}`;    // a change's working copy: .b (definition), .s (scripts), .sv (services), .cn (connections)
export const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
export const csv = (value) => (Array.isArray(value) ? value.join(", ") : "");
export const fromCsv = (text) => String(text ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const rootOf = ({ w, root }) => root ?? `${w}.b`;

// Every object a change holds, as drafted: the one the object editor has open (`.object`, its body
// `.b`) and the others (`.defs`), so a change to a lot and a new machine keeps both.
export const draftDefinitions = (api, w) => {
    const open = api.peek(`${w}.object`);
    return { ...(api.peek(`${w}.defs`) ?? {}), ...(open ? { [open]: api.peek(`${w}.b`) } : {}) };
};
// Opens another of the change's objects in the object editor, keeping the one open as drafted.
export function openObject(api, w, object) {
    const current = api.peek(`${w}.object`);
    if (!object || object === current) return;
    const defs = draftDefinitions(api, w);
    api.batch(() => {
        api.setValue(`${w}.defs`, defs);
        api.setValue(`${w}.object`, object);
        api.setValue(`${w}.b`, clone(defs[object] ?? null));
        api.setValue(`${w}.json`, null);
        api.setValue(`${w}.layoutSel`, null);
        api.setValue(`${w}.rev`, (api.peek(`${w}.rev`) ?? 0) + 1);
        api.setValue(`${w}.vrev`, (api.peek(`${w}.vrev`) ?? 0) + 1);
    });
}

// Compiling a script in the page parses it without running it: the function is built, never called.
// Where the page may not build one (a page that is not the designer's, under its policy), nothing is
// said here: the server compiles it at save, and says.
export const compileInPage = (name, source) => {
    const body = scriptBody(name, source);
    try { new Function(`"use strict"; return (${body});`); } catch (error) { if (error?.name !== "EvalError") throw error; }
};

export const text = (ctx, path, { structural = false, multiline = false, placeholder = "" } = {}) => ({
    [multiline ? "textarea" : "input"]: {
        ...(multiline ? { rows: 3 } : { type: "text" }),
        placeholder,
        disabled: ctx.ro,
        value: () => ctx.api.getState(`${rootOf(ctx)}.${path}`, "") ?? "",
        [structural ? "onchange" : "oninput"]: (e) => ctx.ops.set(path, e.target.value, structural),
    },
});
// A list of words (roles, values, fields, states) as tags: chosen from `options` (strings, or { value, label,
// hint }), or new ones added where `create` allows (true, or (text) => value | { error }); empty is none.
export const listInput = (ctx, path, placeholder = "", { options = [], create = true, onChange = null } = {}) => tagsInput({
    key: `${rootOf(ctx)}.${path}`,
    options: options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
    value: ctx.api.getState(`${rootOf(ctx)}.${path}`, []) ?? [],
    onChange: onChange ?? ((next) => ctx.ops.set(path, next, true)),
    readOnly: ctx.ro, placeholder: placeholder || "Add…", create,
});
// A field and its words. A <label> only around one plain control (an input, a select, a text area): a
// click anywhere in a label is a click on its first control, so around chips, checkboxes or a condition's
// buttons it would remove a chip or tick a box from blank space. Those are in a <div role="group">.
const PLAIN = new Set(["input", "select", "textarea"]);
export const labelled = (label, control, hint) => ({ [PLAIN.has(Object.keys(control ?? {})[0]) ? "label" : "div"]: {
    className: "ed-field", ...(PLAIN.has(Object.keys(control ?? {})[0]) ? {} : { role: "group", "aria-label": typeof label === "string" ? label : undefined }),
    children: [{ span: label }, control, hint ? { span: { className: "muted small", textContent: hint } } : { span: {} }],
} });
export const check = (ctx, path, label) => ({
    label: { children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: () => Boolean(ctx.api.getState(`${rootOf(ctx)}.${path}`, false)), onchange: (e) => ctx.ops.set(path, e.target.checked) } }, { span: ` ${label}` }] },
});

// A panel over an editor, for one thing at a time with room (a field's values, a group): drawn while `open`
// is set, inside the editor's own window. A modal: Esc, the panel's Done or a click outside closes it (`close`),
// focus moves into it, stays inside while it is open, and returns to `returnTo` (a selector) after.
//   editorPanel(api, { id, title, subtitle, children, close, returnTo, wide })
export function editorPanel(api, { id, title, subtitle = null, children = [], close, returnTo = null, footer = [] }) {
    if (api.isServer) return { span: {} };
    const doc = globalThis.document;
    const shut = () => { close(); if (returnTo) setTimeout(() => doc?.querySelector(returnTo)?.focus(), 0); };
    setTimeout(() => {
        const panel = doc?.getElementById(id);
        if (panel && !panel.contains(doc.activeElement)) panel.querySelector("input, select, textarea, button")?.focus();
    }, 0);
    const keys = (e) => {
        if (e.key === "Escape") { e.preventDefault(); shut(); return; }
        if (e.key !== "Tab") return;
        const items = [...doc.getElementById(id).querySelectorAll("input, select, textarea, button")].filter((x) => !x.disabled);
        if (!items.length) return;
        const [first, last] = [items[0], items[items.length - 1]];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    return {
        div: {
            className: "dialog-backdrop",
            onmousedown: (e) => { if (e.target === e.currentTarget) shut(); },
            onkeydown: keys,
            children: [{
                div: {
                    id, className: "dialog-panel editor-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}-title`,
                    children: [
                        { h2: { id: `${id}-title`, className: "dialog-title", textContent: title } },
                        subtitle ? { p: { className: "dialog-message", children: subtitle } } : { span: {} },
                        ...children,
                        { div: { className: "dialog-buttons", children: [...footer, { button: { type: "button", className: "btn primary", textContent: "Done", onclick: shut } }] } },
                    ],
                },
            }],
        },
    };
}
