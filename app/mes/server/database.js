// The Database area (DESIGN.md §38): a system view for the database administrators (People & departments
// gives the role, on `database`), where they see what the platform asks of the database and tune it, at once,
// with no change request: an index changes how fast, never what a query answers. Each index built or dropped
// is in the audit trail, by whom and why.
//
//   statements  every statement the platform sent (sql-stats.js): calls, total and mean time, the slowest,
//               rows, failures, which service sent it, hour by hour; and the database's own statistics
//               (pg_stat_statements) where the extension is installed
//   plans       a statement's plan as the database would run it (EXPLAIN (GENERIC_PLAN): no values needed,
//               nothing run)
//   tables      their rows, size, and how they are read (scanned whole, or by an index)
//   indexes     each with its size and how often it is used; those built here say who, why, and the
//               statements' time before against after
//   proposals   the AI reads the slowest statements, their plans, the tables and the indexes, and proposes
//               indexes as a description (never SQL): an object and its fields, or a table's columns. The
//               server writes the statement from it, with the expressions the platform's own queries use
//               (query.js column), so what is built is what they can use. With HypoPG installed, each is
//               tried as a hypothetical index: the plans' cost before and with it. The AI never builds one.
//   build/drop  CREATE INDEX CONCURRENTLY (writes never wait for it), in the background, its state shown;
//               only an index built here may be dropped here, never the platform's own (its migrations).
import { fail } from "@opencore-mes/juris-kit/errors.js";
import { appendAudit } from "./audit.js";
import { column } from "./query.js";
import { BUCKETS, KINDS, percentile } from "./call-stats.js";
import { IDENTIFIER, isSensitive } from "../client/definition.js";

export const DB_ADMIN_ROLE = "administrator";
const PREFIX = "mesx_";                 // the names of the indexes this area builds
const COLUMN = /^[a-z_][a-z0-9_]{0,62}$/;
const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);
const n = (v) => (v === null || v === undefined ? null : Number(v));

