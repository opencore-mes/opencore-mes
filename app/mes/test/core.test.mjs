// The POC's core rules, without a database: policy decisions and explanations, the rule pipe, the
// backend runner, the audit hash. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, mask, explainDecision, actionRefusal } from "../server/policy.js";
import { runPipe, scriptBody, isFault } from "../client/pipe.js";
import { runRules, checkScript } from "../server/rules.js";
import { canonical } from "../server/audit.js";
import { explain } from "../client/expr.js";
import { definitions, scripts as seedScripts } from "../db/seed.mjs";

const lot = definitions.find((d) => d.object === "lot");
const operator = { id: "olga", roles: ["operator"] };
const quality = { id: "quinn", roles: ["quality"] };
const nobody = { id: "x", roles: [] };

test("who reads every record (§27.7): every field but one a rule hides, no write, no action, no archiving", () => {
    const reader = { id: "iris", roles: ["$reader"] };
    const d = decide(lot, reader, { state: "in_process" });
    assert.equal(d.read, true);
    assert.ok(Object.values(d.fields).every((level) => level === "r" || level === null));
    assert.ok(Object.values(d.fields).includes("r"));
    assert.deepEqual(d.actions, []);
    assert.equal(d.create, false);
    assert.equal(d.archive, false);
    // A field some rule hides stays hidden from the reader.
    const hiding = { ...lot, policies: [...lot.policies, { id: "hide-it", roles: ["nobody"], deny: { read: ["qty"] } }] };
    assert.equal(decide(hiding, reader, { state: "in_process" }).fields.qty, null);
    // With another role too, the writes are that role's.
    assert.equal(decide(lot, { id: "iris", roles: ["$reader", "operator"] }, { state: "in_process" }).fields.qty, "w");
});

test("deny by default: no role, no read", () => {
    const d = decide(lot, nobody, { state: "in_process" });
    assert.equal(d.read, false);
    assert.equal(mask(lot, nobody, { id: "1", state: "in_process", data: { qty: 1 } }), null);
});

test("state conditions: an operator writes qty in process, not once released", () => {
    assert.equal(decide(lot, operator, { state: "in_process" }).fields.qty, "w");
    const released = decide(lot, operator, { state: "released" });
    assert.equal(released.fields.qty, "r");
    assert.equal(released.why.qty, "state");
});

test("roles: only quality writes disposition, and the reason says so", () => {
    assert.equal(decide(lot, quality, { state: "on_hold" }).fields.disposition, "w");
    const d = decide(lot, operator, { state: "on_hold" });
    assert.equal(d.fields.disposition, "r");
    assert.equal(d.why.disposition, "role");
});

test("an explicit deny locks a field and keeps it readable", () => {
    const d = decide(lot, operator, { state: "released" });
    assert.equal(d.fields.expiry, "r");
    assert.equal(d.why.expiry, "deny");
});

test("actions follow the state machine, then the rules", () => {
    assert.deepEqual(decide(lot, operator, { state: "created" }).actions, ["start", "hold"]);
    assert.deepEqual(decide(lot, quality, { state: "on_hold" }).actions, ["resume", "release"]);
    assert.equal(decide(lot, operator, { state: "released" }).why["action:release"], "state");
});

test("explain: the failing condition, its value, and the remedy", () => {
    const trace = explainDecision(lot, operator, { id: "1", state: "released", qty: 5 }, { field: "qty", op: "write" });
    assert.equal(trace.decision, "deny");
    const rule = trace.because.find((b) => b.rule === "lot-production-edit");
    assert.match(rule.condition, /fails: record\.state in \["created", "in_process"\] \(value: "released"\)/);
    assert.match(trace.remedies[0].detail, /deviation/);
});

test("explain hides a condition on a field the reader cannot see", () => {
    const def = {
        object: "t", fields: { secret: { type: "string" }, open: { type: "string" } }, states: { initial: "a", transitions: [] },
        policies: [
            { id: "see-open", roles: ["r"], record: { read: true }, fields: { open: "read" } },
            { id: "edit-open", roles: ["r"], when: { eq: [{ record: "secret" }, "yes"] }, fields: { open: "write" } },
        ],
    };
    const trace = explainDecision(def, { id: "u", roles: ["r"] }, { state: "a", secret: "no" }, { field: "open" });
    const text = JSON.stringify(trace);
    assert.ok(!text.includes("secret"), "the hidden field is not named");
    assert.match(text, /a condition on data you do not have access to/);
});

