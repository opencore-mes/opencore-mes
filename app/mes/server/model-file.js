// A model file (DESIGN.md §24.1): a plant's whole model carried to another installation as one file.
//
//   { format: "opencore-mes-model", version: 1,
//     about:   { exportedAt, by, from: { site, instance, build }, versions: { kind: { name: version } },
//                empty: [objects exported without their records], left: [{ object, why }], notes: [words] },
//     designs: a design pack (packs.js): definitions, scripts, tests, connections, services,
//              transactions, screens, flows, layouts, and the roles departments and groups hold,
//     records: the tables an Excel export holds (transfer.js exportTables): one per object that was
//              not exported empty, references written as the referred record's key }
//
// Export: everything published, as the person may read it (a record or a field a policy hides from
// them is not in the file); they say which objects go empty. A scenario's picked records (records of
// this plant, by id or by a condition) are written as given ones, with what they refer to, so the
// fitness test finds them where the file lands. No secret is in a design, so none is in the file.
//
// Import, on the other installation, is two steps, each previewed first:
//   1. the designs, as one change request (design.js changeFromPack): everything new or different from
//      what is live there, through review and approval like any change. Nothing is live by the import.
//   2. once that change has executed, the records: through the record services as the person
//      (transfer.js importTables), so policies, the rule pipe, the audit trail and approval apply as at
//      a form. A record arrives in its object's initial state: a state changes by its actions.
// What is live there and not in the file is left alone. History (versions, signatures, the audit
// trail) is not carried: the change's first audit entry says where the file came from, and its hash.
import { createHash } from "node:crypto";
import { fail } from "../../../src/errors.js";
import { mask } from "./policy.js";
import { recordWhere } from "./record-where.js";
import { sessionIdOf } from "./auth.js";
import { packProblems } from "./packs.js";
import { appendAudit } from "./audit.js";
import { managedOf } from "../client/builtins.js";

export const MODEL_FORMAT = "opencore-mes-model";
export const MODEL_VERSION = 1;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 50_000;
const PICK_DEPTH = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z][a-z0-9_]{0,47}$/;
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// (`elements`: design elements of the suites' own kinds, §30.11, carried untouched whether or not the
// suite is installed on either side.)
const DESIGN_KINDS = ["definitions", "connections", "services", "transactions", "screens", "flows", "layouts", "elements"];

// What is wrong with a model file's shape, in words. → [message]
export function modelFileProblems(file) {
    if (!isPlain(file) || file.format !== MODEL_FORMAT) return ["This is not a model file: one is exported from the Designer (Export model) of an OpenCore MES installation."];
    if (file.version !== MODEL_VERSION) return [`This model file is version ${String(file.version)}; this installation reads version ${MODEL_VERSION}. Export it again from an installation of the same release.`];
    const out = [];
    if (!isPlain(file.designs)) out.push("designs: the designs it carries.");
    else out.push(...packProblems({ label: "Model", version: "1", ...file.designs }));
    if (file.records !== undefined && !(Array.isArray(file.records) && file.records.every((t) => isPlain(t) && typeof t.name === "string" && Array.isArray(t.rows) && t.rows.every(Array.isArray)))) out.push("records: a list of tables, each { name, object, rows }.");
    return out;
}

