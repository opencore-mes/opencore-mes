// Entry without a mouse (DESIGN.md §25.6, §26.8): a transaction's form, on its own page or a screen's
// block, is filled from the keyboard or a scanner. Its inputs are taken in the order its layout draws
// them (whatever the design), the ones a person may write:
//   Enter        the next input (a scan first finds its record, and moves on only when it did; an input
//                whose field shows an error, or is required and empty, keeps the cursor); on the
//                last, the form's main button (Check, then Confirm), which then has the focus: Enter again
//                confirms
//   Ctrl/⌘+Enter the main button, from anywhere in the form
//   Esc          back to the input before (out of a check: back to the inputs)
// An input flow (§32.13) can say otherwise: which input next, on what, and what to do at the end.
const FIELD_CONTROLS = ".form .field input, .form .field select, .form .field textarea";

// The inputs a person may write, in the order they are drawn (on the tab of the form in view).
export function controlsOf(root) {
    if (!root) return [];
    return [...root.querySelectorAll(FIELD_CONTROLS)].filter((el) => el.type !== "hidden" && !el.disabled && !el.readOnly && el.offsetParent !== null);
}

// What a field says is wrong with its input now (its error under it), or that it is required and empty.
export function fieldError(el) {
    const field = el?.closest?.(".field");
    if (!field) return null;
    const said = [...field.querySelectorAll(".field-error")].map((x) => x.textContent.trim()).find(Boolean);
    if (said) return said;
    const required = /\*\s*$/.test(field.querySelector("label")?.textContent ?? "");
    return required && el.type !== "checkbox" && String(el.value ?? "").trim() === "" ? "This is required." : null;
}
// The input left (its change committed, its checks run): then `go()`, or, when its field shows an error,
// the cursor stays there, its entry selected (the person fixes it, and presses the key again).
export function leaveUnlessError(el, go, { stay = true } = {}) {
    el?.blur?.();
    if (!stay) { setTimeout(go, 0); return; }
    setTimeout(() => {
        if (fieldError(el)) { el.focus(); if (typeof el.select === "function" && el.type !== "checkbox" && el.tagName !== "SELECT") el.select(); return; }
        go();
    }, 120);
}

// The control of a form's field by its id (records.js: the form's path and the input's name): the
// input itself, or the first control in it (radio buttons, a list of choice buttons).
export function controlFor(root, path) {
    const el = globalThis.document?.getElementById(String(path).replace(/[^a-zA-Z0-9_-]/g, "-"));
    if (!el || (root && !root.contains(el))) return null;
    return ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) ? el : el.querySelector("input, select, textarea, button");
}

const isEmpty = (el) => (el.type === "checkbox" || el.type === "radio" ? false : String(el.value ?? "") === "");

// The cursor to the first input still empty (else the first), unless the person is in another one.
export function focusFirst(root, { force = false } = {}) {
    if (!root) return false;
    const doc = root.ownerDocument;
    const busy = doc.activeElement && doc.activeElement !== doc.body && !root.contains(doc.activeElement);
    if (busy && !force) return false;
    const list = controlsOf(root);
    const el = list.find(isEmpty) ?? list[0];
    if (!el) return false;
    el.focus();
    if (typeof el.select === "function" && el.type !== "checkbox") el.select();
    return true;
}

// The cursor to the input whose field shows an error, if any.
export function focusError(root) {
    const field = [...(root?.querySelectorAll(".form .field") ?? [])].find((x) => x.querySelector(".field-error")?.textContent);
    const el = field && controlsOf(root).find((c) => field.contains(c));
    if (el) { el.focus(); return true; }
    return false;
}

// Keys on a form. `rootOf()`: the form's root element now (it may be drawn after this is set up, and
// drawn again); `primary()`: its main button now (Check or Confirm); `back()`: Esc's own job, if it has
// one (leaving a check), true when it did it. Listened for on the document, for what happens in the
// root. → stop
export function keyFlow(rootOf, { primary, back = () => false }) {
    const doc = globalThis.document;
    if (!doc) return () => {};
    const press = () => {
        const b = primary();
        if (b && !b.disabled) b.click();
    };
    // Leaving an input commits it (its change); on to the next, or the button once that has happened. An
    // input whose field shows an error (or is required and empty) keeps the cursor.
    const next = (root, from) => leaveUnlessError(from, () => {
        const list = controlsOf(root);
        const i = list.indexOf(from);
        if (i >= 0 && i < list.length - 1) { list[i + 1].focus(); if (typeof list[i + 1].select === "function" && list[i + 1].type !== "checkbox" && list[i + 1].tagName !== "SELECT") list[i + 1].select(); return; }
        press();
    });
    const keydown = (e) => {
        const root = rootOf();
        const t = e.target;
        if (e.isComposing || !root || !root.contains(t)) return;
        if (e.key === "Enter") {
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); t?.blur?.(); setTimeout(press, 0); return; }
            // The signature's box: Enter ticks it, and goes on to Confirm, or to the passwords two signers
            // re-enter (§7.4), each Enter to the next, the last to Confirm.
            if (t?.type === "checkbox" && t.closest(".tx-sign")) { e.preventDefault(); if (!t.checked) t.click(); setTimeout(() => ((rootOf() ?? document).querySelector(".tx-sign .tx-pw input") ?? primary())?.focus(), 0); return; }
            if (t?.type === "password" && t.closest(".tx-sign")) { e.preventDefault(); const pws = [...(rootOf() ?? document).querySelectorAll(".tx-sign .tx-pw input")]; const after = pws[pws.indexOf(t) + 1]; setTimeout(() => (after ?? primary())?.focus(), 0); return; }
            if (t?.tagName === "TEXTAREA" || t?.tagName === "BUTTON" || t?.tagName === "A" || e.defaultPrevented) return;
            if (!controlsOf(root).includes(t)) return;
            e.preventDefault();
            next(root, t);
            return;
        }
        if (e.key === "Escape") {
            if (back()) { e.preventDefault(); const list = controlsOf(root); list[list.length - 1]?.focus(); return; }
            const list = controlsOf(root);
            const i = list.indexOf(t);
            if (i > 0) { e.preventDefault(); list[i - 1].focus(); }
        }
    };
    // A scan that found its record moves on (records.js ScanField).
    const advanced = (e) => { const root = rootOf(); if (root && controlsOf(root).includes(e.target)) next(root, e.target); };
    doc.addEventListener("keydown", keydown);
    doc.addEventListener("mes-advance", advanced);
    return () => { doc.removeEventListener("keydown", keydown); doc.removeEventListener("mes-advance", advanced); };
}
