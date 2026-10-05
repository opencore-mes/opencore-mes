// Excel import and export of records (DESIGN.md §24).
//
// Export: a workbook with a tab per model (object) asked for, and, when asked, a tab per model its
// records refer to, with the records referred to (a lot's work orders), recursively. Each tab holds
// the records the person may read, the fields they may read (others blank), references written as
// the referred record's key (a work order's number), so a workbook moves between plants whose ids
// differ. An "_about" tab says what was exported, from which model versions, and each field's type;
// each row carries its record's row_version.
//
// Import: a workbook with any number of model tabs. Each model's design says whether import may
// create records, update (override) existing ones, and by which field a row is matched
// (`transfer.import: { create, update, key }`); without it, import is refused for that model. The
// tabs are loaded in dependency order (work orders before the lots that refer to them), references
// resolved by key among the records already there and those this import creates. Every row goes
// through the generic record services as the person importing: their policies, the object's rule
// pipe, the audit trail and triggers apply as at a form. A definition is never changed by an import:
// that is a change request. A workbook remembers what it was exported from, and import checks both:
//   the model   a tab whose _about version is not the one in use is reported, with how its fields
//               changed since (rows are still checked against the model in use)
//   the record  a row whose row_version is not the record's refuses to write over it: someone changed
//               it since the export; emptying the cell writes over it on purpose
//   preview  every row as a dry run: what would be created, updated, left alone or refused, and why
//   apply    the same, for real; each row carries an idempotency key from the file's hash, so applying
//            the same file twice creates nothing twice. Rows are applied one by one: a refused row
//            is reported and the others go on (POC; see §24).
import { createHash } from "node:crypto";
import { fail } from "../../../src/errors.js";
import { CALL_KIND } from "../../../src/live-protocol.js";
import { decide, mask } from "./policy.js";
import { writeXlsx, readXlsx, sheetName, excelDate } from "./xlsx.js";
import { sessionIdOf } from "./auth.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_DEPTH = 3;
const SYSTEM = ["id", "state", "row_version"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const rowOut = (row) => ({ ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at), archived_at: iso(row.archived_at ?? null), row_version: Number(row.row_version) });
const blank = (v) => v === null || v === undefined || v === "";
const same = (a, b) => (blank(a) && blank(b)) || JSON.stringify(a) === JSON.stringify(b);

// The field a model's rows are matched by, and written as when referred to.
export const keyOf = (def) => def?.transfer?.import?.key ?? def?.titleField ?? null;

// A cell as the field's type wants it: { value } or { error }.
export function cellValue(field, raw) {
    if (blank(raw)) return { value: field.multiple ? [] : null };
    // Several values: "dent; scratch" (or with commas), each one of the field's values.
    if (field.multiple) {
        const parts = [...new Set(String(raw).split(/[;,]/).map((v) => v.trim()).filter(Boolean))];
        const bad = parts.filter((v) => !field.values?.includes(v));
        return bad.length ? { error: `some of ${field.values?.join(", ")}; not ${bad.join(", ")}` } : { value: parts };
    }
    switch (field.type) {
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
            if (["true", "yes", "1", "y"].includes(t)) return { value: true };
            if (["false", "no", "0", "n"].includes(t)) return { value: false };
            return { error: "yes or no" };
        }
        case "date": {
            if (typeof raw === "number") return { value: excelDate(raw) };
            const t = String(raw).trim().slice(0, 10);
            return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { value: t } : { error: "a date (YYYY-MM-DD)" };
        }
        case "enum": {
            const t = String(raw).trim();
            return field.values?.includes(t) ? { value: t } : { error: `one of ${field.values?.join(", ")}` };
        }
        default:
            return { value: typeof raw === "number" ? String(raw) : String(raw) };
    }
}

// A field as the _about tab describes it: [label, type, required, values / refers to]. Export writes
// it and import compares with it, so both read a field the same way.
export function aboutField(def, defs, name) {
    const d = def.fields[name];
    return [d.label ?? name, d.type, Boolean(d.required), d.type === "ref" ? `→ ${d.to} (by ${keyOf(defs.get(d.to)) ?? "id"})` : d.values?.join(", ") ?? ""];
}

