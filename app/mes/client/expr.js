// The expression language of policies and rule conditions (DESIGN.md §9.2, §12.3): JSON, never
// code. Parsed by walking it; nothing here builds a function from a string.
//
//   literal      "released", 3, true, null, ["a", "b"]
//   reference    { "record": "state" }  { "user": "id" }  { "data": "qty" }  { "event": "changed" }
//                { "person": "badge" }: a field of the built-in Person record of who acts (a transaction's)
//   comparison   { "eq": [a, b] }  ne  lt  le  gt  ge
//   membership   { "in": [value, list] }     { "contains": [list, value] }
//   logic        { "all": [...] }  { "any": [...] }  { "not": x }  { "is_null": a }
//   arithmetic   { "add": [a, b, …] }  { "sub": [a, b] }   (an empty value counts as 0)
//                { "mul": [a, b, …] }  { "div": [a, b] }   (an empty value, or a division by 0, gives no value)
//   over a list  { "some": [list, condition] }  { "every": [list, condition] }: the condition read
//                once per item, as { "row": "field" } (a transaction's rows input: its readings)
//   count        { "count": { "object": "lot", "where": { "machine": { "input": "machine" }, "state": ["processing"] } } }
//
// A screen's blocks (§26) read { "param": "machine" }, the value the screen was opened with.
// A transaction run on a traveler of a route (§32) also reads { "node": "lsl" }: a setting of the node
// the traveler is at (and { "node": "name" }, { "node": "label" }).
// A transaction's conditions (§25) also read { "input": "qty" } (what was entered; a reference is its
// record's id) and { "lookup": "machine.capacity" } (a field of the record an input names). A count is
// of an object's records in use whose fields equal the values given (a list: any of them); its value
// comes from the caller, which counts in the database (`countsOf` says what to count) and passes
// { counts: { [key]: n } } among the scopes.
//
// Shared by the server (policies, rule `when`) and the browser (rule `when`), so it imports nothing.

const COMPARE = {
    eq: (a, b) => a === b,
    ne: (a, b) => a !== b,
    lt: (a, b) => a < b,
    le: (a, b) => a <= b,
    gt: (a, b) => a > b,
    ge: (a, b) => a >= b,
};
const SYMBOL = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥" };
const SCOPES = ["record", "user", "data", "event", "input", "lookup", "param", "row", "node", "context", "person"];

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A path read from one scope. Own properties only, so "constructor" or "__proto__" read nothing.
function read(scope, path) {
    let value = scope;
    for (const part of String(path).split(".")) {
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
        value = value[part];
    }
    return value;
}

function referenceOf(node) {
    if (!isPlain(node)) return null;
    const keys = Object.keys(node);
    if (keys.length !== 1 || !SCOPES.includes(keys[0])) return null;
    return { scope: keys[0], path: node[keys[0]] };
}

function operatorOf(node) {
    if (!isPlain(node)) return null;
    const keys = Object.keys(node);
    if (keys.length !== 1) throw new TypeError(`expression: an operator node has one key, not ${keys.join(", ") || "none"}`);
    return keys[0];
}

// The value of `node` against `scopes` ({ record, user, data, event }).
export function evaluate(node, scopes) {
    return explain(node, scopes).value;
}

