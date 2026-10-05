// Scenarios (§5.11) without a database: their shape, and what a step's outcome lacks of what it
// expects. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarioProblems } from "../client/definition.js";
import { verdict } from "../server/sandbox.js";
import { definitions, transactions, users } from "../db/seed.mjs";

const known = { objects: Object.fromEntries(definitions.map((d) => [d.object, { fields: d.fields, states: d.states.list }])), users: users.map((u) => u.id) };
const moveIn = transactions.find((t) => t.name === "move_in");
const good = { name: "a lot onto a press", records: { lot: { object: "lot", where: { state: ["created"] } }, press: { object: "machine", data: { machine_id: "P", name: "P", kind: "press", capacity: 1 }, state: "idle" } }, steps: [{ as: "olga", do: { transaction: "move_in", input: { lot: "@lot", machine: "@press" } }, expect: { ok: true, states: { lot: "at_machine" } } }] };

test("a scenario's shape: a good one passes; each mistake is named", () => {
    assert.deepEqual(scenarioProblems({ ...moveIn, scenarios: [good] }, known), []);
    const bad = [
        { ...good, name: "" },
        { ...good, name: "twice" }, { ...good, name: "twice" },
        { ...good, name: "x", records: { "Lot": { object: "nope" } } },
        { ...good, name: "y", records: { lot: { object: "lot", state: "flying" } } },
        { ...good, name: "z", steps: [{ as: "ghost", do: { transaction: "move_in", action: "hold" } }] },
        { ...good, name: "w", steps: [{ do: { transaction: "move_in", input: { lot: "@missing" } }, expect: { states: { other: "x" } } }] },
        { ...good, name: "v", steps: [{ do: { action: "hold", record: "@lot" } }] },
    ];
    const words = scenarioProblems({ ...moveIn, scenarios: bad }, known).join("\n");
    for (const m of [/give it a name/, /two scenarios have this name/, /"Lot": a record's key/, /"nope" is not an object/, /lot has no state "flying"/, /it does one of transaction/, /"@missing" names no record/, /expects something of "other"/, /none of its steps runs move_in/]) assert.match(words, m);
});

test("a step's outcome against what it expects, in words", () => {
    const out = { ok: true, error: null, states: { lot: "at_machine", press: "loaded" }, data: { lot: { qty: 5 } }, created: { deviation: 1 } };
    assert.deepEqual(verdict({ ok: true, states: { lot: "at_machine" }, fields: { lot: { qty: 5 } }, created: { deviation: 1 } }, out), []);
    assert.deepEqual(verdict(undefined, out), []);
    assert.match(verdict({ ok: false }, out).join(), /it ran, but it was expected to be refused/);
    assert.match(verdict({ states: { press: "running" } }, out).join(), /press is loaded, expected running/);
    assert.match(verdict({ created: { deviation: 3 } }, out).join(), /1 deviation created, expected 3/);
    const refused = { ok: false, error: "The machine is full.", states: {} };
    assert.deepEqual(verdict({ ok: false, error: "full" }, refused), []);
    assert.match(verdict({ ok: true }, refused).join(), /it was refused: The machine is full/);
    assert.match(verdict({ ok: false, error: "down" }, refused).join(), /expected the words "down"/);
});