// ---- archiving ----
const supervisor = { id: "sam", roles: ["supervisor"] };

test("archiving is a grant of its own, denied by default, with conditions", () => {
    assert.equal(decide(lot, supervisor, { state: "consumed" }).archive, true);
    assert.equal(decide(lot, supervisor, { state: "on_hold" }).archive, true);
    const early = decide(lot, supervisor, { state: "in_process" });
    assert.equal(early.archive, false);
    assert.equal(early.why["record:archive"], "state");
    const operatorDecision = decide(lot, operator, { state: "consumed" });
    assert.equal(operatorDecision.archive, false);
    assert.equal(operatorDecision.why["record:archive"], "role");
    assert.equal(mask(lot, supervisor, { id: "1", state: "consumed", data: {} }).$perm.archive, true);
});

test("an archived record is read-only: no writes, no actions, reason archived", () => {
    const live = decide(lot, operator, { state: "in_process" });
    assert.equal(live.fields.qty, "w");
    const archived = decide(lot, operator, { state: "in_process", archived_at: "2026-09-30T08:00:00Z" });
    assert.equal(archived.read, true);
    assert.equal(archived.fields.qty, "r");
    assert.equal(archived.why.qty, "archived");
    assert.deepEqual(archived.actions, []);
    assert.equal(archived.why["action:start"], "archived");
    assert.equal(decide(lot, supervisor, { state: "on_hold", archived_at: "2026-09-30T08:00:00Z" }).archive, true, "and it may be restored");
    assert.match(actionRefusal(lot, operator, { lot_no: "4712", state: "in_process" }, "hold", archived), /archived; restore it/);
});

test("explain: why a record cannot be archived, and why an archived one cannot be changed", () => {
    const denied = explainDecision(lot, supervisor, { id: "1", state: "released" }, { archive: true });
    assert.equal(denied.decision, "deny");
    assert.ok(denied.because.some((b) => b.rule === "lot-archive" && /fails/.test(b.condition)));
    const locked = explainDecision(lot, operator, { id: "1", state: "in_process", archived_at: "2026-09-30T08:00:00Z", archived_by: "sam" }, { field: "qty", op: "write" });
    assert.equal(locked.decision, "deny");
    assert.match(locked.because[0].detail, /archived by sam/);
    assert.equal(locked.remedies[0].kind, "archive");
});

test("the object's pipe runs on archive: the seed rule refuses an undecided lot", async () => {
    const published = new Map(Object.entries(seedScripts).map(([name, source]) => [name, { version: 1, source }]));
    const run = (disposition) => runRules({
        definition: lot, scripts: published, lookup: async () => ({ qty: 1000 }),
        ctx: { event: { kind: "archive", object: "lot", action: null, changed: [], source: "user", prev: {} }, user: supervisor, record: { state: "on_hold" }, data: { qty: 10, work_order: "w", disposition }, now: "2026-09-30T08:00:00.000Z" },
    });
    const pending = await run("pending");
    assert.equal(pending.error.script, "lot_archive_checks");
    assert.equal(pending.error.field, "disposition");
    assert.equal(pending.error.fault, false);
    const rejected = await run("reject");
    assert.equal(rejected.error, null);
    assert.deepEqual(rejected.trace.map((t) => t.script), lot.rules.map((r) => r.script), "every script in the pipe saw the archive");
});

test("expressions read own properties only", () => {
    assert.equal(explain({ eq: [{ record: "constructor" }, null] }, { record: {} }).value, false);
    assert.equal(explain({ is_null: { record: "__proto__" } }, { record: {} }).value, true);
});

// ---- the pipe ----
const ctx = (extra = {}) => ({ event: { kind: "change", object: "t", action: null, changed: ["qty"], source: "user", prev: {} }, user: { id: "u" }, record: {}, data: { qty: 1 }, now: "2026-09-29T00:00:00.000Z", ...extra });
const fns = (map) => async (name, c) => map[name](c);

