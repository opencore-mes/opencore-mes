// Transactions (§25) without a database: the expressions they read, the policies' `via`, the checks
// on a transaction's definition, its footprint and its compare. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, countsOf, referencesOf, shapeProblems } from "../client/expr.js";
import { decide, actionRefusal, explainDecision } from "../server/policy.js";
import { validateTransaction, transactionFootprint, validateDefinition, routeOf, derivedOrder } from "../client/definition.js";
import { transactionChanges, countByTab } from "../client/compare.js";
import { definitions, transactions, users, groups } from "../db/seed.mjs";

const byName = Object.fromEntries(definitions.map((d) => [d.object, d]));
const known = {
    objects: Object.fromEntries(definitions.map((d) => [d.object, { fields: d.fields, actions: d.states.transitions.map((t) => t.action), states: d.states.list, transitions: d.states.transitions, stewards: d.stewards }])),
    users: users.map((u) => u.id), groups: groups.map((g) => g.id), departments: ["production", "quality", "engineering"],
};
const moveIn = transactions.find((t) => t.name === "move_in");

test("expressions: add and sub (an empty value is 0), input and lookup, counts the caller supplies", () => {
    const scopes = { input: { good: 390, scrap: null, machine: "m1" }, lookup: { lot: { qty: 390 }, machine: { capacity: 1 } } };
    assert.equal(evaluate({ eq: [{ add: [{ input: "good" }, { input: "scrap" }] }, { lookup: "lot.qty" }] }, scopes), true);
    assert.equal(evaluate({ sub: [10, 3, 2] }, {}), 5);
    assert.equal(evaluate({ add: ["a", 1] }, {}), null);
    const full = { lt: [{ count: { object: "lot", where: { machine: { input: "machine" }, state: ["processing"] } } }, { lookup: "machine.capacity" }] };
    const [spec] = countsOf(full, scopes);
    assert.deepEqual(spec.where, { machine: "m1", state: ["processing"] });
    assert.equal(evaluate(full, { ...scopes, counts: { [spec.key]: 0 } }), true);
    assert.equal(evaluate(full, { ...scopes, counts: { [spec.key]: 1 } }), false);
    assert.deepEqual(referencesOf(full).map((r) => `${r.scope}.${r.path}`), ["input.machine", "lookup.machine.capacity"]);
});

test("a policy with via applies only through those transactions; the refusal and why? say so", () => {
    const lot = byName.lot;
    const operator = { id: "olga", roles: ["operator"] };
    const record = { state: "created", lot_no: "4713" };
    const plain = decide(lot, operator, record);
    assert.ok(!plain.actions.includes("move_in"));
    assert.equal(plain.why["action:move_in"], "transaction");
    assert.equal(plain.fields.machine, "r");
    const through = decide(lot, { ...operator, via: "move_in" }, record);
    assert.ok(through.actions.includes("move_in"));
    assert.equal(through.fields.machine, "w");
    assert.match(actionRefusal(lot, operator, record, "move_in", plain, ["Move in"]), /Move in is done through the Move in transaction/);
    const why = explainDecision(lot, operator, record, { action: "move_in" });
    assert.ok(why.remedies.some((r) => r.kind === "transaction"));
    // Its state condition: a released lot's quantity is not a transaction's to change.
    assert.equal(decide(lot, { ...operator, via: "track_out" }, { state: "released" }).fields.qty, "r");
});

test("the seed's transactions and objects are valid; via names must be transactions", () => {
    for (const t of transactions) assert.deepEqual(validateTransaction(t, known), [], t.name);
    const k = { objects: Object.keys(byName), scripts: ["lot_round_qty", "lot_qty_positive", "lot_default_expiry", "lot_check_qty", "lot_release_checks", "lot_archive_checks"], departments: known.departments };
    assert.deepEqual(validateDefinition(byName.lot, { ...k, transactions: transactions.map((t) => t.name) }), []);
    const messages = validateDefinition(byName.lot, { ...k, transactions: ["move_in"] }).map((p) => p.message).join("\n");
    assert.match(messages, /"track_in" is not a transaction/);
});

