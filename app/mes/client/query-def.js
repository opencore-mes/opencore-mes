// Named queries (DESIGN.md §23.1): a SELECT over the query views, kept as a design element of its own,
// with parameters by name. What the designer and the server both check, and how a query's text is made
// ready to run; nothing here runs it (server/query.js runs it as the person it is for).
//
//   { name, label, description?, sql, params: { name: { type, label?, required? } }, limit?, tests?, http?, deprecated?, stewards }
//
//   paramsIn(sql)                 → { names: [in order of first use], problems: [words] }
//   bindNamed(sql, params, values) → { text (":name" made "$n"), values: [typed, in $n order], problems }
//   validateQuery(body, known)   → [{ path, message }]
//   queryFootprint(name, before, after) → [{ element: "query:<name>[.<key>]", change, stewards }]
// Shared by the browser, so it imports only web-publish.js (which imports nothing) and keeps to the browser
// floor (no lookbehind).
import { webProblems, deprecationProblems } from "./web-publish.js";

export const QUERY_KEYS = ["label", "description", "sql", "params", "limit", "tests", "http", "deprecated", "stewards"];
export const PARAM_TYPES = ["string", "integer", "decimal", "boolean", "date"];
export const QUERY_LIMIT = { default: 200, max: 1000 };
const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_SQL = 20000;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const QUERY_TEMPLATE = (name, label, stewards) => ({
    name, label: (typeof label === "string" && label.trim()) || name.replace(/_/g, " "), description: "",
    sql: "SELECT id, state\nFROM lot\nWHERE state = :state\nORDER BY updated_at DESC",
    params: { state: { type: "string", label: "State", required: true } },
    limit: QUERY_LIMIT.default, tests: [{ name: "created lots", params: { state: "created" } }], stewards,
});

// The ":name" parameters a text uses, walked by hand so that what is in a string, a quoted name, a
// comment, a dollar-quoted body or a "::" cast is never taken for one.
function scan(sql, onParam) {
    const s = String(sql ?? "");
    let out = "";
    let i = 0;
    const word = (at) => { let j = at; while (j < s.length && /[a-z0-9_]/.test(s[j])) j++; return s.slice(at, j); };
    while (i < s.length) {
        const c = s[i];
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < s.length && !(s[j] === c && s[j + 1] !== c)) j += s[j] === c ? 2 : 1;
            out += s.slice(i, j + 1); i = j + 1; continue;
        }
        if (c === "-" && s[i + 1] === "-") { const j = s.indexOf("\n", i); const end = j < 0 ? s.length : j; out += s.slice(i, end); i = end; continue; }
        if (c === "/" && s[i + 1] === "*") { const j = s.indexOf("*/", i + 2); const end = j < 0 ? s.length : j + 2; out += s.slice(i, end); i = end; continue; }
        if (c === "$") {
            const tag = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
            if (tag) { const j = s.indexOf(tag[0], i + tag[0].length); const end = j < 0 ? s.length : j + tag[0].length; out += s.slice(i, end); i = end; continue; }
        }
        if (c === ":" && s[i + 1] === ":") { out += "::"; i += 2; continue; }
        if (c === ":" && /[a-z]/.test(s[i + 1] ?? "")) { const name = word(i + 1); out += onParam(name); i += 1 + name.length; continue; }
        out += c; i++;
    }
    return out;
}

export function paramsIn(sql) {
    const names = [];
    const problems = [];
    scan(sql, (name) => { if (!names.includes(name)) names.push(name); return ""; });
    if (/\$\d/.test(scan(sql, () => ""))) problems.push("Name its parameters (:family), not by number ($1).");
    return { names, problems };
}

// The names a query's text reads, outside its strings and comments (bare ones lower-cased): what a change to an
// object's fields is checked against, so a query that reads a field the change takes away is said (§23.1).
export function namesIn(sql) {
    const text = String(sql ?? "").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, " ");
    const out = new Set();
    for (const m of text.matchAll(/"((?:[^"]|"")+)"|[A-Za-z_][A-Za-z0-9_$]*/g)) out.add(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[0].toLowerCase());
    return out;
}

