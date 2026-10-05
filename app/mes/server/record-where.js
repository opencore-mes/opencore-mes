// Records of one object in use whose fields equal given values (a list: any of them), as SQL: what a
// transaction's `count` (§25) and a screen's tables and numbers (§26) select. `where` is already
// worked out ({ machine: "<id>", state: ["processing"] }); its keys are fields, or state / type / id.
const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;

// The JSON values a field's text (data->>k) may be, for containment (data @> '{"k": …}'), which the
// GIN index serves (migrate-record-indexes.sql): the text itself, and the number or yes/no it spells.
// null when the text could be a list's or an object's, which containment cannot stand for.
function candidates(text) {
    if (/^\s*[[{]/.test(text)) return null;
    const out = [text];
    try {
        const v = JSON.parse(text);
        if (typeof v === "number" || typeof v === "boolean") out.push(v);
    } catch {}
    return out;
}
// An index-friendly condition implied by `data->>key = ANY(values)`, said beside it (never instead):
// the equality stays the condition, this only lets the index find the rows. null when it cannot.
export function containment(key, values, param) {
    const all = [];
    for (const v of values) {
        const c = candidates(String(v));
        if (!c) return null;
        all.push(...c);
    }
    if (!all.length || all.length > 50) return null;
    return `(${all.map((v) => `data @> ${param(JSON.stringify({ [key]: v }))}::jsonb`).join(" OR ")})`;
}

// → { sql: "object = $1 AND …", params } or null for a key that is not an identifier.
export function recordWhere(object, where = {}, { since = null } = {}) {
    const params = [object];
    const parts = ["object = $1", "archived_at IS NULL"];
    for (const [k, v] of Object.entries(where)) {
        if (!IDENTIFIER.test(k)) return null;
        const column = k === "state" || k === "type" ? k : k === "id" ? "id::text" : `data->>${`$${params.push(k)}`}`;
        if (v === null || v === undefined) parts.push(`${column} IS NULL`);
        else {
            const values = (Array.isArray(v) ? v : [v]).map(String);
            parts.push(Array.isArray(v) ? `${column} = ANY($${params.push(values)}::text[])` : `${column} = $${params.push(values[0])}`);
            if (column.startsWith("data")) {
                const quick = containment(k, values, (x) => `$${params.push(x)}`);
                if (quick) parts.push(quick);
            }
        }
    }
    if (since) parts.push(`updated_at >= $${params.push(since)}`);
    return { sql: parts.join(" AND "), params };
}
