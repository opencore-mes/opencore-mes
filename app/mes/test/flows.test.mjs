// Flow templates (§32) without a database: the checks, node by node and wire by wire, for a route and
// for a plan; Tidy's layout; a template in plain words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlow, tidyLayout, explainFlow, flowKindOf, flowStartOf, flowContextNames, validateDefinition, flowMapOf, flowWalk, subFlowsOf, subFlowPath, FLOW_KINDS_OF, copyDesign, copyScript, copiedScriptName } from "../client/definition.js";

const known = {
    objects: {
        lot: { fields: { station: { type: "enum", values: ["cut", "pack"] }, qty: { type: "integer" }, item: { type: "string" } }, states: ["new", "held", "done"], transitions: [{ action: "hold", from: ["new"], to: "held" }], roles: ["router"], flow: { as: ["traveler", "subject"], step: "station" } },
        tool: { fields: { kind: { type: "string" } }, states: ["idle"], transitions: [], roles: [], flow: { as: ["resource"] } },
        reading: { fields: { value: { type: "decimal" } }, states: ["new"], transitions: [], roles: [], flow: { as: ["subject"] } },
    },
    transactions: { cut_it: { appearsOn: { object: "lot" } }, pack_it: { appearsOn: { object: "lot" } }, other: { appearsOn: { object: "tool" } } },
    scripts: ["hold_it"], flows: ["recheck"], departments: ["production"],
};
const route = () => ({
    name: "line", label: "Line", kind: "route",
    participants: { lot: { object: "lot", as: "traveler" }, tool: { object: "tool", as: "resource" } },
    context: { limit: 3 },
    nodes: {
        start: { kind: "start", label: "Start", when: { eq: [{ context: "lot.item" }, "A"] } },
        cut: { kind: "sequence", label: "Cut", offers: ["cut_it"], leaves: ["cut_it"], resource: { kind: ["saw"] }, state: "new" },
        check: { kind: "auto_decision", label: "Check" },
        pack: { kind: "sequence", label: "Pack", offers: ["pack_it"], leaves: ["pack_it"], onExit: "hold_it" },
        done: { kind: "end", label: "Done" },
    },
    edges: [{ from: "start", to: "cut" }, { from: "cut", to: "check" }, { from: "check", to: "done", when: { gt: [{ context: "lot.qty" }, { context: "limit" }] } }, { from: "check", to: "pack" }, { from: "pack", to: "done" }],
    stewards: ["production"],
});
const problems = (body, k = known) => validateFlow(body, k).map((p) => `${p.path}: ${p.message}`);

test("a sound route has no problems; its start, kinds and context names are read off it", () => {
    assert.deepEqual(problems(route()), []);
    assert.equal(flowStartOf(route()), "start");
    assert.equal(flowKindOf({ kind: "x.station" }, { "x.station": { extends: "sequence" } }), "sequence");
    assert.equal(flowKindOf({ kind: "x.station" }, { "x.station": { extends: "operation" } }), null);
    assert.deepEqual(flowContextNames(route()), ["limit"]);
});

