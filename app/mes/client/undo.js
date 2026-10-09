// Undo and redo in a change's editors (§5.3): the draft as it was before each edit, kept per change window,
// most recent last. Every editor writes its draft through its ops (designer.js draftOps, integration-editor.js
// elementOps, organization-editor.js orgOps), which call `before` first: so a field, a policy, a node, a
// person or a script edited anywhere in the change is one step, whichever editor it was in. Typing in one box
// is one step (leaf edits to the same place within MERGE_MS join the step before), a change of shape (add,
// remove, retype) is always a step of its own. Undoing writes the draft back like any edit: it is saved the
// same way, and redo takes it forward again until something new is edited.
//
// The history lives in the page, not in state (snapshots of a whole draft), and only its lengths are in
// state (`${w}.hist`) for the buttons. It is forgotten when the draft comes in changed from elsewhere (a
// co-designer, the copilot, a design brought in): undo never takes back someone else's edit.
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// The parts of a window that are the draft (designer.js loadWorkspace): the object open, every definition,
// the scripts, the other designs, People & departments, the test cases.
export const DRAFT_KEYS = ["object", "defs", "b", "s", "sv", "cn", "tx", "sc", "fl", "ly", "qy", "el", "org", "t"];
export const LIMIT = 100;
export const MERGE_MS = 1500;

const histories = new Map(); // w → { undo: [snapshot], redo: [snapshot], last: { key, at } | null }
const historyOf = (w) => histories.get(w) ?? histories.set(w, { undo: [], redo: [], last: null, inTask: false }).get(w);
const snapshot = (api, w) => Object.fromEntries(DRAFT_KEYS.map((k) => [k, clone(api.peek(`${w}.${k}`))]));
const counts = (api, w) => { const h = historyOf(w); api.setValue(`${w}.hist`, { undo: h.undo.length, redo: h.redo.length }); };

// Before an edit: the draft as it is now becomes a step back. `key` names a leaf edit (a box typed in) so
// that keystrokes in it join one step; null for a change of shape.
export function before(api, w, key = null, now = Date.now()) {
    if (api.isServer) return;
    const h = historyOf(w);
    // Several edits made by one click or key (a script, its test case and the node naming it) are one
    // step: the first in the task takes the snapshot, the others join it.
    if (h.inTask) return;
    if (key && h.last?.key === key && now - h.last.at < MERGE_MS) { h.last.at = now; return; }
    h.inTask = true;
    queueMicrotask(() => { h.inTask = false; });
    h.undo.push(snapshot(api, w));
    if (h.undo.length > LIMIT) h.undo.shift();
    h.redo = [];
    h.last = key ? { key, at: now } : null;
    counts(api, w);
}

// The draft put back as a snapshot has it, and saved like an edit (designer.js saves a dirty window).
function restore(api, w, snap) {
    api.batch(() => {
        for (const k of DRAFT_KEYS) api.setValue(`${w}.${k}`, clone(snap[k]));
        api.setValue(`${w}.dirty`, true);
        for (const k of ["rev", "vrev", "casesRev"]) api.setValue(`${w}.${k}`, (api.peek(`${w}.${k}`) ?? 0) + 1);
    });
}
export function undo(api, w) {
    const h = historyOf(w);
    if (!h.undo.length) return false;
    h.redo.push(snapshot(api, w));
    restore(api, w, h.undo.pop());
    h.last = null;
    counts(api, w);
    return true;
}
export function redo(api, w) {
    const h = historyOf(w);
    if (!h.redo.length) return false;
    h.undo.push(snapshot(api, w));
    restore(api, w, h.redo.pop());
    h.last = null;
    counts(api, w);
    return true;
}

// The draft loaded from the server, at version `draftRev` (draft_rev): the version this window last saved
// or loaded (`${w}.seen`) is its own; another means someone else's edit came in (a co-designer, the copilot,
// a design brought in), and the history is forgotten.
export function loaded(api, w, draftRev) {
    if (!histories.has(w)) return;
    if (Number(api.peek(`${w}.seen`)) !== Number(draftRev)) forget(api, w);
}
export function forget(api, w) {
    histories.delete(w);
    if (!api.isServer) api.setValue(`${w}.hist`, { undo: 0, redo: 0 });
}

// ⌘Z / Ctrl+Z undoes and ⇧⌘Z / Ctrl+Y redoes, outside a box that keeps its own undo (a text box, a code
// editor, anything editable): there the browser's undo goes on as before.
export function isTextTarget(el) {
    const tag = el?.tagName;
    if (!tag) return false;
    if (tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
    if (tag !== "INPUT") return false;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(String(el.type).toLowerCase());
}
export function keyOf(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
    const k = String(e.key).toLowerCase();
    if (k === "z") return e.shiftKey ? "redo" : "undo";
    if (k === "y" && e.ctrlKey && !e.metaKey) return "redo";
    return null;
}
