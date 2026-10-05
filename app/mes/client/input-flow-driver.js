// An input flow (§32.13, input-flow.js) walked in the browser: the cursor to each ask's input in turn,
// what moves on from it as the ask says (Enter, Tab, a key, or by itself), fills and decisions on the
// way, the form checked and confirmed at a run, and back to the start at its end. A transaction's form
// walks its own (transaction.js); a screen walks one over its parameter and its forms (screen.js), each
// telling it where things are:
//   flow            { name, nodes, edges }
//   state           a state path of its own (where it is, its prompt, what went wrong)
//   rootOf()        the element whose keys it takes
//   targets         (input) → { control(): element, filled(): bool, value(), set(v), object: ref's object
//                   or null, form: the form it belongs to (a key of `forms`), param: true } or null
//   forms           { key: { primary(): button, confirm(): button, preview: path, done: path, errors: path,
//                   signs: bool } }; a run names one (its transaction), or the only one
//   scope()         { param, user }
// → stop
import { stepFrom, advances, entryComplete } from "./input-flow.js";
import { referencesOf } from "./expr.js";
import { leaveUnlessError } from "./keyboard.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The inputs whose records a flow's conditions and values read ({ lookup: "lot.state" }).
function lookedUp(flow) {
    const out = new Set();
    const read = (e) => { try { for (const r of referencesOf(e)) if (r.scope === "lookup") out.add(String(r.path).split(".")[0]); } catch { /* not an expression */ } };
    for (const n of Object.values(isPlain(flow?.nodes) ? flow.nodes : {})) if (n?.value !== undefined) read(n.value);
    for (const e of Array.isArray(flow?.edges) ? flow.edges : []) if (e?.when !== undefined) read(e.when);
    return [...out];
}

