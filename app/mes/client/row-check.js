// Checking a file's rows against their columns' constraints, one way for every import (DESIGN.md §24): a
// column says what it holds, and every row is checked and worded the same, whichever import it is (records
// of a model, people, …). Shared by the browser and the server.
//
//   a column: { key, label, type, required, pattern, patternWords, values, multiple, separator, lower, unique, ref, about }
//     type        "string" | "text" (kept as written, several lines) | "integer" | "decimal" | "boolean" | "date" | "enum" | "ref"
//     required    true, or "new" (for a row that makes something new only)
//     pattern     a RegExp the value matches, and patternWords: what it must be, in words
//     values      the allowed values (enum; a ref may list them too)
//     multiple    several values in the cell, separated by `separator` (a RegExp; ; or , by default)
//     lower       the value in lower case before it is checked
//     unique      once in the file (the row's key)
//     ref         { label, find(text) → id | null | "ambiguous", known() → [what there is], scope, hint }: a reference to
//                 something that must exist; `hint` says where it is made
//   checkCell(column, raw, { isNew, excelDate }) → { value } | { error }   (error: what it must be, in words)
//   checkRow(columns, cellOf, { isNew, excelDate, seen }) → { values, problems: { [key]: message } }
//   rowMessage(problems, columns) → "Departments: there is no department qa yet …; Name: required"
export const blank = (v) => v === null || v === undefined || v === "";
const YES = ["true", "yes", "1", "y", "x", "active"];
const NO = ["false", "no", "0", "n", "inactive"];
const quote = (v) => `"${String(v)}"`;
const list = (xs, n = 12) => (xs.length > n ? `${xs.slice(0, n).join(", ")} and ${xs.length - n} more` : xs.join(", "));

// One value of a cell, typed (a ref's id found), or what it must be instead.
function checkOne(col, raw, excelDate) {
    switch (col.type) {
        case "integer": {
            const n = typeof raw === "number" ? raw : Number(String(raw).trim());
            return Number.isInteger(n) ? { value: n } : { error: "a whole number" };
        }
        case "decimal": {
            const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace(/,(?=\d{3}\b)/g, ""));
            return Number.isFinite(n) ? { value: n } : { error: "a number" };
        }
        case "boolean": {
            if (typeof raw === "boolean") return { value: raw };
            const t = String(raw).trim().toLowerCase();
            if (YES.includes(t)) return { value: true };
            if (NO.includes(t)) return { value: false };
            return { error: "yes or no" };
        }
        case "date": {
            if (typeof raw === "number" && excelDate) return { value: excelDate(raw) };
            const t = String(raw).trim().slice(0, 10);
            return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { value: t } : { error: "a date (YYYY-MM-DD)" };
        }
        case "enum": {
            const t = String(raw).trim();
            return col.values?.includes(t) ? { value: t } : { error: `one of ${col.values?.join(", ")}` };
        }
        case "ref": {
            const t = String(raw).trim();
            const id = col.ref?.find(t);
            if (id === "ambiguous") return { error: `more than one ${col.ref.label} ${quote(t)}`, worded: true };
            if (!id) {
                const known = col.ref?.known?.() ?? null;
                return { error: `there is no ${col.ref?.label ?? "such"} ${quote(t)}${col.ref?.scope ? ` ${col.ref.scope}` : ""}${col.ref?.yet ? " yet" : ""}${known ? ` (${known.length ? `there are: ${list(known)}` : "there is none yet"})` : ""}${col.ref?.hint ? `. ${col.ref.hint}` : ""}`, worded: true };
            }
            return { value: id };
        }
        default:
            return { value: typeof raw === "number" ? String(raw) : String(raw) };
    }
}

export function checkCell(col, given, { isNew = false, excelDate = null } = {}) {
    // A cell's text trimmed (§11.1a; a multi-line text kept as written): a cell of only spaces is empty.
    let raw = typeof given === "string" ? (col.type === "text" ? (given.trim() ? given : "") : given.trim()) : given;
    if (col.lower && typeof raw === "string") raw = raw.toLowerCase();
    if (blank(raw)) {
        if (col.required === true || (col.required === "new" && isNew)) return { error: col.required === "new" ? "required for a new one" : "required", worded: true };
        return { value: col.multiple ? [] : null };
    }
    if (col.multiple) {
        const parts = [...new Set(String(raw).split(col.separator ?? /[;,]/).map((v) => v.trim()).filter(Boolean))];
        // Several of a fixed list: which are not in it, said at once.
        if (col.type === "enum") {
            const bad = parts.filter((v) => !col.values?.includes(v));
            return bad.length ? { error: `some of ${col.values?.join(", ")}; not ${bad.join(", ")}` } : { value: parts };
        }
        const out = [];
        for (const p of parts) {
            const one = checkOne(col, p, excelDate);
            if (one.error) return one;
            out.push(one.value);
        }
        return { value: out };
    }
    if (col.pattern && typeof raw === "string" && !col.pattern.test(raw)) return { error: `${quote(raw)} is not ${col.patternWords ?? "allowed here"}`, worded: true };
    return checkOne(col, raw, excelDate);
}

// A row: each column's cell checked; `seen` (a Set, kept across rows) for the unique column.
export function checkRow(columns, cellOf, { isNew = false, excelDate = null, seen = null } = {}) {
    const values = {};
    const problems = {};
    for (const col of columns) {
        const raw = cellOf(col.key);
        if (raw === undefined) continue;
        const r = checkCell(col, raw, { isNew, excelDate });
        if (r.error) { problems[col.key] = r.worded ? r.error : `${r.error}, not ${quote(String(raw).trim())}`; continue; }
        if (col.unique && seen && !blank(r.value)) {
            if (seen.has(r.value)) { problems[col.key] = `${quote(r.value)} is in the file twice: only its first row is taken`; continue; }
            seen.add(r.value);
        }
        values[col.key] = r.value;
    }
    return { values, problems };
}

// A row's problems in one line, each by its column's label, in the columns' order.
export function rowMessage(problems, columns) {
    return columns.filter((c) => problems[c.key]).map((c) => `${c.label}: ${problems[c.key]}`).join("; ");
}
