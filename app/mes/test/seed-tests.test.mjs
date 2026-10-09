// The seed's rule scripts carry their evidence (seed.mjs tests, fitness.js): every script an object's rule
// pipe names has test cases, each { name, run, expect }, so a copy of the object (which carries them, §37's
// first course copies Lot) passes the fitness test as it is. Whether each case holds is run on a server:
// the fitness test, and POST /ai/v1/scripts/{name}/test. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { definitions, tests } from "../db/seed.mjs";

test("every script in a seeded rule pipe has test cases, each a name, a run and an expectation", () => {
    const piped = [...new Set(definitions.flatMap((d) => (d.rules ?? []).map((r) => r.script)))];
    assert.ok(piped.length >= 8);
    for (const name of piped) {
        assert.ok(Array.isArray(tests[name]) && tests[name].length > 0, `${name} has no test cases`);
        for (const c of tests[name]) {
            assert.ok(typeof c.name === "string" && c.name.trim(), `${name}: a case without a name`);
            assert.ok(c.run && typeof c.run.event?.kind === "string", `${name} / ${c.name}: run.event.kind`);
            assert.ok(c.expect && (c.expect.throws || Array.isArray(c.expect.changed)), `${name} / ${c.name}: expects a refusal or what it changes`);
        }
        assert.ok(tests[name].some((c) => c.expect.throws) || tests[name].some((c) => c.expect.changed?.length), `${name}: no case shows what it does`);
    }
});
