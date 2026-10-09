// Named queries' shared checks (client/query-def.js, DESIGN.md §23.1). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paramsIn, bindNamed, validateQuery, queryFootprint, optionsOf, QUERY_TEMPLATE } from "../client/query-def.js";

test("parameters by name: casts, strings, quoted names, comments and dollar quotes are not parameters", () => {
    const sql = `SELECT id::text, ':not' AS a, "x:y", now() -- :nor\n/* :nor */ FROM machine WHERE family = :family AND $q$:no$q$ <> '' AND line = :line AND family <> :family`;
    assert.deepEqual(paramsIn(sql).names, ["family", "line"]);
    const b = bindNamed(sql, { family: { type: "string", required: true }, line: { type: "integer" } }, { family: "die_attach", line: "3" });
    assert.match(b.text, /family = \$1 AND .* line = \$2 AND family <> \$1/);
    assert.deepEqual(b.values, ["die_attach", 3]);
    assert.deepEqual(b.problems, []);
    assert.deepEqual(bindNamed(sql, { family: { type: "string", required: true, label: "Family" }, line: { type: "integer" } }, { line: "x" }).problems, ["Family is required.", "line is not a whole number."]);
    assert.match(paramsIn("SELECT * FROM lot WHERE id = $1").problems[0], /Name its parameters/);
});

test("a query's checks: one SELECT, every parameter declared and used, a limit, its tests, stewards", () => {
    assert.deepEqual(validateQuery(QUERY_TEMPLATE("open_lots", "Open lots", ["engineering"]), { departments: ["engineering"] }), []);
    const m = (patch) => validateQuery({ ...QUERY_TEMPLATE("q1", "Q", ["engineering"]), ...patch }, { departments: ["engineering"] }).map((p) => p.message).join("\n");
    assert.match(m({ sql: "DELETE FROM lot" }), /one SELECT/);
    assert.match(m({ sql: "SELECT 1; SELECT 2" }), /One statement only/);
    assert.match(m({ sql: "SELECT id FROM lot WHERE state = :state AND qty > :qty" }), /:qty is used but not declared/);
    assert.match(m({ params: { state: { type: "string" }, extra: { type: "integer" } } }), /extra is declared but the SELECT never uses :extra/);
    assert.match(m({ limit: 5000 }), /from 1 to 1000/);
    assert.match(m({ tests: [{ name: "t", params: {} }] }), /t: State is required/);
    assert.match(m({ stewards: ["nobody"] }), /"nobody" is not a department/);
    assert.match(m({ params: { state: { type: "text" } } }), /its type is one of/);
});

test("its footprint: its stewards, per key", () => {
    const a = QUERY_TEMPLATE("q1", "Q", ["engineering"]);
    assert.deepEqual(queryFootprint("q1", null, a), [{ element: "query:q1", change: "added", stewards: ["engineering"] }]);
    assert.deepEqual(queryFootprint("q1", a, { ...a, sql: "SELECT 1", stewards: ["quality"] }).map((e) => e.element), ["query:q1.sql", "query:q1.stewards"]);
});

test("a dropdown's options: the value column kept, display columns joined, duplicates and empties left out", () => {
    const ran = { columns: ["id", "tool_no", "family"], rows: [["a", "T1", "die"], ["b", "T2", null], ["a", "T1", "die"], [null, "T3", "die"]] };
    assert.deepEqual(optionsOf({ value: "id", display: ["tool_no", "family"] }, ran).options, [{ value: "a", label: "T1 · die" }, { value: "b", label: "T2" }]);
    assert.deepEqual(optionsOf({ value: "id", display: ["nope"] }, ran).missing, ["nope"]);
});
