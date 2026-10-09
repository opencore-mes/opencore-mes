// The Database area (DESIGN.md §38): statements counted by their text (never their values), and an index
// written by the server from a description, with the expressions the platform's queries use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, keyOf, createSqlStats } from "../server/sql-stats.js";
import { indexStatement } from "../server/database.js";

test("a statement is counted by its text: white space collapsed, numbers written into it as ?, values never", () => {
    assert.equal(normalize("SELECT *\n  FROM mes.records WHERE object = $1 LIMIT 51 OFFSET 100"), "SELECT * FROM mes.records WHERE object = $1 LIMIT ? OFFSET ?");
    assert.equal(keyOf(normalize("select 1 limit 50")), keyOf(normalize("select 1   limit 100")));
    assert.equal(normalize("SELECT p1, data->>'k2' FROM t1"), "SELECT p1, data->>'k2' FROM t1", "names and quoted keys keep their digits");
});

test("measured: each statement's calls, time and rows, put down to the service that sent it", async () => {
    const stats = createSqlStats();
    const db = { query: async (sql) => (sql.includes("fail") ? Promise.reject(new Error("no")) : [{ a: 1 }, { a: 2 }]), transaction: async (fn) => fn({ query: async () => [{ x: 1 }] }) };
    const m = stats.wrap(db);
    await stats.within("records.list", () => m.query("SELECT a FROM t WHERE b = $1 LIMIT 10", ["secret value"]));
    await stats.within("records.list", () => m.query("SELECT a FROM t WHERE b = $1 LIMIT 20", ["other"]));
    await m.query("SELECT fail").catch(() => {});
    await m.transaction((tx) => tx.query("UPDATE t SET a = $1", [1]));
    const p = stats.pending();
    const list = p.find((x) => x.text.startsWith("SELECT a FROM t"));
    assert.equal(list.calls, 2);
    assert.equal(list.rows, 4);
    assert.deepEqual(list.sources, { "records.list": 2 });
    assert.ok(!JSON.stringify(p).includes("secret value"), "a value given with a statement is never kept");
    assert.equal(p.find((x) => x.text === "SELECT fail").errors, 1);
    assert.equal(p.find((x) => x.text.startsWith("UPDATE")).calls, 1, "a transaction's statements are counted too");
});

const lot = { object: "lot", label: "Lot", fields: { lot_no: { label: "Lot", type: "string" }, qty: { label: "Quantity", type: "decimal" }, patient: { label: "Patient", type: "string", sensitive: true }, made: { label: "Made", type: "date" }, tags: { label: "Tags", type: "enum", multiple: true, values: ["a"] } } };
const known = { definitionOf: (o) => (o === "lot" ? lot : null), columnsOf: (t) => ({ records: ["id", "object", "state", "data", "updated_at", "created_at", "archived_at", "type"], records_lot: ["id", "object", "state"], audit_log: ["seq", "at", "actor", "object"] })[t] ?? null };

test("an index described is written by the server: a record's field by the platform's own expression, partial to its object", () => {
    const st = indexStatement({ table: "records", object: "lot", keys: [{ field: "lot_no" }, { column: "updated_at", desc: true }], inUse: true }, known);
    assert.match(st.sql, /^CREATE INDEX CONCURRENTLY IF NOT EXISTS mesx_lot_\w+ ON mes\."records_lot" \(\(CASE WHEN jsonb_typeof\(data->'lot_no'\) = 'string' THEN data->>'lot_no' END\), updated_at DESC\) WHERE archived_at IS NULL$/);
    assert.match(indexStatement({ table: "records", object: "lot", keys: [{ field: "qty" }] }, known).sql, /\(data->'qty'\)::numeric/);
    assert.match(indexStatement({ table: "audit_log", keys: [{ column: "actor" }, { column: "at", desc: true }] }, known).sql, /ON mes\.audit_log \(actor, at DESC\)$/);
});

test("…and refuses what it cannot index, or what would write anything but an index", () => {
    const why = (spec) => indexStatement(spec, known).error ?? "";
    assert.match(why({ table: "records", object: "lot", keys: [{ field: "patient" }] }), /sensitive/);
    assert.match(why({ table: "records", object: "lot", keys: [{ field: "made" }] }), /date/);
    assert.match(why({ table: "records", object: "lot", keys: [{ field: "tags" }] }), /several values/);
    assert.match(why({ table: "records", object: "lot'; DROP TABLE mes.records; --", keys: [{ field: "lot_no" }] }), /is not an object/);
    assert.match(why({ table: "records", object: "lot", keys: [{ field: "lot_no) ; DROP TABLE x; --" }] }), /is not a field/);
    assert.match(why({ table: "audit_log", keys: [{ column: "actor DESC); DROP TABLE x; --" }] }), /is not a column/);
    assert.match(why({ table: "pg_authid", keys: [{ column: "rolname" }] }), /not one of the platform's tables/);
    assert.match(why({ table: "records", object: "lot", keys: [] }), /one to four keys/);
    assert.match(why({ table: "records_lot", keys: [{ column: "state" }] }), /on its partition/);
});
