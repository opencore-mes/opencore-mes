// The equipment-adapter 1.0 conformance kit (docs/contracts/equipment-adapter, DESIGN.md §31.4, §31.6),
// without a database: the reference adapter passes every step, and an adapter that breaks the contract
// is caught where it breaks it. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runKit, KIT_TOOL_TYPE } from "../../../docs/contracts/equipment-adapter/kit.mjs";
import fixture from "../../../docs/contracts/equipment-adapter/reference/fixture.mjs";

const failed = (result) => result.steps.filter((s) => !s.ok).map((s) => s.name);

test("the reference adapter conforms, step by step", async () => {
    const result = await runKit(fixture, { timeoutMs: 3000, reconnectMs: 3000 });
    assert.equal(result.contract, "equipment-adapter@1.0");
    assert.equal(result.adapter, "memory");
    assert.deepEqual(failed(result), []);
    assert.ok(result.steps.length >= 25, `${result.steps.length} steps`);
    assert.ok(result.ok);
});

test("an adapter that breaks the contract is caught where it breaks it", async () => {
    // Its units unconverted, and an event emitted after stop().
    const broken = {
        ...fixture.adapter,
        connect(machine, hooks) {
            const session = fixture.adapter.connect({ ...machine, mapping: { ...machine.mapping, variables: { ...machine.mapping.variables, temp_k: { as: "Temperature", units: "K" } } } }, hooks);
            return { ...session, async stop() { await session.stop(); setTimeout(() => hooks.emit({ kind: "event", code: "late", name: "Started", values: {} }), 100); } };
        },
    };
    const result = await runKit({ ...fixture, adapter: broken }, { timeoutMs: 1500, reconnectMs: 1500 });
    assert.equal(result.ok, false);
    assert.deepEqual(failed(result), ["status: Temperature in degC (the tool reports 300 K)", "nothing emitted after stop()"]);
});

test("an adapter for another major version, or with no check, stops at the module", async () => {
    const result = await runKit({ ...fixture, adapter: { ...fixture.adapter, contract: "2.0", check: undefined } });
    assert.deepEqual(failed(result), ["the module: name, label, contract, serves, check, connect"]);
    assert.match(result.steps[0].detail, /contract: "1\.0".*check: a function/);
});

test("the contract is written twice: for people and for machines", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../docs/contracts/equipment-adapter/schema.json", import.meta.url), "utf8"));
    assert.deepEqual(schema["x-contract"], { name: "equipment-adapter", version: "1.0" });
    assert.deepEqual(schema["x-module"].required, ["name", "label", "contract", "serves", "check", "connect"]);
    const spec = readFileSync(new URL("../../../docs/contracts/equipment-adapter/README.md", import.meta.url), "utf8");
    for (const word of ["`check(mapping, { toolType })`", "`connect(machine, hooks)`", "`status(names, { module? })`", "A command is sent once"]) assert.ok(spec.includes(word), word);
    assert.deepEqual(Object.keys(KIT_TOOL_TYPE.commands), ["START", "STOP"]);
});
