// Services and connections (DESIGN.md §15.2), end to end, against a running server and a fake ERP:
//   1. Dana designs an ERP integration in one change: a connection (ERP's address, its secret by
//      name, the one request allowed), a web service ERP calls to send work orders, and a trigger
//      that confirms a released lot to ERP. Nothing answers before it is approved.
//   2. The change is reviewed and approved by the stewards of everything it reaches, and executed:
//      the services are live at once, with no restart.
//   3. ERP calls the web service: no token, the wrong caller, bad input, a quantity the work order's
//      own rule refuses (the same rule pipe as a form), a good order, and a retry with the same key.
//   4. Quality releases a lot: the trigger confirms it to ERP, with the secret, after the commit.
//
//   DATABASE_URL=postgres:///openmes_poc node app/mes/test/integration.mjs
import http from "node:http";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";
import { createTokens } from "../server/ai-api.js";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = `${Date.now() % 100000}`;
const CONN = `erp_t${tag}`;
const IN = `erp_wo_in_t${tag}`;
const OUT = `erp_lot_out_t${tag}`;

// ---- a fake ERP: POST /api/confirmations, bearer s3cret ----
const erp = [];
let erpDown = false;
const erpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
        erp.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null, down: erpDown });
        if (req.headers.authorization !== "Bearer s3cret") { res.writeHead(401); res.end(); return; }
        if (erpDown) { res.writeHead(503); res.end(); return; }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `CONF-${erp.length}` }));
    });
});
await new Promise((r) => erpServer.listen(0, "127.0.0.1", r));
const erpUrl = `http://127.0.0.1:${erpServer.address().port}/api`;

// ---- the MES, with the connection's secret set on the server ----
const app = await createApp({ db, dev: false, build: "test", secrets: (name) => (name === "erp_token" ? "s3cret" : undefined), outboxEveryMs: 100 });
const { url: mes } = await app.listen({ port: 0 });
const sessions = {};
for (const user of ["dana", "vera", "eli", "sam", "quinn"]) {
    sessions[user] = `it-${randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [sessions[user], user]);
}
const call = async (user, name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sessions[user]}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const tokens = createTokens(db);
const erpToken = (await tokens.issue("erp", { name: `test ${tag}`, agent: "integration", scopes: ["service:call"] })).token;
const samToken = (await tokens.issue("sam", { name: `test ${tag}`, agent: "integration", scopes: ["service:call"] })).token;
const svc = async (name, input, { token = erpToken, key } = {}) => {
    const res = await fetch(`${mes}/svc/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(input),
    });
    return { status: res.status, body: await res.json() };
};