// createModelFile({ store, design, transfer, records, secrets, suites, invalidate, instance, build, log })
//   design    design.js: published, designRolesOf, changeFromPack, packPreview
//   transfer  transfer.js: exportTables, importTables
//   records   services.js: internals (loadRow, rowOut, actorFor), recordTargets
//   secrets   (name) → its value or undefined, to say which a connection names that this server lacks
//   suites    the installed suites' names, to say which a field in the file was added by and is not here
export function createModelFile({ store, design, transfer, records, secrets = () => undefined, suites = [], invalidate = async () => {}, instance = null, build = null, log = console }) {
    const { db } = store;
    const x = records.internals;

    const designer = async (user, need = null) => {
        const roles = await design.designRolesOf(user.id);
        if (!roles.length) fail("The designer is not shared with you.", { status: 403 });
        if (need && !roles.includes(need)) fail(`Only a ${need} does this.`, { status: 403 });
        return roles;
    };

    // ---- export ----
    // A record as this person sees it, or null.
    const visible = async (user, row) => {
        const def = await store.definition(row.object);
        if (!def || row.archived_at) return null;
        const seen = mask(def.body, await x.actorFor(user, row.object), x.rowOut(row));
        return seen ? { def, seen } : null;
    };
    // A scenario's records, the picked ones written as given: the record as the person sees it, and
    // what it refers to, two references deep (as a sandbox copies them, sandbox.js prepare), each under
    // a key of its own. One that is not found stays as it is, and is said.
    async function portableRecords(user, spec, notes, where) {
        const out = {};
        const keys = new Set(Object.keys(spec));
        const keyFor = new Map(); // record id → key
        const fresh = (wanted) => {
            let key = wanted.slice(0, 44).replace(/[^a-z0-9_]/g, "_");
            if (!IDENT.test(key)) key = `r_${key}`.slice(0, 44);
            for (let i = 2; keys.has(key); i++) key = `${key.replace(/_\d+$/, "")}_${i}`;
            keys.add(key);
            return key;
        };
        const give = async (key, row, depth) => {
            const v = await visible(user, row);
            if (!v) return false;
            keyFor.set(row.id, key);
            const data = {};
            for (const [f, field] of Object.entries(v.def.body.fields ?? {})) {
                const value = row.data?.[f];
                if (value === undefined || v.seen[f] === undefined || field.type === "image") continue;
                if (field.type !== "ref") { data[f] = value; continue; }
                const named = [];
                for (const id of [].concat(value).filter((id) => typeof id === "string" && UUID.test(id))) {
                    if (keyFor.has(id)) { named.push(`@${keyFor.get(id)}`); continue; }
                    if (depth >= PICK_DEPTH) continue;
                    const ref = await x.loadRow(db, field.to, id);
                    const refKey = fresh(`${key}_${f}`);
                    if (ref && (await give(refKey, ref, depth + 1))) named.push(`@${refKey}`);
                    else keys.delete(refKey);
                }
                if (named.length) data[f] = Array.isArray(value) ? named : named[0];
            }
            out[key] = { object: row.object, data, state: row.state };
            return true;
        };
        // Each picked record first, under its own key: one that another refers to is named by that key,
        // not given a second time under a made-up one.
        const picked = [];
        for (const [key, r] of Object.entries(spec)) {
            if (!isPlain(r) || r.data !== undefined) { out[key] = r; continue; }
            let row = typeof r.id === "string" && UUID.test(r.id) ? await x.loadRow(db, r.object, r.id) : null;
            if (row && !(await visible(user, row))) row = null;
            if (!row) {
                const w = typeof r.object === "string" ? recordWhere(r.object, isPlain(r.where) ? r.where : {}) : null;
                if (w) for (const candidate of await db.query(`SELECT * FROM mes.records WHERE ${w.sql} ORDER BY updated_at DESC LIMIT 50`, w.params)) { if (!keyFor.has(candidate.id) && (await visible(user, candidate))) { row = candidate; break; } }
            }
            if (!row || keyFor.has(row.id)) {
                out[key] = r;
                notes.push(`${where}: its record "${key}" is picked from this plant's records and none was found that you may read; where the file lands, give the record in the scenario.`);
                continue;
            }
            keyFor.set(row.id, key);
            picked.push([key, row]);
        }
        for (const [key, row] of picked) await give(key, row, 0);
        return out;
    }
    async function portable(user, body, notes, what) {
        if (!Array.isArray(body.scenarios) || !body.scenarios.some((sc) => Object.values(isPlain(sc?.records) ? sc.records : {}).some((r) => isPlain(r) && r.data === undefined))) return body;
        const scenarios = [];
        for (const sc of body.scenarios) scenarios.push(isPlain(sc?.records) ? { ...sc, records: await portableRecords(user, sc.records, notes, `${what}, scenario "${sc.name ?? ""}"`) } : sc);
        return { ...body, scenarios };
    }

    // The objects there are, for the export's choice: which go with their records, which empty.
    async function objectsFor(user) {
        await designer(user);
        const live = await design.published();
        const counts = Object.fromEntries((await db.query("SELECT object, count(*)::int AS n FROM mes.records WHERE archived_at IS NULL GROUP BY object")).map((r) => [r.object, r.n]));
        const out = [];
        for (const [object, { body }] of Object.entries(live.definitions)) {
            const readable = (await store.rolesFor(user.id, object)).length > 0;
            // (An object whose records the platform makes, one per person: the other installation has its own.)
            const why = managedOf(object).platformRecords ? "the platform keeps its records, one per person" : body.transfer?.export === false ? "its design does not allow export" : !readable ? "you hold no role on it" : null;
            out.push({ object, label: body.label ?? object, area: body.area ?? null, records: counts[object] ?? 0, ...(why ? { emptyBecause: why } : {}) });
        }
        return out.sort((a, b) => a.label.localeCompare(b.label));
    }

    async function exportModel(user, { empty = [], designsOnly = false, site = null } = {}) {
        await designer(user);
        const live = await design.published();
        const notes = [];
        const designs = { definitions: Object.values(live.definitions).map((d) => d.body), scripts: {}, tests: {} };
        for (const [name, s] of Object.entries(live.scripts)) { designs.scripts[name] = s.source; if (s.tests?.length) designs.tests[name] = s.tests; }
        for (const kind of DESIGN_KINDS.slice(1)) {
            designs[kind] = [];
            for (const [name, { body }] of Object.entries(live[kind])) designs[kind].push(kind === "transactions" || kind === "flows" ? await portable(user, body, notes, `${kind === "flows" ? "flow template" : "transaction"} ${name}`) : body);
        }
        // The roles departments and groups hold on the objects it carries: people are the other plant's own.
        designs.roles = {};
        for (const object of Object.keys(live.definitions)) {
            for (const [role, subjects] of Object.entries(live.organization.roles?.[object] ?? {})) {
                const groups = subjects.filter((s) => String(s).startsWith("group:"));
                if (groups.length) (designs.roles[object] ??= {})[role] = groups;
            }
        }
        const versions = Object.fromEntries(["definitions", "scripts", ...DESIGN_KINDS.slice(1)].map((k) => [k, Object.fromEntries(Object.entries(live[k]).map(([n, v]) => [n, v.version]))]));
        // Records: every object not asked for empty, that its design lets out and the person reads.
        const left = [];
        const wanted = [];
        const asked = new Set(designsOnly ? Object.keys(live.definitions) : empty);
        for (const o of await objectsFor(user)) {
            if (asked.has(o.object)) continue;
            if (o.emptyBecause) { if (o.records && !managedOf(o.object).platformRecords) left.push({ object: o.object, why: o.emptyBecause }); continue; }
            if (o.records) wanted.push(o.object);
        }
        const total = wanted.length ? (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE archived_at IS NULL AND object = ANY($1)", [wanted]))[0].n : 0;
        if (total > MAX_ROWS) fail(`A model file carries at most ${MAX_ROWS} records; these objects hold ${total}. Export the largest ones empty, and move their records with Data → Import / export.`, { status: 413, code: "model.rows" });
        // A table per object, as an Excel export holds it, without what only means something here: each
        // record's id and row version (the other installation finds a record by its key, and has its own).
        const records_ = [];
        for (const { name, object, rows } of wanted.length ? (await transfer.exportTables(user, wanted, { related: false })).tables : []) {
            if (!object) continue;
            const own = ["id", "row_version"].map((c) => rows[0].indexOf(c)).filter((i) => i >= 0);
            records_.push({ name, object, rows: rows.map((row, r) => (r === 0 ? row : row.map((cell, i) => (own.includes(i) ? null : cell)))) });
        }
        const file = {
            format: MODEL_FORMAT, version: MODEL_VERSION,
            about: { exportedAt: new Date().toISOString(), by: user.id, from: { ...(site ? { site } : {}), instance, build }, versions, empty: Object.keys(live.definitions).filter((o) => asked.has(o)).sort(), left, notes },
            designs, records: records_,
        };
        await db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$model", action: "model:export", after: { designs: Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, Object.keys(v).length])), records: Object.fromEntries(records_.filter((t) => t.object).map((t) => [t.object, t.rows.length - 1])), empty: file.about.empty } }));
        return file;
    }

    // ---- import ----
    // (As bytes, the page's upload; or the file itself, a service's argument.)
    const read = (given) => {
        const buffer = Buffer.isBuffer(given) ? given : isPlain(given) ? Buffer.from(JSON.stringify(given)) : null;
        if (!buffer?.length) fail("Send a model file.");
        let file;
        try { file = JSON.parse(buffer.toString("utf8")); } catch { fail("This file could not be read as a model file: it is not JSON."); }
        const problems = modelFileProblems(file);
        if (problems.length) fail(`This model file cannot be used: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}.`, { status: 422 });
        return { file, hash: createHash("sha256").update(buffer).digest("hex") };
    };
    const packOf = (file) => ({ label: "Model", version: "1", ...file.designs });
    const titleOf = (file) => `Model from ${file.about?.from?.site ? `${file.about.from.site}, ` : ""}${String(file.about?.exportedAt ?? "").slice(0, 10) || "a file"}`;

    // What the file would do here, nothing written.
    async function preview(user, buffer) {
        await designer(user);
        const { file, hash } = read(buffer);
        const found = await design.packPreview(packOf(file));
        const live = await design.published();
        // What this installation lacks that the designs name: said now, not found out at run time.
        const needs = [];
        for (const c of file.designs.connections ?? []) {
            const secret = c?.auth?.kind && c.auth.kind !== "none" ? c.auth.secret : null;
            if (secret && secrets(secret) === undefined) needs.push({ kind: "secret", name: secret, words: `Connection ${c.label ?? c.name} names the secret "${secret}", which this server does not have: IT sets MES_SECRET_${String(secret).toUpperCase()} before it is called.` });
        }
        const foreign = new Map();
        for (const d of file.designs.definitions ?? []) for (const [name, f] of Object.entries(d.fields ?? {})) if (typeof f?.suite === "string" && !suites.includes(f.suite)) foreign.set(f.suite, [...(foreign.get(f.suite) ?? []), `${d.object}.${name}`]);
        for (const [suite, fields] of foreign) needs.push({ kind: "suite", name: suite, words: `${fields.length} field(s) were added by the suite "${suite}", which is not installed here (${fields.slice(0, 3).join(", ")}${fields.length > 3 ? ", …" : ""}): they arrive labelled as its own and stay unused until it is.` });
        // Its records: what there is to load, and what stands in the way.
        const byObject = Object.fromEntries((file.designs.definitions ?? []).map((d) => [d.object, d]));
        const recordsOf = (file.records ?? []).filter((t) => t.object).map((t) => {
            const def = live.definitions[t.object]?.body ?? null;
            const coming = byObject[t.object] ?? def;
            const why = !coming?.transfer?.import?.create ? "will not load: its design does not let an import create records (Import & export, in its design)" : !def ? "not yet: it is not live here, and its records are loaded once the change has executed" : null;
            return { object: t.object, label: coming?.label ?? t.object, rows: Math.max(0, t.rows.length - 1), live: Boolean(def), ...(why ? { waits: why } : {}) };
        });
        return {
            hash, title: titleOf(file), about: file.about ?? {},
            designs: { new: found.elements.filter((e) => e.status === "new").length, changed: found.elements.filter((e) => e.status === "changed").length, same: found.elements.filter((e) => e.status === "same").length, elements: found.elements.filter((e) => e.status !== "same").slice(0, 500), roles: found.roles, problems: found.problems.slice(0, 200) },
            needs, records: recordsOf,
        };
    }

    // Step 1: the designs, as a change request.
    async function start(user, buffer, self = null) {
        await designer(user, "designer");
        const { file, hash } = read(buffer);
        const from = file.about?.from ?? {};
        return design.changeFromPack(self, user, packOf(file), {
            title: titleOf(file),
            reason: `From a model file exported ${String(file.about?.exportedAt ?? "").slice(0, 10)}${from.site ? ` from ${from.site}` : ""}${file.about?.by ? ` by ${file.about.by}` : ""}: every design in it that is new or different here.`,
            from: { modelFile: hash, from, exportedAt: file.about?.exportedAt ?? null, versions: file.about?.versions ?? {} },
        });
    }

    // Step 2: its records, through the record services as the person. `apply` false is the preview.
    async function loadRecords(user, buffer, { apply = false, reason = "" } = {}) {
        const { file, hash } = read(buffer);
        const tables = file.records ?? [];
        if (!tables.some((t) => t.object)) fail("This model file carries no records: every object was exported empty.", { status: 409, code: "model.empty" });
        // References that go round (a kiln's first load, a load's kiln; a record that names another of its
        // own object) cannot all be there when a row is made. Those columns wait: every record is made
        // without them, then they are set, by an update of the record found by its key.
        const live = await design.published();
        const inFile = new Map(tables.filter((t) => t.object).map((t) => [t.object, t]));
        const refsOf = (object) => (inFile.get(object)?.rows[0] ?? []).filter((f) => { const field = live.definitions[object]?.body.fields?.[f]; return field?.type === "ref" && inFile.has(field.to); });
        const later = new Map(); // object → columns set in the second pass
        const state = new Map();  // object → "open" | "done"
        const visit = (object) => {
            state.set(object, "open");
            for (const f of refsOf(object)) {
                const to = live.definitions[object].body.fields[f].to;
                if (state.get(to) === "open") later.set(object, [...(later.get(object) ?? []), f]);
                else if (!state.has(to)) visit(to);
            }
            state.set(object, "done");
        };
        for (const object of inFile.keys()) if (!state.has(object)) visit(object);
        const without = (t) => { const drop = (later.get(t.object) ?? []).map((f) => t.rows[0].indexOf(f)); return drop.length ? { ...t, rows: t.rows.map((row) => row.filter((_, i) => !drop.includes(i))) } : t; };
        const source = `model-${hash.slice(0, 16)}`;
        const result = await transfer.importTables(user, tables.map(without), { apply, reason, source, maxRows: MAX_ROWS });
        if (later.size) {
            const words = [...later].map(([object, fields]) => `${live.definitions[object].body.label ?? object}: ${fields.join(", ")}`).join("; ");
            if (!apply) (result.warnings ??= []).push(`References that go round are set once every record is made (${words}).`);
            else {
                const linked = await transfer.importTables(user, tables.filter((t) => later.has(t.object)), { apply, reason, source: `${source}-refs`, maxRows: MAX_ROWS });
                for (const second of linked.models ?? []) {
                    const firstPass = (result.models ?? []).find((x) => x.object === second.object);
                    if (!firstPass) continue;
                    firstPass.linked = second.counts.update + second.counts.approval;
                    firstPass.counts.approval += second.counts.approval;
                    firstPass.counts.refused += second.counts.refused;
                    firstPass.rows = [...(firstPass.rows ?? []), ...(second.rows ?? []).filter((r) => r.action === "refused").map((r) => ({ ...r, message: `Its reference (${later.get(second.object).join(", ")}) was not set: ${r.message}` }))];
                }
            }
        }
        const wrote = apply ? (result.models ?? []).filter((m) => m.counts && m.counts.create + m.counts.update + m.counts.approval > 0) : [];
        if (wrote.length) {
            const targets = wrote.flatMap((m) => records.recordTargets({ object: m.object }, m.counts.approval ? { $request: true } : undefined).map((t) => (t.where ? { ...t, where: { object: m.object } } : t)));
            invalidate(targets.filter((t, i) => targets.findIndex((o) => JSON.stringify(o) === JSON.stringify(t)) === i)).catch((e) => log.error?.("model file: invalidate", e));
        }
        return result;
    }

    // ---- HTTP: GET /model-file/export, POST /model-file/preview, /model-file/start, /model-file/records ----
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
        if (!url.pathname.startsWith("/model-file/")) return false;
        const user = await store.userForSession(sessionIdOf(req));
        if (!user) return json(res, 401, { error: "Sign in first." });
        try {
            if (req.method === "GET" && url.pathname === "/model-file/export") {
                const empty = (url.searchParams.get("empty") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
                const file = await exportModel(user, { empty, designsOnly: url.searchParams.get("records") === "0", site: String(req.headers.host ?? "").slice(0, 120) || null });
                const name = `opencoremes-model-${String(req.headers.host ?? "site").replace(/[^\w.-]/g, "_")}-${file.about.exportedAt.slice(0, 10)}.json`;
                res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
                res.end(JSON.stringify(file));
                return true;
            }
            if (req.method !== "POST") return json(res, 404, { error: "Not found." });
            if (!sameSite(req)) return json(res, 403, { error: "Import from this site's own page." });
            const body = await readBody(req);
            if (url.pathname === "/model-file/preview") return json(res, 200, await preview(user, body));
            if (url.pathname === "/model-file/start") {
                const made = await start(user, body);
                invalidate([{ name: "design.home" }, { name: "design.view" }, { name: "inbox.mine" }]).catch((e) => log.error?.("model file: invalidate", e));
                return json(res, 200, made);
            }
            if (url.pathname === "/model-file/records") {
                const result = await loadRecords(user, body, { apply: url.searchParams.get("apply") === "1", reason: (url.searchParams.get("reason") ?? "").slice(0, 1000) });
                // The page is told what was refused, the first of them: a file holds thousands of rows.
                for (const model of result.models ?? []) {
                    const refused = (model.rows ?? []).filter((r) => r.action === "refused");
                    model.rows = refused.slice(0, 200);
                    if (refused.length > 200) model.moreRefused = refused.length - 200;
                }
                return json(res, 200, result);
            }
            return json(res, 404, { error: "Not found." });
        } catch (error) {
            if (error?.expose) return json(res, error.status ?? 400, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.fields ? { fields: error.fields } : {}) });
            log.error?.("model file", error);
            return json(res, 500, { error: "The request failed." });
        }
    };

    // As services too, for what works as the person through a token (the AI API, §16): the designs
    // only. An AI reads designs and drafts changes; it neither carries nor loads a plant's records.
    const services = {
        async "model.export"() {
            return exportModel(await design.designUser(this), { designsOnly: true });
        },
        async "model.preview"({ file } = {}) {
            return preview(await design.designUser(this), file);
        },
        async "model.start"({ file } = {}) {
            return start(await design.designUser(this), file, this);
        },
        // The objects, each with how many records it holds, for the export's choice.
        async "model.objects"({ as } = {}) {
            const user = await store.userForSession(this?.sessionId);
            if (!user || (as !== undefined && as !== user.id)) fail("Sign in first.", { status: 401 });
            return objectsFor(user);
        },
    };
    return { handler, services, touches: { "model.objects": [], "model.export": [], "model.preview": [], "model.start": [{ name: "design.home" }, { name: "design.view" }, { name: "inbox.mine" }] }, exportModel, preview, start, loadRecords, objectsFor };
}