export function driveInputFlow(api, { flow, state, rootOf, targets, forms, scope = () => ({}) }) {
    const doc = globalThis.document;
    if (!doc || !flow) return () => {};
    const nodes = flow.nodes ?? {};
    const stops = [];
    const history = [];
    const records = new Map(); // id → record, for lookups
    let at = null; // the node it stopped at
    let busy = false;

    const say = (prompt, error = null) => api.batch(() => { api.setValue(`${state}.prompt`, prompt); api.setValue(`${state}.error`, error); api.setValue(`${state}.at`, at); });
    const mark = (input) => {
        const root = rootOf();
        for (const el of root?.querySelectorAll(".field.flow-at") ?? []) el.classList.remove("flow-at");
        targets(input)?.control()?.closest(".field")?.classList.add("flow-at");
    };
    const focus = (el) => { if (!el) return; el.focus(); if (typeof el.select === "function" && el.type !== "checkbox" && el.tagName !== "SELECT") el.select(); };
    const formOf = (name) => forms[name] ?? (Object.keys(forms).length === 1 ? Object.values(forms)[0] : null);

    // What its conditions read, now: the inputs, the records the looked-up ones name, the parameter, the person.
    const scopeNow = async () => {
        const input = {};
        const lookup = {};
        for (const n of Object.values(nodes)) for (const name of [n?.input].filter((x) => typeof x === "string")) { const t = targets(name); if (t) input[name] = t.value(); }
        for (const name of lookedUp(flow)) {
            const t = targets(name);
            const id = t?.value();
            if (!t?.object || !id) continue;
            if (!records.has(id)) records.set(id, await api.call("records.get", { object: t.object, id, as: api.peek("me.id") }).catch(() => null));
            const r = records.get(id);
            if (r) lookup[name] = { ...r, state: r.$state ?? r.state, id };
        }
        return { input, lookup, ...scope() };
    };

    // On from `from` (null: the start) to the next ask, run or end. `past`: an ask whose input is already
    // filled is gone past this once, whatever it says (a screen just opened on the parameter it asked for).
    const go = async (from, past = false) => {
        if (busy) return;
        busy = true;
        try {
            const step = stepFrom(flow, from, await scopeNow(), { filled: (input) => Boolean(targets(input)?.filled()) });
            if (step.error) { at = null; say(null, `${flow.label ?? flow.name}: ${step.error}`); return; }
            for (const f of step.fills) targets(f.input)?.set(f.value);
            at = step.id;
            const n = step.node;
            if (n.kind === "ask") {
                const t = targets(n.input);
                // An input this page does not have: passed over.
                if (!t || (past && t.filled())) { busy = false; return go(step.id); }
                if (history[history.length - 1] !== step.id) history.push(step.id);
                say(n.prompt || n.label || null);
                // On a screen, its tab first.
                t.show?.();
                setTimeout(() => { mark(n.input); focus(t.control()); }, t.show ? 60 : 0);
                return;
            }
            if (n.kind === "run") {
                const form = formOf(n.transaction);
                if (!form) { say(null, `${n.label ?? at}: no form here to run${n.transaction ? ` (${n.transaction})` : ""}.`); return; }
                say(n.label || "Checking…");
                mark(null);
                pending = { node: n, id: step.id, form };
                setTimeout(() => form.primary()?.click(), 0);
                return;
            }
            // The end: the next one from the start, or stop here.
            history.length = 0;
            mark(null);
            if (n.then === "stop") { at = null; say(n.label || "Done."); doc.activeElement?.blur?.(); return; }
            busy = false;
            return go(null);
        } finally {
            busy = false;
        }
    };
    let pending = null; // the run under way: { node, id, form }

    // A run: checked → confirmed (by itself, or Enter on Confirm); done → on past it; refused → back to
    // the ask of what was refused, else the last ask.
    for (const form of Object.values(forms)) {
        stops.push(api.bindState(() => Boolean(api.getState(form.preview, null)), (on) => {
            if (!on || !pending || pending.form !== form) return;
            setTimeout(() => {
                if (pending.node.confirm === "auto" && !form.signs) form.confirm()?.click();
                else focus(form.signs ? rootOf()?.querySelector(".tx-sign input") ?? form.confirm() : form.confirm());
            }, 0);
        }));
        stops.push(api.bindState(() => Boolean(api.getState(form.done, null)), (on) => {
            if (!on || !pending || pending.form !== form) return;
            const id = pending.id;
            pending = null;
            records.clear();
            setTimeout(() => go(id), 0);
        }));
        stops.push(api.bindState(() => Object.keys(api.getState(form.errors, {}) ?? {}).length, (n) => {
            if (!n || !pending || pending.form !== form) return;
            pending = null;
            const back = history[history.length - 1];
            if (back) { at = back; say(nodes[back]?.prompt || nodes[back]?.label || null, "Check what it says, then go on."); mark(nodes[back].input); setTimeout(() => focus(targets(nodes[back].input)?.control()), 0); }
        }));
    }

    const current = () => (at && nodes[at]?.kind === "ask" ? nodes[at] : null);
    const isCurrent = (el) => { const n = current(); const c = n && targets(n.input)?.control(); return Boolean(c && (c === el || c.contains(el))); };
    // On from the ask, unless its input shows an error (onError "stay", the default): then the cursor stays.
    const onward = (el) => { const n = current(); leaveUnlessError(el, () => go(at), { stay: n?.onError !== "go" }); };
    const keydown = (e) => {
        const root = rootOf();
        if (e.isComposing || !root || !root.contains(e.target)) return;
        const n = current();
        // Ctrl/⌘+Enter: the form's main button, wherever the cursor is.
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { const form = formOf(pending?.node.transaction ?? null); e.preventDefault(); e.target.blur?.(); setTimeout(() => (form ?? Object.values(forms)[0])?.primary()?.click(), 0); return; }
        // Esc: out of a check, back to the last ask; else back to the ask before.
        if (e.key === "Escape") {
            const form = pending?.form;
            if (form && api.peek(form.preview)) { e.preventDefault(); api.setValue(form.preview, null); pending = null; }
            else if (history.length > 1 && isCurrent(e.target)) { e.preventDefault(); history.pop(); }
            else return;
            const back = history[history.length - 1];
            if (back) { at = back; say(nodes[back].prompt || nodes[back].label || null); mark(nodes[back].input); focus(targets(nodes[back].input)?.control()); }
            return;
        }
        if (!n || !isCurrent(e.target)) return;
        const t = targets(n.input);
        // A screen's parameter is its own: chosen, the screen opens on it, and the flow goes on from there.
        if (t?.param) return;
        // A scan finds its record first (records.js ScanField: Enter), then says so (mes-advance). A
        // reference picked from a list is like any other input.
        const scan = Boolean(e.target.closest?.(".scan-field"));
        if (scan && e.key === "Enter") return;
        if (!advances(n, e, { complete: entryComplete(n, e.target.value) })) {
            // Enter where the ask moves on by another key: kept from the form (it is not its key).
            if (e.key === "Enter" && n.advance && !["enter", "enter_or_tab", "auto"].includes(n.advance)) e.preventDefault();
            return;
        }
        e.preventDefault();
        // A scan moved on by another key: found first (asked as Enter asks it), then on.
        if (scan) { awaiting = e.target; e.target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return; }
        onward(e.target);
    };
    // A scan that found its record on Enter (records.js ScanField), or one this left by another key.
    let awaiting = null;
    const advanced = (e) => {
        const n = current();
        if (awaiting && e.target === awaiting) { awaiting = null; leaveUnlessError(e.target, () => go(at), { stay: n?.onError !== "go" }); return; }
        if (n && isCurrent(e.target) && n.advance !== "key" && n.advance !== "tab") leaveUnlessError(e.target, () => go(at), { stay: n.onError !== "go" });
    };
    const resolved = (e) => { if (awaiting && e.target === awaiting) { awaiting = null; setTimeout(() => go(at), 0); } };
    const changed = (e) => {
        const n = current();
        if (!n || n.advance !== "auto" || !isCurrent(e.target)) return;
        if (e.target.tagName === "SELECT" || e.target.type === "checkbox" || e.target.type === "radio") onward(e.target);
    };
    const typed = (e) => { const n = current(); if (n?.advance === "auto" && isCurrent(e.target) && e.target.tagName !== "SELECT" && entryComplete(n, e.target.value)) onward(e.target); };
    doc.addEventListener("keydown", keydown);
    doc.addEventListener("mes-advance", advanced);
    doc.addEventListener("mes-resolved", resolved);
    doc.addEventListener("change", changed);
    doc.addEventListener("input", typed);
    stops.push(() => { doc.removeEventListener("keydown", keydown); doc.removeEventListener("mes-advance", advanced); doc.removeEventListener("mes-resolved", resolved); doc.removeEventListener("change", changed); doc.removeEventListener("input", typed); });

    return {
        // Begin (or go on from where it was: a screen opened again with its parameter).
        start(from = null, { past = false } = {}) { setTimeout(() => go(from, past), 0); },
        // The cursor back to the ask it is at (a tab shown again), or begin.
        resume() { const n = current(); if (n) { mark(n.input); setTimeout(() => focus(targets(n.input)?.control()), 0); } else if (!pending) setTimeout(() => go(null), 0); },
        restart() { history.length = 0; pending = null; setTimeout(() => go(null), 0); },
        at: () => at,
        stop() { mark(null); for (const s of stops) s(); },
    };
}