test("a transaction's mistakes are named", () => {
    const bad = {
        ...moveIn,
        inputs: { ...moveIn.inputs, machine2: { label: "M", type: "ref", to: "machine", from: "lot.work_order" }, qty: { type: "decimal", requiredWhen: { gt: [{ data: "nope" }, 0] } } },
        appearsOn: { object: "lot", states: ["flying"], fills: "machine" },
        require: [{ that: { eq: [{ lookup: "machine.colour" }, 1] }, message: "" }, { that: { lt: [{ count: { object: "tool", where: {} } }, 1] }, message: "x" }],
        steps: [{ on: "lot", action: "fly" }, { on: "qty", action: "move_in" }, { on: "lot", set: { colour: 1 } }, { on: "lot" }],
        callers: { users: ["nobody"], groups: [] },
    };
    const m = validateTransaction(bad, known).map((p) => p.message).join("\n");
    for (const expected of [
        /machine2": lot\.work_order refers to work_order; this input must be a reference to the same/,
        /"qty" required when: it reads data\.nope, which is not a field/,
        /lot has no state "flying"/,
        /appearsOn\.fills is the input the record fills in/,
        /Check 1: machine has no field "colour"/,
        /Check 1: say in words what is wrong/,
        /Check 2: it counts "tool", which is not an object/,
        /Step 1: lot has no action "fly"/,
        /Step 2: "on" names a reference input/,
        /Step 3: lot has no field "colour"/,
        /Step 4: it sets fields, takes an action, or both/,
        /"nobody" is not a user/,
    ]) assert.match(m, expected);
});

