// Undo and redo in a change's editors (client/undo.js, §5.3): steps, typing joined into one, one click one
// step, redo dropped by a new edit, someone else's edit forgetting the history, the keys. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as history from "../client/undo.js";

// Just enough of a Juris api: state by dotted path.
function fakeApi(start = {}) {
    const state = JSON.parse(JSON.stringify(start));
    const at = (path, make) => { const parts = path.split("."); let o = state; for (const p of parts.slice(0, -1)) { if (o[p] === undefined) { if (!make) return [undefined]; o[p] = {}; } o = o[p]; } return [o, parts.at(-1)]; };
    return {
        isServer: false,
        peek: (path) => { const [o, k] = at(path, false); return o === undefined ? undefined : o[k]; },
        setValue: (path, v) => { const [o, k] = at(path, true); o[k] = v; },
        batch: (fn) => fn(),
        state,
    };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const W = "dw.c1";
const edit = async (api, path, value, key = null, now) => { history.before(api, W, key, now); api.setValue(`${W}.${path}`, value); await tick(); };

test("each edit is a step back; undo and redo walk them; a new edit drops what could be redone", async () => {
    const api = fakeApi({ dw: { c1: { b: { label: "Lot" } } } });
    await edit(api, "b.label", "Lot A");
    await edit(api, "b.label", "Lot B");
    assert.deepEqual(api.peek(`${W}.hist`), { undo: 2, redo: 0 });
    assert.equal(history.undo(api, W), true);
    assert.equal(api.peek(`${W}.b.label`), "Lot A");
    assert.equal(api.peek(`${W}.dirty`), true, "an undo is saved like an edit");
    history.undo(api, W);
    assert.equal(api.peek(`${W}.b.label`), "Lot");
    assert.equal(history.undo(api, W), false, "nothing more to undo");
    history.redo(api, W);
    assert.equal(api.peek(`${W}.b.label`), "Lot A");
    await edit(api, "b.label", "Lot C");
    assert.equal(history.redo(api, W), false, "a new edit drops what could be redone");
    history.forget(api, W);
});

test("typing in one box is one step; another box, or a pause, is another", async () => {
    const api = fakeApi({ dw: { c1: { b: { label: "" } } } });
    await edit(api, "b.label", "L", "b.label", 1000);
    await edit(api, "b.label", "Lo", "b.label", 1500);
    await edit(api, "b.label", "Lot", "b.label", 2000);
    assert.equal(api.peek(`${W}.hist.undo`), 1);
    await edit(api, "b.description", "x", "b.description", 2100);
    await edit(api, "b.label", "Lots", "b.label", 2200 + history.MERGE_MS);
    assert.equal(api.peek(`${W}.hist.undo`), 3);
    history.undo(api, W); history.undo(api, W); history.undo(api, W);
    assert.equal(api.peek(`${W}.b.label`), "");
    history.forget(api, W);
});

test("several edits made by one click are one step", async () => {
    const api = fakeApi({ dw: { c1: { s: {}, t: {} } } });
    history.before(api, W, "s.on_enter"); api.setValue(`${W}.s.on_enter`, "src");
    history.before(api, W); api.setValue(`${W}.t.on_enter`, [{ name: "case" }]);
    await tick();
    assert.equal(api.peek(`${W}.hist.undo`), 1);
    history.undo(api, W);
    assert.deepEqual([api.peek(`${W}.s`), api.peek(`${W}.t`)], [{}, {}]);
    history.forget(api, W);
});

test("someone else's edit coming in forgets the history; this window's own save keeps it", async () => {
    const api = fakeApi({ dw: { c1: { b: { label: "Lot" }, seen: 4 } } });
    await edit(api, "b.label", "Lot A");
    history.loaded(api, W, 4);
    assert.equal(history.undo(api, W), true, "its own save (draft 4) loaded back: still undoable");
    await edit(api, "b.label", "Lot B");
    history.loaded(api, W, 5);
    assert.deepEqual(api.peek(`${W}.hist`), { undo: 0, redo: 0 });
    assert.equal(history.undo(api, W), false);
});

test("at most LIMIT steps are kept", async () => {
    const api = fakeApi({ dw: { c1: { b: { n: 0 } } } });
    for (let i = 1; i <= history.LIMIT + 5; i++) await edit(api, "b.n", i);
    assert.equal(api.peek(`${W}.hist.undo`), history.LIMIT);
    history.forget(api, W);
});

test("the keys: ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Y redo; a text box keeps its own", () => {
    assert.equal(history.keyOf({ key: "z", metaKey: true }), "undo");
    assert.equal(history.keyOf({ key: "z", ctrlKey: true }), "undo");
    assert.equal(history.keyOf({ key: "Z", metaKey: true, shiftKey: true }), "redo");
    assert.equal(history.keyOf({ key: "y", ctrlKey: true }), "redo");
    assert.equal(history.keyOf({ key: "z" }), null);
    assert.equal(history.keyOf({ key: "z", metaKey: true, altKey: true }), null);
    assert.equal(history.isTextTarget({ tagName: "INPUT", type: "text" }), true);
    assert.equal(history.isTextTarget({ tagName: "INPUT", type: "checkbox" }), false);
    assert.equal(history.isTextTarget({ tagName: "TEXTAREA" }), true);
    assert.equal(history.isTextTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(history.isTextTarget({ tagName: "BUTTON" }), false);
});
