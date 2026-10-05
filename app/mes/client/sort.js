// The order lists and tables use (DESIGN.md §10.1): empty values last; numbers by value; text by its
// words, digits compared as numbers ("9" before "10", "OP-2" before "OP-10"), case aside. Shared by
// the server (records.list, screens) and the page, so they sort alike.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareValues(a, b) {
    const ea = a === null || a === undefined || a === "";
    const eb = b === null || b === undefined || b === "";
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
    return collator.compare(Array.isArray(a) ? a.join(", ") : String(a), Array.isArray(b) ? b.join(", ") : String(b));
}

// Rows sorted by one of their values: `get(row)` gives it; `dir` "asc" | "desc" (empty values stay last).
export function sortRows(rows, get, dir = "asc") {
    return [...rows].sort((x, y) => {
        const a = get(x);
        const b = get(y);
        const empty = (v) => v === null || v === undefined || v === "";
        if (empty(a) || empty(b)) return compareValues(a, b);
        return dir === "desc" ? compareValues(b, a) : compareValues(a, b);
    });
}
