// The sandbox (DESIGN.md §5.11): a change's draft run on copies of real records, in a database of its
// own, so nothing in the live database is ever written. A rolled-back transaction on the live database
// was the other way, and the wrong one: every audited write locks the audit chain's head (audit.js),
// so a sandbox held open while a designer clicks would stall every write in the plant.
//
//   template   <live>_sbxt: the schema and the migrations, empty; built once per schema, by its hash
//   a sandbox  <live>_sbx_<node>_<random>, from the template: the people and what is published copied
//              from live, the change's draft applied by the path that executes an approved change
//              (design.executeInto), and an app of its own on it (createApp, no outbound calls, no
//              scheduler), called over HTTP as whoever a step runs as: policies, rule pipes, steps
//              and audit all as in production, in the sandbox.
//   records    { key: { object, id?, where? } }    picked: copied from live, with what they refer to
//                                                  (two references deep), masked by the opener's live
//                                                  rights (a draft that widens access shows no more);
//                                                  `id` when it still matches `where`, else the first
//                                                  record that does
//              { key: { object, data, state? } }   given: made in the sandbox (after the draft, so a
//                                                  new object's records too); "@key" names another,
//                                                  in any order
//   a step     { as?, do: { transaction, input } | { action, record } | { update, data } |
//                         { create, data, key? } | { service, input } | { screen, arg? } |
//                         { act: { record, plan?, action?: acknowledge | retry | time_up, choice?, values? } },
//                expect?: { ok, error, states: { key: state }, fields: { key: { field: value } },
//                           created: { object: n }, node: { key: node } } }   values "@key" name a record
// `act` answers the plan a record is in, as the person (a flow template's scenario, §32.8); `time_up`
// makes a wait's time pass, here only. `node` expects the node a record's run reached: of the template
// the scenario belongs to, or of any it is in.
// A scenario (a transaction's or a flow template's `scenarios`, kept with each of its versions) is
// { name, records, steps }. The fitness test runs every scenario of a new or changed transaction or
// template in one sandbox, each on fresh copies, and one without a scenario fails it (§5.9).
//
// Interactive sandboxes are one per person per change, closed after a quarter of an hour unused, at
// most LIMITS.open on a node; one left behind is dropped when twelve hours old. The live audit trail
// says who opened one, on what.
import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { fail } from "../../../src/errors.js";
import { loadSchema } from "../db/schema-load.mjs";
import { migrate, MIGRATIONS } from "../db/migrate.mjs";
import { mask } from "./policy.js";
import { sessionCookieFor } from "./auth.js";
import { sessionKey } from "./store.js";
import { recordWhere } from "./record-where.js";
import { appendAudit, sha256 } from "./audit.js";
import { adoptRuns } from "./flows.js";
import { managedOf } from "../client/builtins.js";

const IDENT = /^[a-z][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Copied whole: who people are and what they may do, in an order their references allow.
const PEOPLE = ["users", "groups", "group_members", "department_reps", "assignments", "organization"];
const DESIGNS = ["definitions", "scripts", "transactions", "screens", "services", "connections", "flows", "layouts", "elements"];
// open: sandboxes open on this server; perPerson: of those, one person's; scenarios: sandboxes of scenario
// runs (a fitness test, a scenario tried) made at once, the rest waiting their turn, at most `waiting`.
export const LIMITS = { open: 6, perPerson: 2, scenarios: 3, waiting: 20, records: 200, depth: 2, idleMs: 15 * 60_000, steps: 50, leftoverMs: 12 * 60 * 60_000 };
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const holds = (want, have) => (isPlain(want) ? isPlain(have) && Object.entries(want).every(([k, v]) => holds(v, have[k])) : same(want, have));
const cut = (name) => name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 63);
const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);

// A saved selection's name: what the person called it (a date in it, if they like), 1 to 120 characters.
function selectionName(name) {
    const text = typeof name === "string" ? name.trim() : "";
    if (!text || text.length > 120) fail("Name the selection: 1 to 120 characters (a date in it helps, \"Lots at test 2026-10-03\").", { status: 400, fields: { name: "Required." } });
    return text;
}
// Its records, as a sandbox starts with them: { key: { object, id? | where? } } picked, or { object, data, state? } given.
export function selectionProblem(records) {
    if (!isPlain(records)) return "A selection's records are { key: { object, id or where, or data } }.";
    const keys = Object.keys(records);
    if (keys.length > LIMITS.records) return `A selection holds at most ${LIMITS.records} records.`;
    for (const k of keys) {
        const r = records[k];
        if (!IDENT.test(k)) return `"${k}": a key is lower case letters, digits and _, starting with a letter.`;
        if (!isPlain(r) || typeof r.object !== "string" || !IDENT.test(r.object)) return `"${k}": name its object.`;
        if (r.data === undefined && r.id === undefined && r.where === undefined) return `"${k}": pick a record (its id), say where to find one, or give its data.`;
        if (r.id !== undefined && !(typeof r.id === "string" && UUID.test(r.id))) return `"${k}": its id is not a record's.`;
        if ((r.where !== undefined && !isPlain(r.where)) || (r.data !== undefined && !isPlain(r.data))) return `"${k}": where and data are { field: value }.`;
    }
    return null;
}

// "@key" anywhere in a value: the id of the record that key names.
function resolve(value, ids) {
    if (typeof value === "string" && value.startsWith("@")) {
        const id = ids[value.slice(1)];
        if (!id) fail(`"${value}" names no record of this sandbox.`, { status: 400 });
        return id;
    }
    if (Array.isArray(value)) return value.map((v) => resolve(v, ids));
    if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ids)]));
    return value;
}

// What a step's outcome lacks of what was expected, in words; nothing when it holds.
export function verdict(expect = { ok: true }, out, { flow = null } = {}) {
    const problems = [];
    const wantOk = expect.ok ?? true;
    if (wantOk && !out.ok) problems.push(`it was refused: ${out.error}`);
    if (!wantOk && out.ok) problems.push("it ran, but it was expected to be refused");
    if (expect.error !== undefined && !String(out.error ?? "").includes(expect.error)) problems.push(`expected the words "${expect.error}"${out.error ? `, it said "${out.error}"` : ""}`);
    for (const [key, state] of Object.entries(expect.states ?? {})) if (out.states?.[key] !== state) problems.push(`${key} is ${out.states?.[key] ?? "missing"}, expected ${state}`);
    for (const [key, want] of Object.entries(expect.fields ?? {})) if (!holds(want, out.data?.[key])) problems.push(`${key}'s ${Object.keys(want).join(", ")} ${JSON.stringify(Object.fromEntries(Object.keys(want).map((f) => [f, out.data?.[key]?.[f] ?? null])))}, expected ${JSON.stringify(want)}`);
    for (const [object, n] of Object.entries(expect.created ?? {})) if ((out.created?.[object] ?? 0) !== n) problems.push(`${out.created?.[object] ?? 0} ${object} created, expected ${n}`);
    for (const [key, want] of Object.entries(expect.node ?? {})) {
        const runs = out.nodes?.[key] ?? {};
        const got = flow ? runs[flow] : Object.values(runs).find((r) => r.node === want) ?? Object.values(runs)[0];
        if (got?.node !== want) problems.push(`${key} is ${got ? `at ${got.node}${got.state === "stopped" ? ` (stopped: ${got.reason})` : ""}` : `on no ${flow ?? "flow"}`}, expected at ${want}`);
    }
    return problems;
}

