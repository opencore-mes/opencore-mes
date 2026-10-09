// Named queries as a reference's choices and a screen's rows (DESIGN.md §23.1): what each design names of a query,
// checked against the query's parameters and the columns it gives; and every place a query is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { querySourceProblems, queryUses, queryUseProblems, validateScreen, QUERY_SCOPES } from "../client/definition.js";
import { namesIn } from "../client/query-def.js";

const known = {
    queries: { tools: { label: "Tools of a kind", sql: "SELECT id, tool_id, area FROM tool WHERE area = :area", params: { area: { type: "string", required: true } } } },
    queryColumns: { tools: ["id", "tool_id", "area"] },
};

test("a reference's choices: the query there is, its required parameters bound, reading what the form may, its id and display columns given", () => {
    assert.deepEqual(querySourceProblems({ query: "tools", display: ["tool_id"], params: { area: { data: "area" } } }, known, QUERY_SCOPES.form), []);
    const w = (src, scopes = QUERY_SCOPES.form) => querySourceProblems(src, known, scopes).join("\n");
    assert.match(w({ query: "nope" }), /"nope" is not a query/);
    assert.match(w({ query: "tools" }), /needs area: bind it/);
    assert.match(w({ query: "tools", params: { area: { input: "kind" } } }), /area reads input: here a query's parameters read data, record, user/);
    assert.match(w({ query: "tools", params: { area: "x", family: "y" } }), /tools has no parameter "family"/);
    assert.match(w({ query: "tools", display: ["name"], params: { area: "x" } }), /uses "name", which tools does not give \(it gives id, tool_id, area\)/);
    assert.match(w({ query: "tools", params: { area: "x" }, sort: "a" }), /have no "sort"/);
    assert.equal(w({ query: "tools", params: { area: { input: "kind" } } }, QUERY_SCOPES.transaction), "", "a transaction's reads its inputs");
});

test("a screen's table of a query's rows: its columns, sort and row buttons checked against what the query gives", () => {
    const screen = (b) => ({ name: "s", label: "S", params: { machine: { type: "ref", to: "machine" } }, blocks: [{ block: "table", ...b }], callers: { users: [], groups: ["production"] }, stewards: ["production"] });
    const k = { ...known, groups: ["production"], objects: { tool: { fields: {} }, machine: { fields: {} } }, transactions: { fix: { appearsOn: { object: "tool" } }, other: { appearsOn: { object: "lot" } } } };
    const w = (b) => validateScreen(screen(b), k).map((p) => p.message).join("\n");
    assert.equal(w({ query: "tools", params: { area: "etch" }, columns: ["tool_id"], object: "tool", rowActions: ["fix"] }), "");
    assert.match(w({ query: "tools", params: { area: "etch" }, columns: ["name"] }), /its columns uses "name", which tools does not give/);
    assert.match(w({ query: "tools", params: { area: "etch" }, rowActions: ["fix"] }), /row buttons need the object/);
    assert.match(w({ query: "tools", params: { area: "etch" }, object: "tool", rowActions: ["other"] }), /other does not appear on tool records/);
    assert.match(w({ query: "tools", params: { area: { data: "x" } } }), /area reads data: here a query's parameters read param, user/);
    assert.match(w({ query: "tools", params: { area: { param: "lot" } } }), /reads param.lot, which is not the screen's parameter/);
    assert.match(w({ query: "tools", params: { area: "etch" }, where: { area: "x" } }), /has no "where": its query says which rows/);
});

test("every place a query is used, live or drafted, each with what of it it names; a use is checked as its own design would be", () => {
    const uses = queryUses({
        definitions: { lot: { label: "Lot", fields: { tool: { label: "Tool", type: "ref", to: "tool", options: { query: "tools", display: ["tool_id"], params: { area: "etch" } } } } } },
        transactions: { move: { label: "Move", inputs: { tool: { label: "Tool", type: "ref", to: "tool", options: { query: "tools", params: { area: { input: "area" } } } } } } },
        screens: { board: { label: "Board", blocks: [{ block: "table", title: "Etch", query: "tools", params: { area: "etch" }, columns: ["tool_id", "gone"], sort: { field: "area" } }] } },
        flows: { ocap: { label: "OCAP", nodes: { pick: { label: "Pick", fields: [{ name: "t", label: "Tool", type: "query", query: "tools", value: "id", display: ["tool_id"], params: { area: { context: "area" } } }] } } } },
    });
    assert.deepEqual(uses.map((u) => `${u.kind}:${u.name}:${u.columns.join("+")}`), ["object:lot:id+tool_id", "transaction:move:id", "screen:board:tool_id+gone+area", "flow:ocap:id+tool_id"]);
    assert.deepEqual(uses.map((u) => queryUseProblems(u, known).length), [0, 0, 1, 0]);
    assert.match(queryUseProblems(uses[2], known)[0], /its columns uses "gone"/);
});

test("the names a query's text reads: outside its strings and comments, bare ones lower-cased", () => {
    const n = namesIn(`SELECT id, Machine_ID AS label -- the kind
        FROM machine /* only presses */ WHERE kind = 'press''s' AND "Odd Name" IS NULL`);
    assert.ok(n.has("machine") && n.has("machine_id") && n.has("kind") && n.has("Odd Name"));
    assert.ok(!n.has("press") && !n.has("only") && !n.has("the"), "strings and comments read nothing");
});
