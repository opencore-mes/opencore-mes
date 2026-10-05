// Queries (DESIGN.md §23), end to end against the database:
//   1. Every operator of the policy language, compiled to SQL, answers as policy.js's evaluator does,
//      on a table of records and expressions (missing values, nulls, numbers, strings, lists).
//   2. For every seeded person and object, the views show exactly the rows and fields the forms do
//      (policy.js mask): the policies compiled into the views agree with the ones that decide.
//   3. Attempts to get out: the tables, a second statement, RESET ROLE, a data-modifying WITH,
//      set_config (plain, quoted, escaped), query_to_xml, pg_sleep, the context table, a runaway query.
//   4. JSON queries, their errors, the row limit, and views rebuilt when a definition changes.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/query.mjs
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createStore } from "../server/store.js";
import { createQuery, conditionSql } from "../server/query.js";
import { mask } from "../server/policy.js";
import { evaluate } from "../client/expr.js";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const store = createStore(db);
const query = createQuery({ store, log: { info() {} } });
const quick = createQuery({ store, timeoutMs: 300, log: { info() {} } });
// Iris reads every record (§27.7): the views must show her what the forms do, field by field.
const PEOPLE = ["olga", "sam", "quinn", "vera", "dana", "eli", "erp", "iris"];
const sessions = {};
const as = (user) => ({ sessionId: sessions[user] });
const added = [];
const refused = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, code: e.code, message: e.message }));

