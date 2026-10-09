// The platform's statements, measured (DESIGN.md §38): every statement the platform sends the database,
// through the one door it has (the primary and the replica, wrapped before the read routing, and the
// statements inside a transaction too), counted by its text: how often, how long (total, slowest), how many
// rows, how many failed, and which service, live query or worker sent it. Parameter values are never kept:
// they are a record's data, and a sensitive field's value among them. Counted in memory per hour and written
// to mes.sql_stats once a minute (`flush`, by the instance's worker), so the Database area sees every
// instance's, and an index's effect shows as the hours before it against the hours after.
//
//   const stats = createSqlStats()
//   stats.wrap(db, "primary" | "replica")   the same db, measured
//   stats.within(source, fn)                runs fn with its statements put down to `source`
//   stats.flush(db, instance)               writes what was counted (its own statements not counted)
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const MAX_KEYS = 3000;          // distinct statements kept per hour, per instance; beyond, "other"
const MAX_SQL = 20000;          // characters of a statement's text kept
const KEEP_DAYS = 14;           // hours of counts kept in mes.sql_stats

// A statement as it is counted: its words, white space collapsed, numbers written into it (a LIMIT, an
// OFFSET, a list of constants) replaced by `?`, so the same statement for page 2 and page 3 is one.
// Its text keeps what the code wrote, never a value given with it ($1, $2 are where they go).
export function normalize(sql) {
    return String(sql ?? "").replace(/\s+/g, " ").trim().replace(/(?<![\w$.'"])\d+(?:\.\d+)?(?![\w.'"])/g, "?").slice(0, MAX_SQL);
}
export const keyOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const hourOf = (ms) => new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();

export function createSqlStats({ now = () => Date.now() } = {}) {
    const context = new AsyncLocalStorage();
    let counts = new Map(); // `${hour}|${key}` → { hour, key, text, sample, calls, ms, max, rows, errors, replica, sources: Map }
    const count = (sql, ms, rows, failed, where) => {
        const source = context.getStore() ?? "other";
        if (source === "sql-stats") return;
        const text = normalize(sql);
        const hour = hourOf(now());
        let key = keyOf(text);
        // Beyond the statements kept this hour, one "other" counts the rest.
        if (counts.size >= MAX_KEYS && !counts.has(`${hour}|${key}`)) key = "other";
        const id = `${hour}|${key}`;
        let c = counts.get(id);
        if (!c) counts.set(id, (c = { hour, key, text: key === "other" ? "(statements beyond the 3 000 counted this hour)" : text, sample: key === "other" ? null : String(sql).slice(0, MAX_SQL), calls: 0, ms: 0, max: 0, rows: 0, errors: 0, replica: 0, sources: new Map() }));
        c.calls += 1;
        c.ms += ms;
        if (ms > c.max) c.max = ms;
        c.rows += rows;
        if (failed) c.errors += 1;
        if (where === "replica") c.replica += 1;
        c.sources.set(source, (c.sources.get(source) ?? 0) + 1);
    };
    const timed = (where, run, sql) => {
        const began = performance.now();
        return run().then(
            (rows) => { count(sql, performance.now() - began, Array.isArray(rows) ? rows.length : 0, false, where); return rows; },
            (error) => { count(sql, performance.now() - began, 0, true, where); throw error; },
        );
    };
    // A transaction's own handle, measured the same way (its other methods kept, on its prototype or not).
    const wrapQuery = (q, where) => { const out = Object.create(q); out.query = (sql, params) => timed(where, () => q.query(sql, params), sql); return out; };
    function wrap(db, where = "primary") {
        if (!db || db.$measured) return db;
        const out = Object.create(db);
        out.$measured = true;
        out.query = (sql, params) => timed(where, () => db.query(sql, params), sql);
        if (typeof db.transaction === "function") out.transaction = (fn) => db.transaction((tx) => fn(wrapQuery(tx, where)));
        return out;
    }
    const within = (source, fn) => context.run(String(source), fn);
    // Written as each hour's sums (added to what other instances and earlier flushes wrote), then cleared.
    async function flush(db, instance = "local") {
        if (!counts.size) return 0;
        const taken = counts;
        counts = new Map();
        return within("sql-stats", async () => {
            for (const c of taken.values()) {
                await db.query(
                    `INSERT INTO mes.sql_stats (hour, key, instance, text, sample, calls, total_ms, max_ms, rows, errors, replica, sources)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                     ON CONFLICT (hour, key, instance) DO UPDATE SET calls = mes.sql_stats.calls + EXCLUDED.calls, total_ms = mes.sql_stats.total_ms + EXCLUDED.total_ms,
                       max_ms = GREATEST(mes.sql_stats.max_ms, EXCLUDED.max_ms), rows = mes.sql_stats.rows + EXCLUDED.rows, errors = mes.sql_stats.errors + EXCLUDED.errors,
                       replica = mes.sql_stats.replica + EXCLUDED.replica,
                       sources = (SELECT jsonb_object_agg(k, COALESCE((mes.sql_stats.sources->>k)::bigint, 0) + COALESCE((EXCLUDED.sources->>k)::bigint, 0))
                                  FROM (SELECT jsonb_object_keys(mes.sql_stats.sources || EXCLUDED.sources) AS k) x)`,
                    [c.hour, c.key, instance, c.text, c.sample, c.calls, c.ms, c.max, c.rows, c.errors, c.replica, JSON.stringify(Object.fromEntries(c.sources))]);
            }
            await db.query(`DELETE FROM mes.sql_stats WHERE hour < now() - interval '${KEEP_DAYS} days'`);
            return taken.size;
        });
    }
    // What this instance has counted and not yet written (tests, and the area's "this hour, not yet written").
    const pending = () => [...counts.values()].map((c) => ({ ...c, sources: Object.fromEntries(c.sources) }));
    return { wrap, within, flush, pending };
}