test("a pipe passes the context along, and a throw stops it with the script's words", async () => {
    const out = await runPipe({
        entries: [{ script: "double", writes: ["qty"] }, { script: "limit" }, { script: "never" }],
        invoke: fns({
            double: (c) => ({ ...c, data: { ...c.data, qty: c.data.qty * 2 } }),
            limit: (c) => { if (c.data.qty > 1) throw Object.assign(new Error("Too many."), { field: "qty" }); return c; },
            never: () => { throw new Error("must not run"); },
        }),
        ctx: ctx(),
    });
    assert.deepEqual({ message: out.error.message, field: out.error.field, fault: out.error.fault }, { message: "Too many.", field: "qty", fault: false });
    assert.deepEqual(out.trace.map((t) => t.outcome), ["passed", "threw"]);
});

test("an undeclared write and a changed read-only part are faults", async () => {
    const undeclared = await runPipe({ entries: [{ script: "sneaky" }], invoke: fns({ sneaky: (c) => ({ ...c, data: { ...c.data, qty: 9 } }) }), ctx: ctx() });
    assert.equal(undeclared.error.fault, true);
    assert.match(undeclared.error.detail, /does not declare/);
    const frozen = await runPipe({ entries: [{ script: "who" }], invoke: fns({ who: (c) => ({ ...c, user: { id: "admin" } }) }), ctx: ctx() });
    assert.equal(frozen.error.fault, true);
});

test("a bug is a fault whose words are not shown", async () => {
    const out = await runPipe({ entries: [{ script: "bug" }], invoke: fns({ bug: (c) => c.nothing.here }), ctx: ctx() });
    assert.equal(out.error.fault, true);
    assert.match(out.error.message, /could not run/);
    assert.ok(isFault(new TypeError("x")));
    assert.ok(!isFault(new Error("Pick a work order.")));
});

test("committed entries run only on committed events; `when` skips without calling", async () => {
    let ran = 0;
    const out = await runPipe({
        entries: [{ script: "after", committed: true }, { script: "skipped", when: { eq: [{ data: "qty" }, 99] } }],
        invoke: fns({ after: () => { ran += 1; }, skipped: () => { ran += 1; } }),
        ctx: ctx(),
    });
    assert.equal(ran, 0);
    assert.equal(out.error, null);
});

// ---- scripts ----
test("the name rule: file name is function name, one function, nothing else", () => {
    assert.throws(() => scriptBody("a", "export default function b(ctx) { return ctx; }"), /must be the file's name/);
    assert.throws(() => checkScript("a", "export default function a(ctx) { return ctx; }\nconsole.log(1);"));
    assert.throws(() => checkScript("a", "import x from 'y';\nexport default function a(ctx) { return ctx; }"));
    for (const [name, source] of Object.entries(seedScripts)) assert.ok(checkScript(name, source), name);
});

test("the backend runner: seed rules on a lot, a fixed clock, a lookup", async () => {
    const published = new Map(Object.entries(seedScripts).map(([name, source]) => [name, { version: 1, source }]));
    const base = { user: operator, record: {}, now: "2026-09-29T08:00:00.000Z" };
    const created = await runRules({ definition: lot, scripts: published, lookup: async () => ({ qty: 1000, wo_no: "WO-1" }), ctx: { ...base, event: { kind: "save", object: "lot", changed: ["qty"], prev: {} }, data: { qty: 10.12345, work_order: "w" } } });
    assert.equal(created.error, null);
    assert.equal(created.ctx.data.qty, 10.123);
    assert.equal(created.ctx.data.expiry, "2027-03-28", "180 days from the pipe's own clock");
    const over = await runRules({ definition: lot, scripts: published, lookup: async () => ({ qty: 1000, wo_no: "WO-1" }), ctx: { ...base, event: { kind: "save", object: "lot", changed: ["qty"], prev: {} }, data: { qty: 2000, work_order: "w" } } });
    assert.equal(over.error.field, "qty");
    assert.match(over.error.message, /At most 1050/);
});

test("the runner stops a script that never ends", async () => {
    const out = await runRules({
        definition: { rules: [{ script: "spin" }] },
        scripts: new Map([["spin", { version: 1, source: "export default function spin(ctx) { for (;;) {} }" }]]),
        ctx: ctx(), lookup: async () => null,
    });
    assert.equal(out.error.fault, true);
});

test("audit rows hash the same whatever the key order", () => {
    assert.equal(canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), canonical({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
});