// A value as its parameter's type wants it: { ok, value } or { ok: false, message }.
export function asParam(spec, v) {
    const type = spec?.type ?? "string";
    if (v === undefined || v === null || v === "") return { ok: true, value: null };
    if (type === "string") return typeof v === "object" ? { ok: false, message: "is not text" } : { ok: true, value: String(v).slice(0, 4000) };
    if (type === "integer") { const n = Number(v); return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, message: "is not a whole number" }; }
    if (type === "decimal") { const n = Number(v); return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: "is not a number" }; }
    if (type === "boolean") return typeof v === "boolean" ? { ok: true, value: v } : v === "true" || v === "false" ? { ok: true, value: v === "true" } : { ok: false, message: "is not true or false" };
    if (type === "date") return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? { ok: true, value: String(v).slice(0, 10) } : { ok: false, message: "is not a date (YYYY-MM-DD)" };
    return { ok: false, message: `has an unknown type ${type}` };
}

// The text ready to run (each ":name" a "$n"), and its values typed: problems name a required value
// missing or one of the wrong type, in words for whoever gave them.
export function bindNamed(sql, params, values = {}) {
    const order = [];
    const problems = [];
    const text = scan(sql, (name) => {
        let n = order.indexOf(name);
        if (n < 0) { order.push(name); n = order.length - 1; }
        return `$${n + 1}`;
    });
    const typed = order.map((name) => {
        const spec = isPlain(params) ? params[name] : undefined;
        if (!spec) { problems.push(`:${name} is not one of its parameters.`); return null; }
        const got = asParam(spec, isPlain(values) ? values[name] : undefined);
        if (!got.ok) { problems.push(`${spec.label ?? name} ${got.message}.`); return null; }
        if (got.value === null && spec.required) problems.push(`${spec.label ?? name} is required.`);
        return got.value;
    });
    return { text, values: typed, names: order, problems };
}