// What a workbook's _about tab says it was exported from: { models: Map(object → version),
// fields: Map(object → Map(field → [label, type, required, values])) }, or null without one.
export function aboutOf(sheets) {
    const tab = sheets.find((s) => s.name === "_about");
    if (!tab) return null;
    const models = new Map();
    const fields = new Map();
    let section = null;
    for (const row of tab.rows ?? []) {
        const [a, b, c] = row ?? [];
        if (a === "model" && c === "definition version") { section = "models"; continue; }
        if (a === "model" && b === "field") { section = "fields"; continue; }
        if (blank(a) || blank(b)) { section = null; continue; }
        if (section === "models" && Number.isInteger(Number(c))) models.set(String(a), Number(c));
        if (section === "fields") {
            if (!fields.has(String(a))) fields.set(String(a), new Map());
            fields.get(String(a)).set(String(b), [String(c ?? b), String(row[3] ?? ""), row[4] === true || row[4] === "true", String(row[5] ?? "")]);
        }
    }
    return { models, fields };
}

// How a model's fields changed since an export, in words: against what its _about said of each field
// the file holds, the model in use now. A new required field the file does not hold is named too.
export function modelChanges(def, defs, then = new Map()) {
    const out = [];
    for (const [name, [label, type, required, values]] of then) {
        if (!Object.hasOwn(def.fields, name)) { out.push(`${name} is no longer a field`); continue; }
        const [nowLabel, nowType, nowRequired, nowValues] = aboutField(def, defs, name);
        if (nowType !== type) out.push(`${name} was ${type}, now ${nowType}`);
        else if (nowValues !== values) out.push(`${name} was ${values || "free"}, now ${nowValues || "free"}`);
        if (nowLabel !== label) out.push(`${name} was labelled "${label}", now "${nowLabel}"`);
        if (nowRequired && !required) out.push(`${name} is now required`);
    }
    for (const [name, d] of Object.entries(def.fields)) if (d.required && !then.has(name)) out.push(`${name} is required, and not in this file`);
    return out;
}

// The models in dependency order: a model before those that refer to it (cycles keep their order).
export function dependencyOrder(defs) {
    const names = new Set(defs.map((d) => d.object));
    const out = [];
    const seen = new Set();
    const visit = (def, stack = new Set()) => {
        if (seen.has(def.object) || stack.has(def.object)) return;
        stack.add(def.object);
        for (const f of Object.values(def.fields ?? {})) if (f.type === "ref" && f.to !== def.object && names.has(f.to)) visit(defs.find((d) => d.object === f.to), stack);
        seen.add(def.object);
        out.push(def);
    };
    for (const def of defs) visit(def);
    return out;
}