test("a route's wiring: one start, nothing back to it, one wire on from a sequence, conditions only off an auto decision, the last of them may be otherwise", () => {
    const r = route();
    r.nodes.again = { kind: "start", label: "Again" };
    r.edges.push({ from: "pack", to: "start" }, { from: "cut", to: "pack", when: { eq: [1, 1] } }, { from: "again", to: "cut" });
    r.edges.splice(3, 0, { from: "check", to: "pack" });
    const ps = problems(r).join("\n");
    assert.match(ps, /A flow template has one start/);
    assert.match(ps, /nothing leads back to the start/);
    assert.match(ps, /only an auto decision's wires have conditions/);
    assert.match(ps, /Cut: it goes on by one wire; branch with a decision after it/);
    assert.match(ps, /Check: a wire with no condition is taken always/);
});

test("a sequence: what it offers appears on the traveler, it leaves on what it offers, its state is the traveler's, its name a value of the step field", () => {
    const r = route();
    r.nodes.cut = { ...r.nodes.cut, offers: ["other"], leaves: ["cut_it"], state: "gone" };
    r.nodes.pack.onExit = "nope";
    const ps = problems(r).join("\n");
    assert.match(ps, /other does not appear on lot records/);
    assert.match(ps, /it leaves on cut_it, which it does not offer/);
    assert.match(ps, /lot has no state "gone"/);
    assert.match(ps, /onExit "nope" is not a script/);
    const renamed = route();
    renamed.nodes.saw = renamed.nodes.cut;
    delete renamed.nodes.cut;
    renamed.edges = renamed.edges.map((e) => ({ ...e, from: e.from === "cut" ? "saw" : e.from, to: e.to === "cut" ? "saw" : e.to }));
    assert.match(problems(renamed).join("\n"), /lot\.station holds the traveler's step, and "saw" is not one of its values/);
});

test("conditions read the context: its records' fields, its values; anything else is named", () => {
    const r = route();
    r.edges[2].when = { gt: [{ lookup: "lot.qty" }, { context: "nothing" }] };
    const ps = problems(r).join("\n");
    assert.match(ps, /it reads lookup, but a flow's condition reads its context/);
    assert.match(ps, /"nothing" is neither a record of the flow nor a value of its context/);
    r.context = { lot: 1 };
    assert.match(problems(r).join("\n"), /"lot" is a record of the flow already/);
});

test("a plan's nodes: each palette its own; waits, decisions, input screens and sub flows checked", () => {
    assert.match(problems({ ...route(), nodes: { ...route().nodes, ask: { kind: "manual_decision", label: "Ask", for: { groups: ["q"] } } }, edges: [...route().edges, { from: "ask", to: "done", label: "ok" }] }).join("\n"), /Ask: a manual decision belongs to a plan, not a route/);
    const plan = {
        name: "ocap", label: "OCAP", kind: "plan",
        participants: { reading: { object: "reading", as: "subject" } },
        nodes: {
            start: { kind: "start", label: "Start" },
            cool: { kind: "wait", label: "Cool", message: "", seconds: 0, mode: "retry" },
            ask: { kind: "manual_decision", label: "Ask" },
            form: { kind: "input_screen", label: "Form", for: { groups: ["q"] }, fields: [{ name: "photo", type: "image" }, { name: "verdict", type: "enum" }] },
            sub: { kind: "sub_flow", label: "Sub", flow: "elsewhere" },
            cut: { kind: "sequence", label: "Cut", offers: [], leaves: [] },
            done: { kind: "end", label: "Done" },
        },
        edges: [{ from: "start", to: "cool" }, { from: "cool", to: "ask" }, { from: "ask", to: "form" }, { from: "ask", to: "sub", label: "" }, { from: "form", to: "sub" }, { from: "sub", to: "cut" }, { from: "cut", to: "done" }],
        stewards: ["production"],
    };
    const ps = problems(plan).join("\n");
    assert.match(ps, /Cool: say what it shows while it waits/);
    assert.match(ps, /Cool: how long it waits, in whole seconds/);
    assert.match(ps, /Cool: say who acknowledges it/);
    assert.match(ps, /Cool: wire its way back once/);
    assert.match(ps, /Ask: say who decides/);
    assert.match(ps, /Ask: give each of its wires a label/);
    assert.match(ps, /Form: verdict: list the values it may take/);
    assert.match(ps, /Sub: "elsewhere" is not a flow template/);
    assert.match(ps, /Cut: a sequence belongs to a route, not a plan/);
    assert.deepEqual(flowContextNames(plan), ["route", "photo", "verdict"]);
    assert.deepEqual(FLOW_KINDS_OF.plan.includes("sequence"), false);
});

test("sub flows never run in a circle: through other templates, published or drafted, the path is named", () => {
    const plan = (name, sub) => ({
        name, label: name, kind: "plan", participants: { reading: { object: "reading", as: "subject" } },
        nodes: { start: { kind: "start", label: "Start" }, sub: { kind: "sub_flow", label: "Sub", flow: sub }, done: { kind: "end", label: "Done" } },
        edges: [{ from: "start", to: "sub" }, { from: "sub", to: "done" }], stewards: ["production"],
    });
    const k = { ...known, flows: ["a", "b", "c", "d"] };
    assert.deepEqual(subFlowsOf(plan("a", "b")), ["b"]);
    assert.deepEqual(subFlowPath("b", "a", { b: ["c"], c: ["a"] }), ["b", "c", "a"]);
    assert.equal(subFlowPath("b", "a", { b: ["c"], c: ["d"], d: [] }), null);
    // a runs b, which runs c, which runs a: refused, naming the way round.
    assert.match(problems(plan("a", "b"), { ...k, subFlows: { b: ["c"], c: ["a"] } }).join("\n"), /Sub: a → b → c → a runs a again, without end: break the circle/);
    // A chain that ends is fine; a template that runs another twice is not a circle.
    assert.deepEqual(problems(plan("a", "b"), { ...k, subFlows: { b: ["c"], c: ["d"], d: [] } }), []);
    // The change's own draft of a template counts over what is live: a now runs b, where it ran nothing.
    assert.match(problems(plan("b", "a"), { ...k, subFlows: { a: ["b"], b: [] } }).join("\n"), /b → a → b runs b again/);
});

test("an object's step field: a traveler's, a text or choice field of one value", () => {
    const base = { object: "box", label: "Box", fields: { at: { type: "integer" } }, states: { initial: "new", list: ["new"], transitions: [] }, roles: ["r"], policies: [], stewards: { object: ["production"] } };
    const words = (flow) => validateDefinition({ ...base, flow }, { objects: ["box"], departments: ["production"] }).map((p) => p.message).join("\n");
    assert.match(words({ as: ["resource"], step: "at" }), /Only a traveler has a step on a route/);
    assert.match(words({ as: ["traveler"], step: "at" }), /"at" holds a step's name: a text or a choice field/);
    assert.match(words({ as: ["traveler"], mirror: { node: "at" } }), /flow\.mirror is not part of how an object takes part/);
});

test("Tidy lays a template out left to right from its start, branches below; plain words walk it", () => {
    const layout = tidyLayout(route());
    assert.equal(layout.start.x, 40);
    assert.ok(layout.cut.x > layout.start.x && layout.check.x > layout.cut.x);
    assert.equal(layout.done.x, layout.pack.x);
    assert.ok(layout.pack.y !== layout.done.y);
    const words = explainFlow(route(), { transactions: { cut_it: "Cut it" } });
    assert.match(words, /Line is a route over lot \(lot, traveler\), tool \(tool, resource\)/);
    assert.match(words, /Its context starts with limit = 3/);
    assert.match(words, /Start: the start, for runs where lot.item is "A"/);
    assert.match(words, /Cut: a step \(marked new\); Cut it done here on resources where/);
    assert.match(words, /Check: decided at once, on the context; then Done if lot.qty > limit, else Pack/);
    assert.match(words, /Pack: .*\(on leaving, hold_it\)/);
});

test("a run's map: the template without its scripts, settings and conditions; its way on it, wires taken counted, moves off its wires named", () => {
    const r = route();
    r.nodes.cut.kind = "x.saw";
    const map = flowMapOf(r, { "x.saw": { extends: "sequence", label: "Saw step" } });
    assert.deepEqual(map.nodes.cut, { kind: "sequence", label: "Cut", words: "Saw step", hooks: false });
    assert.equal(map.nodes.pack.hooks, true);
    assert.equal(JSON.stringify(map).includes("hold_it"), false);
    assert.deepEqual(map.edges[2], { from: "check", to: "done", cond: true });
    assert.equal(map.nodes.check.kind, "auto_decision");
    // Start, cut, check, pack, check again (by hand: no wire leads from pack to check), done.
    const walk = flowWalk(r, ["start", "cut", "check", "pack", "check", "done"].map((node) => ({ node })));
    assert.deepEqual(walk.visits, { start: 1, cut: 1, check: 2, pack: 1, done: 1 });
    assert.deepEqual(walk.taken, { 0: 1, 1: 1, 3: 1, 2: 1 });
    assert.deepEqual(walk.off, [{ from: "pack", to: "check" }]);
    assert.deepEqual(flowWalk(r, []), { visits: {}, taken: {}, off: [] });
});

test("the seed's flow templates, a process flow and an OCAP, pass the checks against the seed's own designs", async () => {
    const seed = await import("../db/seed.mjs");
    const objects = Object.fromEntries(seed.definitions.map((d) => [d.object, { fields: d.fields, states: d.states.list, transitions: d.states.transitions, roles: d.roles, flow: d.flow }]));
    const transactions = Object.fromEntries(seed.transactions.map((t) => [t.name, { appearsOn: t.appearsOn ?? null }]));
    const k = { objects, transactions, scripts: Object.keys(seed.scripts), flows: seed.flows.map((f) => f.name), groups: seed.groups.map((g) => g.id), departments: seed.groups.filter((g) => g.kind === "department").map((g) => g.id) };
    assert.deepEqual(seed.flows.map((f) => f.kind).sort(), ["plan", "route"]);
    for (const f of seed.flows) assert.deepEqual(problems(f, k), [], f.name);
    const words = explainFlow(seed.flows.find((f) => f.kind === "plan"), {});
    assert.match(words, /Root cause\?: engineering chooses; then Fix the machine on "Machine", else Disposition on "Material", else Retrain the crew on "Method"/);
});

test("a design copied: all of it under its new name and label, its scenarios running the copy, the original untouched", () => {
    const plan = {
        name: "ocap_saw", label: "Saw out of control", kind: "plan", nodes: { start: { kind: "start", when: { eq: [{ context: "r.step" }, "saw_spc"] } } }, edges: [],
        scenarios: [{ name: "set off", records: {}, steps: [{ as: "q", do: { act: { record: "@r", plan: "ocap_saw", values: { v: 1 } } } }, { as: "q", do: { act: { record: "@r", plan: "other" } } }] }],
    };
    const copy = copyDesign("flow", plan, { name: "ocap_mold" });
    assert.equal(copy.name, "ocap_mold");
    assert.equal(copy.label, "Saw out of control (copy)");
    assert.deepEqual(copy.nodes, plan.nodes);
    assert.notEqual(copy.nodes, plan.nodes);
    assert.deepEqual(copy.scenarios[0].steps.map((st) => st.do.act.plan), ["ocap_mold", "other"]);
    assert.equal(plan.scenarios[0].steps[0].do.act.plan, "ocap_saw");
    assert.equal(copyDesign("flow", plan, { name: "x", label: " Mold out of control " }).label, "Mold out of control");
    const tx = copyDesign("transaction", { name: "move_in", label: "Move in", scenarios: [{ steps: [{ do: { transaction: "move_in" } }, { do: { transaction: "track_in" } }] }] }, { name: "move_in_b", label: "Move in B" });
    assert.deepEqual(tx.scenarios[0].steps.map((st) => st.do.transaction), ["move_in_b", "track_in"]);
});

test("an object, a service, a connection copied: named in its own key, its scripts renamed for it", () => {
    const lot = { object: "lot", label: "Lot", fields: { qty: { type: "decimal" } }, rules: [{ script: "lot_round_qty" }, { script: "check_qty" }] };
    const batch = copyDesign("object", lot, { name: "batch", label: "Batch" });
    assert.deepEqual([batch.object, batch.label, batch.name], ["batch", "Batch", undefined]);
    assert.deepEqual(batch.fields, lot.fields);
    assert.equal(copiedScriptName("lot_round_qty", "lot", "batch"), "batch_round_qty");
    assert.equal(copiedScriptName("check_qty", "lot", "batch"), "batch_check_qty");
    assert.equal(copyDesign("connection", { name: "erp", label: "ERP", baseUrl: "https://x" }, { name: "erp_b" }).name, "erp_b");
    // The script's own function takes the copy's name; nothing else in it changes.
    const src = "// erp_in: from ERP\nexport default async function erp_in(ctx) {\n  return ctx; // erp_in\n}";
    assert.equal(copyScript(src, "erp_in", "erp_in_b"), "// erp_in: from ERP\nexport default async function erp_in_b(ctx) {\n  return ctx; // erp_in\n}");
    assert.equal(copyScript("export default function lot_round_qty(ctx) {}", "lot_round_qty", "batch_round_qty"), "export default function batch_round_qty(ctx) {}");
});

// ---- routes inside routes (§32.14) ----
test("a route's sub flow runs another route for the same traveler; a route may be one that runs only inside another", async () => {
    const { flowSetsOff, FLOW_KINDS_OF } = await import("../client/definition.js");
    const withSub = (flow) => { const r = route(); return { ...r, nodes: { ...r.nodes, redo: { kind: "sub_flow", label: "Rework", flow } }, edges: [...r.edges.filter((e) => !(e.from === "pack" && e.to === "done")), { from: "pack", to: "redo" }, { from: "redo", to: "done" }] }; };
    const k = { ...known, flows: ["recheck", "rework", "tool_route"], flowInfo: { recheck: { kind: "plan", object: "reading" }, rework: { kind: "route", object: "lot" }, tool_route: { kind: "route", object: "tool" } }, subFlows: { rework: [], recheck: [], tool_route: [] } };
    assert.ok(FLOW_KINDS_OF.route.includes("sub_flow"));
    assert.deepEqual(problems(withSub("rework"), k), []);
    assert.match(problems(withSub("recheck"), k).join("\n"), /recheck is a plan: a route runs another route/);
    assert.match(problems(withSub("tool_route"), k).join("\n"), /a route for tool records, and this one for lot: a sub route takes the same traveler through/);
    assert.match(problems(withSub("nowhere"), k).join("\n"), /"nowhere" is not a flow template/);
    assert.match(problems(withSub("rework"), { ...k, subFlows: { ...k.subFlows, rework: ["line"] } }).join("\n"), /line → rework → line runs line again, without end/);
    assert.deepEqual(problems({ ...route(), asSub: true }, k), []);
    assert.match(problems({ ...route(), asSub: "yes" }, k).join("\n"), /asSub is true or false, on a route/);
    assert.equal(flowSetsOff(route()), true);
    assert.equal(flowSetsOff({ ...route(), asSub: true }), false, "tried through the routes that run it: no scenario of its own");
});

test("a sequence's place in the route's guide (§35.4): a page or a time", () => {
    const r = route();
    r.nodes.cut.guide = "3";
    r.nodes.pack.guide = "1:05";
    assert.deepEqual(problems(r), []);
    for (const bad of ["page 3", "1:75", 3, ""]) {
        r.nodes.cut.guide = bad;
        assert.match(problems(r).join("\n"), /Cut: guide is where it is in the guide: a page \("3"\) or a time \("0:45"\)/, String(bad));
    }
});