test("a second person who verifies (§7.4): what it means, and who may give it, named and checked", () => {
    const k = { ...known, objects: { ...known.objects, lot: { ...known.objects.lot, roles: ["operator", "supervisor"] } } };
    const of = (signature) => validateTransaction({ ...moveIn, signature }, k).filter((p) => p.path.startsWith("signature")).map((p) => p.message);
    assert.deepEqual(of({ meaning: "Performed", verifier: { meaning: "Verified", departments: ["quality"] } }), []);
    assert.deepEqual(of({ meaning: "Performed", verifier: { meaning: "Verified", roles: ["lot.supervisor"] } }), []);
    assert.match(of({ meaning: "Performed", verifier: { meaning: "", departments: ["quality"] } }).join(), /verifier's signature states its meaning/);
    assert.match(of({ meaning: "Performed", verifier: { meaning: "Verified" } }).join(), /Say who may verify it: a department or a role/);
    assert.match(of({ meaning: "Performed", verifier: { meaning: "Verified", departments: ["it_ops"] } }).join(), /"it_ops" is not a department/);
    assert.match(of({ meaning: "Performed", verifier: { meaning: "Verified", roles: ["lot.pilot"] } }).join(), /lot has no role "pilot"/);
    assert.match(of({ meaning: "Performed", verifier: { meaning: "Verified", roles: ["supervisor"] } }).join(), /a role is "<object>.<role>"/);
    assert.match(of({ meaning: "Performed", verifier: { meaning: "Verified", roles: ["ghost.supervisor"] } }).join(), /"ghost" is not an object/);
    assert.match(of({ meaning: "Performed", verifier: { meaning: "Verified", departments: ["quality"], witness: true } }).join(), /"witness" is not meaning, departments or roles/);
});

test("footprint: a transaction answers to its stewards, and its steps to the stewards of what they write", () => {
    const context = { objects: byName };
    const added = transactionFootprint("move_in", undefined, moveIn, context);
    assert.equal(added[0].element, "transaction:move_in");
    assert.deepEqual(added[0].stewards, ["production", "quality"]);  // the lot's stewards: production and quality
    const label = transactionFootprint("move_in", moveIn, { ...moveIn, label: "Load" }, context);
    assert.deepEqual(routeOf(label).map((r) => r.department), ["production"]);
    const steps = transactionFootprint("move_in", moveIn, { ...moveIn, steps: [...moveIn.steps, { on: "lot", set: { disposition: { input: "x" } } }] }, context);
    assert.deepEqual(routeOf(steps).map((r) => r.department), ["production", "quality"]);
});

test("compare: a transaction's differences, by the tab where each is edited", () => {
    const after = { ...moveIn, label: "Load", require: [...moveIn.require, { that: true, message: "x" }], inputs: { ...moveIn.inputs, note: { type: "text" } } };
    const changes = transactionChanges(moveIn, after);
    assert.deepEqual(countByTab(changes), { general: 1, inputs: 1, checks: 1 });
    assert.equal(changes.find((c) => c.element === "require:2").change, "added");
    assert.equal(transactionChanges(null, moveIn)[0].change, "added");
});

test("the expression language: mul, div, and some/every over rows", async () => {
    const { evaluate } = await import("../client/expr.js");
    const s = { input: { good: 970, reject: 30, readings: [{ value: 1.2 }, { value: 1.6 }, { value: 1.3 }] }, lookup: { product: { yield_limit: 0.95 } } };
    assert.equal(evaluate({ div: [{ input: "good" }, { add: [{ input: "good" }, { input: "reject" }] }] }, s), 0.97);
    assert.equal(evaluate({ ge: [{ div: [{ input: "good" }, { add: [{ input: "good" }, { input: "reject" }] }] }, { lookup: "product.yield_limit" }] }, s), true);
    assert.equal(evaluate({ mul: [2, 3, 0.5] }, s), 3);
    assert.equal(evaluate({ div: [1, 0] }, s), null, "a division by 0 gives no value");
    assert.equal(evaluate({ div: [{ input: "none" }, 2] }, s), null, "an empty value gives no value");
    assert.equal(evaluate({ some: [{ input: "readings" }, { gt: [{ row: "value" }, 1.5] }] }, s), true);
    assert.equal(evaluate({ every: [{ input: "readings" }, { lt: [{ row: "value" }, 1.5] }] }, s), false);
    assert.equal(evaluate({ some: [{ input: "nothing" }, { gt: [{ row: "value" }, 0] }] }, s), false);
});

test("a rows input and a create step are checked like the rest", () => {
    const inputs = { lot: { type: "ref", to: "lot", required: true }, readings: { type: "rows", min: 3, max: 2, fields: { value: { type: "decimal" }, who: { type: "ref", to: "lot" } } } };
    const body = { ...moveIn, inputs, form: undefined, steps: [{ create: "nope", set: { x: 1 } }, { create: "lot", forEach: "lot", on: "lot", set: { qty: { row: "value" }, colour: 1 } }, { create: "lot", set: { qty: { row: "value" } } }] };
    const m = validateTransaction(body, known).map((p) => p.message).join("\n");
    for (const expected of [/at least 3 rows, and at most 2\?/, /"readings.who": a row's field is a string, integer/, /"nope" is not an object/, /names no "on" and takes no action/, /forEach names a rows input/, /lot has no field "colour"/, /it reads a row, but the step does not run once per row/]) {
        assert.match(m, expected);
    }
});

test("an input filled in from one filled in before it; a button only where its condition holds", () => {
    const lot = { label: "Lot", type: "ref", to: "lot", required: true };
    const order = { label: "Order", type: "ref", to: "work_order", from: "lot.work_order" };
    // Two filled in from the lot.
    const chained = { ...moveIn, form: undefined, inputs: { lot, machine: { type: "ref", to: "machine", from: "lot.machine" }, wo: order } };
    assert.deepEqual(validateTransaction(chained, known).filter((p) => p.path.startsWith("inputs")), []);
    // Stored as JSON, inputs keep no order: one filled in from another declared after it is fine; a circle is not.
    const late = { ...chained, form: undefined, inputs: { wo: order, machine: { type: "ref", to: "machine", from: "lot.machine" }, lot } };
    assert.deepEqual(validateTransaction(late, known).filter((p) => p.path.startsWith("inputs")), []);
    assert.deepEqual(derivedOrder({ c: { from: "b.x" }, b: { from: "a.x" }, a: {} }), { order: ["b", "c"], circular: [] });
    const circle = { ...chained, form: undefined, inputs: { lot, a: { type: "ref", to: "deviation", from: "b.lot" }, b: { type: "ref", to: "deviation", from: "a.lot" } } };
    assert.match(validateTransaction(circle, known).map((p) => p.message).join("\n"), /"a": it is filled in from "b", which is filled in, in the end, from "a"/);
    const when = (w) => validateTransaction({ ...moveIn, appearsOn: { ...moveIn.appearsOn, when: w } }, known).filter((p) => p.path === "appearsOn.when").map((p) => p.message);
    assert.deepEqual(when({ eq: [{ record: "machine" }, null] }), []);
    assert.match(when({ eq: [{ record: "colour" }, 1] }).join(), /record.colour, which is not a field/);
    assert.match(when({ eq: [{ input: "lot" }, 1] }).join(), /it reads the record or the user/);
});

test("a screen's param opens only with the records its where names; a table's fills fill its row buttons", async () => {
    const { validateScreen } = await import("../client/definition.js");
    const knownS = { ...known, transactions: Object.fromEntries(transactions.map((t) => [t.name, { inputs: t.inputs, appearsOn: t.appearsOn ?? null }])), screens: [] };
    const screen = (param, table) => ({ name: "press", label: "Press", params: { machine: { label: "Machine", type: "ref", to: "machine", widget: "select", ...param } }, blocks: [{ block: "table", object: "lot", where: {}, columns: ["lot_no"], rowActions: ["move_in"], ...table }], callers: { users: [], groups: ["production"] }, stewards: ["production"] });
    const words = (s) => validateScreen(s, knownS).map((p) => p.message).join("\n");
    assert.equal(words(screen({ where: { kind: ["press"] } }, { fills: { machine: { param: "machine" } } })), "");
    assert.match(words(screen({ where: { colour: ["red"] } }, {})), /machine has no field "colour"/);
    assert.match(words(screen({ where: { kind: [] } }, {})), /where kind is a value or a list of values/);
    assert.match(words(screen({}, { fills: { qty: 1 } })), /no row button's transaction has an entered input "qty"/);
    assert.match(words(screen({}, { fills: { machine: { param: "nope" } } })), /param.nope, which is not a parameter/);
});

// A service runs a transaction (§15.2): its design lists it, and the transaction's callers name the service.
import { validateService, integrationFootprint, SERVICE_TEMPLATE } from "../client/definition.js";
import { callableProblems } from "../client/code-editor.js";
test("a service that runs a transaction, and a transaction a service runs: each side checked, in words", () => {
    const base = { name: "start_batch", label: "Start a batch", inputs: { n: { label: "N", type: "string", required: true } }, require: [], steps: [], stewards: ["production"] };
    const tKnown = { objects: {}, users: [], groups: ["production"], departments: ["production"], services: ["batch_in"], runBy: {} };
    const words = (list) => list.map((p) => p.message).join(" | ");
    // Only services may run it: someone may, so it is not "nobody yet".
    assert.deepEqual(validateTransaction({ ...base, callers: { services: ["batch_in"] } }, tKnown).filter((p) => p.path.startsWith("callers")), []);
    assert.match(words(validateTransaction({ ...base, callers: { services: ["nobody_here"] } }, tKnown)), /"nobody_here" is not a service/);
    assert.match(words(validateTransaction({ ...base, callers: { services: ["batch_in"] }, signature: { meaning: "Started" } }, tKnown)), /signed by the person running it: a service may not run it/);
    assert.match(words(validateTransaction({ ...base, callers: { groups: ["production"] } }, { ...tKnown, runBy: { start_batch: ["batch_in"] } })), /The service batch_in runs it .* keep batch_in among its callers/);

    const service = { name: "batch_in", label: "Batch in", http: { enabled: true }, callers: { users: [], groups: [] }, on: [], runAs: "service", roles: {}, uses: { objects: {}, connections: [], transactions: ["start_batch"] }, stewards: ["production"] };
    const sKnown = (callers, signed = false) => ({ scripts: ["batch_in"], users: ["erp"], groups: [], objects: {}, connections: [], departments: ["production"], transactions: { start_batch: { label: "Start a batch", callers: { services: callers }, signed } } });
    assert.deepEqual(validateService(service, sKnown(["batch_in"])), []);
    assert.match(words(validateService(service, sKnown([]))), /Start a batch's callers do not name it: add batch_in to that transaction's callers/);
    assert.match(words(validateService(service, sKnown(["batch_in"], true))), /Start a batch is signed by the person running it: a service never runs it/);
    assert.match(words(validateService({ ...service, uses: { ...service.uses, transactions: ["nope"] } }, sKnown(["batch_in"]))), /"nope" is not a transaction/);
    assert.match(words(validateService({ ...service, uses: { ...service.uses, transactions: "start_batch" } }, sKnown(["batch_in"]))), /lists the transactions it may run/);
    // Run as a user, the transaction's callers decide at run time (that user, or their groups).
    assert.deepEqual(validateService({ ...service, runAs: "erp" }, sKnown([])), []);
    // What it runs answers to the transaction's stewards too.
    const fp = integrationFootprint("service", "batch_in", undefined, service, { objects: {}, transactions: { start_batch: { stewards: ["quality"] } } });
    assert.deepEqual(fp[0].stewards, ["production", "quality"]);
    // The editor's callable check knows ctx.transactions.run, and nothing else under it; the template says so.
    assert.deepEqual(callableProblems(`export default async function s(ctx) { await ctx.transactions.run("start_batch", {}); return ctx; }`), []);
    assert.match(callableProblems(`export default async function s(ctx) { await ctx.transactions.start("start_batch"); return ctx; }`)[0].message, /ctx.transactions.start does not exist/);
    assert.match(SERVICE_TEMPLATE("s"), /ctx\.transactions\.run\(name, input, \{ key \}\)/);
});

test("an expression's shape: an operator the language does not have, or the wrong arguments, is named at design, never failing a run", () => {
    assert.deepEqual(shapeProblems({ any: [{ is_null: { input: "a" } }, { le: [{ input: "a" }, 50] }] }), []);
    assert.match(shapeProblems({ or: [{ eq: [{ input: "a" }, null] }] }).join(), /"or" is not an operator of the language: say "any"/);
    assert.match(shapeProblems({ count: { object: "lot", where: { qty: { gte: [1, 2] } } } }).join(), /"gte" is not an operator.*say "ge"/);
    assert.match(shapeProblems({ eq: [1] }).join(), /eq takes two things/);
    assert.match(shapeProblems({ all: { eq: [1, 1] } }).join(), /all takes a list of conditions/);
    const body = { name: "t", label: "T", inputs: { a: { type: "decimal" } }, require: [{ that: { or: [{ eq: [{ input: "a" }, null] }] }, message: "m" }], steps: [], callers: { users: ["sam"], groups: [] }, stewards: ["production"] };
    assert.match(validateTransaction(body, { objects: {} }).map((p) => p.message).join("\n"), /Check 1: "or" is not an operator of the language/);
});

test("a policy naming a field read beside \"*\": \"write\" is told it changes nothing (grants add up; deny takes away)", () => {
    const body = { ...definitions.find((d) => d.object === "lot") };
    body.policies = [...body.policies, { id: "lot-oops", roles: [body.roles[0]], fields: { "*": "write", qty: "read" } }];
    assert.match(validateDefinition(body, { objects: definitions.map((d) => d.object) }).map((p) => p.message).join("\n"), /"\*" lets every field be written, so "qty": "read" changes nothing/);
});

test("a policy's via may name a suite's step kind: checked while its suite is installed, inert when it is not", () => {
    const body = { ...definitions.find((d) => d.object === "lot") };
    const withVia = (via) => ({ ...body, policies: [...body.policies, { id: "lot-step", roles: [body.roles[0]], via, fields: { qty: "write" } }] });
    const words = (via, steps) => validateDefinition(withVia(via), { objects: definitions.map((d) => d.object), transactions: transactions.map((t) => t.name), steps }).filter((p) => p.path.endsWith(".via")).map((p) => p.message).join("\n");
    assert.equal(words(["hello.note"], ["hello.note", "hello.bell"]), "");
    assert.match(words(["hello.eat"], ["hello.note"]), /the hello suite has no step "hello.eat" \(hello.note\)/);
    assert.equal(words(["gone.kind"], ["hello.note"]), "");
    assert.match(words(["Not a name"], []), /via lists the transactions \(or the suites' step kinds\)/);
});