let change = null;
const created = { workOrders: [], lots: [], changes: [] };
try {
    // ---- 1. design ----
    ({ id: change } = await call("dana", "design.start", { connection: CONN, label: "ERP (test)" }));
    const inScript = `// ERP sends a work order; it is created as ERP, through the work order's policy and rule pipe.
export default async function ${IN}(ctx) {
  const wo = await ctx.records.create("work_order", { wo_no: ctx.input.wo_no, item: ctx.input.item, qty: ctx.input.qty, line: ctx.input.line });
  ctx.output = { id: wo.id, wo_no: wo.wo_no, state: wo.state };
  return ctx;
}`;
    const outScript = `// A released lot is confirmed to ERP.
export default async function ${OUT}(ctx) {
  if (ctx.event?.kind !== "transition:release") return ctx;
  const lot = await ctx.records.get("lot", ctx.event.id);
  const res = await ctx.http("${CONN}", { method: "POST", path: "/confirmations", body: { lot_no: lot.lot_no, item: lot.item, qty: lot.qty, uom: lot.uom } });
  if (res.status >= 500) throw Object.assign(new Error("ERP is unavailable"), { retry: true });
  if (!res.ok) throw new Error("ERP refused the confirmation (" + res.status + ")");
  ctx.output = { confirmation: res.body.id };
  return ctx;
}`;
    const saved = await call("dana", "design.save", {
        id: change,
        reason: "ERP sends work orders, and is told when a lot is released.",
        connections: { [CONN]: { name: CONN, label: "ERP (test)", baseUrl: erpUrl, auth: { kind: "bearer", secret: "erp_token" }, allow: [{ method: "POST", path: "/confirmations" }], timeoutMs: 3000, stewards: ["engineering"] } },
        services: {
            [IN]: {
                name: IN, label: "Work order from ERP", description: "ERP sends a planned work order.",
                input: { wo_no: { label: "Work order no.", type: "string", required: true }, item: { type: "string", required: true }, qty: { type: "decimal", required: true }, line: { type: "enum", values: ["L1", "L2", "L3"], required: true } },
                http: { enabled: true }, callers: { users: ["erp"], groups: [] }, on: [],
                // Its own service role: it plans work orders, whoever calls it.
                runAs: "service", roles: { work_order: ["planner"] },
                uses: { connections: [], objects: { work_order: ["create"] } }, stewards: ["production"],
            },
            [OUT]: {
                name: OUT, label: "Lot released → ERP", description: "Confirms a released lot to ERP.",
                input: {}, http: { enabled: false }, callers: { users: [], groups: [] }, on: [{ object: "lot", event: "transition:release" }], runAs: "erp",
                uses: { connections: [CONN], objects: { lot: ["read"] } }, stewards: ["production"],
            },
        },
        scripts: { [IN]: inScript, [OUT]: outScript },
    });
    step("the draft validates", saved.problems.length === 0, saved.problems);
    const early = await svc(IN, { wo_no: "X" });
    step("nothing answers before approval", early.status === 404, early);

    // ---- 1b. dry runs of the draft: executed, with everything it may call callable, nothing changed ----
    const conn = { name: CONN, label: "ERP (test)", baseUrl: erpUrl, auth: { kind: "bearer", secret: "erp_token" }, allow: [{ method: "POST", path: "/confirmations" }], timeoutMs: 3000, stewards: ["engineering"] };
    const [draft] = await db.query("SELECT content FROM mes.change_requests WHERE id = $1", [change]);
    const dry = (name, source, run, as = "dana") => call(as, "design.dryRun", { kind: "service", name, source, service: draft.content.services[name], connections: { [CONN]: conn }, run });
    const [anyLot] = await db.query("SELECT id FROM mes.records WHERE object = 'lot' LIMIT 1");
    const before = { erp: erp.length, wo: (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'work_order'"))[0].n };
    const d1 = await dry(OUT, outScript, { event: { kind: "transition:release", object: "lot", id: anyLot.id }, responses: { "POST /confirmations": { status: 201, body: { id: "DRY-1" } } } });
    step("dry run of the trigger: a real read, the request checked and answered as asked, never sent", d1.ok && d1.output?.confirmation === "DRY-1" && d1.reads[0]?.found && d1.requests[0]?.path === "/confirmations" && d1.requests[0].auth.includes("not sent") && erp.length === before.erp, { ok: d1.ok, error: d1.error, requests: d1.requests.length });
    const d2 = await dry(OUT, outScript, { event: { kind: "transition:release", object: "lot", id: anyLot.id }, responses: { "POST /confirmations": { status: 503 } } });
    step("dry run: ERP answering 503 shows the script asking for a retry", !d2.ok && d2.error?.retry === true && d2.error.message === "ERP is unavailable", d2.error);
    const asCaller = { ...draft.content.services[IN], runAs: "caller" };
    const d0 = await call("dana", "design.dryRun", { kind: "service", name: IN, source: inScript, service: asCaller, run: { input: { wo_no: `WO-DRY${tag}`, item: "PA66", qty: 10, line: "L1" } } });
    step("dry run, running as its caller: the caller's rights apply (Dana views work orders only)", !d0.ok && d0.as === "dana" && d0.error?.message === "You cannot create a Work order.", d0.error);
    const dSvc = await dry(IN, inScript, { input: { wo_no: `WO-DRY${tag}`, item: "PA66", qty: 10, line: "L1" } });
    step("dry run, as its own service role: its roles apply, whoever runs it (and that is audited)", dSvc.ok && dSvc.as === `service:${IN}` && dSvc.onBehalfOf === "dana", { as: dSvc.as, for: dSvc.onBehalfOf, error: dSvc.error });
    const d3 = await dry(IN, inScript, { input: { wo_no: `WO-DRY${tag}`, item: "PA66", qty: 0, line: "L1" } }, "sam");
    step("dry run: the work order's rule pipe runs on the would-be write, and refuses it", !d3.ok && d3.error?.message === "The quantity must be more than zero." && !d3.error.fault, d3.error);
    const d4 = await dry(IN, inScript, { input: { wo_no: `WO-DRY${tag}`, item: "PA66", qty: 10, line: "L1" } }, "sam");
    const afterWo = (await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'work_order'"))[0].n;
    step("dry run: a good work order is checked through and shown, and not created", d4.ok && d4.writes[0]?.op === "create" && d4.output?.state === "planned" && afterWo === before.wo, { writes: d4.writes.length, afterWo, before: before.wo });
    const typo = inScript.replace("const wo = await", "lgo(ctx.input);\n  const wo = await");
    const d5 = await dry(IN, typo, { input: { wo_no: "X", item: "Y", qty: 1, line: "L1" } });
    step("dry run: a runtime error is placed on its line", !d5.ok && d5.error?.name === "ReferenceError" && d5.error.line === 3, d5.error);
    const stray = outScript.replace('path: "/confirmations"', 'path: "/orders/1"');
    const d6 = await dry(OUT, stray, { event: { kind: "transition:release", object: "lot", id: anyLot.id } });
    step("dry run: a request the connection does not allow is refused", !d6.ok && d6.error?.fault && d6.error.message.includes("is not allowed") && d6.requests.length === 0, d6.error);
    const [audited] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE after->>'service' = ANY($1) AND action NOT LIKE 'dry-run-as:%'", [[IN, OUT]]);
    const [asAudited] = await db.query("SELECT count(*)::int AS n FROM mes.audit_log WHERE action = $1 AND actor IN ('dana', 'sam')", [`dry-run-as:${IN}`]);
    step("dry runs leave no records and no call audit; acting as another identity is audited", audited.n === 0 && asAudited.n >= 1, { calls: audited.n, dryRunsAs: asAudited.n });

    // ---- 1c. the fitness test: submitting is refused until every new script has passing cases ----
    const refusedSubmit = await call("dana", "design.submit", { id: change }).then(() => null, (e) => e);
    const [{ fitness: unfit }] = await db.query("SELECT fitness FROM mes.change_requests WHERE id = $1", [change]);
    step("fitness: a submit with untested scripts is refused, with the report kept", refusedSubmit?.body?.code === "design.unfit" && !unfit.passed && unfit.checks.find((c) => c.id === "tests").items.some((i) => i.includes("has no test cases")), unfit?.checks.map((c) => `${c.id}:${c.status}`));
    const inCases = [
        { name: "a good order is created", run: { input: { wo_no: `WO-FIT${tag}`, item: "PA66", qty: 5, line: "L1" } }, expect: { ok: true, output: { state: "planned" }, writes: 1 } },
        { name: "a zero quantity is refused by the work order's rule", run: { input: { wo_no: `WO-FIT${tag}`, item: "PA66", qty: 0, line: "L1" } }, expect: { ok: false, error: "more than zero" } },
    ];
    const outCase = (expected) => ({ name: "a release is confirmed", run: { event: { kind: "transition:release", object: "lot", id: anyLot.id }, responses: { "POST /confirmations": { status: 201, body: { id: "C-1" } } } }, expect: { ok: true, output: { confirmation: expected }, requests: 1 } });
    const outDown = { name: "ERP down asks for a retry", run: { event: { kind: "transition:release", object: "lot", id: anyLot.id }, responses: { "POST /confirmations": { status: 503 } } }, expect: { ok: false, error: "unavailable" } };
    await call("dana", "design.save", { id: change, tests: { [IN]: inCases, [OUT]: [outCase("WRONG"), outDown] } });
    const mismatch = await call("dana", "design.fitness", { id: change });
    const wrongCase = mismatch.checks.find((c) => c.id === "tests").cases.find((c) => !c.passed);
    step("fitness: a case whose expectation is not met fails, saying what it got", !mismatch.passed && wrongCase?.name === "a release is confirmed" && wrongCase.detail.includes("C-1"), wrongCase);
    await call("dana", "design.save", { id: change, tests: { [OUT]: [outCase("C-1"), outDown] } });
    const fit = await call("dana", "design.fitness", { id: change });
    const tests = fit.checks.find((c) => c.id === "tests");
    step("fitness: with passing cases (each as its service will run: the service role, the erp user), it passes", fit.passed && tests.cases.length === 4 && tests.cases.every((c) => c.passed) && tests.cases[0].detail.startsWith(`as service:${IN}`) && tests.cases[2].detail.startsWith("as erp"), tests.cases.map((c) => `${c.passed ? "✓" : "✗"} ${c.name}: ${c.detail}`));
    const [{ n: fitWo }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = $1", [`WO-FIT${tag}`]);
    step("fitness: its cases changed nothing", fitWo === 0 && erp.length === before.erp);

    // ---- 2. review, approval by the stewards of everything it reaches, execution ----
    await call("dana", "design.submit", { id: change });
    const [{ fitness: frozen }] = await db.query("SELECT fitness FROM mes.change_requests WHERE id = $1", [change]);
    step("the report submitted is frozen with the change, for its reviewers", frozen?.passed && frozen.hash && frozen.checks.length === 7 && frozen.checks.some((c) => c.id === "scenarios") && frozen.checks.some((c) => c.id === "callers"));
    const [{ route }] = await db.query("SELECT route FROM mes.change_requests WHERE id = $1", [change]);
    const departments = route.map((r) => r.department);
    step("the route: engineering (the connection), production (the services, work orders, lots), quality (lots)", JSON.stringify(departments) === JSON.stringify(["engineering", "production", "quality"]), route.map((r) => `${r.department}: ${r.because.join(", ")}`));
    await call("vera", "design.review", { id: change, decision: "pass", note: "" });
    for (const [user, department] of [["eli", "engineering"], ["sam", "production"], ["quinn", "quality"]]) {
        const r = await call(user, "design.approve", { id: change, department, decision: "approve", meaning: "Approved" });
        if (department === "quality") step("the last approval executes it", r.state === "executed", r);
    }

    // ---- 2b. copies (§5): a service with its script, a connection, an object with its rule scripts ----
    const changeOf = async (r) => (r.id ? call("dana", "design.change", { id: r.id, as: "dana" }) : null);
    const svcCopy = await call("dana", "design.start", { service: `${IN}_b`, from: IN });
    const svcChange = await changeOf(svcCopy);
    const copiedSvc = svcChange?.content?.services?.[`${IN}_b`];
    step("a service started as a copy of a live one: all of it under the new name, its script copied with its function renamed, and its test cases",
        !svcCopy.error && copiedSvc?.name === `${IN}_b` && copiedSvc.label === "Work order from ERP (copy)" && JSON.stringify(copiedSvc.input) === JSON.stringify(draft.content.services[IN].input)
        && svcChange.content.scripts[`${IN}_b`]?.includes(`function ${IN}_b(ctx)`) && (svcChange.content.tests?.[`${IN}_b`] ?? []).length > 0 && /a copy of Work order from ERP/.test(svcChange.title),
        { svcCopy, copiedSvc, title: svcChange?.title });
    const connCopy = await call("dana", "design.start", { connection: `${CONN}_b`, label: "ERP, second plant", from: CONN });
    const copiedConn = (await changeOf(connCopy))?.content?.connections?.[`${CONN}_b`];
    step("a connection started as a copy: its address, what it allows and its secret's name, under the new name and label", !connCopy.error && copiedConn?.label === "ERP, second plant" && copiedConn.baseUrl === erpUrl && copiedConn.auth?.secret === "erp_token", { connCopy, copiedConn });
    const objCopy = await call("dana", "design.start", { object: `batch_t${tag}`, from: "lot" });
    const objChange = await changeOf(objCopy);
    const copiedObj = objChange?.content?.definitions?.[`batch_t${tag}`];
    const [liveLot] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const renamed = (copiedObj?.rules ?? []).map((r) => r.script);
    step("an object started as a copy: its fields, states and policies under the new name, each rule script copied under a name of its own (the object's swapped in), the originals untouched",
        !objCopy.error && copiedObj?.object === `batch_t${tag}` && JSON.stringify(copiedObj.fields) === JSON.stringify(liveLot.body.fields) && JSON.stringify(copiedObj.states) === JSON.stringify(liveLot.body.states)
        && renamed.length === liveLot.body.rules.length && renamed.every((n) => n.startsWith(`batch_t${tag}`) && typeof objChange.content.scripts[n] === "string") && liveLot.body.rules.every((r) => !renamed.includes(r.script)),
        { objCopy, renamed, scripts: Object.keys(objChange?.content?.scripts ?? {}) });
    const notLiveObj = await call("dana", "design.start", { object: `nope_t${tag}`, from: `no_such_t${tag}` }).then(() => null, (e) => e.message);
    step("…a copy of an object that is not live is refused, in words", /no live object/.test(notLiveObj ?? ""), notLiveObj);
    for (const r of [svcCopy, connCopy, objCopy]) if (r.id) await call("dana", "design.withdraw", { id: r.id }).catch(() => null);

    // ---- 3. the web service, called by ERP ----
    const none = await svc(IN, {}, { token: null });
    step("no token: 401", none.status === 401);
    const wrong = await svc(IN, { wo_no: "X" }, { token: samToken });
    step("a caller not among its callers: 403, saying who may and who decides", wrong.status === 403 && wrong.body.error.includes("erp") && wrong.body.error.includes("production"), wrong.body.error);
    const bad = await svc(IN, { wo_no: `WO-T${tag}`, item: "PA66", qty: "lots", line: "L9" });
    step("bad input: 400, per field", bad.status === 400 && bad.body.fields?.qty && bad.body.fields?.line && bad.body.fields?.item === undefined, bad.body);
    const zero = await svc(IN, { wo_no: `WO-T${tag}`, item: "PA66", qty: 0, line: "L1" });
    step("the work order's own rule refuses a zero quantity (same pipe as a form): 422", zero.status === 422 && zero.body.error === "The quantity must be more than zero." && zero.body.fields?.qty, zero.body);
    const good = await svc(IN, { wo_no: `WO-T${tag}`, item: "PA66-NAT-25", qty: 500, line: "L2" }, { key: `k-${tag}-1` });
    step("a good work order: created as ERP", good.status === 200 && good.body.output?.state === "planned", good.body);
    if (good.body.output?.id) created.workOrders.push(good.body.output.id);
    const again = await svc(IN, { wo_no: `WO-T${tag}`, item: "PA66-NAT-25", qty: 500, line: "L2" }, { key: `k-${tag}-1` });
    const [{ n }] = await db.query("SELECT count(*)::int AS n FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = $1", [`WO-T${tag}`]);
    step("a retry with the same Idempotency-Key answers the first result and creates nothing", again.status === 200 && again.body.output?.id === good.body.output?.id && n === 1, { n });
    const [audit] = await db.query("SELECT actor, on_behalf_of, action FROM mes.audit_log WHERE object = 'work_order' AND record_id = $1", [good.body.output?.id]);
    step("the record's audit names the service, on behalf of ERP", audit?.actor === `service:${IN}` && audit.on_behalf_of === "erp" && audit.action === "create", audit);
    const [wo] = await db.query("SELECT created_by FROM mes.records WHERE id = $1", [good.body.output?.id]);
    step("the record was created by the service", wo?.created_by === `service:${IN}`, wo);
    const calls = await db.query("SELECT action FROM mes.audit_log WHERE object = '$service' AND after->>'service' = $1 AND action NOT LIKE 'dry-run-as:%' ORDER BY seq", [IN]);
    step("every call is audited, refused or not (a wrong caller, bad input, a rule, a good one)", calls.map((c) => c.action.split(":")[0]).join(" ") === "rejected rejected rejected called", calls.map((c) => c.action));
    // The retry sent while the first call still runs: one of them runs, the other waits its turn.
    const pair = await Promise.all([1, 2].map(() => svc(IN, { wo_no: `WO-P${tag}`, item: "PA66-NAT-25", qty: 500, line: "L2" }, { key: `k-${tag}-pair` })));
    const pairRows = await db.query("SELECT id FROM mes.records WHERE object = 'work_order' AND data->>'wo_no' = $1", [`WO-P${tag}`]);
    created.workOrders.push(...pairRows.map((r) => r.id));
    const later = await svc(IN, { wo_no: `WO-P${tag}`, item: "PA66-NAT-25", qty: 500, line: "L2" }, { key: `k-${tag}-pair` });
    step("two requests at once with one Idempotency-Key run the service once: the other is told to ask again, and then reads the first answer",
        pairRows.length === 1 && pair.some((r) => r.status === 200) && pair.every((r) => r.status === 200 || (r.status === 409 && r.body.code === "idempotency.running")) && later.status === 200 && later.body.output?.id === pairRows[0].id,
        { pair: pair.map((r) => [r.status, r.body.code ?? r.body.output?.id]), rows: pairRows.length, later: later.status });
    const openapi = await fetch(`${mes}/svc/v1/openapi.json`, { headers: { authorization: `Bearer ${erpToken}` } }).then((r) => r.json());
    step("OpenAPI lists what this caller may call", Boolean(openapi.paths?.[`/${IN}`]) && !openapi.paths?.[`/${OUT}`]);

    // ---- 4. the trigger, on a lot's release ----
    const lot = await call("sam", "records.create", { object: "lot", data: { lot_no: `T-${tag}`, item: "PA66-NAT-25", work_order: good.body.output.id, qty: 100, uom: "kg" } });
    created.lots.push(lot.id);
    const started = await call("sam", "records.action", { object: "lot", id: lot.id, action: "start", rowVersion: lot.row_version });
    const accepted = await call("quinn", "records.update", { object: "lot", id: lot.id, rowVersion: started.row_version, data: { disposition: "accept" } });
    const queuedBefore = await db.query("SELECT id FROM mes.integration_outbox WHERE service = $1", [OUT]);
    await call("quinn", "records.action", { object: "lot", id: lot.id, action: "release", rowVersion: accepted.row_version });
    let row = null;
    for (let i = 0; i < 100 && row?.state !== "done"; i++) {
        await sleep(100);
        [row] = await db.query("SELECT * FROM mes.integration_outbox WHERE service = $1 ORDER BY id DESC LIMIT 1", [OUT]);
        // A neighbour on this database without this test's secret may have claimed an attempt.
        if (row?.state === "retry") await db.query("UPDATE mes.integration_outbox SET next_at = now() WHERE id = $1 AND state = 'retry'", [row.id]);
    }
    step("only the release set it off (not create, start or update)", queuedBefore.length === 0 && Boolean(row));
    step("the trigger ran after the commit, as ERP's integration user", row?.state === "done" && row.run_as === "erp", row && { state: row.state, last_error: row.last_error });
    const sent = erp.find((r) => r.body?.lot_no === `T-${tag}`);
    step("ERP received the confirmation, with the secret the server holds", sent?.url === "/api/confirmations" && sent.auth === "Bearer s3cret" && sent.body.qty === 100, sent);
    step("its result is kept", row?.result?.confirmation?.startsWith("CONF-"), row?.result);
    const [traced] = await db.query("SELECT after FROM mes.audit_log WHERE object = '$service' AND after->>'service' = $1 ORDER BY seq DESC LIMIT 1", [OUT]);
    step("the audit shows the request it sent (never the secret)", traced?.after.calls?.[0]?.path === "/confirmations" && !JSON.stringify(traced.after).includes("s3cret"), traced?.after.calls);

    // ---- 5. ERP is down: the trigger is kept and retried, then goes through ----
    erpDown = true;
    const lot2 = await call("sam", "records.create", { object: "lot", data: { lot_no: `T-${tag}-2`, item: "PA66-NAT-25", work_order: good.body.output.id, qty: 50, uom: "kg" } });
    created.lots.push(lot2.id);
    const s2 = await call("sam", "records.action", { object: "lot", id: lot2.id, action: "start", rowVersion: lot2.row_version });
    const a2 = await call("quinn", "records.update", { object: "lot", id: lot2.id, rowVersion: s2.row_version, data: { disposition: "accept" } });
    await call("quinn", "records.action", { object: "lot", id: lot2.id, action: "release", rowVersion: a2.row_version });
    const latest = async () => (await db.query("SELECT * FROM mes.integration_outbox WHERE service = $1 ORDER BY id DESC LIMIT 1", [OUT]))[0];
    let down = null;
    for (let i = 0; i < 50 && down?.state !== "retry"; i++) { await sleep(100); down = await latest(); }
    step("ERP down: the release still commits, and its trigger waits to be retried", down?.state === "retry", down && { state: down.state, attempts: down.attempts, last_error: down.last_error });
    erpDown = false;
    await db.query("UPDATE mes.integration_outbox SET next_at = now() WHERE id = $1", [down.id]); // skip the backoff's wait
    let up = null;
    for (let i = 0; i < 100 && up?.state !== "done"; i++) {
        await sleep(100);
        up = (await db.query("SELECT * FROM mes.integration_outbox WHERE id = $1", [down.id]))[0];
        // A neighbour without this test's secret may have claimed an attempt and pushed the next one out.
        if (up?.state === "retry") await db.query("UPDATE mes.integration_outbox SET next_at = now() WHERE id = $1 AND state = 'retry'", [down.id]);
    }
    // Another instance on this database (a developer's server) may claim an attempt too; it is the
    // same row, so ERP is confirmed once whoever runs it.
    const confirmed = erp.filter((r) => r.body?.lot_no === `T-${tag}-2` && r.auth === "Bearer s3cret");
    step("ERP back: the retry goes through, and ERP is confirmed once", up?.state === "done" && confirmed.filter((r) => !r.down).length === 1 && up.attempts >= 2, up && { state: up.state, attempts: up.attempts, last_error: up.last_error });

    // ---- 6. fitness on an object change: existing records replayed under the draft ----
    const { id: lotChange } = await call("dana", "design.start", { object: "lot" });
    created.changes.push(lotChange);
    const [{ content: lotContent }] = await db.query("SELECT content FROM mes.change_requests WHERE id = $1", [lotChange]);
    const lotDraft = structuredClone(lotContent.definitions.lot);
    lotDraft.fields.batch_ref = { label: "Batch reference", type: "string", required: true };
    lotDraft.policies = lotDraft.policies.map((p) => (p.id === "lot-quality-disposition" ? { ...p, fields: { ...p.fields, batch_ref: "write" } } : p));
    await call("dana", "design.save", { id: lotChange, reason: "Record the batch reference.", definitions: { lot: lotDraft } });
    const lotFit = await call("dana", "design.fitness", { id: lotChange });
    const recordsCheck = lotFit.checks.find((c) => c.id === "records");
    const accessCheck = lotFit.checks.find((c) => c.id === "access");
    step("fitness: existing lots that a new required field would block are counted, for the approvers (a warning)", lotFit.passed && recordsCheck.status === "warn" && recordsCheck.items.some((i) => i.includes("batch_ref") && i.includes("could no longer be saved")), recordsCheck.items);
    step("fitness: the access diff shows who gains what, by role and state", accessCheck.items.some((i) => i.includes("quality") && i.includes("batch_ref")), accessCheck.items.slice(0, 4));

    // ---- 7. fitness on a service with the object it brings: none of its records exists yet ----
    const NOTE = `note_t${tag}`;
    const NOTES = `notes_t${tag}`;
    const { id: noteChange } = await call("dana", "design.start", { object: NOTE, label: "Handover note" });
    created.changes.push(noteChange);
    const [{ content: noteContent }] = await db.query("SELECT content FROM mes.change_requests WHERE id = $1", [noteChange]);
    await call("dana", "design.save", {
        id: noteChange, reason: "Handover notes, and a service that writes the day's.",
        services: { [NOTES]: {
            name: NOTES, label: "Today's note", description: "Writes today's handover note unless there is one.", input: {}, http: { enabled: false },
            callers: { users: ["erp"], groups: [] }, on: [], runAs: "erp", uses: { connections: [], objects: { [NOTE]: ["read", "create"] } }, stewards: ["production"],
        } },
        scripts: { [NOTES]: `// Today's handover note, once.
export default async function ${NOTES}(ctx) {
  const had = await ctx.records.list("${NOTE}", {});
  const made = had.length ? null : await ctx.records.create("${NOTE}", { ${noteContent.definitions[NOTE].titleField}: "Today" });
  ctx.output = { had: had.length, made: Boolean(made), after: (await ctx.records.list("${NOTE}", {})).length };
  return ctx;
}` },
        tests: { [NOTES]: [{ name: "none yet: it writes one", run: { input: {} }, expect: { ok: true, output: { had: 0, made: true, after: 1 }, writes: 1 } }] },
    });
    const noteFit = await call("dana", "design.fitness", { id: noteChange });
    const noteCase = noteFit.checks.find((c) => c.id === "tests")?.cases?.[0];
    step("fitness: a service tested with the object its change brings: that object has no records yet, so it reads none, and what it creates is simulated (its policy applies once live)",
        noteCase?.passed, noteFit.checks.find((c) => c.id === "tests"));
} catch (error) {
    step("unexpected", false, { message: error.message, body: error.body });
} finally {
    await app.close();
    erpServer.close();
    // What this run made, except its audit (append-only by design).
    if (change) {
        await db.query("DELETE FROM mes.integration_outbox WHERE service = ANY($1)", [[IN, OUT]]);
        for (const table of ["services", "connections"]) await db.query(`DELETE FROM mes.${table} WHERE name = ANY($1)`, [[CONN, IN, OUT]]);
        await db.query("DELETE FROM mes.scripts WHERE name = ANY($1)", [[IN, OUT]]);
        await db.query("DELETE FROM mes.approvals WHERE change_id = $1", [change]);
        await db.query("DELETE FROM mes.change_requests WHERE id = $1", [change]);
    }
    for (const id of created.changes) await db.query("DELETE FROM mes.change_requests WHERE id = $1", [id]);
    if (created.lots.length) await db.query("DELETE FROM mes.records WHERE object = 'lot' AND id = ANY($1::uuid[])", [created.lots]);
    if (created.workOrders.length) await db.query("DELETE FROM mes.records WHERE object = 'work_order' AND id = ANY($1::uuid[])", [created.workOrders]);
    await db.query("DELETE FROM mes.idempotency WHERE key LIKE $1", [`svc:${IN}:%`]);
    await db.query("DELETE FROM mes.api_tokens WHERE name = $1", [`test ${tag}`]);
    await db.query("DELETE FROM mes.sessions WHERE id = ANY($1)", [Object.values(sessions).map(sessionKey)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
