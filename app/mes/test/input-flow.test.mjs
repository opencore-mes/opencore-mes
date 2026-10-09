// Input flows (§32.13, input-flow.js): how one is walked, what moves on from an ask, and what the
// designer is told about a flow, and about the transactions and screens that name it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepFrom, advances, entryComplete, inputFlowSummary, inputScope } from "../client/input-flow.js";
import { validateFlow, validateTransaction, validateScreen, explainFlow } from "../client/definition.js";

const flow = () => ({
    name: "scan_move_in", label: "Scan to move in", kind: "input", stewards: ["production"],
    nodes: {
        start: { kind: "start", label: "Start" },
        lot: { kind: "ask", label: "Scan the lot", input: "lot" },
        held: { kind: "auto_decision", label: "On hold?" },
        why: { kind: "ask", label: "Why", input: "reason", advance: "key", key: "F2" },
        qty: { kind: "fill", label: "Its quantity", input: "good_qty", value: { lookup: "lot.qty" } },
        good: { kind: "ask", label: "Good", input: "good_qty", advance: "tab" },
        run: { kind: "run", label: "Check and confirm", confirm: "auto" },
        done: { kind: "end", label: "Next" },
    },
    edges: [
        { from: "start", to: "lot" }, { from: "lot", to: "held" },
        { from: "held", to: "why", when: { eq: [{ lookup: "lot.state" }, "on_hold"] } }, { from: "held", to: "qty" },
        { from: "why", to: "run" }, { from: "qty", to: "good" }, { from: "good", to: "run" }, { from: "run", to: "done" },
    ],
});

test("walked: the first ask, then on through decisions and fills, to the run and the end", () => {
    const f = flow();
    const filled = (scope) => (input) => scope.input[input] !== undefined && scope.input[input] !== null;
    let scope = { input: {}, lookup: {} };
    assert.equal(stepFrom(f, null, scope).id, "lot");
    // A lot that runs: its quantity filled in, then asked (it is filled, but its ask says skip only when filled before).
    scope = { input: { lot: "L1" }, lookup: { lot: { state: "waiting", qty: 25 } } };
    const after = stepFrom(f, "lot", scope);
    assert.equal(after.id, "good");
    assert.deepEqual(after.fills, [{ input: "good_qty", value: 25 }]);
    // An ask whose input is filled already is passed over (skipIfFilled, the default).
    const passed = stepFrom(f, "lot", scope, { filled: (input) => input === "good_qty" });
    assert.equal(passed.id, "run");
    // A lot on hold: why it is, instead.
    assert.equal(stepFrom(f, "lot", { input: { lot: "L2" }, lookup: { lot: { state: "on_hold" } } }).id, "why");
    assert.equal(stepFrom(f, "run", scope).id, "done");
    // A decision with no way to take is said.
    const stuck = flow();
    stuck.edges = stuck.edges.filter((e) => !(e.from === "held" && e.when === undefined));
    assert.match(stepFrom(stuck, "lot", { input: {}, lookup: { lot: { state: "waiting" } } }).error, /none of its conditions holds/);
    void filled;
});

test("what moves on from an ask: Enter by default, Tab, a key of its own, or by itself once complete", () => {
    const key = (k, extra = {}) => ({ key: k, ...extra });
    assert.ok(advances({}, key("Enter")));
    assert.ok(!advances({}, key("Tab")));
    assert.ok(advances({ advance: "tab" }, key("Tab")));
    assert.ok(!advances({ advance: "tab" }, key("Tab", { shiftKey: true })));
    assert.ok(advances({ advance: "enter_or_tab" }, key("Tab")) && advances({ advance: "enter_or_tab" }, key("Enter")));
    assert.ok(advances({ advance: "key", key: "F2" }, key("F2")) && !advances({ advance: "key", key: "F2" }, key("Enter")));
    assert.ok(advances({ advance: "key", key: "*" }, key("*")));
    assert.ok(!advances({}, key("Enter", { ctrlKey: true })));
    assert.ok(entryComplete({ length: 11 }, "LOT2030HZ-Y") && !entryComplete({ length: 11 }, "LOT2030"));
    assert.ok(entryComplete({ pattern: "LOT\\d{4}[A-Z]{2}-[A-Z]" }, "LOT2030HZ-Y") && !entryComplete({ pattern: "LOT\\d{4}" }, "LOT20301"));
    assert.ok(advances({ advance: "auto", length: 3 }, key("Enter"), { complete: true }));
});

test("an input flow's own problems: its steps, its keys, no records, no scripts", () => {
    assert.deepEqual(validateFlow(flow(), {}).map((p) => p.message), []);
    const bad = flow();
    bad.participants = { lot: { object: "lot", as: "traveler" } };
    bad.nodes.lot.advance = "key";
    bad.nodes.lot.key = "x";
    bad.nodes.why.onEnter = "some_script";
    bad.nodes.qty.value = { context: "lot.qty" };
    bad.nodes.good.length = 4;
    bad.nodes.run.confirm = "later";
    bad.nodes.done.then = "again";
    bad.nodes.extra = { kind: "sequence", label: "A step", offers: [], leaves: [] };
    bad.edges.push({ from: "done", to: "extra" });
    const words = validateFlow(bad, {}).map((p) => p.message).join("\n");
    for (const m of [/takes no records part/, /F1 to F12, or one character/, /run no scripts/, /an input flow reads its inputs/, /a length or a pattern is for advance "auto"/, /confirm is "ask"/, /then is "repeat"/, /a sequence belongs to a route, not an input flow/, /nothing leaves an end/]) assert.match(words, m);
    assert.match(explainFlow(flow()), /input flow/);
    assert.match(explainFlow(flow()), /Why: the cursor to reason, on by the F2 key/);
});

