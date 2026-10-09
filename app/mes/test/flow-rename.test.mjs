// A flow template's node and participant renamed in the designer (renameFlowNode, renameFlowParticipant):
// everything of the template that names them follows; a taken or bad name is refused in words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renameFlowNode, renameFlowParticipant, validateFlow } from "../client/definition.js";

const body = () => ({
    name: "press_route", label: "Press route", kind: "route",
    participants: { record_1: { object: "lot", as: "traveler" }, record_2: { object: "product", as: "reference", from: "record_1.product" } },
    context: { max_scrap: 5 },
    ends: { when: { in: [{ context: "record_1.state" }, ["consumed"]] } },
    nodes: {
        start: { kind: "start", label: "Start", when: { eq: [{ context: "record_1.item" }, "PP"] } },
        sequence_1: { kind: "sequence", label: "Press", offers: ["move_in"], onEnter: "press_enter" },
        auto_decision_1: { kind: "auto_decision", label: "Scrap?" },
        end_1: { kind: "end", label: "Done" },
    },
    edges: [{ from: "start", to: "sequence_1" }, { from: "sequence_1", to: "auto_decision_1" }, { from: "auto_decision_1", to: "end_1", when: { gt: [{ context: "record_1.scrap_qty" }, { context: "max_scrap" }] } }, { from: "auto_decision_1", to: "end_1" }],
    layout: { start: { x: 0, y: 0 }, sequence_1: { x: 200, y: 0 } },
    scenarios: [{ name: "s", steps: [{ as: "olga", do: { transaction: "move_in" }, expect: { node: { record_1: "sequence_1" } } }] }],
});

test("a node renamed: its key, place, wires and the scenarios expecting it, in order", () => {
    const { body: out, problem } = renameFlowNode(body(), "sequence_1", "press");
    assert.equal(problem, undefined);
    assert.deepEqual(Object.keys(out.nodes), ["start", "press", "auto_decision_1", "end_1"]);
    assert.deepEqual(out.layout.press, { x: 200, y: 0 });
    assert.equal(out.layout.sequence_1, undefined);
    assert.deepEqual(out.edges.slice(0, 2).map((e) => [e.from, e.to]), [["start", "press"], ["press", "auto_decision_1"]]);
    assert.equal(out.scenarios[0].steps[0].expect.node.record_1, "press");
    assert.deepEqual(validateFlow(out).filter((p) => /from and to are nodes|no way leads/.test(p.message)), []);
});

test("a node renamed to a taken id or a bad one is refused, the body untouched", () => {
    const b = body();
    assert.match(renameFlowNode(b, "sequence_1", "end_1").problem, /another node's id/);
    assert.match(renameFlowNode(b, "sequence_1", "Press Step").problem, /lower case letters/);
    assert.match(renameFlowNode(b, "nope", "x").problem, /no node nope/);
    assert.ok(b.nodes.sequence_1);
});

test("a participant renamed: conditions, the ends, another's from and the scenarios follow; its scripts named to check", () => {
    const { body: out, scripts } = renameFlowParticipant(body(), "record_1", "lot");
    assert.deepEqual(Object.keys(out.participants), ["lot", "record_2"]);
    assert.equal(out.participants.record_2.from, "lot.product");
    assert.deepEqual(out.nodes.start.when, { eq: [{ context: "lot.item" }, "PP"] });
    assert.deepEqual(out.edges[2].when, { gt: [{ context: "lot.scrap_qty" }, { context: "max_scrap" }] });
    assert.deepEqual(out.ends.when.in[0], { context: "lot.state" });
    assert.deepEqual(out.scenarios[0].steps[0].expect.node, { lot: "sequence_1" });
    assert.deepEqual(scripts, ["press_enter"]);
});

test("a participant renamed onto another record or a context value is refused", () => {
    assert.match(renameFlowParticipant(body(), "record_1", "record_2").problem, /already/);
    assert.match(renameFlowParticipant(body(), "record_1", "max_scrap").problem, /already/);
    assert.match(renameFlowParticipant(body(), "record_1", "1lot").problem, /lower case letters/);
});
