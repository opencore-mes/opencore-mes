// Records read in the database with one person's rights (DESIGN.md §9, §10.1, §26): what lists,
// screens and searches count, sort, search and page, so a number is exact and an old record is found
// however many records an object has. The person's policies are compiled into the query (query.js
// compiles them the same way into the query views, with the viewer as a row there; here the viewer
// is known, so their roles pick the rules and what a condition reads of them is a literal). The
// semantics are policy.js `decide`: a row they may not read is not there, a field they may not read
// matches nothing and sorts last. The rows read are still masked by policy.js before they go out.
import { conditionSql, column, lit, jsonLit } from "./query.js";
import { readAllRule } from "./policy.js";
import { READ_ALL_ROLE } from "../client/definition.js";

// A path read from the person, as expr.js reads one (own properties only).
function readPath(scope, path) {
    let value = scope;
    for (const part of String(path).split(".")) {
        if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
        value = value[part];
    }
    return value;
}

// What `actor` may read of `definition`'s records, as SQL over the alias `r`: { read, field(name) },
// or null when a condition is beyond what compiles (arithmetic, a list's items): the caller then
// reads as before, and policy.js decides row by row.
export function rightsSql(definition, actor, r = "r") {
    const held = new Set(actor.roles ?? []);
    const rules = [...(definition.policies ?? []), ...(held.has(READ_ALL_ROLE) ? [readAllRule(definition)] : [])]
        .filter((rule) => (rule.roles ?? []).some((role) => held.has(role)) && (rule.via === undefined || (Array.isArray(rule.via) && rule.via.includes(actor.via))));
    const env = { alias: r, user: (path) => { const v = readPath(actor, path); return v === undefined ? "NULL::jsonb" : jsonLit(v); } };
    let applies;
    try {
        applies = rules.map((rule) => conditionSql(rule.when, env));
    } catch {
        return null;
    }
    const anyOf = (pick) => {
        const parts = rules.map((rule, k) => (pick(rule) ? applies[k] : null)).filter(Boolean);
        return parts.includes("true") ? "true" : parts.length ? `(${parts.join(" OR ")})` : "false";
    };
    const read = anyOf((rule) => Boolean(rule.record?.read));
    const field = (name) => {
        const granted = anyOf((rule) => ["read", "write"].includes(rule.fields?.[name] ?? rule.fields?.["*"]));
        const hidden = anyOf((rule) => (Array.isArray(rule.deny?.read) ? rule.deny.read : []).includes(name));
        if (granted === "false" || hidden === "true") return "false";
        return hidden === "false" ? granted : `(${granted} AND NOT ${hidden})`;
    };
    return { read, field };
}

// A field's value as the text search reads (client: String(value), a list joined by `joiner`).
const textOf = (name, joiner) => `(CASE jsonb_typeof(r.data->${lit(name)}) WHEN 'array' THEN array_to_string(ARRAY(SELECT jsonb_array_elements_text(r.data->${lit(name)})), ${lit(joiner)}) WHEN 'object' THEN NULL ELSE r.data->>${lit(name)} END)`;

// The order of client/sort.js compareValues, as ORDER BY terms: empty values last whichever way;
// numbers by value, yes before no as false < true; anything else as words, digits as numbers, case
// aside (the collation mes."natural", migrate-record-indexes.sql). `key` is SQL for the value when
// it is not the field itself (a reference sorted by its title).
export function orderSql(definition, rights, sort, key = null) {
    const dir = sort.dir === "desc" ? "DESC" : "ASC";
    const f = definition.fields[sort.field];
    let value;
    if (sort.field === "state") value = `NULLIF(r.state, '') COLLATE mes."natural"`;
    else if (key) value = `NULLIF(${key}, '') COLLATE mes."natural"`;
    else if (!f.multiple && ["integer", "decimal", "boolean"].includes(f.type)) value = column(sort.field, f);
    else value = `NULLIF(${textOf(sort.field, ", ")}, '') COLLATE mes."natural"`;
    const readable = sort.field === "state" ? "true" : rights.field(sort.field);
    const guarded = readable === "true" ? value : `CASE WHEN ${readable} THEN ${value} END`;
    return `${guarded} ${dir} NULLS LAST, r.updated_at DESC, r.id`;
}

// A search, as SQL over `r`: a readable field whose text contains `needle` (as the list and the
// navigator match it), or a state that does. `refs` ({ field: [ids] }, optional) stands for the
// records whose title matches, a reference matching by its title, not its value. → SQL with an
// index-friendly part first: the record's JSON text containing the words (trigrams), unless what
// is typed is spelled differently there (a quote, a backslash).
export function searchSql(definition, rights, needle, param, { joiner = ", ", refs = null } = {}) {
    const like = param(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const states = (definition.states?.list ?? []).filter((s) => s.toLowerCase().includes(needle.toLowerCase()));
    const stateHit = states.length ? `r.state = ANY(${param(states)}::text[])` : null;
    const exact = [];
    const quick = [];
    for (const [name, f] of Object.entries(definition.fields)) {
        const readable = rights.field(name);
        if (readable === "false") continue;
        const guard = (sql) => (readable === "true" ? sql : `(${readable} AND ${sql})`);
        if (refs && f.type === "ref") {
            const ids = refs[name] ?? [];
            if (!ids.length) continue;
            exact.push(guard(`r.data->>${lit(name)} = ANY(${param(ids)}::text[])`));
            const c = ids.length <= 50 ? ids.map((id) => `r.data @> ${param(JSON.stringify({ [name]: id }))}::jsonb`) : null;
            if (c) quick.push(...c);
            else quick.push("true");
        } else exact.push(guard(`${textOf(name, joiner)} ILIKE ${like}`));
    }
    if (stateHit) { exact.push(stateHit); quick.push(stateHit); }
    if (!exact.length) return "false";
    // The JSON text holds every value as typed, but for a quote, a backslash or a control character.
    const plain = !/["\\\u0000-\u001f]/.test(needle);
    const prefilter = plain && !quick.includes("true") ? `(r.data::text ILIKE ${like}${quick.length ? ` OR ${quick.join(" OR ")}` : ""}) AND ` : "";
    return `${prefilter}(${exact.join(" OR ")})`;
}

// The title a record shows under a reference (services.js withTitles): its title field when readable
// and set, else the start of its id.
export function titleSql(definition, rights, r = "r") {
    const t = definition.titleField;
    const readable = t ? rights.field(t) : "false";
    if (readable === "false") return `left(${r}.id::text, 8)`;
    const value = `CASE jsonb_typeof(${r}.data->${lit(t)}) WHEN 'null' THEN NULL ELSE ${r}.data->>${lit(t)} END`;
    return `coalesce(${readable === "true" ? value : `CASE WHEN ${readable} THEN ${value} END`}, left(${r}.id::text, 8))`;
}
