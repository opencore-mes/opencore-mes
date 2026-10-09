// Choosing several from many (people, groups), for lists that outgrow checkboxes: the chosen ones as
// chips (✕ removes one; past 30, a count, and the chips of those matching what is typed), and a box that suggests what matches once something is typed (not on focus;
// ↓ in an empty box lists them), ↑ ↓ to move, Enter or a click to add, Backspace on an empty box
// removes the last. Used by the designer wherever people are named: a department's members and
// approvers, who may call, run or open something, who holds a role.
//
//   pickMany({ key, options: [{ value, label, hint? }], value: [values], onChange(next), readOnly, placeholder,
//              single, create, openOnFocus, none })
//     single       one at a time; choosing replaces it and closes the suggestions
//     create       a value not among the options may be added too: true (as typed, trimmed), or
//                  (text) => value | { error } to shape or refuse it. Several at once with commas
//                  between them; what is typed and left is added as the box is left.
//     openOnFocus  the suggestions open as the box is entered (a short list: roles, fields, states)
//     none         what an empty read-only list says ("nobody" unless given)
//   tagsInput(...) the same, adding new by default and opening on focus: a list of words (roles, values,
//                  columns) where commas were typed before
import { icon } from "./icons.js";

const MAX_SUGGESTED = 8;
// A chip's × is a span acting as a button, not a <button>: a <button> would be the control of a <label>
// around the list, and a click on the label's blank space would remove the first chip.
// Past this many chosen (a department of thousands), the chips are found by typing, not all drawn.
const MAX_CHIPS = 30;

export const pickMany = ({ key, ...props }) => ({ PickMany: { key, id: `pick-${String(key).replace(/[^a-zA-Z0-9_-]/g, "-")}`, ...props } });
export const tagsInput = ({ create = true, openOnFocus = true, none = "none", placeholder = "Add…", ...props }) => pickMany({ create, openOnFocus, none, placeholder, ...props });

