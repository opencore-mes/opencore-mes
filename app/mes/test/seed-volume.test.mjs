// The demo's volume (seed.mjs volume(), SEED_VOLUME): records the lot's own design would accept, the
// same every time. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { definitions, scripts, volume } from "../db/seed.mjs";
import { validate } from "../server/services.js";
import { runRules } from "../server/rules.js";

const lot = definitions.find((d) => d.object === "lot");
const order = definitions.find((d) => d.object === "work_order");

test("none unless asked; asked, 100 lots over a dozen work orders, the same every time", () => {
    assert.deepEqual(volume(), []);
    assert.deepEqual(volume(0), []);
    const records = volume(100);
    assert.equal(records.filter((r) => r.object === "lot").length, 100);
    assert.equal(records.filter((r) => r.object === "work_order").length, 12);
    assert.deepEqual(volume(100), records, "a fixed sequence, no randomness");
    assert.equal(new Set(records.filter((r) => r.object === "lot").map((r) => r.data.lot_no)).size, 100, "lot numbers are unique");
    const states = new Set(records.filter((r) => r.object === "lot").map((r) => r.state));
    assert.deepEqual([...states].sort(), ["consumed", "created", "in_process", "on_hold", "released"]);
});

test("every one passes its object's checks and its rule pipe on save", async () => {
    const records = volume(100);
    const byKey = new Map(records.map((r) => [r.key, r]));
    const published = new Map(Object.entries(scripts).map(([name, source]) => [name, { version: 1, source }]));
    for (const r of records) {
        const def = r.object === "lot" ? lot : order;
        assert.ok(def.states.list.includes(r.state), `${r.key}: ${r.state}`);
        const data = { ...r.data, work_order: r.data.work_order ? "00000000-0000-0000-0000-000000000001" : undefined };
        if (r.object !== "lot") { assert.equal(validate(def, data, { state: r.state }), null, r.key); continue; }
        assert.equal(validate(def, data, { state: r.state }), null, `${r.key}: ${JSON.stringify(validate(def, data, { state: r.state }))}`);
        const wo = byKey.get(r.data.work_order.slice(1));
        const outcome = await runRules({
            definition: def, scripts: published,
            ctx: { event: { kind: "save", object: "lot", changed: Object.keys(data) }, user: { id: "seed" }, record: { state: r.state }, data, now: new Date().toISOString() },
            lookup: async () => ({ id: "x", ...wo.data }),
        });
        assert.equal(outcome.error, null, `${r.key} (${r.data.qty} of ${wo.data.qty}): ${JSON.stringify(outcome.error)}`);
    }
});