export function validateQuery(body, known = {}) {
    const problems = [];
    const add = (path, message) => problems.push({ path, message });
    if (!isPlain(body)) return [{ path: "", message: "A query is an object." }];
    if (!NAME.test(body.name ?? "")) add("name", "A query's name is lower case letters, digits and _, starting with a letter.");
    if (!(typeof body.label === "string" && body.label.trim()) || body.label.length > 120) add("label", "Give the query a label, at most 120 characters.");
    if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 1000)) add("description", "The description is text, at most 1000 characters.");
    for (const k of Object.keys(body)) if (k !== "name" && !QUERY_KEYS.includes(k)) add(k, `A query has no "${k}".`);
    const sql = typeof body.sql === "string" ? body.sql.trim().replace(/;\s*$/, "") : "";
    if (!sql) add("sql", "Write its SELECT.");
    else if (sql.length > MAX_SQL) add("sql", `At most ${MAX_SQL} characters.`);
    else {
        if (!/^(select|with)\b/i.test(sql)) add("sql", "A query is one SELECT (or WITH … SELECT): it reads, never writes.");
        if (scan(sql, () => "").includes(";")) add("sql", "One statement only.");
    }
    const params = body.params === undefined ? {} : body.params;
    if (!isPlain(params)) add("params", "Its parameters are { name: { type, label?, required? } }.");
    else {
        for (const [name, spec] of Object.entries(params)) {
            const at = `params.${name}`;
            if (!NAME.test(name)) add(at, `"${name}": a parameter's name is lower case letters, digits and _.`);
            if (!isPlain(spec) || !PARAM_TYPES.includes(spec.type)) { add(at, `${name}: its type is one of ${PARAM_TYPES.join(", ")}.`); continue; }
            for (const k of Object.keys(spec)) if (!["type", "label", "required"].includes(k)) add(at, `${name}: a parameter has no "${k}".`);
            if (spec.label !== undefined && (typeof spec.label !== "string" || spec.label.length > 80)) add(at, `${name}: its label is text, at most 80 characters.`);
            if (spec.required !== undefined && typeof spec.required !== "boolean") add(at, `${name}: required is true or false.`);
        }
        if (sql) {
            const { names, problems: p } = paramsIn(sql);
            for (const m of p) add("sql", m);
            for (const n of names) if (!Object.hasOwn(params, n)) add("sql", `:${n} is used but not declared: add it to its parameters.`);
            for (const n of Object.keys(params)) if (!names.includes(n)) add(`params.${n}`, `${n} is declared but the SELECT never uses :${n}.`);
        }
    }
    if (body.limit !== undefined && !(Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= QUERY_LIMIT.max)) add("limit", `Its limit is a whole number from 1 to ${QUERY_LIMIT.max}.`);
    if (body.tests !== undefined) {
        if (!Array.isArray(body.tests) || body.tests.length > 20) add("tests", "Its tests are a list, at most 20.");
        else body.tests.forEach((t, i) => {
            if (!isPlain(t) || typeof t.name !== "string" || !t.name.trim()) add(`tests.${i}`, `Test ${i + 1}: give it a name.`);
            else if (t.params !== undefined && !isPlain(t.params)) add(`tests.${i}`, `${t.name}: its params are { name: value }.`);
            else if (isPlain(params) && sql) for (const m of bindNamed(sql, params, t.params ?? {}).problems) add(`tests.${i}`, `${t.name}: ${m}`);
        });
    }
    // Published over HTTP (§23.3, docs/contracts/http-apis): read by an outside system as its token's person, who
    // must be among its web callers (inside the platform it is a question, not a permission: anyone it serves).
    webProblems("query", body, known, add);
    deprecationProblems("query", body, add);
    const stewards = Array.isArray(body.stewards) ? body.stewards : [];
    if (!stewards.length) add("stewards", "Name at least one department that stewards it.");
    for (const d of stewards) if ((known.departments ?? []).length && !known.departments.includes(d)) add("stewards", `"${d}" is not a department.`);
    return problems;
}

// A query's footprint: its stewards. It reads; it writes nothing and grants nothing.
const sameAs = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function queryFootprint(name, before, after) {
    if (sameAs(before, after)) return [];
    const of = (b) => (Array.isArray(b?.stewards) ? b.stewards : []);
    const answer = [...new Set([...of(before), ...of(after)])].filter(Boolean).sort();
    const element = `query:${name}`;
    if (!before) return [{ element, change: "added", stewards: of(after).slice().sort() }];
    if (!after) return [{ element, change: "removed", stewards: of(before).slice().sort() }];
    return QUERY_KEYS.filter((k) => !sameAs(before[k], after[k])).map((k) => ({ element: `${element}.${k}`, change: "changed", stewards: answer }));
}

// An input screen's field of type "query" (§32.6): the options it shows, from the rows a query gave.
// value: the column kept; display: the columns shown, joined by separator.
export function optionsOf(field, ran) {
    const cols = Array.isArray(ran?.columns) ? ran.columns : [];
    const vi = cols.indexOf(field.value);
    const di = (Array.isArray(field.display) && field.display.length ? field.display : [field.value]).map((c) => cols.indexOf(c));
    if (vi < 0 || di.some((i) => i < 0)) return { options: [], missing: [field.value, ...(field.display ?? [])].filter((c) => !cols.includes(c)) };
    const sep = typeof field.separator === "string" ? field.separator : " · ";
    const seen = new Set();
    const options = [];
    for (const row of ran.rows ?? []) {
        const v = row[vi];
        if (v === null || v === undefined || typeof v === "object" || seen.has(String(v))) continue;
        seen.add(String(v));
        options.push({ value: v, label: di.map((i) => (row[i] === null || row[i] === undefined ? "" : String(row[i]))).filter(Boolean).join(sep) || String(v) });
    }
    return { options, missing: [] };
}
