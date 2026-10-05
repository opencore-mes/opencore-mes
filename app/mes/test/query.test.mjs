// Queries (server/query.js): the JSON compiler and the views' SQL, without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileJsonQuery, viewSql } from "../server/query.js";
import { definitions } from "../db/seed.mjs";

const schema = [{ name: "lot", columns: ["id", "state", "lot_no", "item", "qty"].map((name) => ({ name })) }];

test("a JSON query compiles to one SELECT, names checked, values as parameters", () => {
    const q = compileJsonQuery({ from: "lot", select: ["state", { count: "*", as: "lots" }, { avg: "qty" }], where: { all: [{ gt: [{ field: "qty" }, 100] }, { in: [{ field: "state" }, ["released"]] }] }, groupBy: ["state"], orderBy: [{ field: "lots", dir: "desc" }], limit: 20 }, schema);
    assert.equal(q.sql, 'SELECT "state", count(*) AS "lots", avg("qty") AS "avg_qty" FROM "lot" WHERE (("qty" > $1) AND ("state" = ANY($2))) GROUP BY "state" ORDER BY "lots" DESC');
    assert.deepEqual(q.params, [100, ["released"]]);
    assert.equal(q.limit, 20);
});

test("a JSON query cannot name what is not there, nor smuggle SQL", () => {
    assert.throws(() => compileJsonQuery({ from: "records" }, schema), /not a view/);
    assert.throws(() => compileJsonQuery({ from: "lot", select: ['qty"; DROP TABLE x; --'] }, schema), /not a column/);
    assert.throws(() => compileJsonQuery({ from: "lot", select: [{ count: "*", as: "n; drop" }] }, schema), /not a name/);
    assert.throws(() => compileJsonQuery({ from: "lot", where: { raw: "1=1" } }, schema), /not an operator/);
    assert.throws(() => compileJsonQuery({ from: "lot", limit: 1e9 }, schema), /limit is/);
    const q = compileJsonQuery({ from: "lot", where: { eq: [{ field: "lot_no" }, "'; DROP TABLE x; --"] } }, schema);
    assert.ok(!q.sql.includes("DROP"), "a value is a parameter, never text in the SQL");
});

test("each object's view reads mes.records with its policies compiled in, and its stays", () => {
    const lot = definitions.find((d) => d.object === "lot");
    const [view, stays] = viewSql(lot);
    assert.match(view, /^CREATE VIEW q\."lot" AS SELECT/);
    assert.match(view, /r\.object = 'lot'/);
    assert.match(view, /c\.txid = txid_current\(\)/, "the viewer comes from this transaction's context");
    assert.match(view, /'\{operator,supervisor,quality,viewer\}'|ARRAY\['operator', 'supervisor', 'quality', 'viewer'\]/);
    assert.match(stays, /^CREATE VIEW q\."lot_stays"/);
});