// An index described (what the AI proposes, what a person confirms) → its statement, or why not.
//   { table: "records", object: "lot", keys: [{ field: "lot_no" } | { column: "state" }], inUse?: true }
//   { table: "<a platform table>", keys: [{ column: "…", desc?: true }] }
// Records are partitioned by object (mes."records_<object>", schema.sql): an object's index is built on its
// partition, which the database reads alone for a query that names the object (object = $1), and which may
// be indexed concurrently (a partitioned table may not). A field is indexed by the expression the platform's
// queries use for it (query.js column), so they can use it.
export function indexStatement(spec, { definitionOf, columnsOf }) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { error: "An index is { table, keys }." };
    const table = String(spec.table ?? "");
    const keys = Array.isArray(spec.keys) ? spec.keys : [];
    if (!keys.length || keys.length > 4) return { error: "An index has one to four keys." };
    const columns = columnsOf(table);
    if (!columns) return { error: `"${table}" is not one of the platform's tables.` };
    const parts = [];
    let where = "";
    if (table === "records") {
        const def = IDENTIFIER.test(String(spec.object ?? "")) ? definitionOf(spec.object) : null;
        if (!def) return { error: `"${spec.object ?? ""}" is not an object.` };
        for (const k of keys) {
            if (k?.column !== undefined) {
                if (!["state", "updated_at", "created_at", "type"].includes(k.column)) return { error: `A record's own column is state, updated_at, created_at or type, not "${k.column}".` };
                parts.push(`${k.column}${k.desc ? " DESC" : ""}`);
                continue;
            }
            const f = def.fields?.[k?.field];
            if (!IDENTIFIER.test(String(k?.field ?? "")) || !f) return { error: `"${k?.field ?? ""}" is not a field of ${def.label ?? spec.object}.` };
            if (isSensitive(def, k.field)) return { error: `${f.label ?? k.field} is sensitive: it is never indexed, since its order would tell its values.` };
            if (f.multiple || ["image", "file"].includes(f.type)) return { error: `${f.label ?? k.field} holds ${f.multiple ? "several values" : `a ${f.type}`}: it is not indexed this way.` };
            if (f.type === "date") return { error: `${f.label ?? k.field} is a date: the platform reads it through a conversion the database cannot index; index the column its queries sort by instead.` };
            parts.push(`(${column(k.field, f, "X").replace(/X\.data/g, "data")})`);
        }
        // Only the records in use (not archived), as every list asks, when it says so: a smaller index.
        where = spec.inUse ? " WHERE archived_at IS NULL" : "";
    } else {
        if (/^records_/.test(table)) return { error: "An object's records are indexed as { table: \"records\", object }, on its partition." };
        for (const k of keys) {
            if (!COLUMN.test(String(k?.column ?? "")) || !columns.includes(k.column)) return { error: `"${k?.column ?? ""}" is not a column of ${table}.` };
            parts.push(`${k.column}${k.desc ? " DESC" : ""}`);
        }
    }
    const on = table === "records" ? `mes."records_${spec.object}"` : `mes.${table}`;
    const body = `ON ${on} (${parts.join(", ")})${where}`;
    const name = `${PREFIX}${(table === "records" ? spec.object : table).slice(0, 30)}_${hash(body)}`.slice(0, 63);
    return { name, body, sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${body}` };
}
function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
}

const PROPOSE_SYSTEM = `You tune the PostgreSQL database of a manufacturing execution system. You are given the statements the platform sends it, slowest first, each with its key, how often it ran and how long it took, and its plan; the platform's tables with their size and how they are read; the indexes that exist and how often each is used; and the objects whose records live in mes.records (a JSONB column \`data\` holds a record's fields; partitioned by object, each object's records in mes."records_<object>", which the database reads alone for a query that names the object).
Propose only indexes likely to make a slow, frequent statement faster, and only where no existing index serves it. Fewer is better: each index costs every write to its table. Never propose one for a statement that is fast already, or rare.
Answer with the tool propose_indexes, each index as a description, never SQL:
- records of one object: { table: "records", object, keys: [{ field } or { column: "state" | "updated_at" | "created_at" }], inUse: true when the statements ask for records not archived }
- a platform table: { table, keys: [{ column, desc? }] }
For each, say why in one or two plain sentences a database administrator reads, and the keys of the statements it is for. If nothing is worth an index, propose none and say why.`;
const PROPOSE_TOOL = {
    name: "propose_indexes",
    description: "The indexes proposed, each as a description the server turns into a statement.",
    input_schema: {
        type: "object",
        properties: {
            summary: { type: "string", description: "In two or three sentences: what is slow, and what the proposals would change." },
            proposals: { type: "array", items: { type: "object", properties: {
                table: { type: "string" }, object: { type: "string" }, inUse: { type: "boolean" },
                keys: { type: "array", items: { type: "object", properties: { field: { type: "string" }, column: { type: "string" }, desc: { type: "boolean" } } } },
                why: { type: "string" }, statements: { type: "array", items: { type: "string" } },
            }, required: ["table", "keys", "why"] } },
        },
        required: ["summary", "proposals"],
    },
};

export function createDatabase({ store, sqlStats, callStats = null, ai = null, instance = "local", log = console }) {
    const { db } = store;
    // An AI the plant set up (ai-gateway.js: an unset one is there too, saying it is not available).
    const aiReady = Boolean(ai) && ai.available !== false;
    const admin = async (self) => {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        if (!(await store.rolesFor(user.id, "database")).includes(DB_ADMIN_ROLE)) fail("The Database area is for those People & departments makes database administrators.", { status: 403 });
        return user;
    };
    // The area's own statements are its own, not the plant's: counted apart.
    const own = (fn) => sqlStats.within("database-area", fn);
    const extensions = async () => new Set((await db.query("SELECT extname FROM pg_extension WHERE extname IN ('pg_stat_statements', 'hypopg')")).map((r) => r.extname));
    const tablesOf = async () => (await db.query("SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS cols FROM information_schema.columns WHERE table_schema = 'mes' GROUP BY table_name"))
        .reduce((m, r) => m.set(r.table_name, r.cols), new Map());
    const definitions = async () => new Map((await db.query("SELECT object, body FROM mes.definitions WHERE status = 'published'")).map((d) => [d.object, d.body]));

    // The statements of the last `hours`, every instance's, with what this one counted and has not written yet.
    async function statements(hours) {
        const rows = await db.query(
            `SELECT key, max(text) AS text, sum(calls)::bigint AS calls, sum(total_ms) AS total_ms, max(max_ms) AS max_ms, sum(rows)::bigint AS rows,
                    sum(errors)::bigint AS errors, sum(replica)::bigint AS replica, min(hour) AS first, max(hour) AS last,
                    (SELECT jsonb_object_agg(k, v) FROM (SELECT k, sum((s.sources->>k)::bigint) AS v FROM mes.sql_stats s, jsonb_object_keys(s.sources) k WHERE s.key = x.key AND s.hour >= now() - make_interval(hours => $1) GROUP BY k) y) AS sources
             FROM mes.sql_stats x WHERE hour >= now() - make_interval(hours => $1) GROUP BY key`, [hours]);
        const by = new Map(rows.map((r) => [r.key, { key: r.key, text: r.text, calls: n(r.calls), totalMs: n(r.total_ms), maxMs: n(r.max_ms), rows: n(r.rows), errors: n(r.errors), replica: n(r.replica), sources: r.sources ?? {}, first: iso(r.first), last: iso(r.last) }]));
        for (const p of sqlStats.pending()) {
            const s = by.get(p.key) ?? { key: p.key, text: p.text, calls: 0, totalMs: 0, maxMs: 0, rows: 0, errors: 0, replica: 0, sources: {}, first: p.hour, last: p.hour };
            s.calls += p.calls; s.totalMs += p.ms; s.maxMs = Math.max(s.maxMs, p.max); s.rows += p.rows; s.errors += p.errors; s.replica += p.replica;
            for (const [k, v] of Object.entries(p.sources)) s.sources[k] = (s.sources[k] ?? 0) + v;
            by.set(p.key, s);
        }
        return [...by.values()].map((s) => ({ ...s, meanMs: s.calls ? s.totalMs / s.calls : 0 })).sort((a, b) => b.totalMs - a.totalMs);
    }
    // The calls of the last `hours` (call-stats.js, §38.1), every instance's with what this one has not written yet:
    // one row per kind, name and channel, its time buckets summed. `where`: { kind, name } for one design's.
    const SUMS = `sum(calls)::bigint AS calls, sum(ok)::bigint AS ok, sum(refused)::bigint AS refused, sum(failed)::bigint AS failed, sum(total_ms) AS total_ms, max(max_ms) AS max_ms,
                  ARRAY[${BUCKETS.map((_, i) => `sum(buckets[${i + 1}])`).join(", ")}]::bigint[] AS buckets`;
    async function callRows(hours, where = null) {
        const rows = await db.query(
            `SELECT kind, name, channel, ${SUMS} FROM mes.call_stats WHERE hour >= now() - make_interval(hours => $1)${where ? " AND kind = $2 AND name = $3" : ""} GROUP BY kind, name, channel`,
            where ? [hours, where.kind, where.name] : [hours]);
        const by = new Map(rows.map((r) => [`${r.kind}|${r.name}|${r.channel}`, { kind: r.kind, name: r.name, channel: r.channel, calls: n(r.calls), ok: n(r.ok), refused: n(r.refused), failed: n(r.failed), totalMs: n(r.total_ms), maxMs: n(r.max_ms), buckets: (r.buckets ?? []).map(Number) }]));
        for (const p of callStats?.pending() ?? []) {
            if (where && (p.kind !== where.kind || p.name !== where.name)) continue;
            const k = `${p.kind}|${p.name}|${p.channel}`;
            const c = by.get(k) ?? { kind: p.kind, name: p.name, channel: p.channel, calls: 0, ok: 0, refused: 0, failed: 0, totalMs: 0, maxMs: 0, buckets: BUCKETS.map(() => 0) };
            c.calls += p.calls; c.ok += p.ok; c.refused += p.refused; c.failed += p.failed; c.totalMs += p.ms; c.maxMs = Math.max(c.maxMs, p.max);
            c.buckets = c.buckets.map((b, i) => b + (p.buckets[i] ?? 0));
            by.set(k, c);
        }
        return [...by.values()];
    }
    // Each design's (and platform service's) calls, its channels summed: how often, how long (mean, the 50th and
    // 95th percentile as the upper bound of their bucket, the slowest), how many refused and failed, and by channel.
    function callsByName(rows) {
        const by = new Map();
        for (const r of rows) {
            const k = `${r.kind}|${r.name}`;
            const c = by.get(k) ?? { kind: r.kind, name: r.name, calls: 0, ok: 0, refused: 0, failed: 0, totalMs: 0, maxMs: 0, buckets: BUCKETS.map(() => 0), channels: {} };
            c.calls += r.calls; c.ok += r.ok; c.refused += r.refused; c.failed += r.failed; c.totalMs += r.totalMs; c.maxMs = Math.max(c.maxMs, r.maxMs);
            c.buckets = c.buckets.map((b, i) => b + (r.buckets[i] ?? 0));
            c.channels[r.channel] = (c.channels[r.channel] ?? 0) + r.calls;
            by.set(k, c);
        }
        const fin = (x) => (Number.isFinite(x) ? x : null);
        return [...by.values()].map((c) => ({ ...c, meanMs: c.calls ? c.totalMs / c.calls : 0, p50: fin(percentile(c.buckets, 0.5)), p95: fin(percentile(c.buckets, 0.95)) })).sort((a, b) => b.totalMs - a.totalMs);
    }
    async function sampleOf(key) {
        const [row] = await db.query("SELECT sample, text FROM mes.sql_stats WHERE key = $1 AND sample IS NOT NULL ORDER BY hour DESC LIMIT 1", [key]);
        return row?.sample ?? sqlStats.pending().find((p) => p.key === key)?.sample ?? null;
    }
    // A statement's plan as the database would run it, for any values: nothing is run (EXPLAIN without
    // ANALYZE), and only a statement the platform sent, never a text someone typed.
    async function planOf(key, format = "TEXT") {
        const sample = await sampleOf(key);
        if (!sample) return { error: "This statement's text is not kept (it was counted with the statements beyond the 3 000 of an hour)." };
        if (/^\s*(create|alter|drop|vacuum|analyze|begin|commit|rollback|set|lock|notify|listen|grant|revoke|truncate)\b/i.test(sample)) return { error: "Only a query or a write has a plan." };
        try {
            const out = await db.transaction(async (tx) => {
                await tx.query("SET LOCAL statement_timeout = '5s'");
                return tx.query(`EXPLAIN (GENERIC_PLAN, FORMAT ${format}) ${sample}`);
            });
            return format === "JSON" ? { plan: out[0]?.["QUERY PLAN"]?.[0]?.Plan ?? null } : { text: out.map((r) => r["QUERY PLAN"]).join("\n") };
        } catch (error) {
            return { error: `The database could not plan it: ${error.message}` };
        }
    }
    // A plan in a few lines for the AI: each node, what it reads, how many rows it expects, its filter.
    const planLines = (node, depth = 0, out = []) => {
        if (!node || out.length > 14) return out;
        out.push(`${"  ".repeat(depth)}${node["Node Type"]}${node["Relation Name"] ? ` on ${node["Relation Name"]}` : ""}${node["Index Name"] ? ` using ${node["Index Name"]}` : ""} (rows ${node["Plan Rows"]}, cost ${node["Total Cost"]})${node.Filter ? ` filter ${String(node.Filter).slice(0, 220)}` : ""}${node["Index Cond"] ? ` cond ${String(node["Index Cond"]).slice(0, 160)}` : ""}${node["Sort Key"] ? ` sort ${node["Sort Key"].join(", ").slice(0, 160)}` : ""}`);
        for (const c of node.Plans ?? []) planLines(c, depth + 1, out);
        return out;
    };
    async function tables() {
        return (await db.query(
            // A partitioned table (records, by object) as the sum of its partitions; each partition too.
            `WITH t AS (SELECT c.oid, c.relname, c.relkind, c.relispartition FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'mes' WHERE c.relkind IN ('r', 'p'))
             SELECT t.relname AS name, t.relkind = 'p' AS partitioned, t.relispartition AS partition,
                    sum(pg_total_relation_size(l.relid)) AS bytes, sum(s.seq_scan) AS seq_scan, sum(s.idx_scan) AS idx_scan, sum(s.n_live_tup) AS n_live_tup, sum(s.n_dead_tup) AS n_dead_tup, max(s.last_autoanalyze) AS last_autoanalyze
             FROM t CROSS JOIN LATERAL (SELECT relid FROM pg_partition_tree(t.oid) WHERE isleaf UNION SELECT t.oid WHERE t.relkind = 'r') l LEFT JOIN pg_stat_user_tables s ON s.relid = l.relid
             GROUP BY t.relname, t.relkind, t.relispartition ORDER BY sum(pg_total_relation_size(l.relid)) DESC NULLS LAST`)).map((r) => ({ name: r.name, partitioned: r.partitioned, partition: r.partition, rows: n(r.n_live_tup), bytes: n(r.bytes), seqScans: n(r.seq_scan), indexScans: n(r.idx_scan), dead: n(r.n_dead_tup), analyzed: iso(r.last_autoanalyze) }));
    }
    async function indexes() {
        const built = new Map((await db.query("SELECT * FROM mes.db_indexes")).map((r) => [r.name, r]));
        const rows = await db.query(
            `SELECT i.relname AS name, t.relname AS table, pg_get_indexdef(x.indexrelid) AS definition, pg_relation_size(x.indexrelid) AS bytes, s.idx_scan, x.indisvalid AS valid, x.indisunique AS unique, x.indisprimary AS primary
             FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace AND ns.nspname = 'mes'
             LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid ORDER BY t.relname, i.relname`);
        const out = rows.map((r) => ({ name: r.name, table: r.table, definition: r.definition, bytes: n(r.bytes), scans: n(r.idx_scan), valid: r.valid, unique: r.unique, primary: r.primary, ...(built.has(r.name) ? { built: builtOf(built.get(r.name)) } : {}) }));
        // Built here and not in the database (building, failed, dropped): said too.
        for (const [name, b] of built) if (!rows.some((r) => r.name === name)) out.push({ name, table: b.spec?.table ?? null, definition: b.definition, bytes: null, scans: null, valid: false, built: builtOf(b) });
        return out;
    }
    const builtOf = (b) => ({ state: b.state, why: b.why, by: b.created_by, at: iso(b.created_at), readyAt: iso(b.ready_at), error: b.error, droppedBy: b.dropped_by, droppedAt: iso(b.dropped_at), statements: b.statements ?? [], spec: b.spec });
    // Each statement's mean time in the hours before an index was ready, and in the hours since.
    async function effect(name) {
        const [b] = await db.query("SELECT created_at, ready_at, statements FROM mes.db_indexes WHERE name = $1", [name]);
        if (!b?.ready_at || !b.statements?.length) return [];
        const rows = await db.query(
            `SELECT key, sum(calls) FILTER (WHERE hour < date_trunc('hour', $2::timestamptz)) AS c0, sum(total_ms) FILTER (WHERE hour < date_trunc('hour', $2::timestamptz)) AS t0,
                    sum(calls) FILTER (WHERE hour > date_trunc('hour', $2::timestamptz)) AS c1, sum(total_ms) FILTER (WHERE hour > date_trunc('hour', $2::timestamptz)) AS t1
             FROM mes.sql_stats WHERE key = ANY($1) GROUP BY key`, [b.statements, b.ready_at]);
        return rows.map((r) => ({ key: r.key, before: r.c0 ? n(r.t0) / n(r.c0) : null, beforeCalls: n(r.c0) ?? 0, after: r.c1 ? n(r.t1) / n(r.c1) : null, afterCalls: n(r.c1) ?? 0 }));
    }
    // With HypoPG: each statement's plan cost now, and with the index assumed (nothing built).
    async function estimate(sql, keys) {
        const ext = await extensions();
        if (!ext.has("hypopg")) return { available: false };
        const out = [];
        await db.transaction(async (tx) => {
            await tx.query("SET LOCAL statement_timeout = '10s'");
            for (const key of keys.slice(0, 10)) {
                const sample = await sampleOf(key);
                if (!sample) continue;
                const cost = async () => (await tx.query(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${sample}`))[0]?.["QUERY PLAN"]?.[0]?.Plan?.["Total Cost"] ?? null;
                const before = await cost().catch(() => null);
                await tx.query("SELECT * FROM hypopg_create_index($1)", [sql.replace(" CONCURRENTLY IF NOT EXISTS", "")]);
                const after = await cost().catch(() => null);
                await tx.query("SELECT hypopg_reset()");
                out.push({ key, before, after });
            }
        });
        return { available: true, statements: out };
    }

    const services = {
        // The area: what was counted (the last `hours`, 1 to 336), the tables, the indexes, and what is installed.
        async "database.overview"({ hours = 24 } = {}) {
            await admin(this);
            return own(async () => {
                const h = Math.max(1, Math.min(336, Math.floor(Number(hours) || 24)));
                const ext = await extensions();
                const [{ server_version: version }] = await db.query("SHOW server_version");
                let pgss = null;
                if (ext.has("pg_stat_statements")) {
                    pgss = (await db.query(`SELECT queryid::text AS id, query, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read FROM pg_stat_statements
                                            WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY total_exec_time DESC LIMIT 100`).catch(() => []))
                        .map((r) => ({ id: r.id, text: String(r.query).slice(0, 4000), calls: n(r.calls), totalMs: n(r.total_exec_time), meanMs: n(r.mean_exec_time), rows: n(r.rows), hit: n(r.shared_blks_hit), read: n(r.shared_blks_read) }));
                }
                const all = await statements(h);
                const calls = callsByName(await callRows(h));
                return {
                    hours: h, instance, version,
                    installed: { pgStatStatements: ext.has("pg_stat_statements"), hypopg: ext.has("hypopg"), ai: aiReady },
                    totals: { statements: all.length, calls: all.reduce((a, s) => a + s.calls, 0), totalMs: all.reduce((a, s) => a + s.totalMs, 0) },
                    statements: all.slice(0, 500), pgss, tables: await tables(), indexes: await indexes(),
                    calls: calls.slice(0, 500), callTotals: { names: calls.length, calls: calls.reduce((a, c) => a + c.calls, 0), totalMs: calls.reduce((a, c) => a + c.totalMs, 0) },
                };
            });
        },
        // One design's calls (or a platform service's), over the last `hours`: by channel, hour by hour (the last 48),
        // who called (the busiest), why refusals were (their codes), and the statements it sent: each with how often
        // it sent it, the statement's mean time, and so about how much of the design's time it was.
        async "database.call"({ kind, name, hours = 24 } = {}) {
            await admin(this);
            if (!KINDS.includes(kind) || typeof name !== "string" || !name || name.length > 200) fail("Which call: { kind, name }.");
            return own(async () => {
                const h = Math.max(1, Math.min(336, Math.floor(Number(hours) || 24)));
                const where = { kind, name };
                const channels = (await callRows(h, where)).map((r) => ({ ...r, meanMs: r.calls ? r.totalMs / r.calls : 0, p95: Number.isFinite(percentile(r.buckets, 0.95)) ? percentile(r.buckets, 0.95) : null })).sort((a, b) => b.calls - a.calls);
                const [summary] = callsByName(channels);
                const series = await db.query(
                    `SELECT hour, channel, sum(calls)::bigint AS calls, sum(total_ms) AS total_ms, sum(refused)::bigint AS refused, sum(failed)::bigint AS failed FROM mes.call_stats
                     WHERE kind = $1 AND name = $2 AND hour >= now() - interval '48 hours' GROUP BY hour, channel ORDER BY hour`, [kind, name]);
                const merged = async (col) => (await db.query(
                    `SELECT k, sum((c.${col}->>k)::bigint)::bigint AS v FROM mes.call_stats c, jsonb_object_keys(c.${col}) k
                     WHERE c.kind = $1 AND c.name = $2 AND c.hour >= now() - make_interval(hours => $3) GROUP BY k ORDER BY v DESC LIMIT 25`, [kind, name, h])).map((r) => ({ key: r.k, n: n(r.v) }));
                const pend = (callStats?.pending() ?? []).filter((p) => p.kind === kind && p.name === name);
                // …and this instance's hours not yet written.
                for (const p of pend) {
                    const at = Date.parse(p.hour);
                    const r = series.find((x) => Date.parse(x.hour) === at && x.channel === p.channel);
                    if (r) { r.calls = n(r.calls) + p.calls; r.total_ms = n(r.total_ms) + p.ms; r.refused = n(r.refused) + p.refused; r.failed = n(r.failed) + p.failed; }
                    else series.push({ hour: p.hour, channel: p.channel, calls: p.calls, total_ms: p.ms, refused: p.refused, failed: p.failed });
                }
                series.sort((a, b) => Date.parse(a.hour) - Date.parse(b.hour));
                const add = (list, col) => { for (const p of pend) for (const [k, v] of Object.entries(p[col])) { const x = list.find((y) => y.key === k); if (x) x.n += v; else list.push({ key: k, n: v }); } return list.sort((a, b) => b.n - a.n); };
                // Its statements: put down to it by name (a design's as kind:name, a platform service's as its name).
                const source = kind === "platform" ? name : `${kind}:${name}`;
                const sent = (await db.query(
                    `SELECT key, max(text) AS text, sum(calls)::bigint AS calls, sum(total_ms) AS total_ms, sum((sources->>$1)::bigint)::bigint AS mine FROM mes.sql_stats
                     WHERE sources ? $1 AND hour >= now() - make_interval(hours => $2) GROUP BY key`, [source, h]))
                    .map((r) => ({ key: r.key, text: r.text, calls: n(r.mine), meanMs: n(r.calls) ? n(r.total_ms) / n(r.calls) : 0 }));
                for (const p of sqlStats.pending()) {
                    const mine = p.sources?.[source];
                    if (!mine) continue;
                    const x = sent.find((y) => y.key === p.key);
                    if (x) x.calls += mine; else sent.push({ key: p.key, text: p.text, calls: mine, meanMs: p.calls ? p.ms / p.calls : 0 });
                }
                const statementsOf = sent.map((x) => ({ ...x, totalMs: x.calls * x.meanMs })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 50);
                return {
                    kind, name, hours: h, summary: summary ?? null, channels,
                    series: series.map((r) => ({ hour: iso(r.hour), channel: r.channel, calls: n(r.calls), meanMs: n(r.calls) ? n(r.total_ms) / n(r.calls) : 0, refused: n(r.refused), failed: n(r.failed) })),
                    callers: add(await merged("callers"), "callers"), codes: add(await merged("codes"), "codes"),
                    statements: statementsOf, source,
                };
            });
        },
        // One statement: its text (with $1… where values go), who sent it, its hours, and its plan.
        async "database.statement"({ key } = {}) {
            await admin(this);
            return own(async () => {
                const hours = await db.query("SELECT hour, sum(calls)::bigint AS calls, sum(total_ms) AS total_ms, max(max_ms) AS max_ms FROM mes.sql_stats WHERE key = $1 AND hour >= now() - interval '48 hours' GROUP BY hour ORDER BY hour", [String(key)]);
                return { key, sample: await sampleOf(String(key)), hours: hours.map((r) => ({ hour: iso(r.hour), calls: n(r.calls), meanMs: r.calls ? n(r.total_ms) / n(r.calls) : 0, maxMs: n(r.max_ms) })), plan: await planOf(String(key)) };
            });
        },
        // The AI's proposals (it proposes; it never builds), each checked and written as a statement here,
        // and tried as a hypothetical index where HypoPG is installed.
        async "database.propose"({ hours = 24 } = {}) {
            await admin(this);
            if (!aiReady) fail("No AI is set up for this plant (AI_PROVIDER): the statements, plans and indexes are here to read without one.", { status: 409 });
            return own(async () => {
                const defs = await definitions();
                const cols = await tablesOf();
                const top = (await statements(Math.max(1, Math.min(336, Number(hours) || 24)))).filter((s) => s.key !== "other").slice(0, 25);
                const plans = [];
                for (const s of top.slice(0, 15)) { const p = await planOf(s.key, "JSON"); plans.push([s.key, p.plan ? planLines(p.plan).join("\n") : p.error ?? ""]); }
                const objects = [...defs].map(([o, d]) => `${o}: ${Object.entries(d.fields ?? {}).filter(([k, f]) => !isSensitive(d, k) && !f.multiple && !["image", "file", "date"].includes(f.type)).map(([k, f]) => `${k} (${f.type})`).join(", ")}`).join("\n");
                const prompt = [
                    "STATEMENTS (slowest in total first):",
                    ...top.map((s) => `key ${s.key}: ${s.calls} calls, mean ${s.meanMs.toFixed(2)} ms, slowest ${s.maxMs.toFixed(1)} ms, total ${(s.totalMs / 1000).toFixed(1)} s, from ${Object.keys(s.sources).slice(0, 4).join(", ")}\n${s.text.slice(0, 1500)}`),
                    "", "PLANS:", ...plans.map(([k, p]) => `key ${k}:\n${p}`),
                    "", "TABLES:", ...(await tables()).slice(0, 30).map((t) => `${t.name}: ${t.rows} rows, ${t.seqScans ?? 0} whole scans, ${t.indexScans ?? 0} index scans`),
                    "", "INDEXES:", ...(await indexes()).map((i) => `${i.definition} (used ${i.scans ?? 0} times)`),
                    "", "OBJECTS (records in mes.records):", objects,
                ].join("\n");
                const answer = await ai.complete({ system: PROPOSE_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: prompt.slice(0, 120_000) }] }], tools: [PROPOSE_TOOL] });
                const call = (answer.content ?? []).find((b) => b.type === "tool_use" && b.name === "propose_indexes");
                if (!call) fail("The AI answered without proposals; ask again.", { status: 502 });
                const known = new Set(top.map((s) => s.key));
                const proposals = [];
                for (const p of (call.input?.proposals ?? []).slice(0, 10)) {
                    const statement = indexStatement(p, { definitionOf: (o) => defs.get(o) ?? null, columnsOf: (t) => cols.get(t) ?? null });
                    const keys = (p.statements ?? []).filter((k) => known.has(k));
                    proposals.push({ spec: { table: p.table, ...(p.object ? { object: p.object } : {}), keys: p.keys, ...(p.inUse ? { inUse: true } : {}) }, why: String(p.why ?? ""), statements: keys,
                        ...(statement.error ? { refused: statement.error } : { name: statement.name, sql: statement.sql, estimate: await estimate(statement.sql, keys).catch((e) => ({ available: true, error: e.message })) }) });
                }
                return { summary: String(call.input?.summary ?? ""), proposals };
            });
        },
        // An index built, now: from its description (never SQL), in the background (writes never wait for it).
        async "database.createIndex"({ spec, why, statements: keys = [] } = {}) {
            const user = await admin(this);
            const reason = String(why ?? "").trim();
            if (!reason) fail("Say why: it is kept with the index and in the audit trail.", { fields: { why: "Say why." } });
            return own(async () => {
                const defs = await definitions();
                const cols = await tablesOf();
                const st = indexStatement(spec, { definitionOf: (o) => defs.get(o) ?? null, columnsOf: (t) => cols.get(t) ?? null });
                if (st.error) fail(st.error, { status: 400 });
                const [exists] = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'mes' WHERE c.relname = $1", [st.name]);
                const [kept] = await db.query("SELECT state FROM mes.db_indexes WHERE name = $1", [st.name]);
                if (exists && kept?.state !== "dropped") fail(`This index exists already (${st.name}).`, { status: 409 });
                const list = (Array.isArray(keys) ? keys : []).map(String).filter((k) => /^[0-9a-f]{16}$/.test(k)).slice(0, 20);
                await db.transaction(async (tx) => {
                    await tx.query(`INSERT INTO mes.db_indexes (name, spec, definition, why, state, created_by, statements) VALUES ($1, $2, $3, $4, 'building', $5, $6)
                                    ON CONFLICT (name) DO UPDATE SET spec = $2, definition = $3, why = $4, state = 'building', error = NULL, created_by = $5, created_at = now(), ready_at = NULL, dropped_by = NULL, dropped_at = NULL, statements = $6`,
                        [st.name, JSON.stringify(spec), st.sql, reason, user.id, list]);
                    await appendAudit(tx, { actor: user.id, object: "$database", action: "index:build", after: { name: st.name, statement: st.sql, why: reason } });
                });
                // CONCURRENTLY: outside a transaction, the table read and written meanwhile.
                const build = async () => {
                    try {
                        await own(() => db.query(st.sql));
                        const [valid] = await db.query("SELECT x.indisvalid FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE i.relname = $1", [st.name]);
                        if (!valid?.indisvalid) throw new Error("the database left it invalid (another build, or a conflict); drop it and build it again");
                        await db.query("UPDATE mes.db_indexes SET state = 'ready', ready_at = now() WHERE name = $1", [st.name]);
                    } catch (error) {
                        log.error?.(`database: index ${st.name} not built: ${error.message}`);
                        await db.query("UPDATE mes.db_indexes SET state = 'failed', error = $2 WHERE name = $1", [st.name, error.message]).catch(() => {});
                    }
                };
                const running = build();
                if (this?.waitForIndex) await running; // tests wait for it; a person sees it building
                return { name: st.name, sql: st.sql, state: this?.waitForIndex ? (await db.query("SELECT state FROM mes.db_indexes WHERE name = $1", [st.name]))[0]?.state : "building" };
            });
        },
        // An index built here, dropped (CONCURRENTLY: never the platform's own, which its migrations keep).
        async "database.dropIndex"({ name, why } = {}) {
            const user = await admin(this);
            const reason = String(why ?? "").trim();
            if (!reason) fail("Say why: it is kept in the audit trail.", { fields: { why: "Say why." } });
            return own(async () => {
                const [b] = await db.query("SELECT state FROM mes.db_indexes WHERE name = $1", [String(name)]);
                if (!b || !String(name).startsWith(PREFIX)) fail("Only an index built in this area is dropped here: the platform's own are kept by its migrations.", { status: 403 });
                if (b.state === "dropped") fail("It is dropped already.", { status: 409 });
                await db.query(`DROP INDEX CONCURRENTLY IF EXISTS mes.${String(name).replace(/[^a-z0-9_]/g, "")}`);
                await db.transaction(async (tx) => {
                    await tx.query("UPDATE mes.db_indexes SET state = 'dropped', dropped_by = $2, dropped_at = now() WHERE name = $1", [name, user.id]);
                    await appendAudit(tx, { actor: user.id, object: "$database", action: "index:drop", after: { name, why: reason } });
                });
                return { name, state: "dropped" };
            });
        },
        // What an index built here did: each statement's mean time before it was ready, and since.
        async "database.effect"({ name } = {}) {
            await admin(this);
            return own(async () => ({ name, statements: await effect(String(name)) }));
        },
    };
    return { services, touches: Object.fromEntries(Object.keys(services).map((k) => [k, []])), flush: async () => { await sqlStats.flush(db, instance); await callStats?.flush(db, instance); } };
}
