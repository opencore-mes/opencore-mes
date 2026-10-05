// People to and from a file (§27, the People tab of People & departments): a CSV that Excel opens, and
// whatever a spreadsheet saves back (comma, semicolon or tab). An import edits the draft only: it is
// a change like any other, reviewed and approved by governance and the departments concerned.
//
//   id, name, active, departments        departments: their ids, separated by spaces or commas
//
// Each row says what that person is: new ones are added, the others take the name, active and
// departments the row gives (a column left out, or an empty name or active, keeps what is there; an
// empty departments cell means none). People not in the file are left as they are: nobody leaves by
// being missing from a spreadsheet.
import { IDENTIFIER } from "./definition.js";

// The sign-in picker shows at most this many people at once; the server sends one more to say there are.
export const PICKER_SHOWN = 60;
// The People tab and a department's members draw at most this many rows at once.
export const PEOPLE_SHOWN = 100;

const COLUMNS = { id: ["id", "sign-in id", "user", "user id", "login"], name: ["name", "full name"], active: ["active"], departments: ["departments", "department"] };
const YES = new Set(["yes", "y", "true", "1", "active", "x"]);
const NO = new Set(["no", "n", "false", "0", "inactive", ""]);

// A name a spreadsheet would read as a formula is written with an apostrophe before it.
const guarded = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const cell = (v) => { const t = guarded(v); return /[",\n\r;\t]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t; };

// The people as a file, sorted by id, with a byte-order mark so Excel reads it as UTF-8.
export function peopleCsv(org) {
    const deps = Object.entries(org?.departments ?? {});
    const rows = Object.entries(org?.users ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, u]) => [
        id, u.name ?? "", u.active === false ? "no" : "yes", deps.filter(([, d]) => (d.members ?? []).includes(id)).map(([d]) => d).join(" "),
    ]);
    return `﻿${[["id", "name", "active", "departments"], ...rows].map((r) => r.map((v) => cell(String(v))).join(",")).join("\r\n")}\r\n`;
}

// RFC 4180, with the separator the header line uses. → [[cell]]
export function parseTable(text) {
    const src = String(text ?? "").replace(/^﻿/, "");
    const head = src.split(/\r?\n/, 1)[0] ?? "";
    const sep = head.includes("\t") ? "\t" : head.includes(";") && !head.includes(",") ? ";" : ",";
    const rows = [];
    let row = [], value = "", quoted = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quoted) {
            if (c === '"' && src[i + 1] === '"') { value += '"'; i++; } else if (c === '"') quoted = false; else value += c;
        } else if (c === '"' && value === "") quoted = true;
        else if (c === sep) { row.push(value); value = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && src[i + 1] === "\n") i++;
            row.push(value); value = "";
            if (row.some((v) => v.trim() !== "")) rows.push(row);
            row = [];
        } else value += c;
    }
    row.push(value);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    return rows;
}

