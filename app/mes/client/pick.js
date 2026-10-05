// Choosing several from many (people, groups), for lists that outgrow checkboxes: the chosen ones as
// chips (✕ removes one; past 30, a count, and the chips of those matching what is typed), and a box that suggests what matches once something is typed (not on focus;
// ↓ in an empty box lists them), ↑ ↓ to move, Enter or a click to add, Backspace on an empty box
// removes the last. Used by the designer wherever people are named: a department's members and
// approvers, who may call, run or open something, who holds a role.
//
//   pickMany({ key, options: [{ value, label, hint? }], value: [values], onChange(next), readOnly, placeholder,
//              single })   single: one at a time; choosing replaces it and closes the suggestions
import { icon } from "./icons.js";

const MAX_SUGGESTED = 8;
// Past this many chosen (a department of thousands), the chips are found by typing, not all drawn.
const MAX_CHIPS = 30;

export const pickMany = ({ key, ...props }) => ({ PickMany: { key, id: `pick-${String(key).replace(/[^a-zA-Z0-9_-]/g, "-")}`, ...props } });

export function registerPick(juris) {
    juris.registerComponent("PickMany", ({ id, options = [], value = [], onChange, readOnly = false, placeholder = "Add…", single = false }, api) => {
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
        const matches = () => {
            const words = wordsOf();
            const out = [];
            for (const o of options) { if (!chosenSet.has(o.value) && fits(words, o) && out.push(o) >= MAX_SUGGESTED) break; }
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
        const add = (v) => {
            if (v === undefined) return;
            setQ(""); setAt(0); setOpen(false);
            if (single) { globalThis.document?.getElementById(`${id}-q`)?.blur(); onChange([v]); return; }
            onChange([...chosen, v]);
            refocus();
        };
        const remove = (v) => onChange(chosen.filter((x) => x !== v));
        const keys = (e) => {
            const list = matches();
            if (e.key === "ArrowDown") { e.preventDefault(); if (!open()) { setOpen(true); setAt(0); return; } setAt(Math.min(at() + 1, list.length - 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(at() - 1, 0)); } else if (e.key === "Enter") { e.preventDefault(); if (open()) add(list[at()]?.value); } else if (e.key === "Escape") { setOpen(false); } else if (e.key === "Backspace" && !q() && chosen.length) { remove(chosen.at(-1)); refocus(); }
        };
        return {
            div: {
                className: "pick",
                children: [
                    many ? { span: { className: "pick-count muted small", textContent: () => (q().trim() ? `${chosen.length} in all; those matching “${q().trim()}”:` : `${chosen.length} in all: type to find one.`) } } : { span: {} },
                    () => ({ span: { className: "pick-chips", children: chips().map((v) => ({ span: { key: `c-${v}`, className: "pick-chip", children: [{ span: labelOf(v) }, ro() ? { span: {} } : { button: { type: "button", className: "pick-x", title: `Remove ${labelOf(v)}`, "aria-label": `Remove ${labelOf(v)}`, children: [icon("x")], onclick: () => remove(v) } }] } })) } }),
                    !chosen.length && ro() ? { span: { className: "muted small", textContent: "nobody" } } : { span: {} },
                    ro() && !many ? { span: {} } : {
                        span: {
                            className: "pick-box",
                            children: [
                                { input: { id: `${id}-q`, type: "search", autocomplete: "off", placeholder: ro() ? "Find one…" : many ? "Find, or add another…" : chosen.length ? (single ? "Another…" : "Add another…") : placeholder, role: "combobox", "aria-expanded": () => String(open() && matches().length > 0), value: () => q(), oninput: (e) => { setQ(e.target.value); setOpen(e.target.value.trim() !== ""); setAt(0); }, onblur: () => setTimeout(() => setOpen(false), 150), onkeydown: keys } },
                                () => (open() && !ro() && matches().length ? {
                                    ul: {
                                        className: "pick-list", role: "listbox",
                                        children: matches().map((o, k) => ({
                                            li: { key: o.value, role: "option", "aria-selected": String(k === at()), classList: { on: k === at() }, onmousedown: (e) => { e.preventDefault(); add(o.value); }, children: [{ span: o.label }, o.hint ? { span: { className: "muted small", textContent: ` ${o.hint}` } } : { span: {} }] },
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
