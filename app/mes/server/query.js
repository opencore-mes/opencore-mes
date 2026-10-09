// Queries (DESIGN.md §23): SQL, or JSON for those who do not write SQL, over views of the plant's
// objects, with a schema explorer.
//
// Records are JSONB rows whose every field is guarded by policies (§9): a query straight on the tables
// would bypass them. So each object is a **view** in schema `q` (`q.lot`, `q.work_order`, …) with
// typed columns, and its policies are **compiled into the view** (the same semantics as policy.js
// `decide`, which the tests check record by record): a row the viewer may not read is not there, and
// a field they may not read is NULL. Each object also has `q.<object>_stays`, its stays in states
// (§22), for the rows the viewer may read.
//
// Who is viewing is a row in mes.query_context, keyed by the transaction (txid_current()), written by
// the platform before the viewer's SQL runs and invisible to it. A view with no such row returns
// nothing.
//
// The viewer's SQL runs:
//   - as the database role `mes_query`, which may read the q views and nothing else (not mes.*);
//   - as one statement: wrapped in `SELECT * FROM (…) AS _q LIMIT $n`, sent with a parameter so the
//     extended protocol refuses a second command; a data-modifying WITH is refused inside a subquery;
//   - after its plan is checked for functions that could change settings or reach outside
//     (set_config, query_to_xml, pg_sleep, large objects, dblink…), by name as the planner resolved it,
//     so quoting or escapes do not hide one;
//   - with a statement timeout, a row limit and a size limit.
// POC: run the app's database user without superuser rights in production (see §23).
import { createHash } from "node:crypto";
import { fail } from "@opencore-mes/juris-kit/errors.js";
import { decide, readAllRule, requirementsOf } from "./policy.js";
import { isSensitive } from "../client/definition.js";
import { bindNamed, QUERY_LIMIT } from "../client/query-def.js";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const lit = (text) => `'${String(text).replace(/'/g, "''")}'`;
export const jsonLit = (value) => `${lit(JSON.stringify(value ?? null))}::jsonb`;
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Functions a query may not call, as the planner names them. Settings, other queries run from a
// string, sleeping, files, large objects, other databases, signals to other sessions, locks,
// replication and notifications.
const REFUSED = /\b(set_config|query_to_xml\w*|cursor_to_xml\w*|table_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|query_to_xmlschema|pg_sleep\w*|pg_read_\w+|pg_ls_\w+|pg_stat_file|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_notify|pg_advisory_\w+|pg_try_advisory_\w+|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_logical_\w+|pg_replication_\w+|pg_export_snapshot|pg_import_system_collations|pg_promote|pg_log_backend_memory_contexts|nextval|setval)\s*\(/i;

// ---- field types → SQL columns ------------------------------------------------------------------
export const SQL_TYPES = { string: "text", text: "text", enum: "text", integer: "bigint", decimal: "numeric", boolean: "boolean", date: "date", ref: "uuid" };
export function column(name, field, r = "r") {
    const j = `${r}.data->${lit(name)}`;
    const t = `${r}.data->>${lit(name)}`;
    // Several values: a text array (`'dent' = ANY(defects)`, `cardinality(defects)`).
    if (field.multiple) return `CASE WHEN jsonb_typeof(${j}) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${j})) END`;
    switch (field.type) {
        case "integer": return `CASE WHEN jsonb_typeof(${j}) = 'number' THEN (${j})::numeric::bigint END`;
        case "decimal": return `CASE WHEN jsonb_typeof(${j}) = 'number' THEN (${j})::numeric END`;
        case "boolean": return `CASE WHEN jsonb_typeof(${j}) = 'boolean' THEN (${j})::boolean END`;
        case "date": return `CASE WHEN ${t} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (${t})::date END`;
        case "ref": return `CASE WHEN ${t} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${t})::uuid END`;
        default: return `CASE WHEN jsonb_typeof(${j}) = 'string' THEN ${t} END`;
    }
}
const SYSTEM_COLUMNS = [
    ["id", "uuid", "r.id"], ["state", "text", "r.state"], ["type", "text", "r.type"],
    ["created_at", "timestamptz", "r.created_at"], ["created_by", "text", "r.created_by"],
    ["updated_at", "timestamptz", "r.updated_at"], ["updated_by", "text", "r.updated_by"],
    ["archived_at", "timestamptz", "r.archived_at"], ["archived_by", "text", "r.archived_by"],
    ["row_version", "bigint", "r.row_version"], ["def_version", "integer", "r.def_version"],
];

// ---- policy expressions → SQL (expr.js semantics) -------------------------------------------------
// Every value is JSONB, with JavaScript's undefined as SQL NULL and null as 'null'::jsonb, so the
// comparisons keep policy.js's meaning:
//   eq / ne     strict equality (arrays and objects are never equal, as in JavaScript)
//   lt … ge     numbers with numbers, strings with strings (in code point order); anything else false
//   in/contains membership of a plain value in a list
//   all / any   of parts that are true; not: anything but true; is_null: null or missing
// The record is the row as policy.js sees it: its data, then id, state, type, archived_at.
// `r` is the record's alias; a caller that knows the viewer (record-sql.js) gives `user` as literals.
function recordRef(path, r = "r") {
    const p = String(path);
    if (p === "id") return `to_jsonb(${r}.id::text)`;
    if (p === "state") return `to_jsonb(${r}.state)`;
    if (p === "type") return `coalesce(to_jsonb(${r}.type), 'null'::jsonb)`;
    if (p === "archived_at") return `CASE WHEN ${r}.archived_at IS NULL THEN 'null'::jsonb ELSE to_jsonb(to_char(${r}.archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END`;
    const parts = p.split(".");
    return parts.length === 1 ? `(${r}.data->${lit(p)})` : `(${r}.data#>${lit(`{${parts.join(",")}}`)})`;
}
function userRef(path) {
    if (path === "id") return "to_jsonb(ctx.user_id)";
    if (path === "roles") return "ctx.roles";
    if (path === "certifications") return "ctx.certifications";
    // What a person has on a form and a query does not carry (their departments, their name): read as
    // empty, a condition on one failed and its negation held, so "not in my department" showed every
    // record. It cannot be said here, and the rule that reads it grants nothing to a query (viewSql).
    if (["departments", "name", "via", "onBehalfOf"].includes(String(path).split(".")[0])) throw new Error(`a query does not know user.${path}`);
    return "NULL::jsonb"; // nothing else is an attribute of a user: undefined on a form too, so conditions on it fail alike
}
const NUMERIC = "'^[-+]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][-+]?[0-9]+)?$'";
const toNumber = (x) => `(CASE jsonb_typeof(${x}) WHEN 'number' THEN (${x})::numeric
    WHEN 'boolean' THEN (CASE WHEN (${x}) = 'true'::jsonb THEN 1 ELSE 0 END)::numeric
    WHEN 'null' THEN 0::numeric
    WHEN 'string' THEN (CASE WHEN btrim((${x})#>>'{}') = '' THEN 0::numeric WHEN btrim((${x})#>>'{}') ~ ${NUMERIC} THEN btrim((${x})#>>'{}')::numeric END) END)`;
const SCALAR = (x) => `coalesce(jsonb_typeof(${x}), '') NOT IN ('array', 'object')`;
const REL = { lt: "<", le: "<=", gt: ">", ge: ">=" };

// { kind: "json" | "bool", sql }. `env`: { user: path → SQL, alias: the record's }.
const VIEWER = { user: userRef, alias: "r" };
function compile(node, env = VIEWER) {
    if (Array.isArray(node)) {
        const parts = node.map((n) => asJson(compile(n, env)));
        return { kind: "json", sql: parts.length ? `jsonb_build_array(${parts.join(", ")})` : "'[]'::jsonb" };
    }
    if (!isPlain(node)) return { kind: "json", sql: jsonLit(node) };
    const keys = Object.keys(node);
    if (keys.length !== 1) throw new TypeError("an expression node has one key");
    const [op] = keys;
    const arg = node[op];
    if (op === "record") return { kind: "json", sql: recordRef(arg, env.alias) };
    if (op === "user") return { kind: "json", sql: env.user(arg) };
    if (["data", "event", "param", "input", "lookup", "row", "node", "context"].includes(op)) return { kind: "json", sql: "NULL::jsonb" };
    if (op === "eq" || op === "ne") {
        const [a, b] = arg.map((n) => asJson(compile(n, env)));
        const eq = `((${a}) IS NOT DISTINCT FROM (${b}) AND ${SCALAR(`(${a})`)})`;
        return { kind: "bool", sql: op === "eq" ? `(${eq})` : `(NOT ${eq})` };
    }
    if (op in REL) {
        const [a, b] = arg.map((n) => asJson(compile(n, env)));
        const o = REL[op];
        // JavaScript's relational comparison of plain values: two strings by code point, anything
        // else as numbers (a numeric string its number, "" 0, true 1, false 0, null 0), and a value
        // that is not a number (a missing one, a list) compares false.
        return {
            kind: "bool",
            sql: `(CASE WHEN jsonb_typeof(${a}) = 'string' AND jsonb_typeof(${b}) = 'string' THEN ((${a})#>>'{}') COLLATE "C" ${o} ((${b})#>>'{}') COLLATE "C"
                        ELSE coalesce(${toNumber(a)} ${o} ${toNumber(b)}, false) END)`,
        };
    }
    if (op === "in" || op === "contains") {
        const [first, second] = arg.map((n) => asJson(compile(n, env)));
        const [item, list] = op === "in" ? [first, second] : [second, first];
        return { kind: "bool", sql: `(coalesce(jsonb_typeof(${list}) = 'array' AND (${item}) IS NOT NULL AND ${SCALAR(`(${item})`)} AND (${list}) @> jsonb_build_array(${item}), false))` };
    }
    if (op === "all" || op === "any") {
        const parts = arg.map((n) => `(${asBool(compile(n, env))})`);
        if (!parts.length) return { kind: "bool", sql: op === "all" ? "true" : "false" };
        return { kind: "bool", sql: `(${parts.join(op === "all" ? " AND " : " OR ")})` };
    }
    if (op === "not") return { kind: "bool", sql: `(NOT (${asBool(compile(arg, env))}))` };
    if (op === "is_null") {
        const x = asJson(compile(arg, env));
        return { kind: "bool", sql: `((${x}) IS NULL OR (${x}) = 'null'::jsonb)` };
    }
    throw new TypeError(`unknown operator "${op}"`);
}
const asJson = (c) => (c.kind === "json" ? c.sql : `to_jsonb(${c.sql})`);
// "is true", never NULL: a condition holds only when its value is exactly true.
const asBool = (c) => (c.kind === "bool" ? `coalesce(${c.sql}, false)` : `coalesce((${c.sql}) = 'true'::jsonb, false)`);
export const conditionSql = (when, env = VIEWER) => (when === undefined ? "true" : asBool(compile(when, env)));

// ---- the views ---------------------------------------------------------------------------------
// How the views are built: raised when viewSql changes, so every installation rebuilds them.
const VIEWS = 5;
// A sensitive field (§6.10) has no column in any view: no query, AI report or the analytics copilot
// reads it, whoever asks; it is shown only on a record, to someone who asks for it with a reason.
const queried = (definition) => Object.entries(definition.fields ?? {}).filter(([name]) => !isSensitive(definition, name));
// One view per object: the read rule and each field's read rule, from its policies (policy.js decide).
export function viewSql(definition) {
    const object = definition.object;
    // A policy that applies only through a transaction (§25) grants nothing to a query; who reads every
    // record (§27.7) reads here too, as the policy engine has it.
    const rules = [...(definition.policies ?? []).filter((rule) => rule.via === undefined), readAllRule(definition)];
    // A condition SQL cannot say (arithmetic, a count: expr.js has more than a view does) must not take
    // every object's view down with it: such a rule grants nothing here, and what it hides stays hidden
    // from everyone who holds its roles, whatever its condition would have said.
    const applies = (unsaid) => rules.map((rule) => {
        const holds = `ctx.roles ?| ARRAY[${(rule.roles ?? []).map(lit).join(", ") || "NULL::text"}]::text[]`;
        try { return `(${holds} AND ${conditionSql(rule.when)})`; } catch { return `(${holds} AND ${unsaid})`; }
    });
    const [grants, denies] = [applies("false"), applies("true")];
    const anyOf = (pick, from = grants) => {
        const parts = rules.map((rule, k) => (pick(rule) ? from[k] : null)).filter(Boolean);
        return parts.length ? `(${parts.join(" OR ")})` : "false";
    };
    // What the object's access requires (§9.9), before any rule: a record whose condition holds for a
    // certification the viewer does not hold is not in the view at all, whoever reads. A condition SQL
    // cannot say reserves every record (fail closed).
    const reserved = requirementsOf(definition).map((q) => {
        const holds = `ctx.certifications ? ${lit(q.certification)}`;
        try { return `(${holds} OR NOT ${q.when === undefined ? "true" : conditionSql(q.when)})`; } catch { return holds; }
    });
    const granted = anyOf((rule) => Boolean(rule.record?.read));
    const read = reserved.length ? `(${granted} AND ${reserved.join(" AND ")})` : granted;
    const fieldReadable = (name) => {
        const granted = anyOf((rule) => ["read", "write"].includes(rule.fields?.[name] ?? rule.fields?.["*"]));
        const hidden = anyOf((rule) => (Array.isArray(rule.deny?.read) ? rule.deny.read : []).includes(name), denies);
        return `(${granted} AND NOT ${hidden})`;
    };
    const fields = queried(definition);
    const columns = [
        ...SYSTEM_COLUMNS.map(([name, , expr]) => `${expr} AS ${ident(name)}`),
        ...fields.map(([name, field]) => `CASE WHEN ${fieldReadable(name)} THEN ${column(name, field)} END AS ${ident(name)}`),
    ];
    const from = `FROM mes.records r
  JOIN (SELECT c.user_id, coalesce(c.roles->${lit(object)}, '[]'::jsonb) AS roles, coalesce(c.certifications, '[]'::jsonb) AS certifications FROM mes.query_context c WHERE c.txid = txid_current()) ctx ON true
  WHERE r.object = ${lit(object)} AND ${read}`;
    const dims = (definition.analytics?.dimensions ?? []).filter((d) => !isSensitive(definition, d));
    const dimsSql = dims.length
        ? `jsonb_strip_nulls(jsonb_build_object(${dims.map((d) => `${lit(d)}, CASE WHEN ${fieldReadable(d)} THEN i.dims->${lit(d)} END`).join(", ")}))`
        : "'{}'::jsonb";
    return [
        `CREATE VIEW q.${ident(object)} AS SELECT ${columns.join(",\n  ")}\n${from}`,
        `CREATE VIEW q.${ident(`${object}_stays`)} AS SELECT i.record_id, i.state, i.entered_at, i.left_at, i.entered_by, i.left_by, i.enter_action, i.leave_action,
  extract(epoch FROM coalesce(i.left_at, clock_timestamp()) - i.entered_at)::numeric AS seconds, ${dimsSql} AS dims
FROM mes.state_intervals i JOIN mes.records r ON r.object = i.object AND r.id = i.record_id
  JOIN (SELECT c.user_id, coalesce(c.roles->${lit(object)}, '[]'::jsonb) AS roles, coalesce(c.certifications, '[]'::jsonb) AS certifications FROM mes.query_context c WHERE c.txid = txid_current()) ctx ON true
WHERE i.object = ${lit(object)} AND ${read}`,
    ];
}

// The explorer's description of the views, for one viewer: what each column holds, and whether they
// may read it always, in some states, or never.
function describe(definition, actor) {
    const states = definition.states?.list ?? [];
    const levels = states.map((state) => decide(definition, actor, { state }).fields);
    const access = (name) => {
        const readable = levels.filter((f) => f[name]).length;
        return readable === states.length ? "always" : readable ? "in some states" : "never";
    };
    return [
        {
            name: definition.object, object: definition.object, label: definition.label, kind: "records", states,
            columns: [
                ...SYSTEM_COLUMNS.map(([name, type]) => ({ name, type, label: name.replace(/_/g, " "), system: true, access: "always" })),
                ...queried(definition).map(([name, f]) => ({ name, type: f.multiple ? "text[]" : SQL_TYPES[f.type] ?? "text", label: f.label ?? name, fieldType: f.type, values: f.values, to: f.to, access: access(name) })),
            ],
            sample: `SELECT ${[definition.titleField, "state", ...queried(definition).map(([n]) => n).filter((n) => n !== definition.titleField).slice(0, 3)].filter(Boolean).join(", ")}\nFROM ${definition.object}\nORDER BY updated_at DESC\nLIMIT 50`,
        },
        {
            name: `${definition.object}_stays`, object: definition.object, label: `${definition.label}: stays in states`, kind: "stays", states,
            columns: [
                ["record_id", "uuid"], ["state", "text"], ["entered_at", "timestamptz"], ["left_at", "timestamptz"], ["entered_by", "text"], ["left_by", "text"],
                ["enter_action", "text"], ["leave_action", "text"], ["seconds", "numeric"], ["dims", "jsonb"],
            ].map(([name, type]) => ({ name, type, label: name.replace(/_/g, " "), system: true, access: "always" })),
            sample: `SELECT state, count(*) AS stays, round(avg(seconds) / 3600, 1) AS avg_hours\nFROM ${definition.object}_stays\nWHERE left_at > now() - interval '30 days'\nGROUP BY state\nORDER BY avg_hours DESC`,
        },
    ];
}

// ---- JSON queries → SQL ---------------------------------------------------------------------------
// { from, select: [field | { count|sum|avg|min|max: field|"*", as }], where: <expression with
//   { field } references and like/ilike>, groupBy: [field], orderBy: [{ field, dir }], limit }
// Names are checked against the view; every value is a parameter.
const AGGREGATES = ["count", "sum", "avg", "min", "max"];
const COMPARISONS = { eq: "=", ne: "<>", lt: "<", le: "<=", gt: ">", ge: ">=" };
export function compileJsonQuery(query, schema) {
    if (!isPlain(query)) fail("A JSON query is an object: { from, select, where, groupBy, orderBy, limit }.");
    const view = schema.find((v) => v.name === query.from);
    if (!view) fail(`"${query.from ?? ""}" is not a view: ${schema.map((v) => v.name).join(", ")}.`, { fields: { from: "Unknown view." } });
    const columns = new Set(view.columns.map((c) => c.name));
    const params = [];
    const param = (v) => { params.push(v); return `$${params.length}`; };
    const field = (name, where) => {
        if (typeof name !== "string" || !columns.has(name)) fail(`${where}: "${name}" is not a column of ${view.name}.`, { fields: { [where]: "Unknown column." } });
        return ident(name);
    };
    const aliases = new Set();
    const select = (Array.isArray(query.select) && query.select.length ? query.select : ["*"]).map((item) => {
        if (item === "*") return "*";
        if (typeof item === "string") return field(item, "select");
        if (!isPlain(item)) fail("select lists columns, or { count|sum|avg|min|max: column, as: name }.");
        const agg = AGGREGATES.find((a) => a in item);
        if (!agg) fail("select lists columns, or { count|sum|avg|min|max: column, as: name }.");
        const target = item[agg] === "*" && agg === "count" ? "*" : field(item[agg], "select");
        const as = item.as ?? `${agg}_${item[agg] === "*" ? "all" : item[agg]}`;
        if (!IDENTIFIER.test(as)) fail(`"${as}" is not a name: lower case letters, digits and _.`, { fields: { select: "Bad name." } });
        aliases.add(as);
        return `${agg}(${target}) AS ${ident(as)}`;
    });
    const expr = (node) => {
        if (!isPlain(node)) fail("where is an expression: { eq: [{ field: \"state\" }, \"released\"] }, all, any, not, in, is_null, like.");
        const [op] = Object.keys(node);
        const arg = node[op];
        const side = (x) => (isPlain(x) && "field" in x ? field(x.field, "where") : param(x));
        if ((op in COMPARISONS || op === "like" || op === "ilike" || op === "in") && !(Array.isArray(arg) && arg.length === 2)) fail(`${op} compares two things: { ${op}: [{ field: "state" }, "released"] }.`);
        if (op in COMPARISONS) return `(${side(arg[0])} ${COMPARISONS[op]} ${side(arg[1])})`;
        if (op === "like" || op === "ilike") return `(${side(arg[0])}::text ${op === "like" ? "LIKE" : "ILIKE"} ${side(arg[1])})`;
        if (op === "in") {
            if (!Array.isArray(arg[1])) fail("in compares a column with a list: { in: [{ field: \"state\" }, [\"a\", \"b\"]] }.");
            return `(${side(arg[0])} = ANY(${param(arg[1])}))`;
        }
        if (op === "is_null") return `(${side(arg)} IS NULL)`;
        if (op === "not") return `(NOT ${expr(arg)})`;
        if (op === "all" || op === "any") return Array.isArray(arg) && arg.length ? `(${arg.map(expr).join(op === "all" ? " AND " : " OR ")})` : op === "all" ? "true" : "false";
        fail(`"${op}" is not an operator of a JSON query.`, { fields: { where: "Unknown operator." } });
    };
    const orderOf = (o) => {
        const name = isPlain(o) ? o.field : o;
        const dir = isPlain(o) && String(o.dir ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
        return `${aliases.has(name) ? ident(name) : field(name, "orderBy")} ${dir}`;
    };
    let sql = `SELECT ${select.join(", ")} FROM ${ident(view.name)}`;
    if (query.where !== undefined) sql += ` WHERE ${expr(query.where)}`;
    if (Array.isArray(query.groupBy) && query.groupBy.length) sql += ` GROUP BY ${query.groupBy.map((g) => field(g, "groupBy")).join(", ")}`;
    if (Array.isArray(query.orderBy) && query.orderBy.length) sql += ` ORDER BY ${query.orderBy.map(orderOf).join(", ")}`;
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0 && limit <= MAX_LIMIT)) fail(`limit is 1 to ${MAX_LIMIT}.`, { fields: { limit: "Out of range." } });
    return { sql, params, limit };
}

