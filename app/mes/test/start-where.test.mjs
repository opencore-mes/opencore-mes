// What a route's start asks of its traveler, as fields (startWhere): the sandbox's "What a route needs"
// offers those travelers, naming no object of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startWhere } from "../server/sandbox.js";

const body = { fields: { route: { type: "string" }, item: { type: "string" }, qty: { type: "integer" } } };

test("an eq on the traveler's own field, either way round, and several under all", () => {
    assert.deepEqual(startWhere({ eq: [{ context: "record_1.route" }, "cmos_route"] }, "record_1", body), { route: ["cmos_route"] });
    assert.deepEqual(startWhere({ eq: ["PP", { context: "lot.item" }] }, "lot", body), { item: ["PP"] });
    assert.deepEqual(startWhere({ all: [{ eq: [{ context: "lot.item" }, "PP"] }, { in: [{ context: "lot.route" }, ["a", "b"]] }] }, "lot", body), { item: ["PP"], route: ["a", "b"] });
});

test("anything else asks for nothing: another record's field, a field it does not have, an or, no start condition", () => {
    assert.deepEqual(startWhere({ eq: [{ context: "product.route" }, "x"] }, "lot", body), {});
    assert.deepEqual(startWhere({ eq: [{ context: "lot.colour" }, "red"] }, "lot", body), {});
    assert.deepEqual(startWhere({ any: [{ eq: [{ context: "lot.item" }, "PP"] }] }, "lot", body), {});
    assert.deepEqual(startWhere(undefined, "lot", body), {});
});