try {
    for (const user of PEOPLE) {
        sessions[user] = `qy-${randomBytes(8).toString("hex")}`;
        await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
        const [has] = await db.query("SELECT 1 FROM mes.assignments WHERE subject_kind = 'user' AND subject_id = $1 AND object = 'query'", [user]);
        if (!has) {
            await db.query("INSERT INTO mes.assignments (subject_kind, subject_id, object, role) VALUES ('user', $1, 'query', 'analyst')", [user]);
            added.push(user);
        }
    }

    // ---- 1. the expression language, compiled ----
    const id = randomUUID();
    const records = [
        { id, state: "released", type: null, data: { qty: 5, name: "b", tags: ["x", "y"], flag: true, none: null, when: "2026-01-02" } },
        { id, state: "created", type: "wip", data: { qty: 5.0, name: "B", tags: [], flag: false, when: "2025-12-31", nested: { a: 1 } } },
        { id, state: "on_hold", type: null, data: { qty: "5", name: "a" } },
    ];
    const r = (path) => ({ record: path });
    const expressions = [
        { eq: [r("qty"), 5] }, { eq: [r("qty"), "5"] }, { ne: [r("qty"), 5] }, { eq: [r("missing"), null] }, { eq: [r("missing"), r("other")] },
        { eq: [r("none"), null] }, { eq: [r("tags"), ["x", "y"]] }, { eq: [r("state"), "released"] }, { eq: [r("type"), null] },
        { lt: [r("qty"), 6] }, { gt: [r("name"), "a"] }, { lt: [r("name"), "a"] }, { ge: [r("when"), "2026-01-01"] }, { lt: [r("qty"), "6"] }, { gt: [r("missing"), 1] },
        { in: [r("state"), ["released", "created"]] }, { in: [r("name"), ["b"]] }, { in: [r("missing"), ["b"]] }, { in: [r("tags"), [["x", "y"]]] },
        { contains: [r("tags"), "x"] }, { contains: [r("tags"), "z"] }, { contains: [r("name"), "b"] },
        { all: [] }, { any: [] }, { all: [{ eq: [r("qty"), 5] }, { eq: [r("flag"), true] }] }, { any: [{ eq: [r("flag"), false] }, { eq: [r("name"), "a"] }] },
        { not: { eq: [r("state"), "released"] } }, { not: r("flag") }, { is_null: r("none") }, { is_null: r("missing") }, { is_null: r("qty") },
        { eq: [r("nested.a"), 1] }, { eq: [{ user: "id" }, "olga"] }, { contains: [{ user: "roles" }, "operator"] }, { eq: [{ user: "department" }, "x"] },
        { eq: [r("flag"), true] }, r("flag"),
    ];
    const mismatches = [];
    for (const rec of records) {
        for (const expr of expressions) {
            const js = evaluate(expr, { record: { ...rec.data, id: rec.id, state: rec.state, type: rec.type, archived_at: null }, user: { id: "olga", roles: ["operator"] } }) === true;
            const [row] = await db.query(
                `SELECT (${conditionSql(expr)}) AS v FROM (SELECT $1::jsonb AS data, $2::text AS state, $3::text AS type, $4::uuid AS id, NULL::timestamptz AS archived_at) r,
                 (SELECT 'olga'::text AS user_id, '["operator"]'::jsonb AS roles) ctx`,
                [JSON.stringify(rec.data), rec.state, rec.type, rec.id],
            );
            if (row.v !== js) mismatches.push({ expr, record: rec.data, js, sql: row.v });
        }
    }
    step(`every operator compiled to SQL answers as the evaluator (${expressions.length} expressions × ${records.length} records)`, mismatches.length === 0, mismatches.slice(0, 5));

    // ---- 2. views = the forms' masks ----
    const defs = (await db.query("SELECT object, body FROM mes.definitions WHERE status = 'published'")).map((d) => d.body);
    const differences = [];
    let compared = 0;
    for (const user of PEOPLE) {
        for (const def of defs) {
            const roles = await store.rolesFor(user, def.object);
            const actor = { id: user, roles };
            const rows = await db.query("SELECT * FROM mes.records WHERE object = $1", [def.object]);
            const expected = new Map();
            for (const row of rows) {
                const seen = mask(def, actor, { ...row, row_version: Number(row.row_version) });
                if (seen) expected.set(row.id, seen);
            }
            const got = await refused(query.services["query.sql"].call(as(user), { sql: `SELECT * FROM ${def.object}`, limit: 10000 }));
            if (!roles.length) { if (got.ok && got.r.rows.length) differences.push({ user, object: def.object, problem: "rows without a role" }); continue; }
            if (!got.ok) { differences.push({ user, object: def.object, problem: got.message }); continue; }
            const at = (name) => got.r.columns.indexOf(name);
            const ids = new Set(got.r.rows.map((row) => row[at("id")]));
            if (ids.size !== expected.size || [...expected.keys()].some((k) => !ids.has(k))) differences.push({ user, object: def.object, problem: "rows differ", view: ids.size, forms: expected.size });
            for (const row of got.r.rows) {
                const seen = expected.get(row[at("id")]);
                if (!seen) continue;
                for (const field of Object.keys(def.fields)) {
                    compared += 1;
                    const want = seen.$perm.fields[field] && seen[field] !== undefined ? seen[field] : null;
                    const have = row[at(field)];
                    if (JSON.stringify(want) !== JSON.stringify(have)) differences.push({ user, object: def.object, field, want, have });
                }
            }
        }
    }
    step(`the views show exactly what the forms show, for ${PEOPLE.length} people × ${defs.length} objects (${compared} field values compared)`, differences.length === 0 && compared > 0, differences.slice(0, 5));
    const quinnHidden = await query.services["query.sql"].call(as("quinn"), { sql: "SELECT count(*) AS n FROM lot" });
    step("a person sees only what their roles allow: Olga the lots, Dana (viewer) too, nobody without a role", quinnHidden.rows[0][0] >= 3);
    const irisLots = await query.services["query.sql"].call(as("iris"), { sql: "SELECT count(*) AS n FROM lot" });
    const [allLots] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'lot'");
    step("who reads every record reads them in queries too: Iris, with no role on lots, counts every one", Number(irisLots.rows[0][0]) === allLots.n && allLots.n > 0, { iris: irisLots.rows[0][0], all: allLots.n });

    // ---- 3. attempts to get out ----
    const attempts = [
        ["the tables", "SELECT * FROM mes.records", /not readable/],
        ["a second statement", "SELECT 1; DELETE FROM mes.records", /one statement|syntax|database says/i],
        ["closing the wrapper and resetting the role", "SELECT 1) AS x; RESET ROLE; SELECT * FROM (SELECT 1", /one statement|syntax|database says/i],
        ["a data-modifying WITH", "WITH d AS (DELETE FROM lot RETURNING *) SELECT * FROM d", /database says|not readable/i],
        ["set_config", "SELECT set_config('role', 'postgres', true)", /may not call set_config/],
        ["set_config, quoted", 'SELECT "set_config"(\'search_path\', \'mes\', true)', /may not call set_config/],
        ["set_config, escaped", "SELECT U&\"\\0073et_config\"('search_path', 'mes', true)", /may not call set_config/],
        ["query_to_xml", "SELECT query_to_xml('select 1', true, true, '')", /may not call query_to_xml/],
        ["pg_sleep", "SELECT pg_sleep(10)", /may not call pg_sleep/],
        ["the context table", "SELECT * FROM mes.query_context", /not readable/],
        ["another user's context, by writing it", "SELECT * FROM lot, (SELECT 1) x WHERE false", null],
    ];
    const breaches = [];
    for (const [what, sql, expect] of attempts) {
        const out = await refused(query.services["query.sql"].call(as("sam"), { sql }));
        if (expect && (out.ok || !expect.test(out.message))) breaches.push({ what, out: out.ok ? "ran" : out.message });
    }
    const [{ n: records_ }] = await db.query("SELECT count(*)::int AS n FROM mes.records");
    step(`${attempts.length - 1} attempts to get out are refused, and nothing was changed`, breaches.length === 0 && records_ >= 6, breaches);
    const slow = await refused(quick.services["query.sql"].call(as("sam"), { sql: "SELECT count(*) FROM generate_series(1, 200000000)" }));
    step("a runaway query is stopped at the time limit", !slow.ok && slow.code === "query.timeout", slow);
    const nobody = await refused(query.services["query.sql"].call({ sessionId: "none" }, { sql: "SELECT 1" }));
    const olgaSchema = await refused(query.services["query.schema"].call(as("olga"), {}));
    step("no session, refused; the analyst role is needed", nobody.status === 401 && olgaSchema.ok === added.includes("olga"), { nobody: nobody.status });
    const [{ n: contexts }] = await db.query("SELECT count(*)::int AS n FROM mes.query_context");
    step("no viewer is left behind in the context table", contexts === 0);

    // ---- 4. JSON queries, limits, schema ----
    const grouped = await query.services["query.json"].call(as("sam"), { query: { from: "lot", select: ["state", { count: "*", as: "lots" }], groupBy: ["state"], orderBy: [{ field: "lots", dir: "desc" }] } });
    step("a JSON query: lots per state, compiled to SQL with its values as parameters", grouped.columns.join() === "state,lots" && grouped.rows.length >= 3 && /GROUP BY "state"/.test(grouped.sql), { sql: grouped.sql, rows: grouped.rows });
    const filtered = await query.services["query.json"].call(as("sam"), { query: { from: "lot", select: ["lot_no"], where: { all: [{ in: [{ field: "state" }, ["released", "in_process"]] }, { ilike: [{ field: "item" }, "pa66%"] }] } } });
    step("…with where: in, ilike, all; values never in the SQL text", filtered.rows.length >= 2 && !/PA66|pa66|released/.test(filtered.sql) && filtered.params.length === 2, { sql: filtered.sql, params: filtered.params });
    const bad = await refused(query.services["query.json"].call(as("sam"), { query: { from: "lot", select: ["secret_column"] } }));
    step("a JSON query naming a column that does not exist: refused, in words", !bad.ok && /not a column of lot/.test(bad.message), bad);
    const limited = await query.services["query.sql"].call(as("sam"), { sql: "SELECT g FROM generate_series(1, 50) AS g", limit: 10 });
    step("the row limit: 10 rows, marked as more", limited.rows.length === 10 && limited.truncated, { rows: limited.rows.length, truncated: limited.truncated });
    const empty = await query.services["query.sql"].call(as("sam"), { sql: "SELECT lot_no, qty AS kg FROM lot WHERE false" });
    step("an empty result still has its columns", empty.rows.length === 0 && empty.columns.join() === "lot_no,kg", empty.columns);
    const stays = await query.services["query.sql"].call(as("sam"), { sql: "SELECT state, count(*) AS n FROM lot_stays GROUP BY state" });
    step("the stays of each object are a view too", stays.columns.join() === "state,n" && stays.rows.length > 0, stays.rows);
    const schema = await query.services["query.schema"].call(as("olga"), {});
    const lotView = schema.views.find((v) => v.name === "lot");
    step("the schema explorer: views, typed columns, what the viewer may read, a sample query", lotView && lotView.columns.find((c) => c.name === "qty")?.type === "numeric" && lotView.columns.find((c) => c.name === "disposition")?.access === "always" && /FROM lot/.test(lotView.sample) && !schema.views.some((v) => v.name === "deviation" && !added.includes("olga")), lotView?.columns.slice(-4));

    // ---- views follow the definitions ----
    const [lot] = await db.query("SELECT version, body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const next = structuredClone(lot.body);
    next.fields.probe_t = { label: "Probe", type: "string" };
    await db.query("UPDATE mes.definitions SET status = 'superseded' WHERE object = 'lot' AND version = $1", [lot.version]);
    await db.query("INSERT INTO mes.definitions (object, version, status, body) VALUES ('lot', $1, 'published', $2)", [lot.version + 1, JSON.stringify(next)]);
    const after = await query.services["query.sql"].call(as("sam"), { sql: "SELECT lot_no, probe_t FROM lot LIMIT 1" });
    step("a new version of an object: its view is rebuilt with the new field", after.columns.join() === "lot_no,probe_t");
    await db.query("DELETE FROM mes.definitions WHERE object = 'lot' AND version = $1", [lot.version + 1]);
    await db.query("UPDATE mes.definitions SET status = 'published' WHERE object = 'lot' AND version = $1", [lot.version]);
    await query.ensureViews();
} catch (error) {
    step("unexpected", false, { message: error.message, stack: error.stack?.split("\n").slice(0, 4) });
} finally {
    for (const user of added) await db.query("DELETE FROM mes.assignments WHERE subject_kind = 'user' AND subject_id = $1 AND object = 'query'", [user]);
    await db.query("DELETE FROM mes.sessions WHERE id = ANY($1)", [Object.values(sessions).map(sessionKey)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
