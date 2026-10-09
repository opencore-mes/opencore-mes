// Screens (DESIGN.md §26): pages composed of fixed building blocks, each a definition designed and
// approved like an object (definition.js validateScreen). A block is data: which records, which
// fields, which number; the page draws it with components registered once (client/screen.js). What
// a block shows is read with the viewer's own rights (policy.js mask), so a screen never shows more
// than that person's forms would; a number counts only what they may read.
import { fail } from "@opencore-mes/juris-kit/errors.js";
import { evaluate, referencesOf } from "../client/expr.js";
import { validateScreen, isSensitive, stepTargetProblems } from "../client/definition.js";
import { parseSteps, intoOf, secondsOf } from "../client/media-steps.js";
import { mask, decide } from "./policy.js";
import { recordWhere } from "./record-where.js";
import { rightsSql, orderSql } from "./record-sql.js";
import { lit } from "./query.js";
import { sortRows } from "../client/sort.js";
import { inputFlowOf } from "./transactions.js";
import { statusValues, MAX_PLACES } from "../client/floor.js";
import { rowsFor } from "../client/charts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const MAX_SCAN = 5000; // records read when the viewer's rights do not compile to SQL (record-sql.js)

// Midnight today in the plant's time zone, as an instant.
function startOfToday(tz) {
    const now = new Date();
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const offset = Math.round((wall - now.getTime()) / 60000) * 60000;
    return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - offset).toISOString();
}
const sinceOf = (since, tz) => (since === "today" ? startOfToday(tz) : since === "7d" ? new Date(Date.now() - 7 * 86400000).toISOString() : since === "30d" ? new Date(Date.now() - 30 * 86400000).toISOString() : null);

