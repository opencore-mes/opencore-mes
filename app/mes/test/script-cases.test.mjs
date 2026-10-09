// A dry run saved as a test case (integration-editor.js caseFrom): what the case keeps of the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { caseFrom } from "../client/integration-editor.js";

test("a flow node script's case expects what the script did, not who ran it or when", () => {
    const given = { event: { kind: "enter", node: "done" }, context: { lot: { id: "l1" } }, writes: [] };
    const r = { ok: true, output: { ...given, writes: [{ record: "lot", action: "complete" }], as: "dana", now: "2026-10-08T03:00:00.000Z" } };
    const c = caseFrom("plain", "completes the lot", given, r, "dana", "dana");
    assert.deepEqual(c.expect, { output: { event: given.event, context: given.context, writes: [{ record: "lot", action: "complete" }] } });
    // The time it ran at goes into its input: a script that reads ctx.now gives the same output again.
    assert.equal(c.run.now, "2026-10-08T03:00:00.000Z");
    assert.equal(c.expect.output.as, undefined);
});

test("an input that names its own time keeps it", () => {
    const given = { now: "2026-01-01T00:00:00.000Z", writes: [] };
    const c = caseFrom("plain", "keeps its time", given, { ok: true, output: { writes: [], now: "2026-10-08T03:00:00.000Z" } }, "dana", "dana");
    assert.equal(c.run.now, "2026-01-01T00:00:00.000Z");
});

test("a refusal is expected as one", () => {
    const c = caseFrom("plain", "refuses", { writes: [] }, { ok: false, error: { message: "No lot" } }, "dana", "dana");
    assert.deepEqual(c.expect, { throws: { message: "No lot" } });
});