const tx = (extra = {}) => ({
    name: "move_in", label: "Move in", stewards: ["production"], callers: { groups: ["production"] },
    inputs: { lot: { type: "ref", to: "lot", required: true }, machine: { type: "ref", to: "machine" }, qty: { type: "decimal", from: "lot.qty" } },
    steps: [], ...extra,
});
const known = { objects: { lot: { fields: { qty: { type: "decimal" } }, actions: [] }, machine: { fields: {}, actions: [] } }, groups: ["production"], departments: ["production"], inputFlows: {} };

test("a transaction names an input flow that asks for its own inputs", () => {
    const k = { ...known, inputFlows: { good: inputFlowSummary({ kind: "input", nodes: { a: { kind: "ask", input: "lot" }, b: { kind: "ask", input: "machine" }, r: { kind: "run" } } }), bad: inputFlowSummary({ kind: "input", nodes: { a: { kind: "ask", input: "lot" }, b: { kind: "ask", input: "qty" }, c: { kind: "ask", input: "tool" }, d: { kind: "ask", input: "param" }, r: { kind: "run", transaction: "track_in" } } }) } };
    const of = (b) => validateTransaction(b, k).filter((p) => p.path === "inputFlow").map((p) => p.message);
    assert.deepEqual(of(tx({ inputFlow: "good" })), []);
    const words = of(tx({ inputFlow: "bad" })).join("\n");
    assert.match(words, /qty is filled in from lot.qty: nobody types it/);
    assert.match(words, /"tool" is not an input of this transaction/);
    assert.match(words, /a transaction's input flow names its inputs alone/);
    assert.match(words, /runs that transaction, not track_in/);
    assert.match(of(tx({ inputFlow: "nope" })).join(""), /"nope" is not an input flow/);
});

test("a screen names an input flow over its parameter and its transaction blocks", () => {
    const k = { ...known, transactions: { move_in: { inputs: tx().inputs }, track_in: { inputs: { lot: { type: "ref", to: "lot" } } } }, inputFlows: {
        station: inputFlowSummary({ kind: "input", nodes: { p: { kind: "ask", input: "param" }, a: { kind: "ask", input: "move_in.lot" }, r: { kind: "run", transaction: "move_in" } } }),
        loose: inputFlowSummary({ kind: "input", nodes: { a: { kind: "ask", input: "lot" }, r: { kind: "run" } } }),
    } };
    const screen = (blocks, extra = {}) => ({ name: "station", label: "Station", stewards: ["production"], callers: { groups: ["production"] }, params: { machine: { type: "ref", to: "machine" } }, blocks, ...extra });
    const two = [{ block: "transaction", name: "move_in", tab: "Move in" }, { block: "transaction", name: "track_in", tab: "Track in" }];
    const of = (b) => validateScreen(b, k).filter((p) => p.path === "inputFlow").map((p) => p.message);
    assert.deepEqual(of(screen(two, { inputFlow: "station" })), []);
    const words = of(screen(two, { inputFlow: "loose" })).join("\n");
    assert.match(words, /several transactions \(move_in, track_in\): name which, "<transaction>.lot"/);
    assert.match(words, /say which it runs/);
    // One transaction block: its inputs by name alone.
    assert.deepEqual(of(screen([two[0]], { inputFlow: "loose" })), []);
    assert.match(of(screen([two[1]], { inputFlow: "station" })).join("\n"), /move_in is not a transaction block of this screen/);
    assert.match(of({ ...screen(two, { inputFlow: "station" }), params: {} }).join("\n"), /the screen has no parameter/);
});

test("a screen's decision on one of its transactions' inputs ({ input: \"<transaction>.<input>\" }) reads it, asked or filled on the way", () => {
    const f = {
        nodes: {
            start: { kind: "start" }, condition: { kind: "ask", input: "take_in.condition" }, damaged: { kind: "auto_decision" },
            symptom: { kind: "ask", input: "take_in.symptom" }, good: { kind: "run", transaction: "take_in" }, flag: { kind: "fill", input: "take_in.note", value: "seen" },
            noted: { kind: "auto_decision" }, bad: { kind: "end" }, odd: { kind: "end" },
        },
        edges: [
            { from: "start", to: "condition" }, { from: "condition", to: "damaged" },
            { from: "damaged", to: "flag", when: { eq: [{ input: "take_in.condition" }, "damaged"] } }, { from: "damaged", to: "good" },
            { from: "flag", to: "noted" }, { from: "noted", to: "symptom", when: { eq: [{ input: "take_in.note" }, "seen"] } }, { from: "noted", to: "odd" },
        ],
    };
    assert.deepEqual(inputScope([["take_in.condition", "damaged"], ["take_in.touchdowns", 5], ["param", "b1"]]), { take_in: { condition: "damaged", touchdowns: 5 }, param: "b1" });
    // As the screen's driver gives it (nested), and as flat names (older callers): the same way on.
    assert.equal(stepFrom(f, "condition", { input: inputScope([["take_in.condition", "damaged"]]) }).id, "symptom");
    assert.equal(stepFrom(f, "condition", { input: { "take_in.condition": "damaged" } }).id, "symptom");
    assert.equal(stepFrom(f, "condition", { input: inputScope([["take_in.condition", "good"]]) }).id, "good");
});
