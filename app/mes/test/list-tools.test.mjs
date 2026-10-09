// A designer tab's search, filters and order (client/list-tools.js). `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyListTools, stewardFilter, openFilter, designSorts, optionsOf } from "../client/list-tools.js";

const flows = [
    { name: "molding_route", label: "Molding route", kind: "route", object: "lot", version: 3, stewards: ["production"], open: [] },
    { name: "deviation_response", label: "Deviation response", kind: "plan", object: "deviation", version: 10, stewards: ["quality"], open: ["c1"] },
    { name: "pm_plan", label: "Preventive maintenance", kind: "plan", object: "machine", version: 2, stewards: ["production"], open: [] },
];
const kind = { id: "kind", label: "Kind", options: [], test: (x, v) => x.kind === v };
const filters = [kind, stewardFilter(() => []), openFilter];
const run = (opts) => applyListTools(flows, { text: (x) => [x.name, x.label, x.object], filters, sorts: designSorts(), ...opts }).map((x) => x.name);

test("search: every word somewhere, in any order, case aside", () => {
    assert.deepEqual(run({ q: "RESPONSE dev" }), ["deviation_response"]);
    assert.deepEqual(run({ q: "machine" }), ["pm_plan"]);
    assert.deepEqual(run({ q: "nothing like it" }), []);
});
test("filters: each set one narrows; an empty one is any", () => {
    assert.deepEqual(run({ values: { kind: "plan" } }), ["deviation_response", "pm_plan"]);
    assert.deepEqual(run({ values: { kind: "plan", steward: "production" } }), ["pm_plan"]);
    assert.deepEqual(run({ values: { open: "yes" } }), ["deviation_response"]);
    assert.deepEqual(run({ values: { open: "no", kind: "" } }), ["molding_route", "pm_plan"]);
});
test("order: by name first; by version as numbers; descending; open changes first", () => {
    assert.deepEqual(run({}), ["deviation_response", "molding_route", "pm_plan"]);
    assert.deepEqual(run({ sort: "version" }), ["pm_plan", "molding_route", "deviation_response"]);
    assert.deepEqual(run({ sort: "version", desc: true }), ["deviation_response", "molding_route", "pm_plan"]);
    assert.equal(run({ sort: "open" })[0], "deviation_response");
    assert.deepEqual(optionsOf(flows, (x) => x.object), [["deviation", "deviation"], ["lot", "lot"], ["machine", "machine"]]);
});