export function createScreens({ store, records, design, transactions, query = null, titles = null, plantTz = "UTC" }) {
    const x = records.internals;

    async function mayOpen(s, user) {
        const callers = s.body.callers ?? {};
        if ((callers.users ?? []).includes(user.id)) return true;
        if (!(callers.groups ?? []).length) return false;
        const groups = await store.db.query("SELECT group_id FROM mes.group_members WHERE user_id = $1", [user.id]);
        return groups.some((g) => callers.groups.includes(g.group_id));
    }
    const publicOf = (s) => ({ name: s.body.name, version: s.version, label: s.body.label, description: s.body.description ?? "", params: s.body.params ?? {}, blocks: s.body.blocks ?? [], maximize: s.body.maximize ?? null, oneTab: s.body.oneTab === true });
    const paramOf = (body) => Object.entries(body.params ?? {})[0] ?? null;

    // The labels and types of an object's fields, for the page to draw values with.
    const fieldsOf = (def, names) => Object.fromEntries(names.filter((n) => n !== "state" && def.body.fields[n]).map((n) => [n, { label: def.body.fields[n].label ?? n, type: def.body.fields[n].type }]));
    // Which records a block reads: its `where`, and the viewer's rights compiled to SQL (record-sql.js),
    // so the database counts, sorts and keeps the first `limit` over all of them. `rights` is null
    // when a policy's condition does not compile: then up to MAX_SCAN rows are read and decided here.
    async function scopeOf(user, def, where, since = null) {
        const w = recordWhere(def.body.object, where, { since });
        if (!w) return null;
        const actor = await x.actorFor(user, def.body.object);
        const rights = rightsSql(def.body, actor);
        // A `where` on a field counts only the records whose field the viewer may read: otherwise a
        // value chosen in the page would say whether a hidden field holds it (as records.list has it).
        const keys = Object.keys(where ?? {}).filter((k) => def.body.fields[k]);
        return { ...w, actor, rights, keys, sql: rights ? `${w.sql} AND ${rights.read}${keys.map((k) => ` AND ${rights.field(k)}`).join("")}` : w.sql };
    }
    // The records of a block the viewer may read, newest first (or as it sorts, sort.js), each masked.
    async function visibleRows(user, def, where, { sort = null, limit = MAX_SCAN, since = null } = {}) {
        const s = await scopeOf(user, def, where, since);
        if (!s) return [];
        const sorted = sort && (sort.field === "state" || def.body.fields[sort.field]);
        const n = Math.max(0, Math.min(MAX_SCAN, Number.isInteger(limit) ? limit : MAX_SCAN));
        const seen = (rows) => rows.map((row) => mask(def.body, s.actor, x.rowOut(row))).filter(Boolean);
        if (s.rights) {
            const order = sorted ? orderSql(def.body, s.rights, sort) : "r.updated_at DESC, r.id";
            return seen(await x.reader.query(`SELECT r.* FROM mes.records r WHERE ${s.sql} ORDER BY ${order} LIMIT ${n}`, s.params));
        }
        const rows = await x.reader.query(`SELECT * FROM mes.records WHERE ${s.sql} ORDER BY updated_at DESC LIMIT ${sorted ? MAX_SCAN : Math.min(MAX_SCAN, n * 3 + 20)}`, s.params);
        // …and never by a sensitive field's value (§6.10), as record-sql.js has it in the database.
        const visible = seen(rows).filter((r) => s.keys.every((k) => r.$perm.fields[k] && !isSensitive(def.body, k)));
        return (sorted ? sortRows(visible, (r) => (sort.field === "state" ? r.state : r[sort.field]), sort.dir ?? "asc") : visible).slice(0, n);
    }
    const whereOf = (b, scope) => Object.fromEntries(Object.entries(b.where ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v : evaluate(v, scope) ?? null]));
    const round = (v) => Math.round(v * 1000) / 1000;
    function measure(rows, m = "count") {
        if (m === "count") return rows.length;
        const [op, field] = Object.entries(m)[0];
        const values = rows.map((r) => r[field]).filter((v) => typeof v === "number");
        if (!values.length) return op === "sum" ? 0 : null;
        const sum = values.reduce((a, b) => a + b, 0);
        return round(op === "sum" ? sum : op === "avg" ? sum / values.length : op === "min" ? Math.min(...values) : Math.max(...values));
    }
    // What measure() reads, aggregated in SQL: n rows; of the measured field (a number the viewer may
    // read), its sum, how many, the least and the most. → { n, sum, c, lo, hi } per row of the result.
    function aggregatesSql(def, rights, m = "count") {
        const field = m && m !== "count" ? Object.values(m)[0] : null;
        if (!field || !def.body.fields[field]) return "count(*) AS n, NULL::numeric AS sum, 0 AS c, NULL::numeric AS lo, NULL::numeric AS hi";
        const readable = rights.field(field);
        const j = `r.data->${lit(field)}`;
        const v = `CASE WHEN ${readable === "true" ? "" : `${readable} AND `}jsonb_typeof(${j}) = 'number' THEN (${j})::numeric END`;
        return `count(*) AS n, sum(${v}) AS sum, count(${v}) AS c, min(${v}) AS lo, max(${v}) AS hi`;
    }
    function measured(a, m = "count") {
        if (m === "count") return Number(a.n);
        const op = Object.keys(m)[0];
        const c = Number(a.c);
        if (!c) return op === "sum" ? 0 : null;
        return round(op === "sum" ? Number(a.sum) : op === "avg" ? Number(a.sum) / c : op === "min" ? Number(a.lo) : Number(a.hi));
    }
    const slim = (r, columns) => ({ id: r.id, state: r.state, $title: r.$title ?? null, $titles: r.$titles ?? {}, ...Object.fromEntries(columns.filter((c) => c !== "state").map((c) => [c, r[c] ?? null])) });

    // A guide's steps done (§35.4): the records of its log, as the viewer may read them, each saying which
    // step (its number) and who did it; and how the page marks one done: its transaction, the inputs it
    // fills (worked out here, as the viewer), and the inputs a step's value, photo or file goes in.
    async function stepsDone(user, d, scope, steps) {
        const logDef = await store.definition(d.log?.object);
        const tx = (await store.transactions()).get(d.transaction);
        if (!logDef || !tx) return { error: "Its steps cannot be marked done: its transaction or its log is not there. Ask its designer." };
        const where = whereOf({ where: d.log.where }, scope);
        // No record to read them for (no lot opened): nothing is done, and nothing can be.
        if (Object.values(where).some((v) => v === null)) return { list: {}, off: true };
        const rows = await visibleRows(user, logDef, where, { limit: 1000 });
        const list = {};
        for (const r of rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
            const n = Number(r[d.log.step]);
            // The first record of a step counts; undone (archived), the next takes its place. Undo is the
            // log record archived, for whoever its policies let archive it, as anywhere else.
            if (Number.isInteger(n) && n > 0 && !list[n]) list[n] = { by: r.created_by, at: r.created_at, id: r.id, rowVersion: r.row_version, undo: Boolean(r.$perm?.archive) };
        }
        const ids = [...new Set(Object.values(list).map((v) => v.by))];
        const names = ids.length ? new Map((await store.db.query("SELECT id, name FROM mes.users WHERE id = ANY($1)", [ids])).map((u) => [u.id, u.name])) : new Map();
        for (const v of Object.values(list)) v.name = names.get(v.by) ?? (String(v.by).startsWith("service:") || String(v.by).startsWith("flow:") ? "the system" : v.by);
        const inputs = tx.body.inputs ?? {};
        const fills = {};
        for (const [k, e] of Object.entries(d.fills ?? {})) { try { fills[k] = evaluate(e, scope) ?? null; } catch { fills[k] = null; } }
        // What each step done at the screen fills besides its number, and how it is asked for.
        const into = {};
        const problems = {};
        for (const s of steps ?? []) {
            const target = intoOf(s, d);
            if (target && inputs[target]) {
                const spec = inputs[target];
                into[target] = { type: spec.type, label: spec.label ?? target, ...(Array.isArray(spec.values) ? { values: spec.values } : {}), ...(spec.unit ? { unit: spec.unit } : {}) };
            }
        }
        // A record's own steps are checked here, as they are shown: one that names what is not there says so.
        for (const m of stepTargetProblems(steps ?? [], d, inputs, [...(await store.screens()).keys()])) {
            const k = Number(/^step (\d+)/.exec(m)?.[1]);
            if (k) problems[steps[k - 1].n] = m.replace(/^step \d+, "[^"]*": ?/, "");
        }
        return {
            list, log: logDef.body.object, transaction: d.transaction, label: tx.body.label ?? d.transaction, signed: Boolean(tx.body.signature), meaning: tx.body.signature?.meaning ?? null,
            // Verified by a second person (§7.4): the one signed in beside the operator, as on its form.
            verifier: tx.body.signature?.verifier?.meaning ?? null, step: d.step, fills, into, gate: d.gate === true, problems,
        };
    }
    // A guide that follows a route (§35.4, §32.4): the traveler's way along it, the sequences placed in the
    // guide as its steps, each done once the route has left it, the one it is at the current step.
    async function routeSteps(user, r, scope) {
        let id;
        try { id = evaluate(r.of, scope); } catch { id = null; }
        if (typeof id !== "string" || !UUID.test(id)) return { route: null };
        const [run] = await x.reader.query("SELECT id, flow, version, node, state FROM mes.flow_runs WHERE subject_id = $1 AND flow = $2 AND kind = 'route' ORDER BY (state <> 'ended') DESC, started_at DESC LIMIT 1", [id, r.flow]);
        const [t] = run ? await x.reader.query("SELECT body FROM mes.flows WHERE name = $1 AND version = $2", [run.flow, run.version]) : await x.reader.query("SELECT body FROM mes.flows WHERE name = $1 ORDER BY version DESC LIMIT 1", [r.flow]);
        if (!t) return { route: null };
        const nodes = t.body.nodes ?? {};
        const way = run ? await x.reader.query("SELECT node, at, by FROM mes.flow_steps WHERE run_id = $1 ORDER BY seq", [run.id]) : [];
        const left = new Map();
        for (const [i, w] of way.entries()) if (i < way.length - 1 || run.state === "ended") left.set(w.node, { by: way[i + 1]?.by ?? w.by, at: way[i + 1]?.at ?? w.at });
        const txs = await store.transactions();
        const steps = Object.entries(nodes).filter(([, n]) => n?.kind === "sequence" && typeof n.guide === "string" && secondsOf(n.guide.trim()) !== null)
            .map(([node, n]) => ({ node, at: secondsOf(n.guide.trim()), time: n.guide.includes(":"), label: n.label ?? node, needs: "route", leaves: (n.leaves ?? []).map((name) => txs.get(name)?.body.label ?? name) }))
            .sort((a, b) => a.at - b.at)
            .map((s, i) => ({ ...s, n: i + 1 }));
        const list = {};
        for (const s of steps) {
            const l = left.get(s.node);
            if (l && s.node !== (run.state === "ended" ? null : run.node)) list[s.n] = { by: l.by, at: l.at instanceof Date ? l.at.toISOString() : l.at };
        }
        const ids = [...new Set(Object.values(list).map((v) => v.by).filter(Boolean))];
        const names = ids.length ? new Map((await store.db.query("SELECT id, name FROM mes.users WHERE id = ANY($1)", [ids])).map((u) => [u.id, u.name])) : new Map();
        for (const v of Object.values(list)) v.name = names.get(v.by) ?? "the route";
        const current = run && run.state !== "ended" ? steps.find((s) => s.node === run.node)?.n ?? null : null;
        return { steps, route: { flow: r.flow, label: t.body.label ?? r.flow, state: run?.state ?? null, current, nodeLabel: run ? nodes[run.node]?.label ?? run.node : null }, done: { list, route: true } };
    }

    // What was done lately with some transactions (§26.10, a `runs` block): their runs as the audit trail keeps
    // them, newest first, each with the records it moved as the viewer may read them now (one they may not, or one archived since, is
    // left out, and a run with none left), its state's way and the values it set (only fields the viewer may read, never
    // a sensitive one; what it emptied is not said), who ran it and when. Nothing is written for it: the runs are already audited (§7).
    async function runsOf(user, b) {
        const names = (Array.isArray(b.transactions) ? b.transactions : []).filter((n) => typeof n === "string");
        if (!names.length) return { rows: [] };
        const limit = Number.isInteger(b.limit) ? Math.min(200, Math.max(5, b.limit)) : 50;
        const live = await store.transactions();
        const mine = b.mine === true;
        const audited = await x.reader.query(
            `SELECT a.seq, a.at, a.actor, u.name AS who, a.after FROM mes.audit_log a LEFT JOIN mes.users u ON u.id = a.actor
             WHERE a.object = '$transaction' AND a.action = ANY($1)${mine ? " AND a.actor = $3" : ""} ORDER BY a.seq DESC LIMIT $2`,
            mine ? [names.map((n) => `run:${n}`), limit, user.id] : [names.map((n) => `run:${n}`), limit]);
        const defs = new Map();
        const seenRows = new Map();
        const rows = [];
        for (const a of audited) {
            const records = [];
            for (const r of Array.isArray(a.after?.records) ? a.after.records : []) {
                if (!defs.has(r.object)) defs.set(r.object, await store.definition(r.object));
                const def = defs.get(r.object);
                if (!def || typeof r.id !== "string" || !UUID.test(r.id)) continue;
                // (A record archived since, removed from use, is not in a desk's history: its runs are in its own.)
                if (!seenRows.has(r.id)) { const row = await x.loadRow(x.reader, r.object, r.id); seenRows.set(r.id, row && !row.archived_at ? mask(def.body, await x.actorFor(user, r.object), x.rowOut(row)) : null); }
                const seen = seenRows.get(r.id);
                if (!seen) continue;
                const said = new Set();
                const fields = Object.entries(r.fields ?? {})
                    .filter(([f]) => Object.hasOwn(def.body.fields ?? {}, f) && !isSensitive(def.body, f) && seen.$perm?.fields?.[f])
                    .map(([, v]) => ({ label: v.label, to: v.to ?? null }))
                    // What it set, not what it cleared (a board off its tester: its tester, lot, borrower emptied).
                    .filter((v) => v.to !== null && v.to !== "")
                    .filter((v) => { const k = `${v.label}\u0000${v.to}`; if (said.has(k)) return false; said.add(k); return true; });
                records.push({ id: r.id, object: r.object, title: seen[def.body.titleField] ?? r.title ?? null, label: def.body.label, from: r.state?.from ?? null, to: r.state?.to ?? null, tones: def.body.states?.tones ?? {}, fields });
            }
            if (records.length) rows.push({ seq: Number(a.seq), at: a.at, who: a.who ?? a.actor, transaction: live.get(a.after?.transaction)?.body.label ?? a.after?.transaction ?? "", records });
        }
        return { rows };
    }

    async function blockData(user, b, scope) {
        // A block of a kind a suite adds (§30.11): what the suite reads for it, as the viewer. With the
        // suite gone the block says what it needs, and the screen's other blocks are read as ever.
        if (typeof b.block === "string" && b.block.includes(".")) {
            const spec = design.suiteExtensions().blocks[b.block];
            if (!spec) return { $needs: b.block.split(".")[0] };
            return (await spec.data?.(b, { user: { id: user.id, name: user.name }, param: scope.param ?? {} })) ?? {};
        }
        if (b.block === "runs") return runsOf(user, b);
        // The step a record's plan waits at (§26.10, a `plan` block): the newest running plan set off by the record the
        // block names (of its flows, if it names some), as the viewer may read that record. The page draws the step
        // itself (flows.task: its form for those it is for, whom it waits for to anyone else).
        if (b.block === "plan") {
            const id = evaluate(b.of, scope);
            if (typeof id !== "string" || !UUID.test(id)) return { run: null };
            const flows = Array.isArray(b.flows) ? b.flows.filter((f) => typeof f === "string") : [];
            const [r] = await x.reader.query(`SELECT id, subject_object FROM mes.flow_runs WHERE kind = 'plan' AND state = 'running' AND subject_id = $1${flows.length ? " AND flow = ANY($2)" : ""} ORDER BY started_at DESC LIMIT 1`, flows.length ? [id, flows] : [id]);
            if (!r) return { run: null };
            const def = await store.definition(r.subject_object);
            const row = def ? await x.loadRow(x.reader, r.subject_object, id) : null;
            const seen = row && mask(def.body, await x.actorFor(user, r.subject_object), x.rowOut(row));
            return seen ? { run: r.id } : { run: null };
        }
        // A table of a named query's rows (§23.1, §26): the query run as the viewer (what their policies hide is not
        // there), its parameters bound over the screen's parameter and the viewer, in the design's order, at most its
        // limit. Ids are never shown, each its record's title; a row keeps its id for its buttons (`object`).
        if (b.block === "table" && b.query !== undefined) {
            if (!query) return { error: "Queries are not set up here." };
            const body = (await store.queries()).get(b.query)?.body;
            if (!body) return { error: `The query ${b.query} is not there: ask whoever designs this screen.` };
            try {
                const values = Object.fromEntries(Object.entries(b.params ?? {}).map(([p, e]) => [p, evaluate(e, scope) ?? null]));
                const ran = await query.pageNamed(user, body, values, { sort: b.sort, limit: b.limit ?? 200, channel: "screen" });
                const at = (c) => ran.columns.indexOf(c);
                const shown = Array.isArray(b.columns) && b.columns.length ? b.columns.filter((c) => at(c) >= 0) : ran.columns.filter((c) => c !== "id");
                const named = titles ? await titles.titled(user, ran) : ran;
                const odef = b.object ? await store.definition(b.object) : null;
                return {
                    query: b.query, label: body.label ?? b.query, columns: shown, object: odef ? b.object : null, truncated: Boolean(ran.truncated),
                    // A row's state, when the query gives it, decides which of its buttons it offers (their appearsOn states).
                    rows: ran.rows.map((row, i) => ({ id: at("id") >= 0 ? row[at("id")] : null, ...(at("state") >= 0 ? { state: row[at("state")] } : {}), cells: shown.map((c) => named.rows[i][at(c)]) })),
                };
            } catch (error) {
                return { error: error?.expose === true ? error.message : "This table could not be read." };
            }
        }
        const def = b.object ? await store.definition(b.object) : null;
        if (["record", "table", "kpi", "breakdown", "floor"].includes(b.block) && !def) return { error: `No object ${b.object}.` };
        switch (b.block) {
            // A floor layout (§35): the placed records the viewer may read, each with its status as it
            // is now and its picture. Only those placed are read (by what they are called), never the
            // object's whole list; one the viewer may not read is drawn where it stands, saying nothing.
            case "floor": {
                const d = def.body;
                const status = b.status ?? "state";
                const places = (Array.isArray(b.places) ? b.places : []).slice(0, MAX_PLACES);
                const base = {
                    object: d.object, label: d.label, image: b.image ?? null, status, statusLabel: status === "state" ? "State" : d.fields[status]?.label ?? status,
                    values: statusValues(d, status), colours: b.colours ?? {}, tones: status === "state" ? d.states.tones ?? {} : {},
                };
                if (!d.titleField || !places.length) return { ...base, items: [] };
                const rows = await visibleRows(user, def, { ...whereOf(b, scope), [d.titleField]: places.map((p) => p.of) }, { limit: MAX_PLACES });
                const by = new Map(rows.map((r) => [String(r[d.titleField]), r]));
                // Each record's picture: an image field of its own, or of the record a reference field
                // of it names (its model), read with the viewer's rights on that object.
                const [own, far] = String(b.picture ?? "").split(".");
                let pictureOf = () => null;
                if (own && !far) pictureOf = (r) => r[own] ?? null;
                else if (own && far && d.fields[own]?.type === "ref") {
                    const other = await store.definition(d.fields[own].to);
                    const seen = new Map();
                    if (other) {
                        const actor = await x.actorFor(user, other.body.object);
                        for (const id of new Set(rows.map((r) => r[own]).filter((v) => typeof v === "string" && UUID.test(v)))) {
                            const row = await x.loadRow(x.reader, other.body.object, id);
                            const shown = row && mask(other.body, actor, x.rowOut(row));
                            if (shown) seen.set(id, shown[far] ?? null);
                        }
                    }
                    pictureOf = (r) => seen.get(r[own]) ?? null;
                }
                return {
                    ...base,
                    items: places.map((p) => {
                        const r = by.get(p.of);
                        const v = r ? (status === "state" ? r.state : isSensitive(d, status) ? null : r[status]) : null;
                        return { of: p.of, x: p.x, y: p.y, w: p.w, ix: p.ix, iy: p.iy, id: r?.id ?? null, status: v === undefined || v === null ? null : String(v), picture: r ? pictureOf(r) : null };
                    }),
                };
            }
            // A file shown (§35.4): a record's file or picture, read through the record as the viewer (its
            // policies, what its access requires), or a file of the screen's own design (its guide).
            case "media": {
                const about = async (blob) => (await x.reader.query("SELECT type, size, name FROM mes.blobs WHERE sha256 = $1", [blob]))[0] ?? null;
                let shown;
                if (typeof b.file === "string") {
                    const meta = /^[0-9a-f]{64}$/.test(b.file) ? await about(b.file) : null;
                    shown = meta ? { src: `/blob/${b.file}`, type: meta.type, size: meta.size, name: b.name ?? meta.name ?? null, steps: parseSteps(b.steps).steps } : { src: null };
                } else {
                    if (!def || !["file", "image"].includes(def.body.fields?.[b.field]?.type)) return { src: null };
                    const id = evaluate(b.of, scope);
                    if (typeof id !== "string" || !UUID.test(id)) return { src: null };
                    const row = await x.loadRow(x.reader, def.body.object, id);
                    const seen = row && mask(def.body, await x.actorFor(user, def.body.object), x.rowOut(row));
                    const blob = seen?.[b.field];
                    const meta = typeof blob === "string" && /^[0-9a-f]{64}$/.test(blob) ? await about(blob) : null;
                    // Its steps, from a text field of the same record, as the viewer may read it.
                    const stepsText = b.stepsField && typeof seen?.[b.stepsField] === "string" ? seen[b.stepsField] : null;
                    shown = meta ? { src: `/file/${def.body.object}/${id}/${b.field}`, type: meta.type, size: meta.size, name: meta.name ?? null, title: seen[def.body.titleField] ?? null, steps: parseSteps(stepsText).steps } : { src: null, none: Boolean(seen) };
                }
                if (!shown.src) return shown;
                if (b.route) return { ...shown, ...(await routeSteps(user, b.route, scope)) };
                if (b.done) return { ...shown, done: await stepsDone(user, b.done, scope, shown.steps) };
                return shown;
            }
            case "record": {
                const id = evaluate(b.of, scope);
                const show = b.show ?? [];
                const base = { object: def.body.object, label: def.body.label, fields: fieldsOf(def, show), tones: def.body.states.tones ?? {} };
                if (typeof id !== "string" || !UUID.test(id)) return { ...base, record: null };
                const row = await x.loadRow(x.reader, def.body.object, id);
                const seen = row && mask(def.body, await x.actorFor(user, def.body.object), x.rowOut(row));
                if (!seen) return { ...base, record: null };
                const [titled] = await x.withTitles(def.body, user, [{ ...seen, $title: seen[def.body.titleField] ?? null }]);
                return { ...base, record: slim({ ...titled, $title: seen[def.body.titleField] ?? null }, show) };
            }
            case "table": {
                // The fields its row buttons' conditions read (appearsOn.when) ride along, unshown.
                const txs = b.rowActions?.length ? await store.transactions() : null;
                const extra = (b.rowActions ?? []).flatMap((t) => (txs.get(t)?.body.appearsOn?.when !== undefined ? referencesOf(txs.get(t).body.appearsOn.when) : []).filter((r) => r.scope === "record").map((r) => String(r.path).split(".")[0]));
                const columns = b.columns ?? [];
                const carried = [...columns, ...extra.filter((f) => !columns.includes(f) && Object.hasOwn(def.body.fields, f))];
                const rows = await visibleRows(user, def, whereOf(b, scope), { sort: b.sort, limit: b.limit ?? 200 });
                const titled = await x.withTitles(def.body, user, rows);
                // The record buttons the viewer may have: New (their right to create), Remove on the rows
                // they may archive (and the row's version, which archiving checks).
                const actor = await x.actorFor(user, def.body.object);
                const canCreate = Boolean(b.create) && decide(def.body, actor, { state: def.body.states.initial }).create;
                return {
                    // No role on the object: an empty table says so, rather than looking as if there were none.
                    object: def.body.object, label: def.body.label, fields: fieldsOf(def, columns), tones: def.body.states.tones ?? {}, canCreate, noRole: !actor.roles.length,
                    rows: titled.map((r) => ({ ...slim({ ...r, $title: r[def.body.titleField] ?? null }, carried), ...(b.archive ? { $archive: Boolean(r.$perm?.archive), row_version: r.row_version } : {}) })),
                };
            }
            case "kpi": {
                const field = b.measure && b.measure !== "count" ? Object.values(b.measure)[0] : null;
                const unit = field ? def.body.fields[field]?.label ?? field : null;
                const s = await scopeOf(user, def, whereOf(b, scope), sinceOf(b.since, plantTz));
                if (s?.rights) {
                    const [a] = await x.reader.query(`SELECT ${aggregatesSql(def, s.rights, b.measure ?? "count")} FROM mes.records r WHERE ${s.sql}`, s.params);
                    return { value: measured(a, b.measure ?? "count"), of: Number(a.n), unit };
                }
                const rows = await visibleRows(user, def, whereOf(b, scope), { since: sinceOf(b.since, plantTz) });
                return { value: measure(rows, b.measure ?? "count"), of: rows.length, unit };
            }
            case "breakdown": {
                const label = b.by === "state" ? "State" : def.body.fields[b.by]?.label ?? b.by;
                const isRef = def.body.fields[b.by]?.type === "ref";
                // Never grouped by a sensitive field (§6.10): the groups would tell what it holds.
                if (isSensitive(def.body, b.by)) return { by: label, groups: [] };
                const s = await scopeOf(user, def, whereOf(b, scope), sinceOf(b.since, plantTz));
                const top = (groups) => [...groups].map(([key, a]) => ({ key, value: measured(a, b.measure ?? "count") })).sort((a, c) => (c.value ?? 0) - (a.value ?? 0)).slice(0, 12);
                if (s?.rights) {
                    // Grouped in the database by what the page shows: the state, or the field's text (a
                    // list joined by ", ", empty as "—"); a reference by the record it names, then titled
                    // here, with the viewer's rights on that object (several may share "(not visible)").
                    // A record whose field the viewer may not read, or that has none, is in no group.
                    if (b.by !== "state" && !def.body.fields[b.by]) return { by: label, groups: [] };
                    const j = `r.data->${lit(b.by)}`;
                    const key = b.by === "state" ? "r.state" : isRef ? `r.data->>${lit(b.by)}` : `(CASE jsonb_typeof(${j}) WHEN 'null' THEN '' WHEN 'array' THEN array_to_string(ARRAY(SELECT jsonb_array_elements_text(${j})), ', ') WHEN 'object' THEN '' ELSE r.data->>${lit(b.by)} END)`;
                    const readable = b.by === "state" ? "true" : s.rights.field(b.by);
                    const only = b.by === "state" ? "" : ` AND ${readable} AND r.data ? ${lit(b.by)}`;
                    const rows = await x.reader.query(
                        `SELECT ${key} AS k, ${aggregatesSql(def, s.rights, b.measure ?? "count")}, max(r.updated_at) AS last
                         FROM mes.records r WHERE ${s.sql}${only} GROUP BY 1 ORDER BY last DESC LIMIT 10000`,
                        s.params,
                    );
                    const titled = isRef ? await x.withTitles(def.body, user, rows.map((r) => ({ [b.by]: r.k }))) : null;
                    const groups = new Map();
                    rows.forEach((r, i) => {
                        const k = r.k === null || r.k === "" ? "—" : isRef ? titled[i].$titles?.[b.by] ?? "(not visible)" : String(r.k);
                        const g = groups.get(k);
                        if (!g) return groups.set(k, { ...r });
                        g.n = Number(g.n) + Number(r.n); g.c = Number(g.c) + Number(r.c);
                        g.sum = g.sum === null ? r.sum : r.sum === null ? g.sum : Number(g.sum) + Number(r.sum);
                        g.lo = g.lo === null ? r.lo : r.lo === null ? g.lo : Math.min(Number(g.lo), Number(r.lo));
                        g.hi = g.hi === null ? r.hi : r.hi === null ? g.hi : Math.max(Number(g.hi), Number(r.hi));
                    });
                    return { by: label, groups: top(groups) };
                }
                const rows = await visibleRows(user, def, whereOf(b, scope), { since: sinceOf(b.since, plantTz) });
                const titled = isRef ? await x.withTitles(def.body, user, rows) : rows;
                const groups = new Map();
                for (const r of titled) {
                    const raw = b.by === "state" ? r.state : r[b.by];
                    if (raw === undefined && b.by !== "state") continue; // a field this viewer may not read
                    const key = raw === null || raw === "" ? "—" : isRef ? r.$titles?.[b.by] ?? "(not visible)" : Array.isArray(raw) ? raw.join(", ") : String(raw);
                    (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
                }
                return { by: label, groups: [...groups].map(([key, list]) => ({ key, value: measure(list, b.measure ?? "count") })).sort((a, c) => (c.value ?? 0) - (a.value ?? 0)).slice(0, 12) };
            }
            // A chart (§34.9): its query run as the viewer, as theirs would be on the Queries page (what their
            // policies hide is not there); a JSON query's { param: name } is the screen's parameter.
            case "chart": {
                if (!query) return { error: "Charts are not set up here." };
                const withParam = (v) => (Array.isArray(v) ? v.map(withParam) : isPlain(v) ? (Object.keys(v).length === 1 && typeof v.param === "string" ? scope.param?.[v.param] ?? null : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withParam(x)]))) : v);
                // A named query's rows (§23.1, `{ named, params? }`): one formula, approved once, for every chart and
                // table that reads it; its parameters bound over the screen's parameter and the viewer.
                const named = typeof b.query.named === "string" ? (await store.queries()).get(b.query.named)?.body ?? null : null;
                if (b.query.named !== undefined && !named) return { error: `The query ${b.query.named} is not there: ask whoever designs this screen.` };
                try {
                    const ran = named
                        ? await query.runNamed(user, named, Object.fromEntries(Object.entries(isPlain(b.query.params) ? b.query.params : {}).map(([p, e]) => [p, evaluate(e, scope) ?? null])), { channel: "screen" })
                        : await query.runAs(user, b.query.sql !== undefined ? { sql: b.query.sql } : { json: withParam(b.query.json) }, rowsFor(b));
                    // Ids never shown (§34.9): each is its record's title, as the viewer may read it.
                    const r = titles ? await titles.titled(user, ran) : ran;
                    return { columns: r.columns, rows: r.rows, truncated: Boolean(r.truncated) };
                } catch (error) {
                    return { error: error?.expose === true ? error.message : "This chart could not be read." };
                }
            }
            // A button that opens a screen as a dialog (§26.6): offered only to those who may open it.
            case "button": {
                const target = (await store.screens()).get(b.opens);
                return { canOpen: Boolean(target && (await mayOpen(target, user))), label: target?.body.label ?? b.opens };
            }
            default:
                return {};
        }
    }

    // Pop-ups (§26.7): the screens whose design opens them by themselves over `target` (a transaction's
    // page, a screen's, or every page: "*"), for this person, while their condition holds. The
    // condition reads what the page has (a transaction's inputs and the records they name, a screen's
    // parameter) with counts, as a transaction's checks do. A pop-up decides nothing: a condition that
    // cannot be worked out is simply not holding.
    const inGroups = async (who, user) => {
        if ((who?.users ?? []).includes(user.id)) return true;
        if (!(who?.groups ?? []).length) return false;
        const groups = await store.db.query("SELECT group_id FROM mes.group_members WHERE user_id = $1", [user.id]);
        return groups.some((g) => who.groups.includes(g.group_id));
    };
    async function popupsFor(user, target, values) {
        const person = { id: user.id, name: user.name };
        let scope = { user: person };
        if (target.startsWith("transaction:")) scope = (await transactions.scopeFor(user, target.slice("transaction:".length), values)) ?? scope;
        else if (target.startsWith("screen:")) {
            const p = paramOf((await store.screens()).get(target.slice("screen:".length))?.body ?? {});
            scope = { param: p ? { [p[0]]: values?.[p[0]] ?? null } : {}, user: person };
        }
        const out = [];
        for (const s of (await store.screens()).values()) {
            const popup = s.body.popup;
            if (!isPlain(popup) || !(popup.on ?? []).includes(target)) continue;
            if (!(await inGroups(popup.for, user)) || !(await mayOpen(s, user))) continue;
            let holds = false;
            try { holds = evaluate(popup.while, await transactions.counted([popup.while], scope)) === true; } catch { holds = false; }
            if (!holds) continue;
            let arg = null;
            try { arg = popup.with === undefined ? null : evaluate(popup.with, scope) ?? null; } catch { arg = null; }
            out.push({ name: s.body.name, label: s.body.label, arg });
        }
        return out;
    }

    // A screen's data for one viewer, opened with `arg` (its parameter's value).
    async function dataOf(user, body, arg) {
        const param = paramOf(body);
        const scope = { param: {}, user: { id: user.id, name: user.name } };
        // What a block's condition reads besides (§26.9): the record the screen was opened with, as the
        // viewer may read it ({ lookup: "<param>.<field>" }), and the viewer's departments.
        const lookup = {};
        let paramRecord = null;
        if (param) {
            const [name, spec] = param;
            const value = arg === undefined || arg === null || arg === "" ? null : arg;
            if (value === null) return spec.required === false ? { param: null, blocks: await all() } : { need: name };
            if (spec.type === "ref") {
                const def = await store.definition(spec.to);
                const row = def && typeof value === "string" && UUID.test(value) ? await x.loadRow(x.reader, spec.to, value) : null;
                const seen = row && mask(def.body, await x.actorFor(user, spec.to), x.rowOut(row));
                if (!seen) return { need: name, error: `No ${def?.body.label?.toLowerCase() ?? spec.to} that you can see.` };
                // Only the records it opens with (its where): a wire bonder is not opened as a die saw.
                const off = Object.entries(spec.where ?? {}).find(([f, v]) => !(Array.isArray(v) ? v : [v]).includes(f === "state" ? row.state : seen[f]));
                if (off) return { need: name, error: `${seen[def.body.titleField] ?? "This record"} is not one this screen opens with: its ${(def.body.fields[off[0]]?.label ?? off[0]).toLowerCase()} is ${seen[off[0]] ?? row.state ?? "empty"}.` };
                paramRecord = { id: row.id, title: seen[def.body.titleField] ?? row.id.slice(0, 8), state: row.state, tones: def.body.states.tones ?? {} };
                lookup[name] = { ...Object.fromEntries(Object.keys(def.body.fields).filter((f) => seen[f] !== undefined).map((f) => [f, seen[f]])), state: row.state, id: row.id };
            }
            scope.param[name] = value;
        }
        return { param: paramRecord ?? (param ? { value: scope.param[param[0]] } : null), blocks: await all() };
        async function all() {
            const out = [];
            const conditioned = (body.blocks ?? []).some((b) => b.showWhen !== undefined || b.enableWhen !== undefined);
            const cond = conditioned ? { ...scope, user: { ...scope.user, departments: await store.departmentsOf(user.id) }, lookup } : null;
            // A condition that cannot be worked out is not holding: the block is not shown, or not enabled.
            const holds = async (expr) => { try { return evaluate(expr, await transactions.counted([expr], cond)) === true; } catch { return false; } };
            for (const b of body.blocks ?? []) {
                // Not shown: not read either, so nothing of it reaches the page.
                if (b.showWhen !== undefined && !(await holds(b.showWhen))) { out.push({ $off: "hidden" }); continue; }
                // A form the viewer may not send (not among its callers) is left out too (§26.10: a desk two kinds of
                // people use, each seeing only their own moves).
                if (b.block === "transaction" && transactions.mayRun && !(await transactions.mayRun(b.name, user))) { out.push({ $off: "hidden" }); continue; }
                let data;
                try { data = await blockData(user, b, scope); } catch (error) { data = { error: error.expose ? error.message : "This block could not be read." }; }
                if (b.enableWhen !== undefined && !(await holds(b.enableWhen))) data = { ...data, $off: "disabled", $why: b.disabledBecause ?? null };
                out.push(data);
            }
            return out;
        }
    }

    async function load(self, name, as) {
        const user = await x.requireViewer(self, as);
        const s = typeof name === "string" ? (await store.screens()).get(name) : null;
        return { user, s: s && (await mayOpen(s, user)) ? s : null };
    }

    const services = {
        // The screens this person may open, for the navigator.
        async "screens.list"({ as } = {}) {
            const user = await x.requireViewer(this, as);
            const out = [];
            for (const s of (await store.screens()).values()) if (await mayOpen(s, user)) out.push({ name: s.body.name, label: s.body.label, description: s.body.description ?? "", param: paramOf(s.body)?.[0] ?? null });
            return out.sort((a, b) => a.label.localeCompare(b.label));
        },
        // Its definition; null for one that does not exist or is not this person's to open.
        async "screens.get"({ name, as } = {}) {
            const { s } = await load(this, name, as);
            return s ? { ...publicOf(s), ...(await inputFlowOf(store, s.body.inputFlow)) } : null;
        },
        // What its blocks show, for this viewer: live, re-run whenever a record changes.
        async "screens.data"({ name, arg = null, as } = {}) {
            const { user, s } = await load(this, name, as);
            return s ? dataOf(user, s.body, arg) : null;
        },
        // The pop-ups open over a page for this person now (§26.7): live, re-run whenever a record
        // changes, so one appears and goes away for everyone at once.
        async "popups.for"({ target, values = {}, as } = {}) {
            const user = await x.requireViewer(this, as);
            if (typeof target !== "string" || !/^(\*|(transaction|screen):[a-z][a-z0-9_]{0,47})$/.test(target)) fail("A pop-up's page is transaction:<name>, screen:<name> or *.");
            return popupsFor(user, target, isPlain(values) ? values : {});
        },
        // A draft screen, for its designer: checked, then drawn with the designer's own rights.
        async "screens.preview"({ screen, arg = null } = {}) {
            const user = await design.designUser(this);
            if (!isPlain(screen)) fail("Give the draft screen.");
            const problems = validateScreen(screen, await design.knownFor({}));
            if (problems.length) return { problems };
            return { def: { ...screen, params: screen.params ?? {}, blocks: screen.blocks ?? [] }, data: await dataOf(user, screen, arg) };
        },
    };
    const touches = { "screens.list": [], "screens.get": [], "screens.data": [], "popups.for": [], "screens.preview": [] };
    return { services, touches, queries: ["screens.list", "screens.get", "screens.data", "popups.for"] };
}
