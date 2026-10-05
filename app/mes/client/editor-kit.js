// What the designer's editors share: the working copy's path, and inputs bound to one leaf of it.
// A tab's `ctx` is { api, w, ops, ro, root }: `root` is the part of the working copy it edits (the
// object's definition `${w}.b` unless given, or a service's or a connection's), and `ops.set(path,
// value, structural)` writes under it.
import { scriptBody } from "./pipe.js";

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
export const listInput = (ctx, path, placeholder = "") => ({
    input: { type: "text", placeholder, disabled: ctx.ro, value: () => csv(ctx.api.getState(`${rootOf(ctx)}.${path}`, [])), onchange: (e) => ctx.ops.set(path, fromCsv(e.target.value), true) },
});
export const labelled = (label, control, hint) => ({ label: { className: "ed-field", children: [{ span: label }, control, hint ? { span: { className: "muted small", textContent: hint } } : { span: {} }] } });
export const check = (ctx, path, label) => ({
    label: { children: [{ input: { type: "checkbox", disabled: ctx.ro, checked: () => Boolean(ctx.api.getState(`${rootOf(ctx)}.${path}`, false)), onchange: (e) => ctx.ops.set(path, e.target.checked) } }, { span: ` ${label}` }] },
});
