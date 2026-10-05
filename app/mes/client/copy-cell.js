// Copy what a list shows (CLAUDE.md, every list): the pointer over a cell of any table in the work area
// (an object's list, a screen's table, a query's result, the designer's), a small button at the cell's
// right edge copies its text: a lot number, a value to paste into a report or another system. One
// button for the whole page, placed where the pointer is, so no list draws one per cell. A cell that
// holds an input, a choice or a button is the person's to edit, not copied; an empty one has nothing.
// A cell may say what it copies (data-copy), when what it shows is not it.
import { icon } from "./icons.js";

const AREA = ".tabbody td, .screen-dialog td";
const EMPTY = new Set(["", "—", "·", "-"]);

// What a cell copies, or null when there is nothing to copy there.
export function cellText(cell) {
    if (!cell || cell.closest("thead, .win-spacer, .win-more")) return null;
    if (cell.querySelector("input, select, textarea, button")) return null;
    const text = String(cell.dataset?.copy ?? cell.innerText ?? cell.textContent ?? "").replace(/\s+/g, " ").trim();
    return EMPTY.has(text) || text.length > 4000 ? null : text;
}

// Onto the clipboard: the Clipboard API where the page may use it (https, localhost), else the old way.
async function toClipboard(text) {
    try {
        if (globalThis.navigator?.clipboard?.writeText) { await globalThis.navigator.clipboard.writeText(text); return true; }
    } catch { /* not allowed here: the old way */ }
    const doc = globalThis.document;
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:-1000px;opacity:0";
    doc.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = doc.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
}

export function registerCopyCell(juris) {
    juris.registerComponent("CopyCell", (props, api) => {
        const [at, setAt] = api.useState("at", null);     // { x, y, text } of the cell the pointer is on
        const [copied, setCopied] = api.useState("copied", false);
        let cell = null;
        let hide = null;
        if (!api.isServer) {
            api.onMount(() => {
                const doc = globalThis.document;
                const place = (td) => {
                    const text = cellText(td);
                    if (!text) { cell = null; setAt(null); return; }
                    cell = td;
                    const r = td.getBoundingClientRect();
                    setCopied(false);
                    setAt({ x: Math.round(r.right - 28), y: Math.round(r.top + r.height / 2 - 12), text });
                };
                const over = (e) => {
                    const t = e.target;
                    if (t.closest?.(".copy-cell-btn")) { clearTimeout(hide); return; }
                    const td = t.closest?.(AREA);
                    if (td) { clearTimeout(hide); if (td !== cell) place(td); return; }
                    // Gone from the cell: a moment to reach the button first.
                    clearTimeout(hide);
                    hide = setTimeout(() => { cell = null; setAt(null); }, 150);
                };
                // A list that scrolls moves the cell from under the button: put away.
                const away = () => { cell = null; setAt(null); };
                doc.addEventListener("mouseover", over);
                doc.addEventListener("scroll", away, { capture: true, passive: true });
                return () => { clearTimeout(hide); doc.removeEventListener("mouseover", over); doc.removeEventListener("scroll", away, { capture: true }); };
            });
        }
        const copy = async () => {
            const a = at();
            if (!a) return;
            if (await toClipboard(a.text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
        };
        return () => {
            const a = at();
            if (!a) return { span: {} };
            const short = a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text;
            return {
                button: {
                    type: "button", className: `copy-cell-btn${copied() ? " done" : ""}`, style: `left:${a.x}px;top:${a.y}px`,
                    title: copied() ? "Copied" : `Copy “${short}”`, "aria-label": copied() ? "Copied" : `Copy ${short}`,
                    // The click copies; the cell keeps what had the focus.
                    onmousedown: (e) => e.preventDefault(),
                    onclick: copy,
                    children: [icon(copied() ? "check" : "copy")],
                },
            };
        };
    });
}