export function registerPick(juris) {
    juris.registerComponent("PickMany", ({ id, options = [], value = [], onChange, readOnly = false, placeholder = "Add…", single = false, create = false, openOnFocus = false, none = "nobody" }, api) => {
        const [q, setQ] = api.useState("q", "");
        const [open, setOpen] = api.useState("open", false);
        const [at, setAt] = api.useState("at", 0);
        const ro = () => (typeof readOnly === "function" ? readOnly() : Boolean(readOnly));
        const chosen = Array.isArray(value) ? value : [];
        const chosenSet = new Set(chosen);
        const byValue = new Map(options.map((o) => [o.value, o]));
        const labelOf = (v) => byValue.get(v)?.label ?? v;
        // Every word typed appears somewhere, in any order ("lot oper" finds "Lot · operator").
        const wordsOf = () => q().trim().toLowerCase().split(/\s+/).filter(Boolean);
        const fits = (words, o) => { const text = `${o.label} ${o.value} ${o.hint ?? ""}`.toLowerCase(); return words.every((w) => text.includes(w)); };
        // What typed text adds, when new values may be added: each part between commas, shaped by `create`.
        const made = (text) => String(text ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => (typeof create === "function" ? create(t) : t));
        const newOf = () => {
            if (!create || !q().trim()) return null;
            const parts = made(q());
            const error = parts.find((x) => x && typeof x === "object")?.error;
            if (error) return { error };
            // A value as `create` shaped it (a number stays a number); an { error } is not one.
            const fresh = [...new Set(parts.filter((x) => x !== "" && x !== null && x !== undefined && typeof x !== "object" && !chosenSet.has(x)))];
            // Typed exactly as one already offered: that one is the suggestion, not a new one.
            if (fresh.length === 1 && byValue.has(fresh[0])) return null;
            return fresh.length ? { values: fresh } : null;
        };
        const matches = () => {
            const words = wordsOf();
            const out = [];
            for (const o of options) { if (!chosenSet.has(o.value) && fits(words, o) && out.push(o) >= MAX_SUGGESTED) break; }
            const n = newOf();
            if (n?.values) out.push({ value: n.values, label: `Add ${n.values.map((v) => `“${v}”`).join(", ")}`, isNew: true });
            else if (n?.error) out.push({ value: null, label: n.error, isError: true });
            // Typed, and nothing to choose nor to add: said, rather than an empty list.
            else if (!out.length && words.length && !create) out.push({ value: null, label: `Nothing matches “${q().trim()}”`, isError: true, isNone: true });
            return out;
        };
        // The chips drawn: all of them, or past MAX_CHIPS those matching what is typed.
        const many = chosen.length > MAX_CHIPS;
        const chips = () => {
            if (!many) return chosen;
            const words = wordsOf();
            if (!words.length) return [];
            const out = [];
            for (const v of chosen) { if (fits(words, byValue.get(v) ?? { label: v, value: v }) && out.push(v) >= MAX_CHIPS) break; }
            return out;
        };
        // The editor redraws on every edit: focus returns to the box, ready for the next one.
        const refocus = () => setTimeout(() => globalThis.document?.getElementById(`${id}-q`)?.focus(), 0);
        const add = (v, { stay = true } = {}) => {
            if (v === undefined || v === null) return;
            const list = Array.isArray(v) ? v : [v];
            setQ(""); setAt(0); setOpen(false);
            if (single) { globalThis.document?.getElementById(`${id}-q`)?.blur(); onChange([list[0]]); return; }
            onChange([...chosen, ...list.filter((x) => !chosenSet.has(x))]);
            if (stay) refocus();
        };
        // Leaving the box with something typed that may be added: it is added (nothing is lost on the way out).
        const left = () => setTimeout(() => {
            setOpen(false);
            const n = create && !ro() ? newOf() : null;
            if (n?.values) add(n.values, { stay: false });
        }, 150);
        const remove = (v) => onChange(chosen.filter((x) => x !== v));
        const keys = (e) => {
            const list = matches();
            if (e.key === "ArrowDown") { e.preventDefault(); if (!open()) { setOpen(true); setAt(0); return; } setAt(Math.min(at() + 1, list.length - 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(at() - 1, 0)); } else if (e.key === "Enter") { e.preventDefault(); if (open() || create) add(list[Math.min(at(), list.length - 1)]?.value); } else if (e.key === "Escape") { setOpen(false); } else if (e.key === "Backspace" && !q() && chosen.length) { remove(chosen.at(-1)); refocus(); }
        };
        return {
            div: {
                // One field: the chips and the box to type in, wrapping as it fills. A click on its blank
                // space puts the cursor in the box.
                className: ro() ? "pick ro" : "pick",
                onclick: (e) => { if (!ro() && (e.target === e.currentTarget || e.target.classList?.contains("pick-chips"))) globalThis.document?.getElementById(`${id}-q`)?.focus(); },
                children: [
                    many ? { span: { className: "pick-count muted small", textContent: () => (q().trim() ? `${chosen.length} in all; those matching “${q().trim()}”:` : `${chosen.length} in all: type to find one.`) } } : { span: {} },
                    () => ({ span: { className: "pick-chips", children: chips().map((v) => ({ span: { key: `c-${v}`, className: "pick-chip", children: [{ span: labelOf(v) }, ro() ? { span: {} } : { span: { role: "button", tabindex: "0", className: "pick-x", title: `Remove ${labelOf(v)}`, "aria-label": `Remove ${labelOf(v)}`, children: [icon("x")], onclick: () => remove(v), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); remove(v); } } } }] } })) } }),
                    !chosen.length && ro() ? { span: { className: "muted small", textContent: none } } : { span: {} },
                    ro() && !many ? { span: {} } : {
                        span: {
                            className: "pick-box",
                            children: [
                                { input: { id: `${id}-q`, type: "search", autocomplete: "off", placeholder: ro() ? "Find one…" : many ? "Find, or add another…" : chosen.length ? (single ? "Another…" : "Add another…") : placeholder, role: "combobox", "aria-expanded": () => String(open() && matches().length > 0), value: () => q(), oninput: (e) => { setQ(e.target.value); setOpen(e.target.value.trim() !== "" || openOnFocus); setAt(0); }, onfocus: () => { if (openOnFocus && !ro()) setOpen(true); }, onblur: left, onkeydown: keys } },
                                () => (open() && !ro() && matches().length ? {
                                    ul: {
                                        className: "pick-list", role: "listbox",
                                        children: matches().map((o, k) => ({
                                            li: { key: o.isNew ? "+new" : o.isError ? "!error" : o.value, role: "option", "aria-selected": String(k === at()), "aria-disabled": o.isError ? "true" : undefined, classList: { on: k === at() && !o.isError, "pick-new": Boolean(o.isNew), "pick-error": Boolean(o.isError) && !o.isNone, "pick-none": Boolean(o.isNone) }, onmousedown: (e) => { e.preventDefault(); add(o.value); }, children: [{ span: o.label }, o.hint ? { span: { className: "muted small", textContent: ` ${o.hint}` } } : { span: {} }] },
                                        })),
                                    },
                                } : { span: {} }),
                            ],
                        },
                    },
                ],
            },
        };
    });
}
