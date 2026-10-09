// Input flows (DESIGN.md §32.13): how a person fills a transaction, or a screen, from the keyboard or a
// scanner, without a mouse. A flow template of kind "input", drawn in the Flow designer like a route or
// a plan, and named by any number of transactions (inputFlow) and screens (inputFlow):
//   start
//   ask      { input, prompt?, advance?, key?, length?, pattern?, skipIfFilled?, onError? }
//            the cursor to one input: a transaction's input by name; on a screen, "param" (what it is
//            opened with) or "<transaction>.<input>" (a transaction block's; the name alone when the
//            screen has one). What moves on from it (advance): enter (the default; a scanner's too), tab,
//            enter_or_tab, key (one key: F1–F12, or a scanner's suffix character), or auto (by itself: a
//            scan that found its record, a choice picked, or the entry reaching `length` characters or
//            matching `pattern`). An input already filled (by the screen, a row, a fill) is passed over
//            unless skipIfFilled is false. While its field shows an error (or it is required and empty),
//            the cursor stays on it (onError "stay", the default); onError "go" moves on regardless.
//   fill     { input, value }        an input set to an expression's value, on the way
//   auto_decision                     its wires' conditions (when), tried in order; the last may have none
//   run      { transaction?, confirm? }  the form's Check, then Confirm: the person confirms (confirm
//            "ask", the default: Enter on Confirm) or it does once checked ("auto"). A signature is always
//            asked for. On a screen, which transaction block (its name), when it has several.
//   end      { then? }                "repeat" (the default): back to the start for the next one; "stop"
// Conditions and values read { input: "lot" } (an input's value), { lookup: "lot.state" } (a field, or
// the state, of the record an input names), { param: "equipment" } and { user: "id" }.
import { evaluate, referencesOf } from "./expr.js";

export const INPUT_FLOW_NODES = ["start", "ask", "fill", "auto_decision", "run", "end"];
export const ADVANCE = ["enter", "tab", "enter_or_tab", "key", "auto"];
export const ADVANCE_WORDS = { enter: "Enter (a scanner's too)", tab: "Tab", enter_or_tab: "Enter or Tab", key: "A key of its own", auto: "By itself, once complete" };
// One key an ask may move on with: F1–F12, or one character that is neither a letter nor a digit (a
// scanner's suffix: *, #, ~); letters and digits are what people type.
export const ADVANCE_KEY = /^(F([1-9]|1[0-2])|[^\sA-Za-z0-9])$/;
// What an ask names: an input, "param", or "<transaction>.<input>".
export const ASK_TARGET = /^(param|[a-z][a-z0-9_]{0,47}(\.[a-z][a-z0-9_]{0,47})?)$/;
export const INPUT_FLOW_SCOPES = ["input", "lookup", "param", "user"];

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// What a flow asks for, fills and runs: for checking the transactions and screens that name it.
// → { asks: [{ id, input }], fills: [{ id, input }], runs: [{ id, transaction }] }
export function inputFlowSummary(body) {
    const nodes = Object.entries(isPlain(body?.nodes) ? body.nodes : {});
    return {
        asks: nodes.filter(([, n]) => n?.kind === "ask" && typeof n.input === "string").map(([id, n]) => ({ id, input: n.input })),
        fills: nodes.filter(([, n]) => n?.kind === "fill" && typeof n.input === "string").map(([id, n]) => ({ id, input: n.input })),
        runs: nodes.filter(([, n]) => n?.kind === "run").map(([id, n]) => ({ id, transaction: typeof n.transaction === "string" ? n.transaction : null })),
    };
}

// What is wrong with an input flow's condition or value: it reads its inputs, the records they name,
// the screen's parameter and the person.
export function inputFlowExprProblems(expr) {
    try {
        return referencesOf(expr).filter((r) => !INPUT_FLOW_SCOPES.includes(r.scope)).map((r) => `it reads ${r.scope}, but an input flow reads its inputs ({"input": "lot"}), the records they name ({"lookup": "lot.state"}), the screen's parameter ({"param": "equipment"}) and the person ({"user": "id"}).`);
    } catch (error) {
        return [error.message];
    }
}