// ---- the module ------------------------------------------------------------------------------
export function createQuery({ store, timeoutMs = 5000, log = console, certificationsOf = async () => [] }) {
    const { db } = store;
    let built = null; // the signature of the views this instance last saw built

    // The published definitions, and how views are built from them (VIEWS): either changing rebuilds them.
    const signatureOf = (defs) => createHash("sha256").update(JSON.stringify([VIEWS, ...defs.map((d) => [d.object, d.version]).sort()])).digest("hex");
    async function published() {
        return (await db.query("SELECT object, version, body FROM mes.definitions WHERE status = 'published' ORDER BY object")).map((r) => ({ object: r.object, version: r.version, body: r.body }));
    }
    // The views match the published definitions; rebuilt when they do not (after a change executed),
    // by one instance at a time.
    async function ensureViews() {
        const defs = await published();
        const signature = signatureOf(defs);
        if (built === signature) return defs;
        await db.transaction(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtext('mes.query_views'))");
            const [row] = await tx.query("SELECT signature FROM mes.query_views WHERE id");
            if (row?.signature === signature) return;
            const old = await tx.query("SELECT table_name FROM information_schema.views WHERE table_schema = 'q'");
            for (const v of old) await tx.query(`DROP VIEW IF EXISTS q.${ident(v.table_name)} CASCADE`);
            for (const d of defs) for (const statement of viewSql(d.body)) await tx.query(statement);
            await tx.query("GRANT SELECT ON ALL TABLES IN SCHEMA q TO mes_query");
            await tx.query("INSERT INTO mes.query_views (id, signature, built_at) VALUES (true, $1, now()) ON CONFLICT (id) DO UPDATE SET signature = $1, built_at = now()", [signature]);
            log.info?.(`query views rebuilt for ${defs.length} object(s)`);
        });
        built = signature;
        return defs;
    }

    async function analyst(self) {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        if (!(await store.rolesFor(user.id, "query")).length) fail("Queries are not shared with you: they need the analyst role.", { status: 403 });
        return user;
    }
    async function rolesOf(user, defs) {
        const out = {};
        for (const d of defs) out[d.object] = await store.rolesFor(user.id, d.object);
        return out;
    }
    async function schemaFor(user, defs) {
        const roles = await rolesOf(user, defs);
        return defs.filter((d) => roles[d.object].length).flatMap((d) => describe(d.body, { id: user.id, roles: roles[d.object] }));
    }

    // Runs one SELECT as the viewer: { columns, rows, truncated, ms, sql }.
    // `describe`: the columns alone, from the database's description of a result with no rows (what a design that
    // names a query's columns is checked against).
    async function execute(user, defs, sql, params = [], limit = DEFAULT_LIMIT, { describe = false } = {}) {
        if (typeof sql !== "string" || !sql.trim()) fail("Write a query.", { fields: { sql: "Empty." } });
        if (sql.length > 20_000) fail("A query is at most 20 000 characters.", { fields: { sql: "Too long." } });
        const text = sql.trim().replace(/;\s*$/, "");
        const max = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
        const roles = await rolesOf(user, defs);
        const n = params.length + 1;
        // Rows as JSON text, so dates and numbers keep the database's own forms; the columns from the
        // same query with no rows. Each carries a parameter, so neither can hold a second statement.
        const wrapped = `SELECT row_to_json(_q)::text AS r FROM (\n${text}\n) AS _q LIMIT $${n}`;
        const namesOf = `SELECT * FROM (\n${text}\n) AS _q LIMIT $${n}`;
        const started = Date.now();
        try {
            return await db.transaction(async (tx) => {
                await tx.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.round(timeoutMs))}`);
                await tx.query("SET LOCAL lock_timeout = 1000");
                await tx.query("INSERT INTO mes.query_context (txid, user_id, roles, certifications) VALUES (txid_current(), $1, $2, $3)", [user.id, JSON.stringify(roles), JSON.stringify(await certificationsOf(user.id))]);
                await tx.query("SET LOCAL ROLE mes_query");
                await tx.query("SET LOCAL search_path = q");
                // The plan, first: the functions it calls, as the planner resolved them.
                const [explained] = await tx.query(`EXPLAIN (VERBOSE, FORMAT JSON) ${wrapped}`, [...params, max + 1]);
                const planText = JSON.stringify(explained);
                const refused = REFUSED.exec(planText) ?? REFUSED.exec(text);
                if (refused) throw Object.assign(new Error(`A query may not call ${refused[1]}().`), { refusal: true });
                // The columns, from the database's own description of the result (none of its rows).
                const columns = (await tx.query(namesOf, [...params, 0])).fields ?? [];
                if (new Set(columns).size !== columns.length) throw Object.assign(new Error("Two columns have the same name: name each once (… AS name)."), { refusal: true });
                if (describe) { await tx.query("RESET ROLE"); await tx.query("DELETE FROM mes.query_context WHERE txid = txid_current()"); return { columns }; }
                const rows = await tx.query(wrapped, [...params, max + 1]);
                await tx.query("RESET ROLE");
                await tx.query("DELETE FROM mes.query_context WHERE txid = txid_current()");
                const truncated = rows.length > max;
                const out = (truncated ? rows.slice(0, max) : rows).map((row) => { const o = JSON.parse(row.r); return columns.map((c) => o[c] ?? null); });
                const size = JSON.stringify(out).length;
                if (size > MAX_BYTES) throw Object.assign(new Error(`The result is over ${MAX_BYTES / 1024 / 1024} MB: ask for fewer rows or columns.`), { refusal: true });
                return { columns, rows: out, truncated, limit: max, ms: Date.now() - started, sql: text, params };
            });
        } catch (error) {
            if (error.refusal) fail(error.message, { code: "query.refused" });
            if (error.code === "57014") fail(`The query ran past ${Math.round(timeoutMs / 1000)} s and was stopped: narrow it (a WHERE, a LIMIT).`, { code: "query.timeout" });
            if (error.code === "42501") fail("That is not readable: a query reads the views in the schema explorer, nothing else.", { code: "query.denied" });
            if (error.code === "42601" && /multiple commands/i.test(error.message)) fail("One statement at a time.", { code: "query.refused" });
            // What to do about the commonest: a column two views share (state, updated_at, …), named bare.
            const ambiguous = error.code === "42702" ? /column reference "([^"]+)"/.exec(error.message)?.[1] : null;
            const hint = ambiguous ? ` Two of the views you joined have ${ambiguous}: say whose, as view.${ambiguous} (or an alias: FROM a_view v … v.${ambiguous}).` : "";
            if (typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)) fail(`The database says: ${error.message}${error.position ? ` (at character ${error.position})` : ""}.${hint}`, { code: "query.error" });
            throw error;
        }
    }

    const services = {
        async "query.schema"() {
            const user = await analyst(this);
            const defs = await ensureViews();
            return { views: await schemaFor(user, defs), limit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT, timeoutMs };
        },
        async "query.sql"({ sql, limit } = {}) {
            const user = await analyst(this);
            const defs = await ensureViews();
            return execute(user, defs, sql, [], limit);
        },
        // A named query's draft tried in the designer (§23.1), with values typed in, as whoever tries it.
        async "query.named"({ sql, params, values, limit } = {}) {
            const user = await analyst(this);
            return runNamed(user, { sql, params, limit }, values);
        },
        async "query.json"({ query } = {}) {
            const user = await analyst(this);
            const defs = await ensureViews();
            const compiled = compileJsonQuery(query, await schemaFor(user, defs));
            return execute(user, defs, compiled.sql, compiled.params, compiled.limit);
        },
    };
    const touches = Object.fromEntries(Object.keys(services).map((n) => [n, []]));
    // For what else reads the views as a person (a report's blocks, §34): one query, SQL or JSON, run
    // as `user` exactly as their own would be; and the views as they may read them.
    async function runAs(user, { sql, json } = {}, limit) {
        const defs = await ensureViews();
        if (json !== undefined) {
            const compiled = compileJsonQuery(json, await schemaFor(user, defs));
            return execute(user, defs, compiled.sql, compiled.params, Math.min(compiled.limit ?? limit ?? DEFAULT_LIMIT, limit ?? MAX_LIMIT));
        }
        return execute(user, defs, sql, [], limit);
    }
    const schemaAs = async (user) => schemaFor(user, await ensureViews());
    // A named query (§23.1) run as `user` (a person filling a plan's screen, the fitness test's submitter):
    // its ":name" parameters bound as SQL parameters, typed; at most its limit. It grants nothing: the
    // views give `user` what their policies do.
    // Each counted by its name and how it was asked (call-stats.js, §38.1): `channel`, a screen's table, a
    // reference's choices, a plan, the web, the fitness test.
    let calls = null;
    // (`channel` null: counted by whoever called, as a request over the web is.)
    const measured = (body, channel, fn, who = null) => (calls && channel && typeof body?.name === "string" ? calls.measure({ kind: "query", name: body.name, channel, who }, fn) : fn());
    async function runNamed(user, body, values = {}, { channel = "internal" } = {}) {
        return measured(body, channel, () => runNamedNow(user, body, values));
    }
    async function runNamedNow(user, body, values) {
        const bound = bindNamed(body?.sql ?? "", body?.params ?? {}, values ?? {});
        if (bound.problems.length) fail(bound.problems.join(" "), { code: "query.params" });
        const limit = Math.min(Math.max(1, Number(body?.limit) || QUERY_LIMIT.default), QUERY_LIMIT.max);
        return execute(user, await ensureViews(), bound.text, bound.values, limit);
    }
    // A named query's columns, without running it (§23.1): its parameters given no values (each NULL, typed), its
    // rows none. As the platform, whose roles are none: what it describes is the views' columns, not anyone's rows.
    // Kept per text and the views it reads (a design published changes them). → { columns } or { problem: words }.
    const described = new Map();
    async function describeNamed(body) {
        const defs = await ensureViews();
        const key = JSON.stringify([body?.sql ?? "", body?.params ?? {}, defs.map((d) => `${d.object}:${d.version ?? ""}`)]);
        if (described.has(key)) return described.get(key);
        let out;
        try {
            const bound = bindNamed(body?.sql ?? "", body?.params ?? {}, {});
            const hard = bound.problems.filter((m) => !/ is required\.$/.test(m));
            out = hard.length ? { problem: hard.join(" ") } : { columns: (await execute({ id: "platform" }, defs, bound.text, bound.values, 1, { describe: true })).columns };
        } catch (error) {
            out = { problem: error.message };
        }
        if (described.size > 500) described.delete(described.keys().next().value);
        described.set(key, out);
        return out;
    }
    // A window of a named query's rows (a screen's table, §26), as `user`: in the order asked (one of its columns,
    // checked against what it gives), from `offset`, at most `limit`. → execute's { columns, rows, truncated }.
    async function pageNamed(user, body, values = {}, { sort = null, offset = 0, limit = QUERY_LIMIT.default, channel = "internal", who = null } = {}) {
        return measured(body, channel, () => pageNamedNow(user, body, values, { sort, offset, limit }), who);
    }
    async function pageNamedNow(user, body, values, { sort, offset, limit }) {
        const bound = bindNamed(body?.sql ?? "", body?.params ?? {}, values ?? {});
        if (bound.problems.length) fail(bound.problems.join(" "), { code: "query.params" });
        const n = bound.values.length;
        let order = "";
        if (sort?.field) {
            const d = await describeNamed(body);
            if (!d.columns?.includes(sort.field)) fail(`The query gives no column "${sort.field}" to sort by.`, { code: "query.params" });
            order = ` ORDER BY "${sort.field.replace(/"/g, '""')}" ${sort.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`;
        }
        const text = `SELECT * FROM (\n${bound.text}\n) AS _page${order} OFFSET $${n + 1}`;
        const max = Math.min(Math.max(1, Number(limit) || QUERY_LIMIT.default), QUERY_LIMIT.max);
        return execute(user, await ensureViews(), text, [...bound.values, Math.max(0, Number(offset) || 0)], max);
    }
    // Whether a record is among a named query's rows for `user` (a reference's choices, §23.1): asked of the query
    // by its id, so a long list is never cut short by the query's limit.
    async function hasId(user, body, values, id, { channel = "internal" } = {}) {
        return measured(body, channel, () => hasIdNow(user, body, values, id));
    }
    async function hasIdNow(user, body, values, id) {
        const bound = bindNamed(body?.sql ?? "", body?.params ?? {}, values ?? {});
        if (bound.problems.length) return { ok: false, problem: bound.problems.join(" ") };
        const n = bound.values.length;
        const ran = await execute(user, await ensureViews(), `SELECT id FROM (\n${bound.text}\n) AS _has WHERE _has.id::text = $${n + 1}`, [...bound.values, String(id)], 1);
        return { ok: ran.rows.length > 0 };
    }
    return { services, touches, ensureViews, runAs, schemaAs, runNamed, describeNamed, pageNamed, hasId, useCallStats: (c) => { calls = c; } };
}
