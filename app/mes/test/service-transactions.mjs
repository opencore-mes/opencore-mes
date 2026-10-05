// A service runs a transaction (DESIGN.md §15.2, §25), end to end against a running server:
//   1. Dana designs a batch object that is created only through its Start a batch transaction (a policy
//      with `via`), and the transaction (its check: at least one unit); approved, they are live. Then, in a
//      second change, the web service ERP calls to start a batch, which runs the transaction, and the
//      transaction's callers naming the service.
//   2. The checks: a service that runs a transaction whose callers do not name it, a signed transaction,
//      and a transaction that drops a service running it, are each told, in words.
//   3. A dry run plans the transaction as drafted in the change (the callers naming the service), writing
//      nothing; its fitness case passes the same way; the change is approved by the stewards of what it
//      reaches, the transaction's among them.
//   4. ERP calls the service: the batch is started through the transaction, as the service's identity
//      on behalf of ERP, audited as a run of the transaction; the same batch again is found, not started
//      twice; a retried run with the same key answers the first; the transaction's own check refuses a
//      batch of no units, its words and field reaching ERP (422).
//   5. Where no transaction is run, the batch is not made: a service writing it directly is refused by
//      its policy. A service the transaction's callers do not name, and a signed transaction, are refused
//      at run time too, in words.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/service-transactions.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "../../../src/server/db.js";
import { createApp } from "../app.mjs";
import { createTokens } from "../server/ai-api.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });
const tag = `${Date.now() % 100000}`;
const OBJ = `batch_t${tag}`;
const TX = `start_batch_t${tag}`;
const TXS = `signed_batch_t${tag}`;
const SVC = `batch_in_t${tag}`;
const people = ["dana", "vera", "eli", "sam", "quinn", "olga", "ivan", "ines", "iris"];

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of people) {
    sessions[user] = `st-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    return res.ok ? body : { error: body.error, status: res.status, code: body.code, fields: body.fields, problems: body.problems };
};
const tokens = createTokens(db);
const erpToken = (await tokens.issue("erp", { name: `test ${tag}`, agent: "service-transactions", scopes: ["service:call"] })).token;
const svc = async (name, input, { key } = {}) => {
    const res = await fetch(`${mes}/svc/v1/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${erpToken}`, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json() };
};
const batches = (no) => db.query("SELECT id, created_by FROM mes.records WHERE object = $1 AND archived_at IS NULL AND data->>'batch_no' = $2", [OBJ, no]);

// A batch: made only through the transaction (`via`), by whoever holds maker; read by maker and viewer.
const object = {
    object: OBJ, label: "Batch (test)", area: "Production", titleField: "batch_no",
    fields: { batch_no: { label: "Batch", type: "string", required: true }, qty: { label: "Units", type: "integer", required: true } },
    states: { initial: "open", list: ["open", "closed"], transitions: [{ action: "close", label: "Close", from: ["open"], to: "closed" }] },
    roles: ["maker", "viewer"], stewards: { object: ["production"] },
    policies: [
        { id: "batch-read", roles: ["maker", "viewer"], record: { read: true }, fields: { "*": "read" } },
        { id: "batch-start", roles: ["maker"], via: [TX], record: { create: true }, fields: { batch_no: "write", qty: "write" } },
    ],
    list: { columns: ["batch_no", "qty"] }, rules: [],
};
const transaction = (name, extra = {}) => ({
    name, label: name === TX ? "Start a batch" : "Start a batch (signed)", description: "A new batch of units.",
    inputs: { batch_no: { label: "Batch", type: "string", required: true }, qty: { label: "Units", type: "integer", required: true } },
    require: [{ that: { gt: [{ input: "qty" }, 0] }, message: "A batch starts with at least one unit.", field: "qty" }],
    steps: [{ create: OBJ, set: { batch_no: { input: "batch_no" }, qty: { input: "qty" } } }],
    callers: { users: [], groups: ["production"], services: [SVC] }, stewards: ["production"],
    scenarios: [{ name: "a batch of no units is refused", records: {}, steps: [{ as: "sam", do: { transaction: name, input: { batch_no: `BSC${tag}`, qty: 0 } }, expect: { ok: false } }] }],
    ...extra,
});
// ERP sends a batch: one already there is answered as it is; a new one is started through the transaction.
const script = `// ERP starts a batch: through Start a batch, so its check and its policy apply, as on the floor.
export default async function ${SVC}(ctx) {
  const [there] = await ctx.records.list("${OBJ}", { batch_no: ctx.input.batch_no });
  if (there) { ctx.output = { batch: there.id, started: false }; return ctx; }
  const run = await ctx.transactions.run("${TX}", { batch_no: ctx.input.batch_no, qty: ctx.input.qty }, { key: ctx.input.batch_no });
  ctx.output = { batch: run.records[0]?.id ?? null, run: run.run ?? null, started: true, changes: run.changes.length };
  return ctx;
}`;
const service = (name = SVC, extra = {}) => ({
    name, label: "Batch from ERP", description: "ERP starts a batch.",
    input: { batch_no: { label: "Batch", type: "string", required: true }, qty: { label: "Units", type: "integer", required: true } },
    http: { enabled: true }, callers: { users: ["erp"], groups: [] }, on: [],
    runAs: "service", roles: { [OBJ]: ["maker"] },
    uses: { connections: [], objects: { [OBJ]: ["read"] }, transactions: [TX] }, stewards: ["production"], ...extra,
});

const approve = async (id) => {
    const submitted = await call("dana", "design.submit", { id });
    await call("iris", "design.review", { id, decision: "pass" });
    let state = null;
    for (let round = 0; round < 4 && state !== "executed"; round++) {
        for (const user of people) {
            const seen = await call(user, "design.change", { id, as: user });
            for (const department of seen.can?.approveFor ?? []) state = (await call(user, "design.approve", { id, department, decision: "approve", meaning: "Approved" })).state ?? state;
        }
    }
    return { submitted, state };
};

try {
    // ---- 1. designed: the batch and its transaction, then the service ----
    const { id: first } = await call("dana", "design.start", { object: OBJ, label: "Batch (test)" });
    const firstSaved = await call("dana", "design.save", { id: first, reason: "Batches, started through Start a batch.", definitions: { [OBJ]: object }, transactions: { [TX]: transaction(TX, { callers: { users: [], groups: ["production"] } }), [TXS]: transaction(TXS, { callers: { users: [], groups: ["production"] }, signature: { meaning: "Started" } }) } });
    const firstDone = await approve(first);
    const { id: change } = await call("dana", "design.start", { service: SVC, label: "Batch from ERP" });
    const saved = await call("dana", "design.save", {
        id: change, reason: "ERP starts batches, through Start a batch.",
        transactions: { [TX]: transaction(TX) }, services: { [SVC]: service() }, scripts: { [SVC]: script },
    });
    step("the batch object (made only through its transaction) and Start a batch are live; a second change holds the service that runs it and the transaction's callers naming it, with nothing to put right",
        (firstSaved.problems ?? []).length === 0 && firstDone.state === "executed" && Array.isArray(saved.problems) && saved.problems.length === 0, { firstSaved: firstSaved.problems, firstDone, saved: saved.problems ?? saved });

    // ---- 2. the checks ----
    const check = async (extra) => (await call("dana", "design.check", { transactions: { [TX]: transaction(TX) }, services: { [SVC]: service() }, scripts: { [SVC]: script }, ...extra })).problems ?? [];
    const notNamed = await check({ transactions: { [TX]: transaction(TX, { callers: { users: [], groups: ["production"] }, }) }, services: { [SVC]: service() } });
    const signed = await check({ transactions: { [TX]: transaction(TX), [TXS]: transaction(TXS, { callers: { users: [], groups: ["production"], services: [SVC] }, signature: { meaning: "Started" } }) }, services: { [SVC]: service(SVC, { uses: { connections: [], objects: { [OBJ]: ["read"] }, transactions: [TX, TXS] } }) } });
    const noSuch = await check({ services: { [SVC]: service(SVC, { uses: { connections: [], objects: { [OBJ]: ["read"] }, transactions: [TX, "no_such_tx"] } }) } });
    const words = (list) => list.map((p) => p.message).join(" | ");
    step("the checks say: a transaction whose callers do not name the service it runs as (and that transaction keeping the service among its callers), a signed transaction (no service runs it, nor is among its callers), one that does not exist",
        /callers do not name it: add .* to that transaction's callers/.test(words(notNamed)) && /keep .* among its callers/.test(words(notNamed))
        && /signed by the person running it: a service never runs it/.test(words(signed)) && /signed by the person running it: a service may not run it/.test(words(signed)) && /"no_such_tx" is not a transaction/.test(words(noSuch)),
        { notNamed: words(notNamed), signed: words(signed), noSuch: words(noSuch) });

    // ---- 3. dry run, fitness, approval ----
    const before = (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1", [OBJ]))[0].n;
    const liveOnly = await call("dana", "design.dryRun", { kind: "service", name: SVC, source: script, service: service(), run: { input: { batch_no: `BD${tag}`, qty: 3 } } });
    const planned = await call("dana", "design.dryRun", { kind: "service", name: SVC, source: script, service: service(), transactions: { [TX]: transaction(TX) }, run: { input: { batch_no: `BD${tag}`, qty: 3 } } });
    const after = (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = $1", [OBJ]))[0].n;
    step("a dry run plans the transaction as drafted in the change (its callers naming the service): the batch it would start, as the service's role, writing nothing; against the live one, whose callers do not name it yet, it is refused in words",
        planned.ok && planned.output?.started === true && planned.transactions?.[0]?.transaction === TX && planned.transactions[0].simulated && planned.transactions[0].changes === 1 && after === before
        && !liveOnly.ok && /may not run Start a batch/.test(liveOnly.error?.message ?? ""),
        { planned: { ok: planned.ok, error: planned.error, output: planned.output, transactions: planned.transactions }, liveOnly: liveOnly.error, before, after });
    await call("dana", "design.save", { id: change, tests: { [SVC]: [{ name: "a batch is started", run: { input: { batch_no: `BF${tag}`, qty: 5 } }, expect: { ok: true } }] } });
    const { submitted, state } = await approve(change);
    const [{ route }] = await db.query("SELECT route FROM mes.change_requests WHERE id = $1", [change]);
    step("its fitness case passes (the transaction planned as drafted); submitted, reviewed and approved by the stewards of what it reaches (the transaction's among them), it executes",
        !submitted.error && state === "executed" && route.some((r) => r.department === "production"), { submitted, state, route });

    // ---- 4. ERP calls it ----
    const good = await svc(SVC, { batch_no: `B${tag}`, qty: 12 });
    const [made] = await batches(`B${tag}`);
    const [ran] = await db.query("SELECT actor, on_behalf_of, after FROM mes.audit_log WHERE object = '$transaction' AND action = $1 ORDER BY seq DESC LIMIT 1", [`run:${TX}`]);
    const [called] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$service' AND action = $1 ORDER BY seq DESC LIMIT 1", [`called:${SVC}`]);
    step("ERP starts a batch: run through Start a batch as the service, on behalf of ERP; the run is audited as the transaction's, and the service's call names it",
        good.status === 200 && good.body.output?.started && good.body.output.batch === made?.id && made.created_by === `service:${SVC}` && ran?.actor === `service:${SVC}` && ran.after.records?.[0]?.id === made.id
        && called?.after.calls?.some((c) => c.transaction === TX && c.run === good.body.output.run),
        { good, made, ran: ran && { actor: ran.actor, onBehalfOf: ran.on_behalf_of }, calls: called?.after.calls });
    const again = await svc(SVC, { batch_no: `B${tag}`, qty: 12 });
    const twice = await batches(`B${tag}`);
    step("the same batch again is found, not started twice", again.status === 200 && again.body.output?.started === false && twice.length === 1, { again, twice });
    const zero = await svc(SVC, { batch_no: `BZ${tag}`, qty: 0 });
    step("the transaction's own check refuses a batch of no units: its words and its field reach ERP (422), and nothing is made",
        zero.status === 422 && zero.body.error === "A batch starts with at least one unit." && zero.body.fields?.qty && !(await batches(`BZ${tag}`)).length, zero);
    // A run retried with the same key (a trigger sent again): the first answer, nothing made twice.
    const [{ n: runsBefore }] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE action = $1", [`run:${TX}`]);
    // The batch taken away underneath (as if the first answer were lost): the service runs the transaction
    // again with the same key, and is answered the first run.
    const k1 = await svc(SVC, { batch_no: `BK${tag}`, qty: 2 });
    await db.query("DELETE FROM mes.records WHERE object = $1 AND data->>'batch_no' = $2", [OBJ, `BK${tag}`]);
    const k2 = await svc(SVC, { batch_no: `BK${tag}`, qty: 2 });
    const [{ n: runsAfter }] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE action = $1", [`run:${TX}`]);
    step("a run retried with the same key answers the first run, and runs nothing again", k1.body.output?.run && k2.body.output?.run === k1.body.output.run && runsAfter === runsBefore + 1, { k1: k1.body, k2: k2.body, runs: [runsBefore, runsAfter] });

    // ---- 5. refusals at run time ----
    const direct = await call("dana", "design.dryRun", { kind: "service", name: SVC, source: script.replace(`const run = await ctx.transactions.run("${TX}", { batch_no: ctx.input.batch_no, qty: ctx.input.qty }, { key: ctx.input.batch_no });`, `await ctx.records.create("${OBJ}", { batch_no: ctx.input.batch_no, qty: ctx.input.qty }); const run = { records: [], changes: [] };`), service: service(SVC, { uses: { connections: [], objects: { [OBJ]: ["read", "create"] }, transactions: [TX] } }), run: { input: { batch_no: `BX${tag}`, qty: 1 } } });
    const stranger = await call("dana", "design.dryRun", { kind: "service", name: `${SVC}_b`, source: script.replace(`function ${SVC}(`, `function ${SVC}_b(`), service: service(`${SVC}_b`), run: { input: { batch_no: `BS${tag}`, qty: 1 } } });
    const notUsed = await call("dana", "design.dryRun", { kind: "service", name: SVC, source: script, service: service(SVC, { uses: { connections: [], objects: { [OBJ]: ["read"] } } }), run: { input: { batch_no: `BN${tag}`, qty: 1 } } });
    const signedTx = { name: TXS };
    const signedRun = await call("dana", "design.dryRun", { kind: "service", name: SVC, source: script.replace(`ctx.transactions.run("${TX}"`, `ctx.transactions.run("${signedTx.name}"`), service: service(SVC, { uses: { connections: [], objects: { [OBJ]: ["read"] }, transactions: [signedTx.name] } }), run: { input: { batch_no: `BG${tag}`, qty: 1 } } });
    step("where no transaction is run the batch is not made (a direct write is refused by its policy); a service the callers do not name, one whose design does not list it, and a signed transaction are refused, in words",
        !direct.ok && /cannot create/i.test(direct.error?.message ?? "") && !stranger.ok && /may not run Start a batch/.test(stranger.error?.message ?? "") && /production/.test(stranger.error.message)
        && !notUsed.ok && /may not run .*uses.transactions/.test(notUsed.error?.message ?? "") && !signedRun.ok && /signed by the person running it/.test(signedRun.error?.message ?? ""),
        { direct: direct.error, stranger: stranger.error, notUsed: notUsed.error, signedRun: signedRun?.error });
} catch (error) {
    step("the test ran to the end", false, { error: error.stack ?? error.message });
} finally {
    await app.close().catch(() => {});
    await pool.end();
}
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok || s.detail === undefined ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
const failed = steps.filter((s) => !s.ok).length;
console.log(failed ? `\n${failed} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