// What its conditions read as `input`, from [ask target, value] pairs: a screen's "<transaction>.<input>" nested
// under its transaction, as `{ "input": "take_in.condition" }` reads it (a dotted path goes down), the rest
// as they are.
export function inputScope(pairs, into = {}) {
    for (const [name, value] of pairs) {
        const [tx, field] = String(name).split(".");
        if (field === undefined) into[tx] = value;
        else into[tx] = { ...(isPlain(into[tx]) ? into[tx] : {}), [field]: value };
    }
    return into;
}

// The node an ask, a run or an end stops at, walking on from `from` (null: the start) through fills and
// decisions. `scope`: { input, lookup, param, user }, updated by the fills on the way; `filled(input)`:
// whether an input holds a value (an ask on one is passed over). → { id, node, fills: [{ input, value }] }
// or { error } (a decision with no way to take, a circle without an ask).
export function stepFrom(body, from, scope, { filled = () => false } = {}) {
    const nodes = isPlain(body?.nodes) ? body.nodes : {};
    const edges = list(body?.edges);
    const onward = (id) => edges.filter((e) => e?.from === id);
    const fills = [];
    const local = { ...scope, input: inputScope(Object.entries(scope?.input ?? {})) };
    let id = from ?? Object.entries(nodes).find(([, n]) => n?.kind === "start")?.[0];
    if (!id) return { error: "It has no start." };
    let leaving = from !== null && from !== undefined;
    for (let guard = 0; guard < 200; guard++) {
        const n = nodes[id];
        if (!n) return { error: `"${id}" is not one of its steps.` };
        if (!leaving) {
            if (n.kind === "ask" && !(n.skipIfFilled !== false && filled(n.input, local))) return { id, node: n, fills };
            if (n.kind === "run" || n.kind === "end") return { id, node: n, fills };
            if (n.kind === "fill") {
                const value = evaluate(n.value, local);
                fills.push({ input: n.input, value });
                inputScope([[n.input, value]], local.input);
            }
        }
        leaving = false;
        const ways = onward(id);
        const next = n.kind === "auto_decision" ? ways.find((e) => e.when === undefined || Boolean(evaluate(e.when, local))) : ways[0];
        if (!next) return { error: `${n.label ?? id}: no way on from it${n.kind === "auto_decision" ? " (none of its conditions holds)" : ""}.` };
        id = next.to;
    }
    return { error: "It goes round without asking for anything." };
}

// Whether a key press moves on from an ask. `complete`: whether its entry is complete (auto).
export function advances(node, e, { complete = false } = {}) {
    const how = ADVANCE.includes(node?.advance) ? node.advance : "enter";
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (how === "enter") return e.key === "Enter";
    if (how === "tab") return e.key === "Tab" && !e.shiftKey;
    if (how === "enter_or_tab") return e.key === "Enter" || (e.key === "Tab" && !e.shiftKey);
    if (how === "key") return e.key === node.key;
    return e.key === "Enter" && complete;
}

// Whether an ask's entry is complete, for advance "auto": text of its length, or matching its pattern.
export function entryComplete(node, text) {
    const t = String(text ?? "");
    if (Number.isInteger(node?.length) && t.length >= node.length) return true;
    if (typeof node?.pattern === "string" && node.pattern) { try { return new RegExp(`^(?:${node.pattern})$`).test(t); } catch { return false; } }
    return false;
}