export function createTransfer({ store, records, recordTargets = () => [], invalidate = async () => {}, log = console }) {
    const { db } = store;
    const read = (sql, params) => store.read(sql, params);

    async function actorOf(user, object) { return { id: user.id, name: user.name, roles: await store.rolesFor(user.id, object) }; }
    async function published() {
        return new Map((await store.allDefinitions()).map((d) => [d.body.object, d.body]));
    }
    // The version of each model in use, as an export names it in _about and an import checks it.
    async function versions() {
        return new Map((await store.allDefinitions()).map((d) => [d.body.object, d.version]));
    }
    // The records of a model this person may read, masked, and (for writing references) their keys.
    async function readable(user, def, ids = null) {
        const actor = await actorOf(user, def.object);
        if (!actor.roles.length) return [];
        const rows = ids
            ? await read("SELECT * FROM mes.records WHERE object = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL ORDER BY created_at", [def.object, [...ids]])
            : await read("SELECT * FROM mes.records WHERE object = $1 AND archived_at IS NULL ORDER BY created_at", [def.object]);
        return rows.map((r) => mask(def, actor, rowOut(r))).filter(Boolean);
    }

    // ---- export ----
    // The tables an export holds: _about first, then a table per model ({ name, object, rows: [header,
    // …], widths }). A workbook writes them; a suite (§29) may write them in another format.
    async function exportTables(user, objects, { related = true } = {}) {
        const defs = await published();
        const wanted = [...new Set(objects)];
        if (!wanted.length) fail("Choose at least one model to export.");
        const plan = new Map(); // object -> null (all) | Set of ids
        for (const o of wanted) {
            const def = defs.get(o);
            if (!def || !(await store.rolesFor(user.id, o)).length) fail(`"${o}" is not a model you may read.`, { status: 404 });
            if (def.transfer?.export === false) fail(`${def.label} may not be exported: its design says so.`, { status: 403 });
            plan.set(o, null);
        }
        const sheets = new Map(); // object -> masked rows
        let frontier = [...plan.keys()];
        for (let depth = 0; frontier.length && depth <= MAX_DEPTH; depth++) {
            const next = [];
            for (const o of frontier) {
                const def = defs.get(o);
                const rows = await readable(user, def, plan.get(o));
                const existing = sheets.get(o) ?? [];
                const ids = new Set(existing.map((r) => r.id));
                sheets.set(o, [...existing, ...rows.filter((r) => !ids.has(r.id))]);
                if (!related) continue;
                for (const [name, f] of Object.entries(def.fields)) {
                    if (f.type !== "ref" || !defs.has(f.to) || defs.get(f.to).transfer?.export === false) continue;
                    if (!(await store.rolesFor(user.id, f.to)).length) continue;
                    const refs = rows.map((r) => r[name]).filter((v) => typeof v === "string" && UUID.test(v));
                    if (!refs.length) continue;
                    if (plan.get(f.to) === null) continue; // already exported in full
                    const set = plan.get(f.to) ?? new Set();
                    const before = set.size;
                    for (const id of refs) if (!(sheets.get(f.to) ?? []).some((r) => r.id === id)) set.add(id);
                    plan.set(f.to, set);
                    if (set.size > before) next.push(f.to);
                }
            }
            frontier = [...new Set(next)];
        }
        // References as the referred record's key.
        const keyIndex = new Map(); // object -> id -> key value
        for (const [o, rows] of sheets) {
            const key = keyOf(defs.get(o));
            keyIndex.set(o, new Map(rows.map((r) => [r.id, key && !blank(r[key]) ? r[key] : r.id])));
        }
        const refKey = async (to, id) => {
            if (keyIndex.get(to)?.has(id)) return keyIndex.get(to).get(id);
            const [r] = defs.get(to) ? await readable(user, defs.get(to), [id]) : [];
            const key = keyOf(defs.get(to));
            return r && key && !blank(r[key]) ? r[key] : id;
        };
        const ordered = dependencyOrder([...sheets.keys()].map((o) => defs.get(o)));
        const out = [];
        const about = [["OpenCore MES export"], ["exported", new Date().toISOString()], ["by", user.id], [], ["model", "label", "definition version", "matched by", "records", "import may create", "import may update"]];
        const fieldsAbout = [[], ["model", "field", "label", "type", "required", "values / refers to"]];
        const inUse = await versions();
        for (const def of ordered) {
            const actor = await actorOf(user, def.object);
            const readableFields = Object.keys(def.fields).filter((f) => (def.states?.list ?? []).some((s) => decide(def, actor, { state: s }).fields[f]));
            const header = [...SYSTEM, ...readableFields];
            const rows = [header];
            for (const r of sheets.get(def.object)) {
                const line = [r.id, r.state, r.row_version];
                for (const f of readableFields) {
                    const v = r[f];
                    line.push(def.fields[f].type === "ref" && typeof v === "string" && UUID.test(v) ? await refKey(def.fields[f].to, v) : Array.isArray(v) ? v.join("; ") : v ?? null);
                }
                rows.push(line);
            }
            out.push({ name: sheetName(def.object), object: def.object, label: def.label, rows, widths: header.map((h) => Math.min(40, Math.max(10, h.length + 4))) });
            about.push([def.object, def.label, inUse.get(def.object), keyOf(def) ?? "id", sheets.get(def.object).length, Boolean(def.transfer?.import?.create), Boolean(def.transfer?.import?.update)]);
            for (const f of readableFields) fieldsAbout.push([def.object, f, ...aboutField(def, defs, f)]);
        }
        out.unshift({ name: "_about", rows: [...about, ...fieldsAbout], widths: [16, 22, 18, 14, 10, 18, 18] });
        return { tables: out, models: ordered.map((d) => ({ object: d.object, records: sheets.get(d.object).length })) };
    }
    async function exportWorkbook(user, objects, options = {}) {
        const { tables, models } = await exportTables(user, objects, options);
        return { buffer: writeXlsx(tables.map(({ name, rows, widths }) => ({ name, rows, widths }))), models };
    }

    // ---- import ----
    // `reason`: why, for the rows whose change waits for approval (§28): each becomes a request.
    async function importWorkbook(user, buffer, { apply = false, reason = "" } = {}) {
        if (!Buffer.isBuffer(buffer) || !buffer.length) fail("Send an .xlsx file.");
        if (buffer.length > MAX_BYTES) fail(`The file is over ${MAX_BYTES / 1024 / 1024} MB.`);
        let sheets;
        try { sheets = readXlsx(buffer); } catch (e) { fail(`The file could not be read as a workbook: ${e.message}`); }
        const fileHash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
        return importTables(user, sheets, { apply, reason, source: fileHash });
    }
    // The import itself, from tables: [{ name, object?, rows: [header, …] }]: a workbook's tabs (a tab
    // named after its model), or what a suite (§29) read from another format and mapped onto a model's
    // fields (`object` given). `source` keys each row's idempotency: the same source applied twice
    // writes nothing twice.
    async function importTables(user, sheets, { apply = false, reason = "", source, maxRows = MAX_ROWS }) {
        if (typeof source !== "string" || !source) fail("An import names its source.");
        const fileHash = source;
        const defs = await published();
        const inUse = await versions();
        const about = aboutOf(sheets); // what an exported workbook says it came from; null otherwise
        const warnings = [];
        const found = [];
        for (const s of sheets) {
            if (s.name?.startsWith("_")) continue;
            const def = s.object ? defs.get(s.object) : [...defs.values()].find((d) => sheetName(d.object) === s.name);
            if (!def) { warnings.push(`Tab "${s.name}" is not a model: left out.`); continue; }
            if (found.some((f) => f.def.object === def.object)) { warnings.push(`Tab "${s.name}" appears twice: the second is left out.`); continue; }
            found.push({ def, sheet: s });
        }
        if (!found.length) fail("No tab of this workbook is a model (a tab is named after its model, e.g. lot).");
        const total = found.reduce((n, f) => n + Math.max(0, f.sheet.rows.length - 1), 0);
        if (total > maxRows) fail(`At most ${maxRows} rows at a time; this file has ${total}.`);

        // A person's own change, as from a form: what its design says waits for approval, waits.
        const self = { [CALL_KIND]: "internal", reason: apply ? "excel import" : "excel import preview", user, asPerson: true, ...(apply ? {} : { dryRun: true }) };
        const why = String(reason ?? "").trim() ? `Excel import: ${String(reason).trim()}` : "";
        const call = (name, args) => records[name].call(self, args);
        const resolved = new Map(); // object -> Map(key value or id -> id)
        const pending = new Set();  // ids a preview only pretended to create
        const indexOf = async (def) => {
            if (resolved.has(def.object)) return resolved.get(def.object);
            const key = keyOf(def);
            const map = new Map();
            for (const r of await readable(user, def)) {
                map.set(r.id, r.id);
                if (key && !blank(r[key])) map.set(String(r[key]), map.has(String(r[key])) && map.get(String(r[key])) !== r.id ? "ambiguous" : r.id);
            }
            resolved.set(def.object, map);
            return map;
        };

        const results = [];
        for (const { def, sheet } of dependencyOrder(found.map((f) => f.def)).map((d) => found.find((f) => f.def === d))) {
            const controls = def.transfer?.import ?? null;
            const key = controls?.key ?? null;
            const summary = { object: def.object, label: def.label, key: key ?? "id", create: Boolean(controls?.create), update: Boolean(controls?.update), counts: { create: 0, update: 0, approval: 0, unchanged: 0, refused: 0 }, rows: [], warnings: [] };
            results.push(summary);
            // The model the file was exported from, against the one in use: the rows are checked against
            // the one in use, but a field whose meaning changed (a unit) still reads, so the person is told.
            const exported = about?.models.get(def.object);
            if (exported !== undefined && exported !== inUse.get(def.object)) {
                const changes = modelChanges(def, defs, about.fields.get(def.object));
                const message = `This file was exported from version ${exported} of ${def.label}; version ${inUse.get(def.object)} is in use now. ${changes.length ? `Since then: ${changes.join("; ")}.` : "Its fields are named, typed and labelled as they were; if what one means changed (a unit, say), its values in this file may be wrong."}`;
                summary.model = { exported, inUse: inUse.get(def.object), changes, message };
                summary.warnings.push(message);
            }
            const [header = [], ...body] = sheet.rows;
            const columns = header.map((h) => (blank(h) ? null : String(h).trim()));
            const seen = new Set();
            for (const c of columns) {
                if (!c) continue;
                if (seen.has(c)) fail(`Tab "${sheet.name}": the column "${c}" appears twice.`);
                seen.add(c);
                if (!SYSTEM.includes(c) && !Object.hasOwn(def.fields, c)) summary.warnings.push(`Column "${c}" is not a field of ${def.label}: left out.`);
            }
            if (columns.includes("state")) summary.warnings.push("The state column is left as it is: a state changes by its actions, not by an import.");
            const refuse = (rowNumber, message, fields) => { summary.counts.refused += 1; summary.rows.push({ row: rowNumber, action: "refused", message, ...(fields ? { fields } : {}) }); };
            if (!controls || (!controls.create && !controls.update)) {
                body.forEach((line, i) => { if (line.some((v) => !blank(v))) refuse(i + 2, `${def.label} may not be imported: its design does not allow it.`); });
                continue;
            }
            if (!(await store.rolesFor(user.id, def.object)).length) { body.forEach((_, i) => refuse(i + 2, `${def.label} is not shared with you.`)); continue; }
            const index = await indexOf(def);
            const actor = await actorOf(user, def.object);
            const current = new Map((await readable(user, def)).map((r) => [r.id, r]));
            for (const [i, line] of body.entries()) {
                const rowNumber = i + 2;
                if (!line.some((v) => !blank(v))) continue;
                const cell = (name) => { const k = columns.indexOf(name); return k < 0 ? undefined : line[k]; };
                // The row's values, typed, references resolved.
                const data = {};
                const problems = {};
                let dependsOnPending = false;
                for (const [name, field] of Object.entries(def.fields)) {
                    const raw = cell(name);
                    if (raw === undefined) continue;
                    if (field.type === "ref") {
                        if (blank(raw)) { data[name] = null; continue; }
                        const target = defs.get(field.to);
                        const map = target ? await indexOf(target) : new Map();
                        const id = map.get(String(raw).trim());
                        if (!id) { problems[name] = `no ${target?.label ?? field.to} "${raw}" that you can see`; continue; }
                        if (id === "ambiguous") { problems[name] = `more than one ${target.label} "${raw}"`; continue; }
                        if (pending.has(id)) dependsOnPending = true;
                        data[name] = id;
                        continue;
                    }
                    const typed = cellValue(field, raw);
                    if (typed.error) problems[name] = `${field.label ?? name}: ${typed.error}, not "${raw}"`;
                    else data[name] = typed.value;
                }
                if (Object.keys(problems).length) { refuse(rowNumber, "Some cells need attention.", problems); continue; }
                // Which record it is: by the model's key, else by id.
                const keyValue = key ? cell(key) : undefined;
                const idValue = cell("id");
                let match = null;
                if (key && !blank(keyValue)) match = index.get(String(keyValue).trim()) ?? null;
                else if (!key && typeof idValue === "string" && UUID.test(idValue)) match = index.get(idValue) ?? null;
                if (match === "ambiguous") { refuse(rowNumber, `More than one ${def.label} has ${key} "${keyValue}".`); continue; }
                if (key && blank(keyValue)) { refuse(rowNumber, `The ${key} column is empty: ${def.label} rows are matched by it.`); continue; }
                // Applying: a key per row from the file's hash, so the same file applied twice does nothing twice.
                const idem = apply ? `imp-${fileHash}-${def.object}-${rowNumber}` : undefined;
                try {
                    if (match && !pending.has(match)) {
                        if (!controls.update) { refuse(rowNumber, `${def.label} ${keyValue ?? match} exists, and updating ${def.label} records by import is not allowed.`); continue; }
                        const now = current.get(match);
                        const changed = Object.fromEntries(Object.entries(data).filter(([name, v]) => decide(def, actor, { ...now, state: now.state }).fields[name] && !same(v, now[name])));
                        if (!Object.keys(changed).length) { summary.counts.unchanged += 1; continue; }
                        // The record as the file saw it: changed by someone since the export, this row would
                        // put back what they replaced, so it is refused. An empty cell (or a file without the
                        // column) writes over it on purpose. The same file applied again goes on to its
                        // remembered result: the record moved on because of this very row.
                        const seenVersion = cell("row_version");
                        if (!blank(seenVersion)) {
                            const v = Number(seenVersion);
                            if (!Number.isInteger(v)) { refuse(rowNumber, "Some cells need attention.", { row_version: `a whole number, or empty to write over the record, not "${seenVersion}"` }); continue; }
                            const once = `imp-${fileHash}-${def.object}-${rowNumber}`;
                            if (v !== now.row_version && !(await db.query("SELECT 1 FROM mes.idempotency WHERE key = $1 AND user_id = $2", [once, user.id])).length) {
                                refuse(rowNumber, `${def.label} ${keyValue ?? match} changed since this file was exported (version ${v} in the file, ${now.row_version} now, last by ${now.updated_by}). Export it again, or empty its row_version cell to write over it.`, Object.keys(changed));
                                continue;
                            }
                        }
                        if (dependsOnPending && !apply) {
                            summary.counts.update += 1;
                            summary.rows.push({ row: rowNumber, action: "update", id: match, fields: Object.keys(changed), note: "Checked when applied: it refers to a record this import creates." });
                            continue;
                        }
                        const out = await call("records.update", { object: def.object, id: match, rowVersion: now.row_version, data: changed, key: idem, reason: why });
                        if (out.$approval || out.$request) {
                            summary.counts.approval += 1;
                            summary.rows.push({ row: rowNumber, action: "approval", id: match, fields: Object.keys(changed), ...(out.$request ? { request: out.$request.id } : {}) });
                            continue;
                        }
                        summary.counts.update += 1;
                        summary.rows.push({ row: rowNumber, action: "update", id: out.id ?? match, fields: Object.keys(changed) });
                    } else if (match && pending.has(match)) {
                        refuse(rowNumber, `The same ${def.label} appears twice in this import.`);
                    } else {
                        if (!controls.create) { refuse(rowNumber, `No ${def.label} ${keyValue ?? ""} exists, and creating ${def.label} records by import is not allowed.`.replace(/\s+,/, ",")); continue; }
                        const values = Object.fromEntries(Object.entries(data).filter(([, v]) => !blank(v)));
                        if (dependsOnPending && !apply) {
                            const fake = `pending-${def.object}-${rowNumber}`;
                            pending.add(fake);
                            if (key && !blank(keyValue)) index.set(String(keyValue).trim(), fake);
                            summary.counts.create += 1;
                            summary.rows.push({ row: rowNumber, action: "create", note: "Checked when applied: it refers to a record this import creates." });
                            continue;
                        }
                        const out = await call("records.create", { object: def.object, data: values, key: idem, reason: why });
                        // A new record that waits for approval does not exist yet: nothing refers to it.
                        if (out.$approval || out.$request) {
                            summary.counts.approval += 1;
                            summary.rows.push({ row: rowNumber, action: "approval", ...(out.$request ? { request: out.$request.id } : {}) });
                            continue;
                        }
                        if (!apply) pending.add(out.id);
                        index.set(out.id, out.id);
                        if (key && !blank(keyValue)) index.set(String(keyValue).trim(), out.id);
                        summary.counts.create += 1;
                        summary.rows.push({ row: rowNumber, action: "create", id: apply ? out.id : null });
                    }
                } catch (error) {
                    if (!error?.expose) throw error;
                    refuse(rowNumber, error.message, error.fields);
                }
            }
            summary.rows = summary.rows.slice(0, 500);
        }
        return { applied: apply, file: fileHash, warnings, models: results };
    }

    // ---- HTTP: GET /transfer/export.xlsx, POST /transfer/import ----
    const sameSite = (req) => {
        const from = req.headers.origin ?? req.headers.referer;
        try { return Boolean(from) && new URL(from).host === req.headers.host; } catch { return false; }
    };
    const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; };
    const readBody = (req) => new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { reject(Object.assign(new Error(`The file is over ${MAX_BYTES / 1024 / 1024} MB.`), { expose: true, status: 413 })); req.destroy(); } else chunks.push(c); });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
    const handler = async (req, res, url) => {
        if (!url.pathname.startsWith("/transfer/")) return false;
        const user = await store.userForSession(sessionIdOf(req));
        if (!user) return json(res, 401, { error: "Sign in first." });
        try {
            if (req.method === "GET" && url.pathname === "/transfer/export.xlsx") {
                const objects = (url.searchParams.get("objects") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
                const { buffer } = await exportWorkbook(user, objects, { related: url.searchParams.get("related") !== "0" });
                const name = `opencoremes-${objects.join("-")}-${new Date().toISOString().slice(0, 10)}.xlsx`.replace(/[^\w.-]/g, "_");
                res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
                res.end(buffer);
                return true;
            }
            if (req.method === "POST" && url.pathname === "/transfer/import") {
                if (!sameSite(req)) return json(res, 403, { error: "Import from this site's own page." });
                const body = await readBody(req);
                const apply = url.searchParams.get("apply") === "1";
                const result = await importWorkbook(user, body, { apply, reason: (url.searchParams.get("reason") ?? "").slice(0, 1000) });
                // This handler is not a service with `touches`: what it wrote reaches the open pages here,
                // each object once (every record of it, so no id), and the approvals list where rows wait.
                const wrote = apply ? (result.models ?? []).filter((m) => m.counts && m.counts.create + m.counts.update + m.counts.approval > 0) : [];
                if (wrote.length) {
                    const targets = wrote.flatMap((m) => recordTargets({ object: m.object }, m.counts.approval ? { $request: true } : undefined).map((t) => (t.where ? { ...t, where: { object: m.object } } : t)));
                    invalidate(targets.filter((t, i) => targets.findIndex((o) => JSON.stringify(o) === JSON.stringify(t)) === i)).catch((e) => log.error?.("import invalidate", e));
                }
                return json(res, 200, result);
            }
            return json(res, 404, { error: "Not found." });
        } catch (error) {
            if (error?.expose) return json(res, error.status ?? 400, { error: error.message, ...(error.fields ? { fields: error.fields } : {}) });
            throw error;
        }
    };

    // The models a person may export or import, with their controls.
    const services = {
        async "transfer.models"() {
            const user = await store.userForSession(this?.sessionId);
            if (!user) fail("Sign in first.", { status: 401 });
            const out = [];
            for (const [object, def] of await published()) {
                if (!(await store.rolesFor(user.id, object)).length) continue;
                out.push({ object, label: def.label, area: def.area, export: def.transfer?.export !== false, import: def.transfer?.import ?? null, key: keyOf(def), refers: Object.values(def.fields).filter((f) => f.type === "ref").map((f) => f.to) });
            }
            return out.sort((a, b) => a.label.localeCompare(b.label));
        },
    };
    return { handler, services, touches: { "transfer.models": [] }, exportWorkbook, importWorkbook, exportTables, importTables, readXlsx, writeXlsx, cellValue };
}