// `test`: where the test sandbox (§5.13) is served: { port (0: any free one), host, url? (its address, when a
// proxy in front gives it one of its own) }.
export function createSandboxes({ store, design, records, suites = [], instance = null, makeApp, test = { port: 0, host: "127.0.0.1", url: null }, url = process.env.DATABASE_URL ?? "postgres:///openmes_poc", log = console }) {
    const { db } = store;
    const open = new Map(); // `${change}:${user}` -> sandbox
    const node = cut(instance ?? "local").slice(0, 12);
    const urlFor = (name) => url.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
    let live = null;
    const liveName = async () => (live ??= (await db.query("SELECT current_database() AS d"))[0].d);
    // A pool on a sandbox's (or the template's) database. An error on one of its connections (one
    // closing as its database is dropped) is expected there, never a crash: every connection has a
    // listener, as the pool has.
    const poolFor = (name, max) => {
        const pool = new pg.Pool({ connectionString: urlFor(name), max });
        pool.on("error", () => {});
        pool.on("connect", (client) => client.on("error", () => {}));
        return pool;
    };
    // Dropped once nothing is connected to it (a pool's end lets go of its connections before the
    // server has seen them close); forced only if something still is, after a few seconds.
    const drop = async (name) => {
        for (let i = 0; i < 40; i++) {
            const [{ n }] = await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [name]).catch(() => [{ n: 0 }]);
            if (!n) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((e) => log.error?.("sandbox: drop", name, e.message));
    };

    // The template: built when missing or when the schema it was built from changed.
    let template = null;
    function ensureTemplate() {
        template ??= (async () => {
            const name = cut(`${await liveName()}_sbxt`);
            const files = ["schema.sql", "integration.sql", "fitness.sql", ...MIGRATIONS.map((m) => m.file)];
            const texts = await Promise.all(files.map((f) => readFile(new URL(`../db/${f}`, import.meta.url), "utf8").catch(() => "")));
            const suiteFiles = await Promise.all(suites.flatMap((s) => s.migrations ?? []).map((m) => readFile(m.file, "utf8").catch(() => "")));
            const hash = sha256([...texts, ...suiteFiles, JSON.stringify(MIGRATIONS.map((m) => m.name))].join("\n")).slice(0, 16);
            const [have] = await db.query("SELECT shobj_description(oid, 'pg_database') AS hash FROM pg_database WHERE datname = $1", [name]);
            if (have?.hash === hash) return name;
            if (have) await drop(name);
            await db.query(`CREATE DATABASE "${name}"`);
            const pool = poolFor(name, 2);
            try {
                await loadSchema(pool);
                await migrate(fromPg(pool), { log: {}, suites });
            } finally {
                await pool.end();
            }
            await db.query(`COMMENT ON DATABASE "${name}" IS '${hash}'`);
            return name;
        })().catch((error) => { template = null; throw error; });
        return template;
    }

    // A sandbox for a change: people and designs copied, the draft applied, an app on it.
    async function build(change) {
        const tpl = await ensureTemplate();
        const name = cut(`${await liveName()}_sbx_${node}_${randomBytes(4).toString("hex")}`);
        await db.query(`CREATE DATABASE "${name}" TEMPLATE "${tpl}"`);
        // When it was made: what the sweep of leftovers goes by (another process's may be in use).
        await db.query(`COMMENT ON DATABASE "${name}" IS 'sandbox ${new Date().toISOString()}'`);
        const pool = poolFor(name, 4);
        const sdb = fromPg(pool);
        const sb = { name, pool, db: sdb, app: null, url: null, sessions: new Map(), change: change.id, lastUsed: Date.now() };
        try {
            for (const table of PEOPLE) {
                const rows = await db.query(`SELECT * FROM mes.${table}`);
                await sdb.query(`DELETE FROM mes.${table}`);
                if (rows.length) await sdb.query(`INSERT INTO mes.${table} SELECT * FROM json_populate_recordset(null::mes.${table}, $1)`, [JSON.stringify(rows)]);
                const [seq] = await sdb.query("SELECT pg_get_serial_sequence($1, a.attname) AS s FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = 'id' AND NOT a.attisdropped", [`mes.${table}`]);
                if (seq?.s) await sdb.query(`SELECT setval($1, coalesce((SELECT max(id) FROM mes.${table}), 0) + 1, false)`, [seq.s]);
            }
            for (const table of DESIGNS) {
                const rows = await db.query(`SELECT * FROM mes.${table} WHERE status = 'published'`);
                // The template's own (the built-in objects its migrations published) give way to live's.
                await sdb.query(`DELETE FROM mes.${table}`);
                if (rows.length) await sdb.query(`INSERT INTO mes.${table} SELECT * FROM json_populate_recordset(null::mes.${table}, $1)`, [JSON.stringify(rows)]);
            }
            for (const { object } of await sdb.query("SELECT object FROM mes.definitions")) {
                if (IDENT.test(object)) await sdb.query(`CREATE TABLE IF NOT EXISTS mes."records_${object}" PARTITION OF mes.records FOR VALUES IN ('${object}')`);
            }
            try {
                await design.executeInto(sdb, { id: change.id, content: change.content, base: change.base ?? {} });
            } catch (error) {
                fail(`The draft could not be applied in a sandbox: ${error.message}.`, { status: 409, code: "sandbox.apply" });
            }
            sb.app = await makeApp(sdb);
            sb.url = (await sb.app.listen({ port: 0 })).url;
            return sb;
        } catch (error) {
            await destroy(sb);
            throw error;
        }
    }
    async function destroy(sb) {
        await sb.app?.close().catch(() => {});
        await sb.pool.end().catch(() => {});
        await drop(sb.name);
    }

    // The records a sandbox starts with (or starts again with): picked ones copied fresh from live,
    // given ones made anew. → { ids: { key: id }, notes: [words] }
    async function prepare(sb, user, spec = {}) {
        const ids = {};
        const notes = [];
        const copied = new Map(); // id -> row as copied
        const entries = Object.entries(isPlain(spec) ? spec : {});
        if (entries.some(([k]) => !IDENT.test(k))) fail("A record's key is lower case letters, digits and _.", { status: 400 });
        const visible = async (row) => {
            const def = await store.definition(row.object);
            if (!def || row.archived_at) return null;
            const seen = mask(def.body, await records.internals.actorFor(user, row.object), records.internals.rowOut(row));
            return seen ? { def, seen } : null;
        };
        // …picked by a `where` only on fields they may read on it: a hidden field's value is not found out
        // by asking which value picks a record.
        const fits = async (row, where) => {
            const v = await visible(row);
            return Boolean(v && Object.keys(where ?? {}).every((f) => !v.def.body.fields[f] || v.seen.$perm.fields[f]));
        };
        const matches = (row, where) => Object.entries(where ?? {}).every(([f, v]) => (Array.isArray(v) ? v : [v]).map(String).includes(String(f === "state" ? row.state : row.data?.[f])));
        // Picked: by id while it still matches, else the newest record that does.
        const queue = [];
        for (const [key, r] of entries.filter(([, r]) => isPlain(r) && r.data === undefined)) {
            const def = typeof r.object === "string" ? await store.definition(r.object) : null;
            if (!def) fail(`"${key}": "${r.object}" is not live, so no record of it can be picked: give one instead ({ object, data }).`, { status: 400 });
            let row = typeof r.id === "string" && UUID.test(r.id) ? await records.internals.loadRow(db, r.object, r.id) : null;
            if (row && (!matches(row, r.where) || !(await fits(row, r.where)))) row = null;
            if (!row) {
                const w = recordWhere(r.object, isPlain(r.where) ? r.where : {});
                if (!w) fail(`"${key}": where names fields by name.`, { status: 400 });
                for (const candidate of await db.query(`SELECT * FROM mes.records WHERE ${w.sql} ORDER BY updated_at DESC LIMIT 50`, w.params)) {
                    if (await fits(candidate, r.where)) { row = candidate; break; }
                }
                if (!row) fail(`"${key}": no ${def.body.label.toLowerCase()} you can see${Object.keys(r.where ?? {}).length ? ` where ${Object.entries(r.where).map(([f, v]) => `${f} is ${[].concat(v).join(" or ")}`).join(" and ")}` : ""}.`, { status: 409, code: "sandbox.none" });
                if (r.id) notes.push(`${key}: ${row.data?.[def.body.titleField] ?? row.id.slice(0, 8)} was used, as the one recorded no longer matches.`);
            }
            ids[key] = row.id;
            queue.push([row, 0]);
        }
        // What they refer to, two references deep, as the opener sees it.
        while (queue.length) {
            const [row, depth] = queue.shift();
            if (copied.has(row.id)) continue;
            if (copied.size >= LIMITS.records) { notes.push(`At most ${LIMITS.records} records are copied: some references were left out.`); break; }
            const v = await visible(row);
            if (!v) continue;
            const data = Object.fromEntries(Object.keys(v.def.body.fields ?? {}).filter((f) => v.seen[f] !== undefined && row.data?.[f] !== undefined).map((f) => [f, row.data[f]]));
            copied.set(row.id, { ...row, data });
            if (depth >= LIMITS.depth) continue;
            for (const [f, field] of Object.entries(v.def.body.fields ?? {})) {
                if (field.type !== "ref" || data[f] === undefined) continue;
                for (const id of [].concat(data[f]).filter((x) => typeof x === "string" && UUID.test(x))) {
                    const ref = await records.internals.loadRow(db, field.to, id);
                    if (ref && !copied.has(ref.id)) queue.push([ref, depth + 1]);
                }
            }
        }
        if (copied.size) {
            const rows = [...copied.values()];
            await sb.db.query("DELETE FROM mes.records WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
            await sb.db.query("INSERT INTO mes.records SELECT * FROM json_populate_recordset(null::mes.records, $1)", [JSON.stringify(rows)]);
        }
        // Given: made in the sandbox, by the draft's definitions. Each has its id before any is made, so
        // they may name one another in any order (a stored scenario's keys keep none), even in a circle.
        const given = entries.filter(([, r]) => isPlain(r) && r.data !== undefined);
        for (const [key] of given) ids[key] = randomUUID();
        for (const [key, r] of given) {
            const [def] = typeof r.object === "string" ? await sb.db.query("SELECT version, body FROM mes.definitions WHERE object = $1 AND status = 'published'", [r.object]) : [];
            if (!def) fail(`"${key}": "${r.object}" is not an object, live or in this change.`, { status: 400 });
            const state = r.state ?? def.body.states.initial;
            if (!def.body.states.list.includes(state)) fail(`"${key}": ${r.object} has no state "${state}".`, { status: 400 });
            if (!isPlain(r.data)) fail(`"${key}": data is { field: value }.`, { status: 400 });
            // A built-in object's record the platform keeps one of per person (Person): the one there is
            // given these values, not doubled.
            if (def.body.builtIn && managedOf(r.object).platformRecords && typeof r.data.user === "string") {
                const [there] = await sb.db.query("SELECT id FROM mes.records WHERE object = $1 AND data->>'user' = $2 LIMIT 1", [r.object, r.data.user]);
                if (there) {
                    ids[key] = there.id;
                    await sb.db.query("UPDATE mes.records SET data = data || $2::jsonb WHERE object = $3 AND id = $1", [there.id, JSON.stringify(resolve(r.data, ids)), r.object]);
                    continue;
                }
            }
            await sb.db.query("INSERT INTO mes.records (object, id, def_version, state, data, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, 'sandbox', 'sandbox')", [r.object, ids[key], def.version, state, JSON.stringify(resolve(r.data, ids))]);
        }
        // Travelers part-way along a route take it up where they are, as in a database seeded so (§32.5).
        const flows = new Map((await sb.db.query("SELECT name, version, body FROM mes.flows WHERE status = 'published'")).map((r) => [r.name, { version: r.version, body: r.body }]));
        if (flows.size) {
            const definitions = Object.fromEntries((await sb.db.query("SELECT object, body FROM mes.definitions WHERE status = 'published'")).map((r) => [r.object, r.body]));
            await sb.db.query("DELETE FROM mes.flow_steps WHERE run_id IN (SELECT id FROM mes.flow_runs WHERE subject_id = ANY($1::uuid[]))", [Object.values(ids)]);
            await sb.db.query("DELETE FROM mes.flow_runs WHERE subject_id = ANY($1::uuid[])", [Object.values(ids)]);
            await adoptRuns(sb.db, { flows, definitions });
        }
        return { ids, notes, copied: copied.size };
    }

    // One step, as its person, on the sandbox's app; then the states of the records it knows.
    async function step(sb, st, user) {
        if (!isPlain(st) || !isPlain(st.do)) fail("A step is { as?, do: { transaction | action | update | create | service | screen }, expect? }.", { status: 400 });
        const as = typeof st.as === "string" && st.as ? st.as : user.id;
        let session = sb.sessions.get(as);
        if (!session) {
            const [who] = await sb.db.query("SELECT id FROM mes.users WHERE id = $1 AND active", [as]);
            if (!who) fail(`"${as}" is nobody here: a step runs as one of the plant's people.`, { status: 400 });
            session = `sbx-${randomBytes(12).toString("hex")}`;
            await sb.db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [session, as]);
            sb.sessions.set(as, session);
        }
        const call = async (name, args) => {
            const res = await fetch(`${sb.url}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: sessionCookieFor(session) }, body: JSON.stringify([args]) });
            const body = await res.json().catch(() => ({ error: "The sandbox did not answer." }));
            return res.ok ? { ok: true, body } : { ok: false, error: body.error ?? "Refused.", fields: body.fields ?? null };
        };
        const key = () => `sbx-${randomBytes(8).toString("hex")}`;
        const d = st.do;
        const record = async (object, ref) => {
            const id = resolve(ref, sb.ids);
            const got = await call("records.get", { object, id, as });
            return got.ok ? got.body : null;
        };
        let out;
        if (typeof d.transaction === "string") {
            out = await call("transactions.run", { name: d.transaction, input: resolve(d.input ?? {}, sb.ids), key: key(), ...(d.sign ? { signature: d.sign } : {}) });
        } else if (typeof d.action === "string") {
            const [object] = await sb.db.query("SELECT object FROM mes.records WHERE id = $1", [resolve(d.record, sb.ids)]);
            const rec = object ? await record(object.object, d.record) : null;
            out = rec ? await call("records.action", { object: object.object, id: rec.id, action: d.action, rowVersion: Number(rec.row_version), key: key() }) : { ok: false, error: "That record is not one this person can see here." };
        } else if (d.update !== undefined) {
            const [object] = await sb.db.query("SELECT object FROM mes.records WHERE id = $1", [resolve(d.update, sb.ids)]);
            const rec = object ? await record(object.object, d.update) : null;
            out = rec ? await call("records.update", { object: object.object, id: rec.id, rowVersion: Number(rec.row_version), data: resolve(d.data ?? {}, sb.ids), key: key() }) : { ok: false, error: "That record is not one this person can see here." };
        } else if (typeof d.create === "string") {
            out = await call("records.create", { object: d.create, data: resolve(d.data ?? {}, sb.ids), key: key() });
            if (out.ok && typeof d.key === "string" && IDENT.test(d.key) && out.body?.id) sb.ids[d.key] = out.body.id;
        } else if (typeof d.service === "string") {
            out = await call("integration.call", { name: d.service, input: resolve(d.input ?? {}, sb.ids) });
        } else if (typeof d.screen === "string") {
            out = await call("screens.data", { name: d.screen, arg: d.arg === undefined ? null : resolve(d.arg, sb.ids), as });
            const broken = (out.body?.blocks ?? []).find((b) => b?.error);
            if (out.ok && (out.body?.need || broken)) out = { ok: false, error: out.body.error ?? broken?.error ?? `it needs its ${out.body.need}`, body: out.body };
        } else if (isPlain(d.act)) {
            // The plan the record is in, waiting (a sub flow's own run before its parent's).
            const rid = resolve(d.act.record, sb.ids);
            const [run] = await sb.db.query(
                `SELECT id FROM mes.flow_runs WHERE kind = 'plan' AND state = 'running' AND ($2::text IS NULL OR flow = $2)
                   AND (subject_id = $1 OR EXISTS (SELECT 1 FROM jsonb_each_text(participants) p WHERE p.value = $1::text))
                 ORDER BY (waiting IS NULL), (waiting->>'kind' = 'sub_flow'), started_at DESC LIMIT 1`, [rid, typeof d.act.plan === "string" ? d.act.plan : null]);
            if (!run) out = { ok: false, error: `No plan${d.act.plan ? ` ${d.act.plan}` : ""} is running on that record.` };
            else if (d.act.action === "time_up") out = await call("flows.timeUp", { run: run.id });
            else out = await call("flows.act", { run: run.id, ...(d.act.action ? { action: d.act.action } : {}), ...(d.act.choice !== undefined ? { choice: d.act.choice } : {}), ...(d.act.values !== undefined ? { values: resolve(d.act.values, sb.ids) } : {}) });
        } else fail("A step does a transaction, an action, an update, a create, a service, a screen or acts on a plan.", { status: 400 });
        const created = {};
        for (const c of out.body?.changes ?? []) if (c.created) created[c.object] = (created[c.object] ?? 0) + 1;
        const rows = await sb.db.query("SELECT id, state, data FROM mes.records WHERE id = ANY($1::uuid[])", [Object.values(sb.ids)]);
        const byId = new Map(rows.map((r) => [r.id, r]));
        const states = Object.fromEntries(Object.entries(sb.ids).map(([k, id]) => [k, byId.get(id)?.state ?? null]));
        const data = Object.fromEntries(Object.entries(sb.ids).map(([k, id]) => [k, byId.get(id)?.data ?? null]));
        // Where each record's runs are (§32.8): those it is the traveler or subject of, or takes part in.
        const nodes = {};
        for (const [k, id] of Object.entries(sb.ids)) {
            const runs = await sb.db.query("SELECT flow, node, state, outcome, reason FROM mes.flow_runs WHERE subject_id = $1 OR EXISTS (SELECT 1 FROM jsonb_each_text(participants) p WHERE p.value = $1::text) ORDER BY started_at", [id]);
            if (runs.length) nodes[k] = Object.fromEntries(runs.map((r) => [r.flow, { node: r.node, state: r.state, outcome: r.outcome, reason: r.reason }]));
        }
        sb.lastUsed = Date.now();
        return { ok: out.ok, error: out.ok ? null : out.error, fields: out.fields ?? null, result: out.body ?? null, created, states, data, nodes };
    }

    // A change, visible to this person (its author, a co-designer, or anyone who designs or reviews).
    async function changeFor(self, id) {
        const user = await design.designUser(self);
        if (typeof id !== "string" || !UUID.test(id)) fail("Not found.", { status: 404 });
        const [row] = await db.query("SELECT id, title, state, content, base FROM mes.change_requests WHERE id = $1", [id]);
        if (!row) fail("Not found.", { status: 404 });
        return { user, row };
    }
    const mine = (id, user) => {
        const sb = open.get(`${id}:${user.id}`);
        if (!sb) fail("No sandbox is open for you on this change (or it was closed after a quarter of an hour unused): open it again.", { status: 404, code: "sandbox.closed" });
        return sb;
    };
    const summary = async (sb) => {
        const rows = await sb.db.query("SELECT r.id, r.object, r.state, r.data, d.body->>'titleField' AS tf, d.body->>'label' AS label FROM mes.records r JOIN mes.definitions d ON d.object = r.object AND d.status = 'published' WHERE r.id = ANY($1::uuid[])", [Object.values(sb.ids)]);
        const byId = new Map(rows.map((r) => [r.id, r]));
        return {
            open: true, since: new Date(sb.opened).toISOString(), notes: sb.notes, copied: sb.copied, spec: sb.spec,
            records: Object.fromEntries(Object.entries(sb.ids).map(([k, id]) => { const r = byId.get(id); return [k, r ? { id, object: r.object, label: r.label, title: r.data?.[r.tf] ?? id.slice(0, 8), state: r.state } : { id, missing: true }]; })),
        };
    };
    const close = async (key) => { const sb = open.get(key); open.delete(key); if (sb) await destroy(sb); };
    const sweep = setInterval(() => { for (const [key, sb] of open) if (Date.now() - sb.lastUsed > LIMITS.idleMs) close(key); }, 60_000);
    sweep.unref?.();

    let opening = 0;           // sandboxes being made for sandbox.open, not yet among `open`
    const turns = new Map();   // key → the open of it in progress
    // Scenario runs each make a database: a few at once, the rest in turn, and past a queue's length refused.
    let running = 0;
    const queue = [];
    async function scenarioTurn() {
        if (running < LIMITS.scenarios) { running += 1; return; }
        if (queue.length >= LIMITS.waiting) fail("Many scenarios are being run on this server just now: try again in a minute.", { status: 429 });
        await new Promise((resolve) => queue.push(resolve));
    }
    const scenarioDone = () => { const next = queue.shift(); if (next) next(); else running -= 1; };

    const services = {
        // Open (or open again) a sandbox on a change: its draft applied, these records copied or made.
        async "sandbox.open"({ id, records: spec = {} } = {}) {
            const { user, row } = await changeFor(this, id);
            const key = `${id}:${user.id}`;
            // One at a time per sandbox: two opens of the same one at once each made a database, and
            // the first was left behind, unowned, until the sweep.
            const before = turns.get(key) ?? Promise.resolve();
            const mine = before.catch(() => {}).then(async () => {
                await close(key);
                // Counted with those still being made: opens sent at once all saw the same count.
                if (open.size + opening >= LIMITS.open) fail(`${LIMITS.open} sandboxes are open on this server: close one (or wait a quarter of an hour), then open yours.`, { status: 429 });
                if ([...open.keys()].filter((k) => k.endsWith(`:${user.id}`)).length >= LIMITS.perPerson) fail(`You have ${LIMITS.perPerson} sandboxes open: close one, then open this one.`, { status: 429 });
                opening += 1;
                let sb;
                try {
                    sb = await build(row);
                    try {
                        Object.assign(sb, { opened: Date.now(), spec }, await prepare(sb, user, spec));
                    } catch (error) {
                        await destroy(sb);
                        throw error;
                    }
                    open.set(key, sb);
                } finally {
                    opening -= 1;
                }
                await db.transaction((tx) => appendAudit(tx, { actor: user.id, object: "$change", recordId: id, action: "sandbox:open", after: { records: Object.fromEntries(Object.entries(sb.ids).map(([k, rid]) => [k, { object: spec[k]?.object, id: rid, given: spec[k]?.data !== undefined }])) } }));
                return summary(sb);
            });
            turns.set(key, mine);
            try { return await mine; } finally { if (turns.get(key) === mine) turns.delete(key); }
        },
        // Its records copied and made again, as they are now: a fresh start, the draft as applied.
        async "sandbox.reset"({ id } = {}) {
            const { user } = await changeFor(this, id);
            const sb = mine(id, user);
            Object.assign(sb, await prepare(sb, user, sb.spec));
            return summary(sb);
        },
        async "sandbox.state"({ id } = {}) {
            const { user } = await changeFor(this, id);
            const sb = open.get(`${id}:${user.id}`);
            return sb ? summary(sb) : { open: false };
        },
        // One step on it, as its person. Nothing in the live database is written.
        async "sandbox.run"({ id, step: st } = {}) {
            const { user } = await changeFor(this, id);
            return step(mine(id, user), st, user);
        },
        // What a reference may name in it: an object's records there, the ones it made included.
        async "sandbox.records"({ id, object } = {}) {
            const { user } = await changeFor(this, id);
            const sb = mine(id, user);
            if (!IDENT.test(object ?? "")) fail("Which object?", { status: 400 });
            const [def] = await sb.db.query("SELECT body FROM mes.definitions WHERE object = $1 AND status = 'published'", [object]);
            if (!def) return [];
            const keys = Object.fromEntries(Object.entries(sb.ids).map(([k, rid]) => [rid, k]));
            return (await sb.db.query("SELECT id, state, data FROM mes.records WHERE object = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200", [object]))
                .map((r) => ({ id: r.id, key: keys[r.id] ?? null, title: String(r.data?.[def.body.titleField] ?? r.id.slice(0, 8)), state: r.state }));
        },
        // One scenario tried on a change's draft, in a sandbox of its own (the AI's try_scenario, §32.10):
        // each step's outcome and where the records' runs are; nothing is saved.
        async "sandbox.tryScenario"({ id, transaction, flow, scenario } = {}) {
            const { user, row } = await changeFor(this, id);
            if (!isPlain(scenario)) fail("A scenario is { name, records, steps }.", { status: 400 });
            const [result] = await runScenarios(row, user, [{ ...(typeof flow === "string" ? { flow } : { transaction }), scenario: { name: "tried", ...scenario } }]);
            return result;
        },
        async "sandbox.close"({ id } = {}) {
            const { user } = await changeFor(this, id);
            await close(`${id}:${user.id}`);
            return { open: false };
        },

        // Saved selections: a designer's named sets of starting records (the sandbox's `records`), their
        // own, newest first, to switch between on any change's sandbox.
        async "sandbox.selections"({ as } = {}) {
            const user = await design.designUser(this, as);
            return (await db.query("SELECT id, name, records, created_at, updated_at FROM mes.sandbox_selections WHERE owner = $1 ORDER BY updated_at DESC, name", [user.id]))
                .map((r) => ({ id: r.id, name: r.name, records: r.records, count: Object.keys(r.records ?? {}).length, created_at: iso(r.created_at), updated_at: iso(r.updated_at) }));
        },
        // Save: with `id`, over that one (Save); without, a new one (Save as). → the selection saved.
        async "sandbox.selection.save"({ id = null, name, records } = {}) {
            const user = await design.designUser(this);
            const problem = selectionProblem(records);
            if (problem) fail(problem, { status: 400, fields: { records: problem } });
            if (id !== null) {
                await ownSelection(user, id);
                const [row] = await named(() => db.query("UPDATE mes.sandbox_selections SET records = $3, name = coalesce($4, name), updated_at = now() WHERE id = $1 AND owner = $2 RETURNING id, name, updated_at", [id, user.id, JSON.stringify(records), name === undefined ? null : selectionName(name)]), name);
                return { id: row.id, name: row.name, updated_at: iso(row.updated_at) };
            }
            const [row] = await named(() => db.query("INSERT INTO mes.sandbox_selections (owner, name, records) VALUES ($1, $2, $3) RETURNING id, name, updated_at", [user.id, selectionName(name), JSON.stringify(records)]), name);
            return { id: row.id, name: row.name, updated_at: iso(row.updated_at) };
        },
        async "sandbox.selection.rename"({ id, name } = {}) {
            const user = await design.designUser(this);
            await ownSelection(user, id);
            const [row] = await named(() => db.query("UPDATE mes.sandbox_selections SET name = $3 WHERE id = $1 AND owner = $2 RETURNING id, name", [id, user.id, selectionName(name)]), name);
            return { id: row.id, name: row.name };
        },
        // Gone for good: a person's own workspace, not a design or a record.
        async "sandbox.selection.delete"({ id } = {}) {
            const user = await design.designUser(this);
            await ownSelection(user, id);
            await db.query("DELETE FROM mes.sandbox_selections WHERE id = $1 AND owner = $2", [id, user.id]);
            return { deleted: id };
        },
    };
    async function ownSelection(user, id) {
        if (typeof id !== "string" || !UUID.test(id)) fail("Which selection?", { status: 400 });
        const [row] = await db.query("SELECT owner FROM mes.sandbox_selections WHERE id = $1", [id]);
        if (!row || row.owner !== user.id) fail("No such selection of yours: it may have been deleted.", { status: 404 });
    }
    // A name taken already among this person's selections is refused in words, not as a database error.
    async function named(write, name) {
        try {
            return await write();
        } catch (error) {
            if (error?.code === "23505") fail(`You have a selection named "${String(name).trim()}" already: pick another name.`, { status: 409, fields: { name: "Taken." } });
            throw error;
        }
    }
    const touches = Object.fromEntries(Object.keys(services).map((k) => [k, k.startsWith("sandbox.selection.") ? [{ name: "sandbox.selections" }] : []]));

    // Scenarios of transactions and flow templates, for the fitness test: one sandbox, each scenario
    // on fresh records. list: [{ transaction | flow, scenario }]
    // → [{ transaction | flow, name, passed, steps: [{ step, ok, problems, nodes }], notes, detail }]
    async function runScenarios(row, user, list) {
        if (!list.length) return [];
        const owner = (e) => (e.flow ? { flow: e.flow } : { transaction: e.transaction });
        let sb;
        await scenarioTurn();
        try {
            sb = await build(row);
        } catch (error) {
            scenarioDone();
            return list.map((e) => ({ ...owner(e), name: e.scenario?.name ?? "(unnamed)", passed: false, detail: error.expose ? error.message : `the sandbox could not be made: ${error.message}` }));
        }
        const out = [];
        try {
            for (const e of list) {
                const { scenario } = e;
                const name = scenario?.name ?? "(unnamed)";
                try {
                    Object.assign(sb, { sessions: sb.sessions }, await prepare(sb, user, scenario.records ?? {}));
                    const steps = [];
                    for (const [i, st] of (scenario.steps ?? []).slice(0, LIMITS.steps).entries()) {
                        const result = await step(sb, st, user);
                        const problems = verdict(st.expect, result, { flow: e.flow ?? null });
                        steps.push({ step: i + 1, ok: result.ok, problems, nodes: result.nodes, error: result.error });
                        if (problems.length) break;
                    }
                    const failed = steps.find((s) => s.problems.length);
                    out.push({ ...owner(e), name, passed: !failed && steps.length === (scenario.steps ?? []).length && steps.length > 0, steps, notes: sb.notes, detail: failed ? `step ${failed.step}: ${failed.problems.join("; ")}` : steps.length ? `${steps.length} step(s) as expected` : "it has no steps" });
                } catch (error) {
                    out.push({ ...owner(e), name, passed: false, detail: error.expose ? error.message : `it could not run: ${error.message}` });
                }
            }
        } finally {
            await destroy(sb).finally(scenarioDone);
        }
        return out;
    }

    // Sandboxes left behind (a process that stopped without closing them): dropped once they are older
    // than any could still be in use, whichever process made them; at start, and every hour. Not by
    // name or node: another process on this node (the pipeline's server beside a test, a second worker)
    // may be using its own right now. Closing waits for a sweep under way, so none outlives the pool.
    let leftovers = Promise.resolve();
    function sweepLeftovers() {
        leftovers = (async () => {
            const prefix = cut(`${await liveName()}_sbx_`);
            const rows = await db.query("SELECT datname, shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE datname LIKE $1", [`${prefix.replace(/_/g, "\\_")}%`]);
            for (const { datname, note } of rows) {
                const made = Date.parse(String(note ?? "").replace(/^sandbox /, ""));
                if (Number.isFinite(made) && Date.now() - made > LIMITS.leftoverMs) await drop(datname);
            }
        })().catch((error) => log.error?.("sandbox: leftovers", error.message));
        return leftovers;
    }
    const hourly = setInterval(() => { sweepLeftovers(); }, 60 * 60_000);
    hourly.unref?.();
    async function closeAll() {
        clearInterval(sweep);
        clearInterval(hourly);
        await leftovers;
        for (const key of [...open.keys()]) await close(key);
    }

    // ---- a rollback's conflicts (§5.14) ----
    // The change applied in a sandbox, by the path that executes an approved one; then everything
    // published there checked together, as one draft: what the rollback takes away from under something
    // else (a field a screen changed since still shows, a transaction a route still offers) shows as a
    // problem there, and nowhere else. `known`: the problems the live system has already, which are not
    // the rollback's. → { ok, items: [words] }
    const WORLD = [["definitions", "object", "body"], ["scripts", "name", "source"], ["services", "name", "body"], ["connections", "name", "body"], ["transactions", "name", "body"], ["screens", "name", "body"], ["flows", "name", "body"], ["layouts", "name", "body"], ["elements", "name", "body"]];
    async function worldOf(q) {
        const out = {};
        for (const [kind, key, value] of WORLD) out[kind] = Object.fromEntries((await q.query(`SELECT ${key} AS k, ${value} AS v FROM mes.${kind} WHERE status = 'published'`)).map((r) => [r.k, r.v]));
        return out;
    }
    async function conflictsOf(change, user) {
        const known = new Set((await design.problemsOf(await worldOf(db)).catch(() => [])).map((p) => p.message));
        let sb = null;
        try {
            sb = await build(change);
        } catch (error) {
            return { ok: false, items: [String(error.message ?? error)] };
        }
        try {
            const session = `sbx-${randomBytes(12).toString("hex")}`;
            await sb.db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [session, user.id]);
            const res = await fetch(`${sb.url}/api/design.check`, { method: "POST", headers: { "content-type": "application/json", cookie: sessionCookieFor(session) }, body: JSON.stringify([await worldOf(sb.db)]) });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return { ok: false, items: [body.error ?? "The sandbox could not check the result."] };
            const items = (body.problems ?? []).map((p) => p.message).filter((m) => !known.has(m));
            return { ok: !items.length, items };
        } finally {
            await destroy(sb);
        }
    }

    // ---- the test sandbox (§5.13) ---------------------------------------------------------------
    // One for the installation, shared: a small database of its own (<live>_test) holding the people,
    // what is published, and **every change under test**, applied one after another in their order (the
    // execution flow), each by the path that executes an approved change. So changes not yet approved
    // see each other: a screen in one change shows the object of another. Nothing in it reaches the live
    // database. It is built again whenever what is under test changes; the records made in it are kept
    // across a build (their history starts over). People enter it from the live system, as themselves,
    // with the roles they hold (and those the changes under test give them).
    const bench = { name: null, pool: null, db: null, app: null, url: null, builtAt: null, by: null, applied: [], sessions: new Set(), building: null };
    const hashOf = (content) => sha256(JSON.stringify(content ?? {})).slice(0, 16);
    const underTest = () => db.query("SELECT id, title, state, author, co_designers, content, base, test, updated_at FROM mes.change_requests WHERE test IS NOT NULL AND state = ANY($1) ORDER BY (test->>'order')::int, id", [["design", "review", "approval"]]);
    const KEPT_RECORDS = 50_000;
    async function buildBench(user) {
        const name = cut(`${await liveName()}_test`);
        const changes = await underTest();
        // The records made there so far: kept across the build, for the objects that are still there.
        let kept = [];
        if (bench.db) kept = await bench.db.query(`SELECT * FROM mes.records ORDER BY created_at LIMIT ${KEPT_RECORDS}`).catch(() => []);
        else {
            const [there] = await db.query("SELECT shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE datname = $1", [name]);
            // Its own only (the comment it leaves on the database it makes): a database of that name that
            // something else made is neither read nor dropped.
            if (there && !String(there.note ?? "").startsWith("test sandbox ")) fail(`The test sandbox keeps its copy in a database named "${name}", and one of that name is here already that it did not make. Ask IT to rename or remove that database; nothing in it was touched.`, { status: 409, code: "test.database" });
            if (there) { const old = poolFor(name, 1); kept = await fromPg(old).query(`SELECT * FROM mes.records ORDER BY created_at LIMIT ${KEPT_RECORDS}`).catch(() => []); await old.end().catch(() => {}); }
        }
        await bench.app?.close().catch(() => {});
        await bench.pool?.end().catch(() => {});
        Object.assign(bench, { pool: null, db: null, app: null, url: null, sessions: new Set() });
        await drop(name);
        const tpl = await ensureTemplate();
        await db.query(`CREATE DATABASE "${name}" TEMPLATE "${tpl}"`);
        await db.query(`COMMENT ON DATABASE "${name}" IS 'test sandbox ${new Date().toISOString()}'`);
        const pool = poolFor(name, 6);
        const sdb = fromPg(pool);
        for (const table of PEOPLE) {
            const rows = await db.query(`SELECT * FROM mes.${table}`);
            await sdb.query(`DELETE FROM mes.${table}`);
            if (rows.length) await sdb.query(`INSERT INTO mes.${table} SELECT * FROM json_populate_recordset(null::mes.${table}, $1)`, [JSON.stringify(rows)]);
            const [seq] = await sdb.query("SELECT pg_get_serial_sequence($1, a.attname) AS s FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = 'id' AND NOT a.attisdropped", [`mes.${table}`]);
            if (seq?.s) await sdb.query(`SELECT setval($1, coalesce((SELECT max(id) FROM mes.${table}), 0) + 1, false)`, [seq.s]);
        }
        for (const table of DESIGNS) {
            const rows = await db.query(`SELECT * FROM mes.${table} WHERE status = 'published'`);
            await sdb.query(`DELETE FROM mes.${table}`);
            if (rows.length) await sdb.query(`INSERT INTO mes.${table} SELECT * FROM json_populate_recordset(null::mes.${table}, $1)`, [JSON.stringify(rows)]);
        }
        // Each change, in its place in the order: one that cannot be applied on top of those before it is
        // left out, saying why (it is drafted on something that moved, or needs what a later one brings),
        // and the rest go on.
        // Checked as production checks a change when it executes: against what is live and what the
        // changes before it brought, so the order is the execution flow.
        const applied = [];
        let together = {};
        const joined = (into, content) => {
            const out = { ...into };
            for (const [kind, part] of Object.entries(content ?? {})) {
                if (kind === "organization") out.organization = part;
                else if (kind === "retire") out.retire = Object.fromEntries([...new Set([...Object.keys(out.retire ?? {}), ...Object.keys(part ?? {})])].map((k) => [k, [...new Set([...(out.retire?.[k] ?? []), ...(part?.[k] ?? [])])]]));
                else out[kind] = { ...(out[kind] ?? {}), ...(part ?? {}) };
            }
            return out;
        };
        for (const c of changes) {
            const next = joined(together, c.content);
            const problems = await design.problemsOf(next).catch((error) => [{ message: String(error.message ?? error) }]);
            if (problems.length) {
                applied.push({ id: c.id, title: c.title, hash: hashOf(c.content), ok: false, error: `${problems[0].message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""} It may need a change that is applied after it: set the order.`.slice(0, 500) });
                continue;
            }
            try {
                await design.executeInto(sdb, { id: c.id, content: c.content, base: c.base ?? {} });
                together = next;
                applied.push({ id: c.id, title: c.title, hash: hashOf(c.content), ok: true });
            } catch (error) {
                applied.push({ id: c.id, title: c.title, hash: hashOf(c.content), ok: false, error: String(error.message ?? error).slice(0, 500) });
            }
        }
        const objects = (await sdb.query("SELECT DISTINCT object FROM mes.definitions WHERE status = 'published'")).map((r) => r.object).filter((o) => IDENT.test(o));
        for (const object of objects) await sdb.query(`CREATE TABLE IF NOT EXISTS mes."records_${object}" PARTITION OF mes.records FOR VALUES IN ('${object}')`);
        const still = kept.filter((r) => objects.includes(r.object));
        for (let i = 0; i < still.length; i += 500) await sdb.query("INSERT INTO mes.records SELECT * FROM json_populate_recordset(null::mes.records, $1) ON CONFLICT DO NOTHING", [JSON.stringify(still.slice(i, i + 500))]).catch((e) => log.error?.("test sandbox: keeping records", e.message));
        const app = await makeApp(sdb, { test: true });
        // Served beside the live system, on a port of its own: the same people, signed in as there.
        const { url: at, port: bound } = await app.listen({ port: test.port ?? 0, host: test.host ?? "127.0.0.1" }).catch(() => app.listen({ port: 0, host: test.host ?? "127.0.0.1" }));
        bench.port = bound;
        Object.assign(bench, { name, pool, db: sdb, app, url: at, builtAt: new Date().toISOString(), by: user?.id ?? "platform", applied, sessions: new Set() });
        // What each was tested with, kept with the change (§5.13): for its reviewers and approvers.
        for (const a of applied) {
            const entry = { at: bench.builtAt, by: bench.by, hash: a.hash, ok: a.ok, ...(a.error ? { error: a.error } : {}), with: applied.filter((o) => o.id !== a.id && o.ok).map((o) => ({ id: o.id, title: o.title, hash: o.hash })) };
            await db.query("UPDATE mes.change_requests SET tested = (SELECT coalesce(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM (SELECT e, n FROM jsonb_array_elements(tested || $2::jsonb) WITH ORDINALITY t(e, n) ORDER BY n DESC LIMIT 20) x) WHERE id = $1", [a.id, JSON.stringify([entry])]);
        }
        return bench;
    }
    // One build at a time; whoever asks while one runs waits for it.
    const rebuildBench = (user) => (bench.building ??= buildBench(user).finally(() => { bench.building = null; }));
    // Built, and as what is under test now is (a change saved, added or taken out since): else built again.
    async function benchReady(user) {
        const now = (await underTest()).map((c) => `${c.id}:${hashOf(c.content)}`).join();
        const was = bench.applied.map((a) => `${a.id}:${a.hash}`).join();
        if (!bench.app || now !== was) await rebuildBench(user);
        return bench;
    }
    const benchState = async () => {
        const changes = await underTest();
        const built = new Map(bench.applied.map((a) => [a.id, a]));
        return {
            built: bench.builtAt, by: bench.by, open: Boolean(bench.app),
            stale: !bench.app || changes.map((c) => `${c.id}:${hashOf(c.content)}`).join() !== bench.applied.map((a) => `${a.id}:${a.hash}`).join(),
            changes: changes.map((c) => ({ id: c.id, title: c.title, state: c.state, author: c.author, order: Number(c.test?.order ?? 0), addedBy: c.test?.by ?? null, addedAt: c.test?.at ?? null,
                applied: built.get(c.id)?.hash === hashOf(c.content) ? { ok: built.get(c.id).ok, error: built.get(c.id).error ?? null } : null })),
        };
    };
    Object.assign(services, {
        // What is under test, in order, and how the last build went for each.
        async "test.state"() {
            await design.designUser(this);
            return benchState();
        },
        // A change in design put under test (by its author or a co-designer), last in the order; or taken out.
        async "test.add"({ id } = {}) {
            const { user, row } = await changeFor(this, id);
            const [full] = await db.query("SELECT author, co_designers, test FROM mes.change_requests WHERE id = $1", [id]);
            if (row.state !== "design" || ![full.author, ...(full.co_designers ?? [])].includes(user.id)) fail("A change is put under test by its author or a co-designer, while it is in design.", { status: 409 });
            if (!full.test) {
                const [{ n }] = await db.query("SELECT coalesce(max((test->>'order')::int), 0) + 1 AS n FROM mes.change_requests WHERE test IS NOT NULL AND state = ANY($1)", [["design", "review", "approval"]]);
                await db.transaction(async (tx) => {
                    await tx.query("UPDATE mes.change_requests SET test = $2 WHERE id = $1", [id, JSON.stringify({ at: new Date().toISOString(), by: user.id, order: n })]);
                    await appendAudit(tx, { actor: user.id, object: "$change", recordId: id, action: "change:test-add", after: { order: n } });
                });
            }
            return benchState();
        },
        async "test.remove"({ id } = {}) {
            const { user, row } = await changeFor(this, id);
            const [full] = await db.query("SELECT author, co_designers, test FROM mes.change_requests WHERE id = $1", [id]);
            if (![full.author, ...(full.co_designers ?? [])].includes(user.id)) fail("A change is taken out of the test sandbox by its author or a co-designer.", { status: 403 });
            if (full.test) await db.transaction(async (tx) => {
                await tx.query("UPDATE mes.change_requests SET test = NULL WHERE id = $1", [id]);
                await appendAudit(tx, { actor: user.id, object: "$change", recordId: id, action: "change:test-remove", after: { state: row.state } });
            });
            return benchState();
        },
        // The execution flow: the order the changes under test are applied in, first to last.
        async "test.order"({ ids } = {}) {
            const user = await design.designUser(this);
            if (!user.designRoles.includes("designer")) fail("Only a designer sets the order.", { status: 403 });
            const now = (await underTest()).map((c) => c.id);
            if (!Array.isArray(ids) || ids.length !== now.length || !now.every((x) => ids.includes(x))) fail("Give every change under test once, in the order to apply them.", { fields: { ids: "The changes under test, each once." } });
            await db.transaction(async (tx) => {
                for (const [i, cid] of ids.entries()) await tx.query("UPDATE mes.change_requests SET test = jsonb_set(test, '{order}', to_jsonb($2::int)) WHERE id = $1", [cid, i + 1]);
                await appendAudit(tx, { actor: user.id, object: "$change", recordId: null, action: "test:order", after: { order: ids } });
            });
            return benchState();
        },
        // Built again now, from what is live and what is under test.
        async "test.build"() {
            const user = await design.designUser(this);
            await rebuildBench(user);
            return benchState();
        },
    });
    Object.assign(touches, { "test.state": [], "test.add": [{ name: "design.home" }, { name: "design.change" }], "test.remove": [{ name: "design.home" }, { name: "design.change" }], "test.order": [{ name: "design.home" }], "test.build": [{ name: "design.home" }, { name: "design.change" }] });
    // Where a signed-in person's requests go while they are in the test sandbox: its app, with their
    // session known there too (the same one, the same person). Null when nothing is under test.
    async function benchFor(sessionId, user) {
        if (!(await underTest()).length && !bench.app) return null;
        const b = await benchReady(user);
        if (!b.sessions.has(sessionId)) {
            const [row] = await db.query("SELECT * FROM mes.sessions WHERE id = $1", [sessionKey(sessionId)]);
            if (!row) return null;
            await b.db.query("INSERT INTO mes.sessions SELECT * FROM json_populate_record(null::mes.sessions, $1) ON CONFLICT (id) DO NOTHING", [JSON.stringify(row)]);
            b.sessions.add(sessionId);
        }
        return b.url;
    }
    Object.assign(services, {
        // Into the test sandbox, as oneself: it is built if what is under test changed, and this session
        // is known there too. → where it is served ({ url } when it has an address of its own, else its port
        // on this host).
        async "test.enter"() {
            const user = await store.userForSession(this?.sessionId);
            if (!user) fail("Sign in first.", { status: 401 });
            if (!(await underTest()).length) fail("Nothing is under test: a change is put there with Add to test sandbox.", { status: 409, code: "test.empty" });
            const at = await benchFor(this.sessionId, user);
            if (!at) fail("The test sandbox could not be opened.", { status: 409 });
            return { url: test.url ?? null, port: bench.port ?? null, built: bench.builtAt, changes: bench.applied.map((a) => ({ id: a.id, title: a.title, ok: a.ok, error: a.error ?? null })) };
        },
    });
    touches["test.enter"] = [{ name: "design.home" }, { name: "design.change" }];
    const closeBench = async () => { await bench.app?.close().catch(() => {}); await bench.pool?.end().catch(() => {}); Object.assign(bench, { app: null, pool: null, db: null, url: null }); };

    return { services, touches, queries: ["sandbox.selections"], runScenarios, sweepLeftovers, closeAll: async () => { await closeBench(); return closeAll(); }, benchFor, conflictsOf };
}