// Problems with an input flow's own steps (validateFlow, kind "input"), each { path, message }.
export function inputFlowNodeProblems(id, n, add) {
    const at = `nodes.${id}`;
    const name = n.label ?? id;
    if (n.onEnter !== undefined || n.onExit !== undefined) add(at, `${name}: an input flow runs in the browser, as the person types: its steps run no scripts.`);
    if (n.kind === "ask") {
        if (typeof n.input !== "string" || !ASK_TARGET.test(n.input)) add(at, `${name}: name the input it asks for: an input of the transaction, or on a screen "param" or "<transaction>.<input>".`);
        if (n.prompt !== undefined && (typeof n.prompt !== "string" || n.prompt.length > 200)) add(at, `${name}: its prompt is words, at most 200 characters.`);
        if (n.advance !== undefined && !ADVANCE.includes(n.advance)) add(at, `${name}: it moves on by ${ADVANCE.join(", ")}.`);
        if (n.advance === "key" && !ADVANCE_KEY.test(n.key ?? "")) add(at, `${name}: name its key: F1 to F12, or one character that is not a letter or a digit (a scanner's suffix, such as * or #).`);
        if (n.key !== undefined && n.advance !== "key") add(at, `${name}: a key is for advance "key".`);
        if (n.length !== undefined && (!Number.isInteger(n.length) || n.length < 1 || n.length > 200)) add(at, `${name}: its length is a whole number from 1 to 200.`);
        if (n.pattern !== undefined) { try { if (typeof n.pattern !== "string" || n.pattern.length > 200) throw new Error(); new RegExp(n.pattern); } catch { add(at, `${name}: its pattern is a regular expression, at most 200 characters.`); } }
        if ((n.length !== undefined || n.pattern !== undefined) && n.advance !== "auto") add(at, `${name}: a length or a pattern is for advance "auto".`);
        if (n.skipIfFilled !== undefined && typeof n.skipIfFilled !== "boolean") add(at, `${name}: skipIfFilled is true or false.`);
        if (n.onError !== undefined && !["stay", "go"].includes(n.onError)) add(at, `${name}: onError is "stay" (the cursor stays while its input shows an error, the default) or "go".`);
    }
    if (n.kind === "fill") {
        if (typeof n.input !== "string" || !ASK_TARGET.test(n.input) || n.input === "param") add(at, `${name}: name the input it fills.`);
        if (n.value === undefined) add(at, `${name}: give the value it fills in (value).`);
        else for (const m of inputFlowExprProblems(n.value)) add(at, `${name}, value: ${m}`);
    }
    if (n.kind === "run") {
        if (n.transaction !== undefined && !/^[a-z][a-z0-9_]{0,47}$/.test(n.transaction ?? "")) add(at, `${name}: transaction names the transaction it runs (on a screen with several).`);
        if (n.confirm !== undefined && !["ask", "auto"].includes(n.confirm)) add(at, `${name}: confirm is "ask" (the person confirms) or "auto" (confirmed once checked).`);
    }
    if (n.kind === "end" && n.then !== undefined && !["repeat", "stop"].includes(n.then)) add(at, `${name}: then is "repeat" (back to the start) or "stop".`);
}

// What is wrong with a transaction's or a screen's inputFlow, against the flow it names (summaries:
// known.inputFlows). `targets(input)` → null (fine) or the words of what is wrong; `runs(transaction)` likewise.
export function inputFlowUseProblems(name, known, { targets, runs }) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,47}$/.test(name)) return ["inputFlow names an input flow: a flow template of kind input."];
    const summaries = known?.inputFlows;
    if (!summaries) return [];
    const f = summaries[name];
    if (!f) return [`"${name}" is not an input flow (a flow template of kind input).`];
    const out = [];
    for (const a of f.asks) { const m = targets(a.input, "ask"); if (m) out.push(`${name} asks for ${a.input}: ${m}`); }
    for (const a of f.fills) { const m = targets(a.input, "fill"); if (m) out.push(`${name} fills ${a.input}: ${m}`); }
    for (const r of f.runs) { const m = runs(r.transaction); if (m) out.push(`${name} runs ${r.transaction ?? "the form"}: ${m}`); }
    return out;
}

// The file types a collected file may be opened as in the browser, beside the page (§32): pictures, a
// PDF, plain text. Anything else (HTML, SVG, a script) would run as this site, with the session of
// whoever opens it, so it is kept and handed back as bytes to save, whatever its sender called it.
export const INLINE_FILE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;
export const fileTypeOf = (type) => (INLINE_FILE.test(String(type ?? "")) ? String(type) : "application/octet-stream");