// The value, and in words why: { value, text, refs } where `refs` lists the references read, so a
// caller can hide a condition that read a field the reader may not see (§9.7).
export function explain(node, scopes = {}) {
    if (!isPlain(node)) {
        if (Array.isArray(node)) {
            const parts = node.map((item) => explain(item, scopes));
            return { value: parts.map((p) => p.value), text: `[${parts.map((p) => p.text).join(", ")}]`, refs: parts.flatMap((p) => p.refs) };
        }
        return { value: node, text: JSON.stringify(node), refs: [] };
    }
    const reference = referenceOf(node);
    if (reference) {
        const value = read(scopes[reference.scope], reference.path);
        return { value, text: `${reference.scope}.${reference.path}`, refs: [reference], read: value };
    }
    const op = operatorOf(node);
    const arg = node[op];
    if (op in COMPARE) {
        const [a, b] = arg.map((item) => explain(item, scopes));
        const value = COMPARE[op](a.value, b.value);
        return { value, text: `${a.text} ${SYMBOL[op]} ${b.text}${readNote(a, b)}`, refs: [...a.refs, ...b.refs] };
    }
    if (op === "in" || op === "contains") {
        const [first, second] = arg.map((item) => explain(item, scopes));
        const [item, list] = op === "in" ? [first, second] : [second, first];
        const value = Array.isArray(list.value) && list.value.includes(item.value);
        const text = op === "in" ? `${item.text} in ${list.text}` : `${list.text} contains ${item.text}`;
        return { value, text: `${text}${readNote(first, second)}`, refs: [...first.refs, ...second.refs] };
    }
    if (op === "all" || op === "any") {
        const parts = arg.map((item) => explain(item, scopes));
        const value = op === "all" ? parts.every((p) => p.value === true) : parts.some((p) => p.value === true);
        return { value, text: parts.map((p) => p.text).join(op === "all" ? " and " : " or "), refs: parts.flatMap((p) => p.refs), parts };
    }
    if (op === "not") {
        const inner = explain(arg, scopes);
        return { value: inner.value !== true, text: `not (${inner.text})`, refs: inner.refs };
    }
    if (op === "add" || op === "sub") {
        const parts = (Array.isArray(arg) ? arg : [arg]).map((item) => explain(item, scopes));
        const nums = parts.map((p) => (p.value === null || p.value === undefined || p.value === "" ? 0 : p.value));
        const value = nums.every((n) => typeof n === "number" && Number.isFinite(n))
            ? Math.round((op === "add" ? nums.reduce((a, b) => a + b, 0) : nums.slice(1).reduce((a, b) => a - b, nums[0] ?? 0)) * 1e9) / 1e9
            : null;
        return { value, text: `(${parts.map((p) => p.text).join(op === "add" ? " + " : " − ")})${readNote(...parts)}`, refs: parts.flatMap((p) => p.refs) };
    }
    if (op === "mul" || op === "div") {
        const parts = (Array.isArray(arg) ? arg : [arg]).map((item) => explain(item, scopes));
        const nums = parts.map((p) => p.value);
        let value = null;
        if (nums.length && nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
            if (op === "mul") value = Math.round(nums.reduce((a, b) => a * b, 1) * 1e9) / 1e9;
            else if (!nums.slice(1).includes(0)) value = Math.round(nums.slice(1).reduce((a, b) => a / b, nums[0]) * 1e9) / 1e9;
        }
        return { value, text: `(${parts.map((p) => p.text).join(op === "mul" ? " × " : " ÷ ")})${readNote(...parts)}`, refs: parts.flatMap((p) => p.refs) };
    }
    // Each item of a list read as { row } (a rows input's readings): whether some, or every, holds.
    if (op === "some" || op === "every") {
        const [listNode, condition] = Array.isArray(arg) ? arg : [];
        const list = explain(listNode, scopes);
        const items = Array.isArray(list.value) ? list.value : [];
        const parts = items.map((item) => explain(condition, { ...scopes, row: isPlain(item) ? item : { value: item } }));
        const value = op === "some" ? parts.some((p) => p.value === true) : parts.every((p) => p.value === true);
        const shape = parts[0]?.text ?? explain(condition, { ...scopes, row: {} }).text;
        return { value, text: `${op} of ${list.text}: ${shape}`, refs: [...list.refs, ...parts.flatMap((p) => p.refs)] };
    }
    if (op === "count") {
        const spec = countSpec(arg, scopes);
        const value = spec ? (scopes.counts?.[spec.key] ?? null) : null;
        const refs = referencesOf(Object.values(arg?.where ?? {}));
        return { value, text: `the number of ${arg?.object ?? "?"} where ${Object.entries(spec?.where ?? {}).map(([k, v]) => `${k} ${Array.isArray(v) ? `in ${JSON.stringify(v)}` : `= ${JSON.stringify(v)}`}`).join(" and ") || "anything"} (${value ?? "?"})`, refs };
    }
    if (op === "is_null") {
        const inner = explain(arg, scopes);
        return { value: inner.value === null || inner.value === undefined, text: `${inner.text} is empty`, refs: inner.refs };
    }
    throw new TypeError(`expression: unknown operator "${op}"`);
}

// "(value: 'released')" after a comparison that read a reference, so a reader sees what was compared.
function readNote(...sides) {
    const read = sides.filter((side) => "read" in side);
    if (!read.length) return "";
    return ` (value: ${read.map((side) => JSON.stringify(side.read ?? null)).join(", ")})`;
}

// Every reference an expression reads, without evaluating it: for a footprint (§5.6).
export function referencesOf(node) {
    if (Array.isArray(node)) return node.flatMap(referencesOf);
    if (!isPlain(node)) return [];
    const reference = referenceOf(node);
    if (reference) return [reference];
    const op = operatorOf(node);
    if (op === "count") return referencesOf(Object.values(isPlain(node.count?.where) ? node.count.where : {}));
    return referencesOf(node[op]);
}

// A count's object and its conditions with their values worked out, and the key its answer goes under.
function countSpec(arg, scopes) {
    if (!isPlain(arg) || typeof arg.object !== "string") return null;
    const where = Object.fromEntries(Object.entries(isPlain(arg.where) ? arg.where : {}).map(([k, v]) => [k, explain(v, scopes).value ?? null]));
    return { object: arg.object, where, key: JSON.stringify([arg.object, where]) };
}

// The counts an expression needs, against `scopes`: [{ object, where, key }], for the caller to count.
export function countsOf(node, scopes = {}) {
    if (Array.isArray(node)) return node.flatMap((n) => countsOf(n, scopes));
    if (!isPlain(node) || referenceOf(node)) return [];
    const op = operatorOf(node);
    if (op === "count") {
        const spec = countSpec(node.count, scopes);
        return [...(spec ? [spec] : []), ...countsOf(Object.values(node.count?.where ?? {}), scopes)];
    }
    return countsOf(node[op], scopes);
}

// Every count an expression makes, unevaluated: { object, where: { field: expression } } (for checks).
export function countNodesOf(node) {
    if (Array.isArray(node)) return node.flatMap(countNodesOf);
    if (!isPlain(node) || referenceOf(node)) return [];
    const op = operatorOf(node);
    if (op === "count") return [node.count, ...countNodesOf(Object.values(isPlain(node.count?.where) ? node.count.where : {}))];
    return countNodesOf(node[op]);
}