// What a file does to the organization: the next one, what changed, and the rows it could not take.
// → { next, changes: { added, renamed, activated, deactivated, moved }, problems: [{ row, message }] }
export function importPeople(org, text) {
    const next = JSON.parse(JSON.stringify(org ?? {}));
    next.users ??= {};
    next.departments ??= {};
    const changes = { added: [], renamed: [], activated: [], deactivated: [], moved: [] };
    const problems = [];
    const [header, ...rows] = parseTable(text);
    if (!header) return { next, changes, problems: [{ row: 0, message: "The file is empty." }] };
    const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h.trim().toLowerCase()))]));
    if (at.id < 0) return { next, changes, problems: [{ row: 1, message: `No "id" column: the first row names the columns (id, name, active, departments).` }] };
    const seen = new Set();
    rows.forEach((r, k) => {
        const line = k + 2;
        const get = (col) => (at[col] < 0 ? undefined : String(r[at[col]] ?? "").trim());
        const id = get("id").toLowerCase();
        if (!IDENTIFIER.test(id)) return problems.push({ row: line, message: `"${get("id")}" is not an id: lowercase letters, digits and _, starting with a letter.` });
        if (seen.has(id)) return problems.push({ row: line, message: `${id} is in the file twice: only its first row is taken.` });
        seen.add(id);
        // The apostrophe an export put before a name a spreadsheet would read as a formula comes off.
        const name = get("name")?.replace(/^'(?=[=+\-@])/, "");
        const activeCell = get("active");
        const active = activeCell === undefined || activeCell === "" ? undefined : YES.has(activeCell.toLowerCase()) ? true : NO.has(activeCell.toLowerCase()) ? false : null;
        if (active === null) return problems.push({ row: line, message: `${id}: active is "${activeCell}"; write yes or no.` });
        const depCell = get("departments");
        const deps = depCell === undefined ? undefined : depCell.split(/[\s,;]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
        const unknown = (deps ?? []).filter((d) => !next.departments[d]);
        if (unknown.length) return problems.push({ row: line, message: `${id}: no department ${unknown.join(", ")} (departments are named by their id: ${Object.keys(next.departments).join(", ")}).` });
        const was = next.users[id];
        if (!was) {
            if (!name) return problems.push({ row: line, message: `${id} is new: give their name.` });
            next.users[id] = { name, active: active ?? true };
            changes.added.push(id);
        } else {
            if (name && name !== was.name) { changes.renamed.push(id); was.name = name; }
            if (active !== undefined && active !== (was.active !== false)) { (active ? changes.activated : changes.deactivated).push(id); was.active = active; }
        }
        if (deps !== undefined) {
            let moved = false;
            for (const [d, dept] of Object.entries(next.departments)) {
                const members = dept.members ?? [];
                const want = deps.includes(d);
                if (want === members.includes(id)) continue;
                moved = true;
                dept.members = want ? [...members, id] : members.filter((m) => m !== id);
                // Someone who leaves a department leaves its approval steps too.
                if (!want) for (const st of dept.approval ?? []) st.approvers = (st.approvers ?? []).filter((a) => a !== id);
            }
            if (moved && was) changes.moved.push(id);
        }
    });
    return { next, changes, problems };
}

// What an import changes, in words, for the confirmation. → string
export function importWords({ changes, problems }, org) {
    const name = (id) => org?.users?.[id]?.name ?? id;
    const list = (ids) => (ids.length > 6 ? `${ids.slice(0, 6).map(name).join(", ")} and ${ids.length - 6} more` : ids.map(name).join(", "));
    const lines = [
        changes.added.length && `${changes.added.length} new: ${list(changes.added)}`,
        changes.renamed.length && `${changes.renamed.length} renamed: ${list(changes.renamed)}`,
        changes.deactivated.length && `${changes.deactivated.length} made inactive: ${list(changes.deactivated)}`,
        changes.activated.length && `${changes.activated.length} active again: ${list(changes.activated)}`,
        changes.moved.length && `${changes.moved.length} in other departments: ${list(changes.moved)}`,
    ].filter(Boolean);
    if (problems.length) lines.push("", `${problems.length} row${problems.length === 1 ? "" : "s"} not taken:`, ...problems.slice(0, 8).map((p) => `  row ${p.row}: ${p.message}`), ...(problems.length > 8 ? [`  and ${problems.length - 8} more`] : []));
    return lines.join("\n");
}

// A search for people starts at this many letters: one matches nearly everyone.
export const MIN_SEARCH = 2;
// The words of a search, or none while it is shorter than MIN_SEARCH.
export const searchWords = (q) => { const t = String(q ?? "").trim().toLowerCase(); return t.length < MIN_SEARCH ? [] : t.split(/\s+/).filter(Boolean); };
// Whether a person fits every word: the start of a word of their name or department ("kow" finds
// Kowalski, "prod" Production), or anywhere in their sign-in id (ids carry numbers: "123" finds op01234).
export function personFits(words, id, name, departments = []) {
    const parts = `${name ?? ""} ${departments.join(" ")}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const lid = String(id).toLowerCase();
    return words.every((w) => lid.includes(w) || parts.some((p) => p.startsWith(w)));
}

// The people to show (§27): those `touched` (by this change) first, then whoever fits the search
// (personFits), by name. Nothing searched: the touched ones, and everyone else only when `all` (demos
// and test instances). → { ids, total, departmentsOf, short } (short: something typed, too little)
export function findPeople(org, q, { touched = [], all = false } = {}) {
    const departmentsOf = new Map();
    for (const d of Object.values(org?.departments ?? {})) for (const m of d.members ?? []) departmentsOf.set(m, [...(departmentsOf.get(m) ?? []), d.name]);
    const users = org?.users ?? {};
    const words = searchWords(q);
    const short = !words.length && String(q ?? "").trim().length > 0;
    const fits = (id) => !words.length || personFits(words, id, users[id]?.name, departmentsOf.get(id) ?? []);
    const first = touched.filter((id) => users[id] && fits(id));
    const seen = new Set(first);
    const rest = words.length || all
        ? Object.keys(users).filter((id) => !seen.has(id) && fits(id)).sort((a, b) => String(users[a].name ?? a).localeCompare(String(users[b].name ?? b)) || a.localeCompare(b))
        : [];
    const ids = [...first, ...rest];
    return { ids, total: ids.length, departmentsOf, short };
}
