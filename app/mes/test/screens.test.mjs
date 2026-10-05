// Screens (§26) without a database: the checks on a screen's definition, its footprint, its compare,
// and the record filter its blocks share with transactions. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScreen, screenFootprint, routeOf } from "../client/definition.js";
import { screenChanges, countByTab } from "../client/compare.js";
import { recordWhere } from "../server/record-where.js";
import { definitions, transactions, screens, users, groups } from "../db/seed.mjs";

const known = {
    objects: Object.fromEntries(definitions.map((d) => [d.object, { fields: d.fields, states: d.states.list }])),
    transactions: Object.fromEntries(transactions.map((t) => [t.name, { inputs: t.inputs, appearsOn: t.appearsOn }])),
    users: users.map((u) => u.id), groups: groups.map((g) => g.id), departments: ["production", "quality", "engineering"],
};
const workCentre = screens.find((s) => s.name === "work_centre");

test("the seed's screens are valid", () => {
    for (const s of screens) assert.deepEqual(validateScreen(s, known), [], s.name);
});

test("a screen's mistakes are named", () => {
    const bad = {
        ...workCentre,
        params: { a: { type: "ref", to: "machine" }, b: { type: "colour" } },
        blocks: [
            { block: "gallery", object: "lot" },
            { block: "table", object: "lot", where: { colour: "red", state: { input: "x" } }, columns: [], rowActions: ["move_in", "nope"], width: 2 },
            { block: "kpi", object: "lot", measure: { sum: "item" }, since: "yesterday" },
            { block: "breakdown", object: "lot", by: "qty" },
            { block: "record", object: "machine", show: ["colour"] },
            { block: "transaction", name: "track_out", fills: { oven: { param: "zzz" } } },
            { block: "text", text: "" },
        ],
    };
    const m = validateScreen(bad, known).map((p) => p.message).join("\n");
    for (const expected of [
        /at most one parameter/,
        /"b": a parameter is a ref, string, enum or date/,
        /Block 1: the block is one of record, table, kpi, breakdown, chart, transaction, text/,
        /Block 2: width is 3 to 12/,
        /Block 2: lot has no field "colour"/,
        /Block 2, where state: it reads input, but a screen reads param or user/,
        /Block 2: list the columns/,
        /Block 2: "nope" is not a transaction/,
        /Block 3: give the number a label/,
        /Block 3: the measure is "count", or \{ sum/,
        /Block 3: since is today, 7d, 30d/,
        /Block 4: group by a short field/,
        /Block 5: "of" says which record/,
        /Block 5: machine has no field "colour"/,
        /Block 6: track_out has no input "oven"/,
        /Block 6, oven: it reads param\.zzz, which is not a parameter/,
        /Block 7: the text, at most 2000 characters/,
    ]) assert.match(m, expected);
    // A row's transaction must appear on the table's records.
    const moveOnMachines = { ...workCentre, blocks: [{ block: "table", object: "machine", columns: ["machine_id"], rowActions: ["move_in"] }] };
    assert.match(validateScreen(moveOnMachines, known).map((p) => p.message).join("\n"), /move_in does not appear on machine records/);
});

test("footprint: only its stewards (it writes nothing); compare: block by block", () => {
    assert.deepEqual(routeOf(screenFootprint("work_centre", undefined, workCentre)).map((r) => r.department), ["production"]);
    const after = { ...workCentre, blocks: [...workCentre.blocks.slice(0, 2), { ...workCentre.blocks[2], title: "Scrap" }, ...workCentre.blocks.slice(3), { block: "text", text: "x" }] };
    assert.deepEqual(screenFootprint("work_centre", workCentre, after).map((e) => e.element), ["screen:work_centre.blocks"]);
    const changes = screenChanges(workCentre, after);
    assert.deepEqual(countByTab(changes), { blocks: 2 });
    assert.deepEqual(changes.map((c) => c.change), ["changed", "added"]);
});

test("the record filter: values, lists, nothing, and only identifiers", () => {
    const w = recordWhere("lot", { machine: "m1", state: ["processing", "processed"], scrap_reason: null }, { since: "2026-09-30T00:00:00Z" });
    // The equality decides; containment beside it is only for the index (data @> …), never instead.
    assert.equal(w.sql, "object = $1 AND archived_at IS NULL AND data->>$2 = $3 AND (data @> $4::jsonb) AND state = ANY($5::text[]) AND data->>$6 IS NULL AND updated_at >= $7");
    assert.deepEqual(w.params, ["lot", "machine", "m1", '{"machine":"m1"}', ["processing", "processed"], "scrap_reason", "2026-09-30T00:00:00Z"]);
    assert.equal(recordWhere("lot", { "x'; drop": 1 }), null);
    // A text that spells a number or yes/no may be stored as either; one that could be a list cannot be contained.
    assert.deepEqual(recordWhere("lot", { qty: ["5", "true"] }).params.slice(3), ['{"qty":"5"}', '{"qty":5}', '{"qty":"true"}', '{"qty":true}']);
    assert.ok(!recordWhere("lot", { tags: '["a"]' }).sql.includes("@>"));
});

test("lists and tables sort text with numbers in number order, empty values last", async () => {
    const { sortRows, compareValues } = await import("../client/sort.js");
    const codes = sortRows(["10", "9", "100", "OP-10", "OP-2", "", null, "2", "op-3"].map((v) => ({ v })), (r) => r.v).map((r) => r.v);
    assert.deepEqual(codes, ["2", "9", "10", "100", "OP-2", "op-3", "OP-10", "", null]);
    assert.deepEqual(sortRows([{ v: 1 }, { v: null }, { v: 3 }], (r) => r.v, "desc").map((r) => r.v), [3, 1, null]);
    assert.ok(compareValues(2, 10) < 0 && compareValues("b", "A") > 0);
});

test("filling the window: a screen's or a transaction's maximize is toggle, start or left out, and shows in its changes", async () => {
    const { validateTransaction } = await import("../client/definition.js");
    const moveIn = transactions.find((t) => t.name === "move_in");
    for (const maximize of ["toggle", "start", undefined]) {
        assert.deepEqual(validateScreen({ ...workCentre, maximize }, known), [], `screen ${maximize}`);
        assert.deepEqual(validateTransaction({ ...moveIn, maximize }, known).filter((p) => p.path === "maximize"), [], `transaction ${maximize}`);
    }
    assert.match(validateScreen({ ...workCentre, maximize: "full" }, known).map((p) => p.message).join("\n"), /maximize is "toggle"/);
    assert.match(validateTransaction({ ...moveIn, maximize: true }, known).map((p) => p.message).join("\n"), /maximize is "toggle"/);
    const changes = screenChanges({ ...workCentre, maximize: undefined }, { ...workCentre, maximize: "start" });
    assert.ok(changes.some((c) => c.label === "Fill the window" && c.tab === "general"), JSON.stringify(changes));
});

test("a pop-up and a button are checked like the rest of a screen", () => {
    const k = { ...known, screens: screens.map((s) => s.name) };
    const machineDown = screens.find((s) => s.name === "machine_down");
    assert.deepEqual(validateScreen(machineDown, k), []);
    const m = validateScreen({ ...machineDown, popup: { on: ["transaction:nope", "screen:nowhere", "lots"], for: {}, with: { record: "x" } }, blocks: [...machineDown.blocks, { block: "button", opens: "nowhere", label: "" }, { block: "transaction", name: "move_in", closeOnDone: "yes" }] }, k).map((p) => p.message).join("\n");
    for (const expected of [/"nope" is not a transaction/, /"nowhere" is not a screen/, /"lots": a page is transaction:<name>, screen:<name> or \*/, /Name whom it opens for/, /Say while what it opens/, /It reads record; a pop-up reads/, /a button's label, at most 60/, /closeOnDone is true or false/]) {
        assert.match(m, expected);
    }
    const changes = screenChanges(machineDown, { ...machineDown, popup: { ...machineDown.popup, for: { groups: ["quality"] } } });
    assert.ok(changes.some((c) => c.tab === "popup"), JSON.stringify(changes));
});

// ---- a block's conditions (§26.9) ----
test("a block is shown, and enabled, by a condition on what the screen has; its mistakes are named", async () => {
    const { validateScreen: check } = await import("../client/definition.js");
    const known = { objects: { machine: { fields: { machine_id: { type: "string" }, kind: { type: "string" } } }, lot: { fields: { machine: { type: "ref", to: "machine" }, qty: { type: "decimal" } } } }, transactions: { move_in: { inputs: { lot: {}, machine: {} } } }, users: [], groups: ["production"], departments: ["production"] };
    const screen = (blocks, params = { machine: { label: "Machine", type: "ref", to: "machine" } }) => ({ name: "station", label: "Station", params, blocks, callers: { users: [], groups: ["production"] }, stewards: ["production"] });
    const text = (extra) => ({ block: "text", text: "x", ...extra });
    const problems = (b, params) => check(screen([b], params), known).map((p) => p.message);
    for (const ok of [
        { enableWhen: { eq: [{ lookup: "machine.state" }, "idle"] }, disabledBecause: "It has a lot on it." },
        { showWhen: { contains: [{ user: "departments" }, "quality"] } },
        { showWhen: { gt: [{ count: { object: "lot", where: { machine: { param: "machine" } } } }, 0] } },
        { enableWhen: { all: [{ eq: [{ lookup: "machine.kind" }, "press"] }, { not: { is_null: { param: "machine" } } }] } },
    ]) assert.deepEqual(problems(text(ok)), [], JSON.stringify(ok));
    assert.match(problems(text({ showWhen: { eq: [{ lookup: "machine.colour" }, "red"] } })).join(), /machine has no field "colour"/);
    assert.match(problems(text({ showWhen: { eq: [{ lookup: "tool.state" }, "idle"] } })).join(), /tool is not the screen's parameter/);
    assert.match(problems(text({ showWhen: { eq: [{ lookup: "machine.state" }, "idle"] } }), { machine: { label: "M", type: "string" } }).join(), /not a record/);
    assert.match(problems(text({ showWhen: { eq: [{ input: "lot" }, 1] } })).join(), /reads param, lookup or user/);
    assert.match(problems(text({ enableWhen: { nope: 1 } })).join(), /unknown operator "nope"/);
    assert.match(problems(text({ showWhen: { gt: [{ count: { object: "pallet" } }, 0] } })).join(), /"pallet", which is not an object/);
    assert.match(problems(text({ showWhen: { gt: [{ count: { object: "lot", where: { colour: "red" } } }, 0] } })).join(), /by "colour", which is not a field/);
    assert.match(problems(text({ disabledBecause: "Never." })).join(), /nothing ever disables it/);
    assert.match(problems(text({ enableWhen: { eq: [1, 1] }, disabledBecause: "x".repeat(201) })).join(), /at most 200 characters/);
});

test("a chart block (§34.9): a query run as the viewer, a chart's spec, the screen's parameter only in a JSON query", () => {
    const withChart = (block) => validateScreen({ ...workCentre, blocks: [{ block: "chart", width: 6, ...block }] }, known).map((p) => p.message).join(" | ");
    const by = { json: { from: "lot", select: ["state", { count: "*", as: "lots" }], where: { eq: [{ field: "machine" }, { param: "machine" }] }, groupBy: ["state"] } };
    assert.equal(withChart({ query: by, chart: "bar", x: "state", y: ["lots"], marks: [{ value: 5, label: "limit", tone: "danger" }] }), "");
    assert.equal(withChart({ query: { sql: "SELECT state, count(*) AS lots FROM lot GROUP BY 1" }, chart: "donut", x: "state", y: ["lots"], title: "Lots", tab: "Now" }), "");
    assert.match(withChart({ chart: "bar", x: "state", y: ["lots"] }), /its query is \{ sql/);
    assert.match(withChart({ query: { sql: "SELECT 1 WHERE machine = {\"param\": \"machine\"}" }, chart: "bar", x: "a", y: ["b"] }), /only a JSON query names the screen's parameter/);
    assert.match(withChart({ query: by, chart: "sankey", source: "a", target: "b" }), /a sankey chart needs value/);
    assert.match(withChart({ query: by, chart: "bar", x: "state", y: ["lots"], object: "lot" }), /a chart block has no "object"/);
});
