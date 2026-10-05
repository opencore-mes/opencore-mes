// Analytics, phase 1 (server/analytics.js, client/analytics.js), without a database. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { intervalsFromAudit, dimsOf } from "../server/analytics.js";
import { formatDuration } from "../client/analytics.js";

const at = (h) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();

test("a record's stays, rebuilt from its audit rows, with the dimensions it had when each began", () => {
    const rows = [
        { at: at(0), actor: "olga", action: "create", after: { item: "A", qty: 1, state: "created" } },
        { at: at(1), actor: "olga", action: "update", before: { item: "A" }, after: { item: "B" } },
        { at: at(2), actor: "olga", action: "transition:start", before: { state: "created" }, after: { state: "in_process" } },
        { at: at(3), actor: "olga", action: "rejected:action:hold", after: {} },
        { at: at(5), actor: "sam", action: "transition:hold", before: { state: "in_process" }, after: { state: "on_hold" } },
        { at: at(6), actor: "sam", action: "archive", before: {}, after: {} },
        { at: at(9), actor: "sam", action: "restore", before: {}, after: {} },
    ];
    const stays = intervalsFromAudit(rows, ["item"]);
    assert.deepEqual(stays.map((s) => [s.state, s.enter_action, s.leave_action, s.dims.item]), [
        ["created", "create", "start", "A"],
        ["in_process", "start", "hold", "B"],
        ["on_hold", "hold", "archive", "B"],
        ["on_hold", "restore", null, "B"],
    ]);
    assert.equal(stays[0].left_at, at(2));
    assert.equal(stays[2].left_by, "sam");
    assert.equal(stays[3].left_at, null, "the stay after a restore is open");
});

test("dimensions copy plain values only", () => {
    assert.deepEqual(dimsOf({ analytics: { dimensions: ["item", "qty", "meta", "missing"] } }, { item: "A", qty: 3, meta: { x: 1 } }), { item: "A", qty: 3 });
    assert.deepEqual(dimsOf({}, { item: "A" }), {});
});

test("durations read as people say them", () => {
    assert.equal(formatDuration(12), "12 s");
    assert.equal(formatDuration(45 * 60), "45 min");
    assert.equal(formatDuration(2 * 3600 + 5 * 60), "2 h 05 min");
    assert.equal(formatDuration(3 * 86400 + 4 * 3600 + 59), "3 d 4 h");
    assert.equal(formatDuration(null), "—");
});
